import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeModel } from '@shared/models'
import { providerById } from '@shared/providers'
import { ClaudeSuggester } from '../claude'
import { ClaudeCodeSuggester, type EffortLevel } from '../claudeCode'
import { cliEnv, openInTerminal, resolveCommand, runCli } from '../cli'
import {
  LlmError,
  type AskOptions,
  type Availability,
  type LlmSession,
  type ModelInfo,
  type ProviderAdapter,
  type SessionConfig,
  type SessionRole,
  type TurnHandlers,
  type TurnInput,
} from '../types'

/**
 * Claude — обёртка над тем, что уже работает: ClaudeCodeSuggester (живая сессия
 * Claude Code на подписке) и ClaudeSuggester (API по ключу). Сами они не меняются:
 * адаптер только переводит общий контракт в их вызовы, в том же порядке, в каком
 * index.ts звал их раньше, — поведение подсказок Claude остаётся прежним.
 */

const INFO = providerById('claude')

/** «default» и неизвестное — как решит CLI; minimal у Claude нет, ближайшее — low. */
function effortFor(e: SessionConfig['effort']): EffortLevel | undefined {
  if (!e || e === 'default') return undefined
  return e === 'minimal' ? 'low' : e
}

/** Живая сессия Claude Code. Второй агент — такая же, со своим процессом. */
class ClaudeCliSession implements LlmSession {
  private readonly s = new ClaudeCodeSuggester()

  configure(cfg: SessionConfig): void {
    this.s.setModel(normalizeModel(cfg.model))
    this.s.setThinking(cfg.thinking)
    this.s.setEffort(effortFor(cfg.effort))
    // Инструменты трогаем, только если про них сказано: суфлёру их не задавали никогда,
    // второму агенту — веб-поиск по его настройке.
    if (cfg.web !== undefined) this.s.setTools(cfg.web ? ['WebSearch', 'WebFetch'] : undefined)
    this.s.setSystemPrompt(cfg.systemPrompt)
    this.s.setContext(cfg.context)
  }

  warmup(): Promise<void> {
    return this.s.warmup()
  }

  ask(input: TurnInput, h: TurnHandlers, o: AskOptions = {}): Promise<string> {
    return this.s.ask(input.text, (chunk) => h.onDelta(chunk), {
      onThinking: h.onThinking && (() => h.onThinking!()),
      onTool: h.onTool && ((name) => h.onTool!(name)),
      onStart: h.onStart && (() => h.onStart!()),
      isStale: h.isStale && (() => h.isStale!()),
      silenceSec: o.silenceSec,
      silenceMessage: o.silenceMessage,
      // Снимки экрана снимаются JPEG; CLI принимает jpeg и png.
      images: input.images?.map((i) => ({ data: i.data, mediaType: i.mediaType as 'image/jpeg' | 'image/png' })),
    })
  }

  stop(reason?: Error): void {
    this.s.stop(reason)
  }

  get busy(): boolean {
    return this.s.busy
  }
}

/**
 * API по ключу. Модель, размышления и свой промпт он не учитывает — как и раньше:
 * промпт и модель там зашиты в ClaudeSuggester. Очереди нет: запросы независимы.
 * Файлы контекста — учитывает: это данные, а не инструкция, и дописываются к зашитому промпту.
 */
class ClaudeApiSession implements LlmSession {
  private suggester: ClaudeSuggester | null = null
  private running = 0
  private context = ''

  configure(cfg: SessionConfig): void {
    // Из настроек сессии API берёт только материалы пользователя: сессии у него нет, блок уходит в каждый запрос.
    this.context = cfg.context ?? ''
  }

  async warmup(): Promise<void> {
    /* греть нечего: каждый запрос — отдельный вызов API */
  }

