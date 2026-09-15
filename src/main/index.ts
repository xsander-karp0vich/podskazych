import { app, BrowserWindow, clipboard, session, desktopCapturer, dialog, ipcMain, screen, shell } from 'electron'
import { createOverlayWindow, applyContentProtection, setClickThrough, canExcludeFromCapture } from './window'
import { registerHotkeys, unregisterHotkeys, type HotkeyBindings } from './hotkeys'
import { SttSidecar } from './stt/sidecar'
import { createTray } from './tray'
import { createClickThrough } from './clickThrough'
import { readBundledKb, type KbMeta } from './kb/bundled'
import { loadIndex, isConfident, hitsToPrompt, type KbIndex, type KbHit } from './kb/search'
import { kbQueryFor } from './kb/query'
import { buildGlossary, type TopicGlossary } from '@shared/glossary'
import { parseTask } from '@shared/answerFormat'
import { isPromptCommand } from '@shared/promptCommands'
import { DEFAULT_MODEL, modelEfforts, modelFor, modelName } from '@shared/models'
import { PROVIDERS, findModel, isProviderId, providerById, type Effort, type ProviderId } from '@shared/providers'
import type { ClaudeSource } from '@shared/settings'
import { SCREEN_DEFAULT_QUESTION, SCREEN_SYSTEM, configureProxy } from './llm/claude'
import { CancelledError, LlmError, isCancelled, isSkipped, type ImageInput, type LlmErrorKind, type LlmSession, type TurnHandlers } from './llm/types'
import { registry, type ProviderStatus } from './llm/registry'
import { sweepTempImages } from './llm/cli'
import { VERIFY_SYSTEM, buildVerifyPrompt, parseVerdict, type VerifyStage, type VerifyUpdate } from './llm/verify'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { captureScreen, imageTokens } from './screenshot'
import { Journal, type JournalRef } from './journal'
import type { OverlayStatus } from '@shared/types'
import { keepLegacyUserData, migrateAutostart } from './appName'

// До любых обращений к userData: переименование не должно сбросить настройки, журнал и кэш базы.
keepLegacyUserData()

let overlay: BrowserWindow | null = null
let tray: Electron.Tray | null = null
let hotkeys: HotkeyBindings = { ask: null, screenshot: null, addShot: null, session: null, toggleClickThrough: null, hide: null }
/**
 * Режим «клики сквозь панель». Хоткей, трей и меню панели меняют его только
 * здесь и узнают итог по подписке. Создан сразу, а не вместе с окном: вызов,
 * пришедший раньше окна, не должен падать — переключать тогда просто нечего.
 */
const clickThrough = createClickThrough((on) => {
  if (overlay && !overlay.isDestroyed()) setClickThrough(overlay, on)
})

const stt = new SttSidecar()
let kbMeta: KbMeta | null = null
/** база ещё грузится: окно настроек тогда ждёт, а не показывает ошибку */
let kbLoading = true
let kbIndex: KbIndex | null = null
let kbGlossary: TopicGlossary | null = null
/*
 * Сессии подсказок живут в registry: по одной у провайдера, который отвечает сейчас.
 * Второй агент проверяет готовую подсказку — своя verify-сессия выбранного для него
 * провайдера, чтобы не стоять в очереди суфлёра (см. verifierFor).
 */
const journal = new Journal()
let proxyUrl: string | null = null

/**
 * Обработчик оставлен для будущего скриншот-режима: сам системный звук через
 * него получить не вышло (getDisplayMedia + audio:'loopback' даёт на Windows
 * NotReadableError), его захватывает Python-сайдкар напрямую через WASAPI.
 */
function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        // thumbnailSize 0x0 — иначе Electron рендерит превью каждого источника
        // и вешает рендерер на сотни мс (electron#8246).
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const primary = sources[0]
          if (!primary) return callback({})
          callback({ video: primary })
        })
        .catch(() => callback({}))
    },
    { useSystemPicker: false },
  )
}

/**
 * Выбор модели — точный идентификатор модели провайдера. У Claude из окна может прийти
 * и старый псевдоним («opus»), и незнакомое значение — к CLI уходит только известная
 * модель (modelFor в @shared/models); у остальных список живой, id уходит как есть.
 */
type ModelChoice = string

/** Кто отвечает. Из окна приходит провайдер и способ обращения к Claude; старые 'claude-code' | 'api' — тоже. */
interface LlmChoice {
  provider?: ProviderId | 'claude-code' | 'api'
  claudeSource?: ClaudeSource
}

interface Choice {
  provider: ProviderId
  claudeSource: ClaudeSource
}

function choiceOf(p: LlmChoice): Choice {
  if (p.provider === 'claude-code') return { provider: 'claude', claudeSource: 'cli' }
  if (p.provider === 'api') return { provider: 'claude', claudeSource: 'api' }
  return { provider: providerById(p.provider).id, claudeSource: p.claudeSource === 'api' ? 'api' : 'cli' }
}

/** API по ключу: модель, размышления и свой промпт он не учитывает, лимита тишины у него нет. */
const isClaudeApi = (c: Choice) => c.provider === 'claude' && c.claudeSource === 'api'

/** Сессия подсказок под настройки из окна. Сессия сама решает, перезапускаться ли. */
function mainSession(
  c: Choice,
  p: { model?: ModelChoice; thinking?: boolean; effort?: EffortChoice; customPrompt?: string },
): LlmSession {
  const s = registry.session(c.provider, 'main', { claudeSource: c.claudeSource })
  s.configure({
    model: modelFor(c.provider, p.model),
    thinking: p.thinking !== false,
    effort: p.effort,
    systemPrompt: p.customPrompt,
  })
  return s
}

/** Вид ошибки — окну: по нему оно предлагает действие («Войти», «Как установить»), а не только текст. */
const kindOf = (e: unknown): LlmErrorKind | undefined => (e instanceof LlmError ? e.kind : undefined)

