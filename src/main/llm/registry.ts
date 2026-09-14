import { PROVIDER_IDS, providerById, type ModelInfo, type ProviderId } from '@shared/providers'
import type { ClaudeSource } from '@shared/settings'
import type { Availability, LlmSession, ProviderAdapter, SessionRole } from './types'
import { CancelledError } from './types'
import { createClaudeAdapter, type ClaudeAdapter } from './providers/claude'
import { createCodexAdapter } from './providers/codex'
import { createCursorAdapter } from './providers/cursor'
import { createGeminiAdapter } from './providers/gemini'
import { createOllamaAdapter } from './providers/ollama'

/**
 * Реестр провайдеров: адаптеры, кэш проверок и списков моделей, живые сессии.
 *
 * Сессия подсказок одна на провайдера, и живёт только у того, кто отвечает сейчас:
 * переключились на другого — прежнюю гасим, чтобы в фоне не висел второй CLI и не
 * тратил лимиты. Но не посреди ответа: занятую сессию гасим, когда она допишет.
 * Второй агент — отдельная verify-сессия у любого провайдера, по тем же правилам:
 * одна живая, прежняя гасится после того, как освободится.
 *
 * Проверки (установлен ли, выполнен ли вход) не блокируют окно: сначала отдаём то,
 * что знаем, свежий итог приходит событием.
 */

export interface ProviderStatus {
  id: ProviderId
  available: Availability
  /** живой список, если уже пришёл, иначе запасной из каталога */
  models: ModelInfo[]
  /** только у Claude: задан ли ANTHROPIC_API_KEY для источника «API по ключу» */
  claudeApi?: Availability
  /**
   * Проверка установки или список моделей сейчас в работе. Окно показывает «проверяю…»
   * по этому флагу, а не считает события: события от пересекающихся проверок
   * приходят парами, и счёт заканчивался раньше самих проверок.
   */
  checking?: boolean
}

export interface SessionOptions {
  /** только у Claude и только для подсказок: живая сессия Claude Code или API по ключу */
  claudeSource?: ClaudeSource
}

/** Проверка установки и входа не чаще раза в минуту, если не попросили заново. */
const DETECT_TTL_MS = 60_000
const MODELS_TTL_MS = 5 * 60_000
/** Адаптер обещает уложиться в 5 с; это страховка от того, кто не уложился. */
const DETECT_GUARD_MS = 8_000
const MODELS_GUARD_MS = 15_000
/** Как часто смотреть, освободилась ли сессия, которую пора погасить. */
const RETIRE_POLL_MS = 500

const FACTORIES: Record<ProviderId, () => ProviderAdapter> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  cursor: createCursorAdapter,
  gemini: createGeminiAdapter,
  ollama: createOllamaAdapter,
}

function guard<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms)
    }),
  ])
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