  async ask(input: TurnInput, h: TurnHandlers): Promise<string> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new LlmError(
        'not-logged-in',
        'claude',
        input.screen
          ? 'Не задан ANTHROPIC_API_KEY — снимок сделан, но разбирать его нечем. Пропишите ключ или переключитесь на Claude Code в настройках.'
          : 'Не задан ANTHROPIC_API_KEY. Либо пропишите ключ, либо переключитесь на Claude Code в настройках.',
      )
    }
    this.suggester ??= new ClaudeSuggester()
    this.running++
    try {
      if (input.screen) {
        return await this.suggester.describeScreen({
          images: (input.images ?? []).map((i) => ({ data: i.data, mediaType: i.mediaType as 'image/jpeg' | 'image/png' })),
          intro: input.screen.intro,
          question: input.screen.question,
          transcript: input.screen.transcript,
          context: this.context,
          onText: (d) => h.onDelta(d),
        })
      }
      // Найденное в базе уже стоит в начале текста — модели не нужно ходить за ним самой.
      return await this.suggester.suggest({ transcript: input.text, context: this.context, onText: (d) => h.onDelta(d) })
    } finally {
      this.running--
    }
  }

  stop(): void {
    /* обрывать нечего: у API-запроса нет сессии, он допишется и сам */
  }

  get busy(): boolean {
    return this.running > 0
  }
}

export interface ClaudeAdapter extends ProviderAdapter {
  id: 'claude'
  /** Сессия через API по ключу — claudeSource 'api'. createSession даёт Claude Code. */
  createApiSession(): LlmSession
  /** Ключ API задан в окружении. Сам ключ не читаем и никуда не передаём. */
  apiAvailability(): Availability
}

/** Нативный установщик кладёт claude.exe сюда, npm — обёртку в %APPDATA%\npm (она есть в knownDirs). */
const extraDirs = () => [join(homedir(), '.local', 'bin')]

async function detect(): Promise<Availability> {
  const cmd = await resolveCommand(['claude'], extraDirs())
  if (!cmd) return { state: 'not-installed' }
  const env = await cliEnv()
  const ver = await runCli(cmd, ['--version'], { env, timeoutMs: 5000 })
  if (ver.timedOut) return { state: 'unknown', message: 'Claude Code не ответил за 5 с' }
  if (ver.code !== 0) {
    return { state: 'error', message: (ver.stderr || ver.stdout || ver.error?.message || '').trim().slice(-500) || `Claude Code завершился с кодом ${ver.code}` }
  }
  const version = /\d+\.\d+\.\d+/.exec(ver.stdout)?.[0]
  // `claude auth status` отдаёт JSON: {"loggedIn": true, "subscriptionType": "max", ...}.
  // Почту и организацию не берём: в окне достаточно тарифа.
  const auth = await runCli(cmd, ['auth', 'status'], { env, timeoutMs: 5000 })
  try {
    const json = JSON.parse(auth.stdout) as { loggedIn?: unknown; subscriptionType?: unknown }
    if (json.loggedIn === false) return { state: 'not-logged-in' }
    if (json.loggedIn === true) {
      return { state: 'ok', version, account: typeof json.subscriptionType === 'string' ? json.subscriptionType : undefined }
    }
  } catch {
    /* старый CLI без auth status или нечитаемый ответ — про вход ничего не знаем */
  }
  return { state: 'ok', version }
}

export function createClaudeAdapter(): ClaudeAdapter {
  return {
    id: 'claude',
    detect,
    async listModels(): Promise<ModelInfo[]> {
      // Каталог ведём сами: CLI не отдаёт список моделей подписки.
      return INFO.models
    },
    createSession(role: SessionRole): LlmSession {
      void role // второй агент — такая же сессия Claude Code, отличаются только настройки
      return new ClaudeCliSession()
    },
    createApiSession: () => new ClaudeApiSession(),
    apiAvailability: () => (process.env.ANTHROPIC_API_KEY ? { state: 'ok' } : { state: 'not-logged-in' }),
    async openLogin(): Promise<void> {
      await openInTerminal(INFO.login!.command)
    },
  }
}