function currentStatus(): OverlayStatus {
  return {
    capture: 'idle',
    contentProtected: canExcludeFromCapture(),
    hotkey: hotkeys.ask,
    // Комбинации, которые достались на самом деле: основную мог держать другой процесс,
    // и клавиши на кнопках панели иначе показывали бы то, что не работает.
    hotkeys: {
      ask: hotkeys.ask,
      screenshot: hotkeys.screenshot,
      addShot: hotkeys.addShot,
      session: hotkeys.session,
      hide: hotkeys.hide,
      clickThrough: hotkeys.toggleClickThrough,
    },
    clickThrough: clickThrough.on,
  }
}

/**
 * Словарь распознавания из того же снимка, что и поиск. Строится за десятки
 * миллисекунд, поэтому отдельный кэш ему не нужен — пересобираем при каждом
 * обновлении снимка, и правки базы доезжают до распознавания сами.
 */
async function loadGlossary(filePath: string): Promise<TopicGlossary | null> {
  try {
    const rows = (await readFile(filePath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>]
        } catch {
          return [] // одна битая строка не должна ронять словарь
        }
      })
    const g = buildGlossary(rows)
    console.log(`[kb] словарь: ${g.base.length} постоянных, ${Object.keys(g.topics).length} тем`)
    return g
  } catch (e) {
    console.error('[kb] словарь не построился:', e)
    return null
  }
}

/** База для окна настроек. Без рабочего индекса база не загружена, что бы ни говорил паспорт. */
function kbView(): KbMeta | null {
  return kbMeta && kbIndex ? { ...kbMeta, rows: kbIndex.size } : null
}

/**
 * Встроенная база знаний. Грузится в фоне и НЕ блокирует показ окна: если файл
 * повреждён или его нет, приложение обязано работать дальше, просто без базы.
 */
async function loadKnowledgeBase(): Promise<void> {
  const meta = await readBundledKb()
  const t0 = Date.now()
  const index = meta
    ? await loadIndex(meta.filePath).catch((e) => {
        console.warn('[kb] индекс не построился:', e)
        return null
      })
    : null
  // Файл есть, но ни одной записи не прочиталось — база повреждена: считаем, что её нет.
  if (meta && index && index.size > 0) {
    kbMeta = meta
    kbIndex = index
    console.log(`[kb] индекс: ${index.size} документов за ${Date.now() - t0} мс`)
    kbGlossary = await loadGlossary(meta.filePath)
  } else {
    if (meta) console.warn('[kb] база повреждена: ни одной записи', meta.filePath)
    kbMeta = null
    kbIndex = null
    kbGlossary = null
  }
  kbLoading = false
  overlay?.webContents.send('kb:glossary', kbGlossary)
  overlay?.webContents.send('kb:snapshot', kbView())
}

type EffortChoice = 'default' | Effort
const effortFor = (e: EffortChoice | undefined): Effort | undefined =>
  e && e !== 'default' ? e : undefined

interface VerifyConfig {
  enabled: boolean
  /** кто проверяет — любой провайдер, не обязательно тот, что отвечает */
  provider: ProviderId
  /**
   * Принимается ради симметрии с подсказками, но на второго агента не влияет: у Claude он
   * всегда идёт через Claude Code — API по ключу держит свой зашитый промпт и вердикт не напишет.
   */
  claudeSource?: ClaudeSource
  /** точный id модели провайдера */
  model: ModelChoice
  effort: 'low' | 'medium' | 'high'
  /** просьба искать в интернете; исполняется, только если провайдер это умеет (webSearch) */
  web: boolean
}

const VERIFY_EFFORTS = ['low', 'medium', 'high'] as const

/**
 * Настройки второго агента из окна. Окно старой сборки присылает их без провайдера — тогда
 * это Claude: до провайдеров второй агент был только им.
 */
function verifyConfigOf(raw: unknown): VerifyConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const provider = isProviderId(r.provider) ? r.provider : 'claude'
  return {
    enabled: r.enabled === true,
    provider,
    claudeSource: r.claudeSource === 'api' ? 'api' : r.claudeSource === 'cli' ? 'cli' : undefined,
    model: modelFor(provider, r.model),
    effort: VERIFY_EFFORTS.find((e) => e === r.effort) ?? 'high',
    web: r.web === true,
  }
}

/** Веб-поиск второму агенту — только если его попросили и провайдер это умеет. */
const verifyWeb = (v: VerifyConfig): boolean => v.web && providerById(v.provider).webSearch

/**
 * Глубина второго агента. У Claude — как раньше. У остальных — только если у выбранной модели
 * есть уровни и среди них сохранённый: у Gemini глубина задаётся самой моделью (-low/-high),
 * и скрытая «высокая», оставшаяся с Claude, перебивала бы выбранную в окне «самую быструю».
 */
function verifyEffortFor(v: VerifyConfig, model: string): VerifyConfig['effort'] | 'default' {
  if (v.provider === 'claude') return v.effort
  const efforts = modelEfforts(model, v.provider, registry.cachedModels(v.provider))
  return efforts?.includes(v.effort) ? v.effort : 'default'
}

/** Verify-сессия провайдера второго агента. Смена провайдера гасит прежнюю, когда та освободится. */
const verifierFor = (v: VerifyConfig): LlmSession => registry.session(v.provider, 'verify')

/** Проверяющий поднимается под свои настройки; веб-поиск — только если разрешён и доступен. */
function configureVerifier(v: VerifyConfig): LlmSession {
  const s = verifierFor(v)
  // У Claude modelFor приводит модель к известной, как раньше normalizeModel.
  const model = modelFor(v.provider, v.model)
  s.configure({
    model,
    thinking: true,
    effort: verifyEffortFor(v, model),
    web: verifyWeb(v),
    systemPrompt: VERIFY_SYSTEM,
  })
  return s
}

/** Не установлен или без входа — поднимать второго агента незачем: CLI запускался бы ради ошибки. */
function verifierReady(v: VerifyConfig): boolean {
  const state = registry.status(v.provider).available.state
  return state !== 'not-installed' && state !== 'not-logged-in'
}

/**
 * Что нужно, чтобы проверить подсказку позже, по кнопке из окна второго агента:
 * запись в журнале, запрос к базе и найденные записи. Хватает последней сотни.
 */