class Registry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>()
  private readonly detected = new Map<ProviderId, { at: number; value: Availability }>()
  private readonly detecting = new Map<ProviderId, Promise<Availability>>()
  private readonly listed = new Map<ProviderId, { at: number; value: ModelInfo[] }>()
  private readonly listing = new Map<ProviderId, Promise<ModelInfo[]>>()
  private readonly mains = new Map<string, LlmSession>()
  private activeMain: string | null = null
  private readonly verifies = new Map<ProviderId, LlmSession>()
  private activeVerify: ProviderId | null = null
  /** Прежние сессии, которые ещё дописывают ответ: гасим, как только освободятся. */
  private readonly retiring = new Set<LlmSession>()
  private retireTimer: ReturnType<typeof setInterval> | null = null

  adapter(id: ProviderId): ProviderAdapter {
    let a = this.adapters.get(id)
    if (!a) {
      a = FACTORIES[id]()
      this.adapters.set(id, a)
    }
    return a
  }

  /**
   * Сессия провайдера. main — подсказки, verify — второй агент; у каждого провайдера они
   * разные и друг другу не мешают. Смена провайдера в той же роли гасит прежнюю сессию —
   * отменой, а не сбоем (в журнал такое не пишется), и только когда она освободится:
   * раньше переключение посреди ответа обрывало его на полуслове и терялась проверка.
   */
  session(id: ProviderId, role: SessionRole, opts: SessionOptions = {}): LlmSession {
    if (role === 'verify') {
      // API по ключу держит свой зашитый промпт и вердикт не напишет — второй агент у Claude
      // всегда идёт через Claude Code, как бы ни отвечали подсказки.
      if (this.activeVerify && this.activeVerify !== id) this.retire(this.verifies.get(this.activeVerify))
      this.activeVerify = id
      let v = this.verifies.get(id)
      if (!v) {
        v = this.adapter(id).createSession('verify')
        this.verifies.set(id, v)
      }
      this.keep(v)
      return v
    }
    const api = id === 'claude' && opts.claudeSource === 'api'
    const key = api ? 'claude:api' : id
    if (this.activeMain && this.activeMain !== key) this.retire(this.mains.get(this.activeMain))
    this.activeMain = key
    let s = this.mains.get(key)
    if (!s) {
      s = api ? (this.adapter('claude') as ClaudeAdapter).createApiSession() : this.adapter(id).createSession('main')
      this.mains.set(key, s)
    }
    // Вернулись к провайдеру, чья сессия ещё дописывала ответ, — она снова нужна, гасить не будем.
    this.keep(s)
    return s
  }

  /** Погасить сессию сейчас, если свободна, иначе — когда допишет. */
  private retire(s: LlmSession | undefined): void {
    if (!s) return
    if (!s.busy) {
      s.stop(new CancelledError())
      return
    }
    this.retiring.add(s)
    // У сессий нет события «освободилась», а busy есть у всех — опрос дешевле, чем обёртка
    // над каждым вопросом. Таймер живёт, только пока есть кого гасить.
    if (!this.retireTimer) {
      this.retireTimer = setInterval(() => this.sweepRetiring(), RETIRE_POLL_MS)
      this.retireTimer.unref?.()
    }
  }

  private keep(s: LlmSession): void {
    if (this.retiring.delete(s)) this.stopRetireTimer()
  }

  private sweepRetiring(): void {
    for (const s of this.retiring) {
      if (s.busy) continue
      this.retiring.delete(s)
      s.stop(new CancelledError())
    }
    this.stopRetireTimer()
  }

  private stopRetireTimer(): void {
    if (this.retiring.size || !this.retireTimer) return
    clearInterval(this.retireTimer)
    this.retireTimer = null
  }

  /**
   * Второго агента выключили: погасить все его сессии сразу, вместе с идущей проверкой.
   * Отмену стоит отличать от сбоя — reason обычно CancelledError.
   */
  stopVerify(reason: Error): void {
    for (const v of this.verifies.values()) {
      this.retiring.delete(v)
      v.stop(reason)
    }
    this.stopRetireTimer()
  }

  /** Установлен ли и выполнен ли вход. Кэш на минуту; force — проверить заново. */
  detect(id: ProviderId, force = false): Promise<Availability> {
    const cached = this.freshDetect(id, force)
    if (cached) return Promise.resolve(cached)
    const running = this.detecting.get(id)
    if (running) return running
    const agent = providerById(id).agent
    const p = guard(
      this.adapter(id)
        .detect()
        .catch((e): Availability => ({ state: 'error', message: errText(e) })),
      DETECT_GUARD_MS,
      (): Availability => ({ state: 'unknown', message: `${agent} не ответил на проверку` }),
    ).then((value) => {
      this.detected.set(id, { at: Date.now(), value })
      this.detecting.delete(id)
      return value
    })
    this.detecting.set(id, p)
    return p
  }

  private freshDetect(id: ProviderId, force: boolean): Availability | undefined {
    const cached = this.detected.get(id)
    return !force && cached && Date.now() - cached.at < DETECT_TTL_MS ? cached.value : undefined
  }

  /**
   * Список моделей. Живой — от самого CLI, кэш на пять минут. Не пришёл или сломался —
   * запасной из каталога: выбор модели не должен пустеть из-за одной неудачной проверки.
   */
  listModels(id: ProviderId, force = false): Promise<ModelInfo[]> {
    const cached = this.listed.get(id)
    if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) return Promise.resolve(cached.value)
    const running = this.listing.get(id)
    if (running) return running
    const fallback = providerById(id).models
    let ok = true
    const p = guard(
      this.adapter(id)
        .listModels()
        .catch(() => {
          ok = false
          return fallback
        }),
      MODELS_GUARD_MS,
      () => {
        ok = false
        return fallback
      },
    ).then((value) => {
      // Неудачу не кэшируем: следующий запрос попробует живой список снова.
      if (ok) this.listed.set(id, { at: Date.now(), value })
      this.listing.delete(id)
      return value
    })
    this.listing.set(id, p)
    return p
  }

  /** Живой список, если уже известен, — для подписей в main без ожидания. */
  cachedModels(id: ProviderId): ModelInfo[] | undefined {
    return this.listed.get(id)?.value
  }

  /** Что известно прямо сейчас, без запусков. */
  status(id: ProviderId): ProviderStatus {
    const st: ProviderStatus = {
      id,
      available: this.detected.get(id)?.value ?? { state: 'unknown' },
      models: this.listed.get(id)?.value ?? providerById(id).models,
      checking: this.detecting.has(id) || this.listing.has(id),
    }
    if (id === 'claude') st.claudeApi = (this.adapter('claude') as ClaudeAdapter).apiAvailability()
    return st
  }

  statuses(): ProviderStatus[] {
    return PROVIDER_IDS.map((id) => this.status(id))
  }

  /**
   * Проверить провайдера и, если он готов, получить живой список моделей.
   * Всё, что нужно запустить, запускается синхронно, до первого await: statuses(),
   * снятый сразу после вызова, уже честно говорит checking.
   */
  refresh(id: ProviderId, force = false): Promise<ProviderStatus> {
    const known = this.freshDetect(id, force)
    const detecting = known ? Promise.resolve(known) : this.detect(id, force)
    const listing = known?.state === 'ok' ? this.listModels(id, force) : null
    return detecting.then(async (available) => {
      if (available.state === 'ok') await (listing ?? this.listModels(id, force))
      return this.status(id)
    })
  }

  /**
   * Проверить всех параллельно. onUpdate зовётся сразу, когда проверки запущены, и после
   * каждого провайдера — со всем списком: окно просто заменяет своё состояние, ничего не сливая.
   */
  async refreshAll(onUpdate: (all: ProviderStatus[]) => void, force = false): Promise<void> {
    const runs = PROVIDER_IDS.map((id) =>
      this.refresh(id, force)
        .catch(() => undefined)
        .then(() => onUpdate(this.statuses())),
    )
    // Первое событие — до итогов: окно узнаёт, кого проверяем, а не догадывается по молчанию.
    onUpdate(this.statuses())
    await Promise.all(runs)
  }

  /** После входа или установки старый итог проверки больше не верен. */
  invalidate(id: ProviderId): void {
    this.detected.delete(id)
    this.listed.delete(id)
  }

  /** Выход из приложения: погасить все сессии, в том числе дописывающие ответ. */
  stopAll(reason: Error): void {
    for (const s of this.mains.values()) s.stop(reason)
    for (const v of this.verifies.values()) v.stop(reason)
    this.retiring.clear()
    this.stopRetireTimer()
  }
}

export const registry = new Registry()

export function getAdapter(id: ProviderId): ProviderAdapter {
  return registry.adapter(id)
}