interface AskedEntry {
  ref: JournalRef | null
  query: string
  hits: KbHit[]
  /** снимки с условием задачи: второй агент сверяет решение с тем, что было на экране */
  images?: ImageInput[]
}
const askLog = new Map<number, AskedEntry>()
/** Снимок серии, снятый и ещё не отправленный. */
type SeriesShot = Awaited<ReturnType<typeof captureScreen>>
/** Больше шести снимков модель в одном вопросе читает хуже, а ждать ответа приходится дольше. */
const SERIES_MAX = 6
const series = new Map<string, SeriesShot>()

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10
  const b = n % 100
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many
}

/** Снимки весят сотни килобайт — держим только последние. */
const IMAGES_KEPT = 5
function rememberAsk(requestId: number, entry: AskedEntry): void {
  askLog.set(requestId, entry)
  if (askLog.size > 100) {
    const oldest = askLog.keys().next().value
    if (oldest !== undefined) askLog.delete(oldest)
  }
  const withImages = [...askLog.values()].filter((e) => e.images)
  for (const e of withImages.slice(0, Math.max(0, withImages.length - IMAGES_KEPT))) delete e.images
}

/**
 * Настройки второго агента, какие выставлены сейчас: окно присылает их при каждой
 * смене. По ним и решается, проверять ли готовый ответ. Снимок на момент вопроса
 * устаревал, пока ответ печатался: выключенный режим всё равно запускал проверку,
 * а выбранная в заголовке модель откатывалась на прежнюю.
 */
let verifyCfg: VerifyConfig = { enabled: false, provider: 'claude', model: DEFAULT_MODEL, effort: 'high', web: false }

/** Номер последней автоматической проверки: те, что старше и ещё ждут очереди, уже не нужны. */
let autoSeq = 0

interface VerifyJob {
  requestId: number
  /** подсказка в журнале: проверка пишется к ней, даже если созвон уже остановлен */
  ref: JournalRef | null
  question: string
  answer: string
  hits: KbHit[]
  cfg: VerifyConfig
  topK: number
  /** только у автоматических: устарела, если за это время прозвучал следующий вопрос */
  isStale?: () => boolean
  /** снимок с условием: у решений задач со скриншота */
  images?: ImageInput[]
}

/**
 * Проверка готовой подсказки. Результат уходит в окно отдельным событием и
 * ложится в журнал. Сбой проверки не должен задевать саму подсказку: она уже
 * на экране, проверка — надстройка над ней.
 */
async function runVerification({ requestId, ref, question, answer, hits, cfg, topK, isStale, images }: VerifyJob): Promise<void> {
  const t0 = Date.now()
  // Базу проверяющему даём, даже если суфлёру её не подавали: поиск стоит доли миллисекунды.
  const refs = hits.length ? hits : kbIndex ? kbIndex.search(question, topK) : []
  const kbUids = refs.map((h) => h.uid)
  // Окно второго агента показывает ход проверки, а не только итог: что он делает и что уже написал.
  const send = (u: Omit<VerifyUpdate, 'requestId' | 'startedAt' | 'refs'>) =>
    overlay?.webContents.send('llm:verify', {
      requestId,
      startedAt: t0,
      refs: refs.map((h) => h.question),
      ...u,
    } satisfies VerifyUpdate)
  const model = modelFor(cfg.provider, cfg.model)
  const live = registry.cachedModels(cfg.provider)
  // В журнал — кто и какой моделью проверял: у второго агента теперь свой провайдер.
  const who = { provider: cfg.provider, model: modelName(model, cfg.provider, live) }
  let stage: VerifyStage = verifierFor(cfg).busy ? 'queued' : 'working'
  let text = ''
  const progress = (next: VerifyStage) => {
    if (next === stage && next !== 'writing') return
    stage = next
    send({ status: 'checking', notes: [], stage, text })
  }
  send({ status: 'checking', notes: [], stage })
  const web = verifyWeb(cfg)
  // С веб-поиском первое слово появлялось через 13,5 с (замер 11 сентября), а сам поиск идёт без дельт.
  const limitSec = web ? 90 : 45
  // Модель, которая точно не берёт снимки (Gemini), получает решение без них: сверить код с
  // условием она не сможет, но синтаксис и отбор проверит — это лучше ошибки вместо проверки.
  const shots = images?.length && findModel(cfg.provider, model, live)?.images !== false ? images : undefined
  try {
    const session = configureVerifier(cfg)
    const handlers: TurnHandlers = {
      onDelta: (chunk) => {
        text += chunk
        progress('writing')
      },
      // Проверку по кнопке пользователь запросил сам — устаревают только автоматические.
      isStale,
      onStart: () => progress('working'),
      onThinking: () => progress('thinking'),
      // Имена инструментов у провайдеров разные: WebSearch/WebFetch у Claude, web_search у Codex,
      // «Web search»/fetch у ACP-агентов. Без доступа в интернет стадия остаётся «работаю»:
      // локальный grep_search или отклонённый веб-инструмент у Gemini — не «ищу в интернете».
      onTool: (name) => {
        if (web && /web|search|fetch/i.test(name)) progress('searching')
      },
    }
    const limits = { silenceSec: limitSec, silenceMessage: `проверка молчала дольше ${limitSec} с` }
    let raw: string
    try {
      raw = await session.ask({ text: buildVerifyPrompt(question, answer, refs, shots?.length ?? 0), images: shots }, handlers, limits)
    } catch (e) {
      // Каталог не всегда знает, берёт ли модель снимки (у Cursor это видно только после
      // рукопожатия). Отказ от картинок — не повод оставить решение без проверки:
      // один раз повторяем без снимков, как для моделей, которые их точно не берут.
      if (!(shots && e instanceof LlmError && e.kind === 'images-unsupported')) throw e
      text = ''
      progress('working')
      raw = await session.ask({ text: buildVerifyPrompt(question, answer, refs, 0) }, handlers, limits)
    }
    const v = parseVerdict(raw)
    const tookMs = Date.now() - t0
    console.log(`[verify] ${requestId}: ${v.status} за ${(tookMs / 1000).toFixed(1)} с`)
    send({ status: v.status, notes: v.notes, tookMs, text: raw })
    if (ref) journal.verify(ref, { question, status: v.status, notes: v.notes, tookMs, kb: kbUids, ...who })
  } catch (e) {
    if (isSkipped(e)) {
      console.log(`[verify] ${requestId}: пропущена — уже задан следующий вопрос`)
      send({ status: 'skipped', notes: [] })
      return
    }
    // Второго агента выключили посреди проверки — это не сбой, и в журнал его не пишем.
    if (isCancelled(e)) {
      console.log(`[verify] ${requestId}: остановлена`)
      send({ status: 'cancelled', notes: [] })
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    const tookMs = Date.now() - t0
    console.warn('[verify] ошибка:', msg)
    send({ status: 'error', notes: [], tookMs, error: msg })
    if (ref) journal.verify(ref, { question, status: 'error', notes: [], tookMs, kb: kbUids, error: msg, ...who })
  }
}

app.whenReady().then(() => {
  proxyUrl = configureProxy()
  installDisplayMediaHandler()
  // Снимки, записанные для CLI провайдеров и оставшиеся после падения, — убрать.
  void sweepTempImages()

  overlay = createOverlayWindow()

  // После окна, а не до: пользователь видит панель сразу, снимок догоняет.
  void loadKnowledgeBase()

  // Панель узнаёт о смене режима отсюда, кто бы его ни переключил: хоткей, трей или её собственное меню.
  clickThrough.subscribe((on) => {
    if (overlay && !overlay.isDestroyed() && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send('clickthrough:changed', on)
    }
  })

  hotkeys = registerHotkeys({
    onAsk: () => overlay?.webContents.send('hotkey:ask'),
    onScreenshot: () => overlay?.webContents.send('hotkey:screenshot'),
    onAddShot: () => overlay?.webContents.send('hotkey:add-shot'),
    onSession: () => overlay?.webContents.send('hotkey:session'),
    onToggleClickThrough: () => {
      // Исключение из обработчика глобальной клавиши уронило бы main с диалогом ошибки.
      try {
        clickThrough.toggle()
      } catch (e) {
        console.error('[clickthrough] окно не переключилось:', e)
      }
    },
    onHide: () => {
      if (!overlay) return
      if (overlay.isVisible()) overlay.hide()
      else overlay.show()
    },
  })

  // Трей — запасной выход из режима сквозь панель: пока он включён, по самой панели не кликнуть.
  migrateAutostart()
  tray = createTray(overlay, { clickThrough, clickThroughCombo: hotkeys.toggleClickThrough })

  /**
   * Показ окна нельзя вешать только на ready-to-show. У скрытого прозрачного
   * окна Chromium может не отрисовать первый кадр, пока окно не показано, —
   * событие тогда не приходит вовсе, и панель не появляется. Ровно это и
   * случилось на упакованной сборке: рендерер загружался полностью, а окна
   * не было. Показываем по первому пришедшему сигналу, а если не пришёл ни
   * один — по таймеру: невидимая панель хуже некрасивой.
   */
  let shown = false
  const showOverlay = () => {
    if (shown || !overlay) return
    shown = true
    overlay.show()
    overlay.webContents.send('status', currentStatus())

    // Автостарт для отладки: userGesture=true снимает требование настоящего
    // клика мышью, без которого браузерные API захвата отказываются работать.
    if (process.env.COPILOT_AUTOSTART === '1') {
      let tries = 0
      const tick = setInterval(() => {
        tries++
        overlay?.webContents
          .executeJavaScript(
            'typeof window.__copilotStart === "function" ? (window.__copilotStart(), true) : false',
            true,
          )
          .then((ok: boolean) => {
            console.log(`[autostart] попытка ${tries}: ${ok ? 'запущено' : 'крючок ещё не готов'}`)
            if (ok || tries >= 10) clearInterval(tick)
          })
          .catch((e) => {
            console.error('[autostart] ошибка:', e)
            clearInterval(tick)
          })
      }, 800)
    }

    // Снимок окна для отладки вида. capturePage рендерит содержимое напрямую,
    // поэтому обходит исключение из захвата экрана — обычным скриншотом
    // панель снять нельзя, а так можно.
    const shot = process.env.COPILOT_SHOT
    if (shot) {
      const delay = Number(process.env.COPILOT_SHOT_DELAY ?? 3000)
      setTimeout(async () => {
        try {
          // Можно подготовить состояние перед снимком: открыть меню, настройки
          // и так далее — иначе проверить их вид нечем, скриншот их не берёт.
          if (process.env.COPILOT_SHOT_JS) {
            await overlay!.webContents.executeJavaScript(process.env.COPILOT_SHOT_JS, true)
            await new Promise((r) => setTimeout(r, 400))
          }
          const img = await overlay!.webContents.capturePage()
          await writeFile(shot, img.toPNG())
          console.log(`[shot] сохранён: ${shot}`)
        } catch (e) {
          console.error('[shot] не вышло:', e)
        }
      }, delay)
    }
  }

  // Отладка выгрузки: главный процесс — единственное место, где живёт журнал,
  // и проверить текст выгрузки иначе нечем — диалог сохранения не автоматизируешь.
  const dump = process.env.COPILOT_JOURNAL_DUMP
  if (dump) {
    const last = journal.list()[0]
    void writeFile(dump, last ? journal.toMarkdown(last.id) : 'записей нет', 'utf8')
      .then(() => console.log(`[journal] выгружено: ${dump}`))
      .catch((e) => console.error('[journal] не выгрузилось:', e))
  }

  overlay.once('ready-to-show', showOverlay)
  overlay.webContents.once('did-finish-load', showOverlay)
  // Последняя линия обороны: даже если оба сигнала потерялись, окно появится.
  setTimeout(showOverlay, 4000)

  /* ---------- окно ---------- */

  ipcMain.handle('status:get', () => currentStatus())

  /** Встроенная база знаний: сколько записей и какой версии — для окна настроек. */
  ipcMain.handle('kb:snapshot:get', () => (kbLoading ? undefined : kbView()))

  ipcMain.handle('kb:glossary:get', () => kbGlossary)

  /**
   * Поиск по снимку. Вызывается на каждой завершённой реплике собеседника,
   * поэтому обязан быть дешёвым: индекс в памяти, ответ за доли миллисекунды.
   */
  ipcMain.handle('kb:search', (_e, p: { query: string; top?: number }) => {
    if (!kbIndex) return { hits: [] as KbHit[], confident: false }
    const hits = kbIndex.search(p.query, p.top ?? 3)
    return { hits, confident: isConfident(hits) }
  })

  // Панель просит режим и ждёт 'clickthrough:changed': сама его не выставляет, иначе при
  // сбое окна показывала бы режим, которого нет.
  ipcMain.handle('window:setClickThrough', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    clickThrough.set(on)
  })

  ipcMain.handle('window:getClickThrough', () => clickThrough.on)

  // Старый вход в тот же режим, с обратным знаком. Через общий переключатель — чтобы трей и панель узнали о смене.
  ipcMain.handle('window:setInteractive', (_e, interactive: boolean) => {
    clickThrough.set(!interactive)
  })

  ipcMain.handle('window:setOpacity', (_e, value: number) => {
    overlay?.setOpacity(Math.max(0.35, Math.min(1, value)))
  })

  ipcMain.handle('window:setContentProtection', (_e, on: boolean) => {
    if (!overlay) return
    overlay.setContentProtection(on && canExcludeFromCapture())
  })

  ipcMain.handle('app:quit', () => app.quit())

  // Код из ответа. Буфер обмена — из main: окну для него нужен фокус, а панель поверх созвона его часто не держит.
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(String(text))
  })

  /* ---------- размер и масштаб ---------- */

  // У окна нет рамки, поэтому тянуть его за край нечем: размер меняем
  // сами по дельте от точки, где пользователь схватил уголок.
  let resizeStart: Electron.Rectangle | null = null

  ipcMain.handle('window:beginResize', () => {
    resizeStart = overlay?.getBounds() ?? null
  })

  ipcMain.handle('window:resizeBy', (_e, dx: number, dy: number) => {
    if (!overlay || !resizeStart) return
    overlay.setBounds({
      x: resizeStart.x,
      y: resizeStart.y,
      width: Math.max(560, Math.round(resizeStart.width + dx)),
      height: Math.max(220, Math.round(resizeStart.height + dy)),
    })
  })

  ipcMain.handle('window:endResize', () => {
    resizeStart = null
  })

  ipcMain.handle('window:setZoom', (_e, factor: number) => {
    const z = Math.max(0.6, Math.min(2, factor))
    overlay?.webContents.setZoomFactor(z)
    return z
  })

  /* ---------- распознавание ---------- */

  // Сайдкар поднимается лениво: загрузка весов идёт секунды, поэтому
  // дёргаем его по кнопке «Старт», а не при запуске приложения.
  ipcMain.handle('stt:start', async (_e, opts: { language?: string; glossary?: string }) => {
    try {
      const info = await stt.start(opts)
      // Запись созвона живёт ровно столько же, сколько сессия распознавания.
      journal.open()
      return { ok: true as const, info }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('stt:stop', () => {
    stt.stop()
    journal.close()
  })

  // Сайдкар упал посреди созвона. Без этого окно переподключалось бы к мёртвому
  // порту до «Стоп», не объясняя, куда пропала расшифровка. Журнал закроет «Стоп»
  // из окна, как при обычной остановке.
  stt.onExit = (error) => overlay?.webContents.send('stt:exit', { error })

  /* ---------- журнал созвонов ---------- */

  // Расшифровка приходит в окно напрямую от сайдкара, поэтому финальные
  // реплики в журнал пересылает рендерер — здесь их взять неоткуда.
  ipcMain.on('journal:line', (_e, p: { speaker: 'me' | 'them'; text: string }) => {
    journal.line(p.speaker, p.text)
  })

  ipcMain.handle('journal:list', () => journal.list())

  ipcMain.handle('journal:setEnabled', (_e, on: boolean) => {
    journal.enabled = on
    if (!on) journal.close()
  })

  ipcMain.handle('journal:delete', (_e, id: string) => {
    journal.remove(id)
    return journal.list()
  })

  ipcMain.handle('journal:openFolder', () => shell.openPath(journal.dir))

  /** Путь к папке с записями — подпись под кнопкой «Открыть папку». */
  ipcMain.handle('journal:dir', () => journal.dir)

  ipcMain.handle('journal:export', async (_e, p: { id: string; format: 'md' | 'json' }) => {
    try {
      const isMd = p.format === 'md'
      const data = isMd ? journal.toMarkdown(p.id) : JSON.stringify(journal.read(p.id), null, 2)
      // Перегрузка с родительским окном не принимает явный undefined,
      // поэтому выбираем её только когда окно действительно есть.
      const opts = {
        title: 'Сохранить запись созвона',
        defaultPath: `созвон-${p.id}.${isMd ? 'md' : 'json'}`,
        filters: isMd
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
      }
      const res = overlay
        ? await dialog.showSaveDialog(overlay, opts)
        : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const }
      await writeFile(res.filePath, data, 'utf8')
      return { ok: true as const, path: res.filePath }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /* ---------- подсказка ---------- */

  ipcMain.handle(
    'llm:suggest',
    async (
      _e,
      p: LlmChoice & {
        transcript: string
        question: string
        useKnowledgeBase: boolean
        requestId: number
        customPrompt?: string
        model?: ModelChoice
        thinking?: boolean
        /** сколько записей из базы подавать модели */
        kbTopK?: number
        /** глубина размышлений в режиме «думает» */
        effort?: EffortChoice
        /** сколько ждать ответа, секунд */
        timeoutSec?: number
      },
    ) => {
      const c = choiceOf(p)
      const info = providerById(c.provider)
      console.log(`[llm] запрос ${p.requestId}, провайдер=${c.provider}${c.provider === 'claude' ? `/${c.claudeSource}` : ''}`)
      // Контекст из базы кладём в промпт готовым. Дать модели инструмент и
      // ждать, пока она сама сходит за ним, — это лишний round-trip поверх
      // и без того секундного ответа.
      // Искать по последней содержательной реплике, а не по всему транскрипту:
      // по сорока строкам поиск находил ответы на предыдущие вопросы (см. kb/query.ts).
      // Команда из своего промпта («/разбор») — не вопрос по теме: искать по ней в базе
      // нечего, а найденное по слову «разбор» только сбило бы модель.
      const command = isPromptCommand(p.question)
      const kbHits = p.useKnowledgeBase && kbIndex && !command
        ? kbIndex.search(kbQueryFor(p.question, p.transcript), p.kbTopK ?? 3)
        : []
      const kbBlock = hitsToPrompt(kbHits)

      const body = p.transcript
        ? `Расшифровка разговора:
${p.transcript}

${p.question ? `Вопрос: ${p.question}` : 'Подскажи ответ на последний вопрос собеседника.'}`
        : // Сообщение, которое начинается со слеша, Claude Code считает своей командой: «/review»
          // запустил бы его ревью, «/debrief» вернул бы «Unknown command». Команда промпта — модели.
          command
          ? `Вопрос: ${p.question}`
          : p.question
      const prompt = kbBlock ? `${kbBlock}

---

${body}` : body

      const askedAt = Date.now()
      const api = isClaudeApi(c)
      const model = modelFor(c.provider, p.model)
      // Подсказку кладём в журнал одинаково для всех источников и для ошибок:
      // запись созвона без неудавшихся вопросов врала бы о том, как всё шло.
      // Глубина — только у моделей, где она настраивается: у Haiku, Cursor и Gemini её нет.
      const record = (answer: string, error?: string) =>
        journal.ask({
          question: p.question,
          answer,
          provider: c.provider,
          model: api ? 'API' : modelName(model, c.provider, registry.cachedModels(c.provider)),
          thinking: api ? undefined : p.thinking !== false,
          effort:
            !api && modelEfforts(model, c.provider, registry.cachedModels(c.provider)) !== null
              ? p.thinking === false ? 'low' : (effortFor(p.effort) ?? 'default')
              : undefined,
          kb: kbHits.map((h) => h.uid),
          tookMs: Date.now() - askedAt,
          error,
        })

      // Дельты уходят в окно по мере генерации: пользователь начинает читать
      // первый тезис, пока дописываются остальные.
      const onDelta = (chunk: string) =>
        overlay?.webContents.send('llm:delta', { requestId: p.requestId, chunk })

      // Размышления идут молча, иногда десятки секунд. Окно должно сказать,
      // что пауза осмысленная, иначе она читается как зависание.
      let saidThinking = false
      const onThinking = () => {
        if (saidThinking) return
        saidThinking = true
        overlay?.webContents.send('llm:thinking', { requestId: p.requestId })
      }

      try {
        // Без ключа API и спрашивать некого. Проверяем до сессии: это настройка, а не сбой созвона.
        if (api && !process.env.ANTHROPIC_API_KEY) {
          return {
            ok: false as const,
            error: 'Не задан ANTHROPIC_API_KEY. Либо пропишите ключ, либо переключитесь на Claude Code в настройках.',
            kind: 'not-logged-in' as const,
          }
        }
        const session = mainSession(c, p)
        // Таймаут обязателен: без него зависший CLI оставляет интерфейс
        // крутиться вечно, и пользователь не понимает, что произошло.
        // Считается по тишине: живой длинный ответ он не обрывает.
        // У API своей сессии нет — там запрос обрывает сам SDK.
        const t0 = Date.now()
        const timeoutSec = Math.max(10, p.timeoutSec ?? 45)
        const text = await session.ask(
          { text: prompt },
          { onDelta, onThinking },
          api
            ? {}
            : {
                silenceSec: timeoutSec,
                silenceMessage: `${info.agent} молчит дольше ${timeoutSec} с, сессия перезапущена. Если повторится — переключитесь на другой источник в настройках.`,
              },
        )
        console.log(`[llm] ОТВЕТ получен за ${((Date.now() - t0) / 1000).toFixed(1)} с, ${text.length} символов`)
        const ref = record(text)
        const query = kbQueryFor(p.question, p.transcript)
        rememberAsk(p.requestId, { ref, query, hits: kbHits })
        // Режим и настройки второго агента — какие выставлены сейчас, а не в момент вопроса.
        // Ответ на команду («разбери мои ответы») — не утверждения для сверки: второй агент его не проверяет.
        // Кто отвечал, не важно: второй агент живёт своей сессией у своего провайдера.
        // Не установлен или без входа — не запускаем: иначе каждая подсказка поднимала бы CLI ради ошибки.
        // Проверка по кнопке («Проверить») идёт и без этого — после входа она сработает.
        if (verifyCfg.enabled && verifierReady(verifyCfg) && text.trim() && !command) {
          const seq = ++autoSeq
          // Не ждём: подсказка уже на экране, второй агент догонит её в своём окне.
          void runVerification({
            requestId: p.requestId,
            ref,
            question: query,
            answer: text,
            hits: kbHits,
            cfg: verifyCfg,
            topK: p.kbTopK ?? 3,
            isStale: () => seq !== autoSeq,
          })
        }
        return { ok: true as const, text }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Сессию остановили намеренно — например, при выходе. Это не сбой созвона:
        // запись после закрытия журнала открыла бы в нём новую пустую запись.
        if (isCancelled(e)) return { ok: false as const, error: msg, kind: 'cancelled' as const }
        console.error('[llm] ОШИБКА:', msg)
        record('', msg)
        return { ok: false as const, error: msg, kind: kindOf(e) }
      }
    },
  )

  // Окно присылает настройки второго агента при каждой смене — и вне сессии тоже.
  ipcMain.handle('llm:verify-config', (_e, raw: unknown) => {
    const cfg = verifyConfigOf(raw)
    verifyCfg = cfg
    if (cfg.enabled) configureVerifier(cfg)
    // Второго агента выключили: идущую проверку останавливаем как отмену, а не как сбой.
    else registry.stopVerify(new CancelledError())
    return { ok: true as const }
  })

  // Проверка по кнопке из окна второго агента: подсказку ещё не проверяли
  // (режим включили позже) или хочется ещё раз — например, уже с веб-поиском.
  ipcMain.handle(
    'llm:verify-now',
    (_e, p: { requestId: number; question: string; answer: string; verify: unknown; kbTopK?: number }) => {
      const asked = askLog.get(p.requestId)
      void runVerification({
        requestId: p.requestId,
        ref: asked?.ref ?? null,
        question: asked?.query ?? p.question,
        answer: p.answer,
        hits: asked?.hits ?? [],
        cfg: verifyConfigOf(p.verify),
        topK: p.kbTopK ?? 3,
        images: asked?.images,
      })
      return { ok: true as const }
    },
  )

  // Прогрев сессии: стартовые ~10 секунд надо заплатить до созвона, а не во
  // время него.
  ipcMain.handle(
    'llm:warmup',
    async (
      _e,
      p: LlmChoice & {
        customPrompt?: string
        model?: ModelChoice
        thinking?: boolean
        effort?: EffortChoice
        /** основную сессию не греть (Claude по ключу, провайдер без входа), но второго агента — да */
        skipMain?: boolean
      },
    ) => {
      try {
        const c = choiceOf(p ?? {})
        // Сессия основного не создаётся вовсе: иначе смена провайдера гасила бы прежнюю ради ошибки.
        const session = p?.skipMain ? null : mainSession(c, p ?? {})
        // Проверяющего греем параллельно: его старт тоже лучше оплатить до созвона.
        // Его настройки приходят только через 'llm:verify-config': прогрев бывает из
        // устаревшего замыкания — старт сессии секундами ждёт распознавание — и затёр бы свежие.
        let warmVerifier: Promise<void> = Promise.resolve()
        if (verifyCfg.enabled && verifierReady(verifyCfg)) warmVerifier = configureVerifier(verifyCfg).warmup()
        await Promise.all([session?.warmup(), warmVerifier])
        return { ok: true as const }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e), kind: kindOf(e) }
      }
    },
  )

  /* ---------- провайдеры ---------- */

  const sendProviders = (all: ProviderStatus[]) => {
    if (overlay && !overlay.isDestroyed() && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send('llm:providers-updated', all)
    }
  }

  /**
   * Кто может отвечать. Отдаём сразу то, что известно, — окно не ждёт запуска всех CLI.
   * Свежие итоги проверок приходят событием 'llm:providers-updated': одно сразу после запуска
   * проверок (с checking), дальше — по одному на провайдера.
   */
  ipcMain.handle('llm:providers', () => {
    void registry.refreshAll(sendProviders).catch((e) => console.warn('[llm] проверка провайдеров:', e))
    // После запуска проверок, а не до: ответ уже говорит, кого сейчас проверяем.
    return registry.statuses()
  })

  /** Модели провайдера: живой список, если CLI его отдаёт, иначе запасной из каталога. */
  ipcMain.handle('llm:models', (_e, provider: unknown) => registry.listModels(providerById(provider).id))

  /**
   * Вход — в окне терминала, командой самого CLI: пароли и токены через приложение не идут.
   * Итог входа отсюда не узнать — окно потом зовёт 'llm:recheck'.
   */
  ipcMain.handle('llm:login', async (_e, provider: unknown) => {
    const id = providerById(provider).id
    try {
      await registry.adapter(id).openLogin()
      registry.invalidate(id)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** Проверить провайдера заново — после входа или установки. */
  ipcMain.handle('llm:recheck', async (_e, provider: unknown) => {
    const running = registry.refresh(providerById(provider).id, true)
    // Окна, открытые рядом (выбор модели и настройки), узнают, что проверка идёт, сразу.
    sendProviders(registry.statuses())
    const status = await running
    sendProviders(registry.statuses())
    return status
  })

  /**
   * Страница установки провайдера — в браузере. Открываем только адреса из каталога: окно
   * не должно уметь открыть что угодно, даже если в него попадёт чужая ссылка.
   */
  const externalUrls = new Set(PROVIDERS.map((p) => p.install.url))
  ipcMain.handle('app:openExternal', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !externalUrls.has(url)) {
      return { ok: false as const, error: 'Эту ссылку приложение не открывает' }
    }
    try {
      await shell.openExternal(url)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /* ---------- скриншот ---------- */

  /**
   * Серия снимков: задача не влезла в один экран. Каждый снимок снимается сразу,
   * по Ctrl ⇧ +, и ждёт отправки здесь — в окно уходит только миниатюра. Отправляется
   * серия одним вопросом через screen:ask.
   */
  ipcMain.handle('screen:series-add', async (_e, p: { displayId?: string }) => {
    if (series.size >= SERIES_MAX) {
      return { ok: false as const, error: 'В серии не больше шести снимков — отправьте эти, следующие снимите отдельно' }
    }
    try {
      const shot = await captureScreen(overlay, p.displayId)
      const id = randomUUID()
      series.set(id, shot)
      const displays = screen.getAllDisplays()
      const idx = p.displayId ? displays.findIndex((d) => String(d.id) === p.displayId) : -1
      const label = `Экран ${(idx >= 0 ? idx : displays.findIndex((d) => d.id === screen.getPrimaryDisplay().id)) + 1}`
      return { ok: true as const, id, preview: shot.preview, screen: label, count: series.size }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('screen:series-remove', (_e, id: string) => {
    series.delete(id)
    return series.size
  })
  ipcMain.handle('screen:series-clear', () => {
    series.clear()
  })

  ipcMain.handle('screen:list', () =>
    screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: `${d.label || `Экран ${i + 1}`} · ${d.size.width}×${d.size.height}`,
      primary: d.id === screen.getPrimaryDisplay().id,
    })),
  )

  ipcMain.handle(
    'screen:ask',
    async (
      _e,
      p: {
        question: string
        transcript: string
        displayId?: string
        /** снимки серии по порядку; пусто — снять экран сейчас */
        seriesIds?: string[]
        /** источник и настройки — те же, что у текстовых подсказок */
        provider: LlmChoice['provider']
        claudeSource?: ClaudeSource
        requestId: number
        customPrompt?: string
        model?: ModelChoice
        thinking?: boolean
        effort?: EffortChoice
        timeoutSec?: number
      },
    ) => {
      let previews: string[] = []
      /**
       * Решение задачи со снимка проверяется вторым агентом, как обычная подсказка:
       * снимки уходят ему вместе с ответом — без условия код не с чем сверять.
       * Обычный разбор экрана он не проверяет: там нечего сверять, кроме самой картинки.
       */
      const rememberTask = (text: string, images: ImageInput[]) => {
        const task = parseTask(text)
        if (!task) return
        const query = task.restate || p.question || 'Задача на снимке экрана'
        rememberAsk(p.requestId, { ref: null, query, hits: [], images })
        // Проверять решение без кода нечего — снимки всё равно запомнили для проверки по кнопке.
        if (!verifyCfg.enabled || !verifierReady(verifyCfg) || !task.chunks.length) return
        const seq = ++autoSeq
        void runVerification({
          requestId: p.requestId,
          ref: null,
          question: query,
          answer: text,
          hits: [],
          cfg: verifyCfg,
          topK: 3,
          isStale: () => seq !== autoSeq,
          images,
        })
      }
      try {
        // Серия уже снята: берём её в порядке съёмки и забираем из хранилища. Иначе снимаем экран сейчас.
        const ids = p.seriesIds ?? []
        const shots = ids.length ? ids.map((id) => series.get(id)).filter((s): s is SeriesShot => !!s) : [await captureScreen(overlay, p.displayId)]
        for (const id of ids) series.delete(id)
        if (!shots.length) return { ok: false as const, error: 'Снимки серии потерялись — снимите их заново' }
        previews = shots.map((s) => s.preview)
        const images: ImageInput[] = shots.map((s) => ({ data: s.data, mediaType: s.mediaType }))
        const n = shots.length
        const sizes = shots.map((s) => `${s.width}×${s.height}`).join(', ')
        const question = p.question || SCREEN_DEFAULT_QUESTION
        const onDelta = (chunk: string) =>
          overlay?.webContents.send('llm:delta', { requestId: p.requestId, chunk })
        const intro =
          n > 1
            ? `Сейчас не расшифровка, а ${n} ${plural(n, 'снимок', 'снимка', 'снимков')} экрана подряд — они выше, в порядке съёмки. ` +
              'Это одна задача или один документ, который не поместился на экран: читай их как склеенные сверху вниз, ' +
              'то, что повторяется на стыках, не дублируй.'
            : 'Сейчас не расшифровка, а снимок экрана — он выше.'

        const c = choiceOf(p)
        const api = isClaudeApi(c)
        if (api && !process.env.ANTHROPIC_API_KEY) {
          return {
            ok: false as const,
            error: 'Не задан ANTHROPIC_API_KEY — снимок сделан, но разбирать его нечем. Пропишите ключ или переключитесь на Claude Code в настройках.',
            previews,
            kind: 'not-logged-in' as const,
          }
        }

        // Через подписку: снимки уходят картинками в ту же живую сессию, что и подсказки.
        // Правила разбора — в самом сообщении: системный промпт сессии уже задан под расшифровку.
        // API по ключу берёт правила отдельной системной ролью — ему уходят части вопроса (screen).
        const session = mainSession(c, p)
        const agent = providerById(c.provider).agent
        let saidThinking = false
        // Снимок дольше текста: загрузка картинки и префилл визуальных токенов. Лимит тишины — не меньше
        // 30 с и ещё по 10 с на каждый снимок серии сверх первого.
        const timeoutSec = Math.max(30, p.timeoutSec ?? 45) + (n - 1) * 10
        const t0 = Date.now()
        const text = await session.ask(
          {
            text:
              `${intro} Правила для этого ответа:\n${SCREEN_SYSTEM}\n\n` +
              (p.transcript ? `Последние реплики разговора:\n${p.transcript}\n\n` : '') +
              question,
            images,
            screen: { intro: n > 1 ? intro : '', question: p.question, transcript: p.transcript },
          },
          {
            onDelta,
            onThinking: () => {
              // Окну хватит одной отметки: без неё каждый шаг размышления уходил бы отдельным сообщением.
              if (saidThinking) return
              saidThinking = true
              overlay?.webContents.send('llm:thinking', { requestId: p.requestId })
            },
          },
          api
            ? {}
            : {
                silenceSec: timeoutSec,
                silenceMessage: `${agent} молчит дольше ${timeoutSec} с, сессия перезапущена. Попробуйте снимок ещё раз.`,
              },
        )
        if (api) {
          const tokens = shots.reduce((sum, s) => sum + imageTokens(s.width, s.height), 0)
          console.log(`[screen] ${sizes}, ~${tokens} визуальных токенов`)
        } else {
          console.log(`[screen] ${sizes} через ${agent} за ${((Date.now() - t0) / 1000).toFixed(1)} с`)
        }
        // Решение со снимка второй агент проверяет автоматически, кто бы ни отвечал.
        rememberTask(text, images)
        return { ok: true as const, text, previews }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e), previews, kind: kindOf(e) }
      }
    },
  )

  console.log(`[copilot] прокси: ${proxyUrl ?? 'не задан'}`)
})

// Оверлей прячется в трей, а не закрывается: закрытие окна не должно
// означать выход из приложения.
app.on('window-all-closed', () => {
  /* держим процесс живым — выход через трей или меню */
})

app.on('will-quit', () => {
  unregisterHotkeys()
  journal.close()
  stt.stop()
  // Выход — отмена, а не сбой: иначе оборванная подсказка открыла бы новую запись в уже закрытом журнале.
  registry.stopAll(new CancelledError())
  tray?.destroy()
})

app.on('browser-window-created', (_e, win) => applyContentProtection(win))
