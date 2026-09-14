import type { ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { providerById, type ProviderId } from '@shared/providers'
import {
  cliEnv,
  openInTerminal,
  providerWorkDir,
  readLines,
  resolveCommand,
  runCli,
  spawnCli,
  stderrTail,
  treeKill,
  type CliResult,
  type ResolvedCommand,
} from '../cli'
import { JsonRpcConnection } from '../jsonrpc'
import { suggestSystemPrompt } from '../prompts'
import { TurnQueue } from '../queue'
import {
  CancelledError,
  LlmError,
  llmErrorText,
  type AskOptions,
  type Availability,
  type ImageInput,
  type LlmSession,
  type ModelInfo,
  type ProviderAdapter,
  type SessionConfig,
  type SessionRole,
  type TurnHandlers,
  type TurnInput,
} from '../types'
import {
  AcpTurn,
  answerAgentRequest,
  applyConfigOptions,
  buildPrompt,
  exitError,
  initializeParams,
  matchModel,
  modelsFromSelector,
  newSessionWithAuth,
  parseInitialize,
  parseNewSession,
  pickAuthMethod,
  pickReadOnlyMode,
  readUpdate,
  selectRequest,
  stopOutcome,
  toLlmError,
  type AcpInit,
  type AcpSessionInfo,
} from './acpProtocol'

/**
 * Общий клиент Agent Client Protocol (JSON-RPC 2.0 по stdio, сообщение — строка). Сейчас
 * через него работает Cursor Agent (`agent acp`), но к Cursor клиент не привязан: всё
 * особенное для агента задаётся в AcpAdapterOptions (cursor.ts).
 *
 * Одна живая сессия на созвон, как у Claude Code: процесс, initialize и session/new
 * платятся один раз — прогревом по «Старт». Вопросы идут по одному через общую очередь
 * (queue.ts): тишина, устаревшие вопросы и зависания — как у Claude.
 *
 * Суфлёр только отвечает текстом. Защита в несколько слоёв, потому что ни на один
 * полагаться нельзя (сторонние замеры: Cursor 2026.08.31 правил файлы, не спросив
 * разрешения):
 * - клиент не объявляет ни файловую систему, ни терминал;
 * - рабочая папка — пустая подпапка данных приложения, mcpServers пустой;
 * - режим «только чтение» (ask), если агент его объявил;
 * - на session/request_permission — отказ; исключение одно — веб-поиск и чтение страниц
 *   у второго агента, которому веб включили (role 'verify', SessionConfig.web);
 * - флаги запуска и настройки конкретного агента (cursor.ts).
 *
 * Разбор протокола — в acpProtocol.ts (чистый модуль, покрыт тестами).
 */

/** Чем запускать агента: программа и аргументы перед аргументами ACP (например, index.js для node.exe). */
export interface AcpLaunch {
  cmd: ResolvedCommand
  prefix: string[]
}

export interface AcpAdapterOptions {
  provider: ProviderId
  /** имена программы по приоритету: ['agent', 'cursor-agent'] */
  commands: string[]
  /** аргументы запуска ACP-сервера: ['acp'] или ['--acp', ...] */
  args: string[]
  /** папки установки мимо PATH */
  extraDirs?: () => string[]
  /**
   * Запасные аргументы, если процесс с основными умер до initialize и ругается на
   * незнакомый флаг: старая версия CLI не должна ломать подсказки совсем.
   */
  fallbackArgs?: string[]
  /** Найти программу по-своему. Нет — resolveCommand(commands, extraDirs). */
  resolve?: () => Promise<AcpLaunch | null>
  /** Программа для окна входа — там нужен настоящий лаунчер, а не прямой запуск. По умолчанию resolve. */
  resolveLauncher?: () => Promise<AcpLaunch | null>
  /** добавки к окружению процесса */
  env?: NodeJS.ProcessEnv
  /** подготовить рабочую папку (например, запретительные настройки агента) */
  prepareWorkDir?: (dir: string) => Promise<void>
  /** Установлен ли и выполнен ли вход. Нет — проба ACP: initialize + session/new. */
  detect?: (rt: AcpRuntime) => Promise<Availability>
  /** Способы authenticate, которые можно звать без пользователя: вход уже есть, агенту нужна только отметка. */
  silentAuthMethods?: string[]
  /** Без режима «только чтение» не отвечать: для агента, который правит файлы без спроса. */
  requireReadOnlyMode?: boolean
  /** аргументы входа для окна терминала: ['login'] */
  loginArgs?: string[]
  /**
   * Процесс умер до initialize (не из-за флагов). true — способ запуска признан негодным,
   * resolve даст другой, и попытка повторится один раз.
   */
  onEarlyExit?: (launch: AcpLaunch) => boolean
}

/** Таймауты рукопожатия. Сам ответ ограничен тишиной (AskOptions.silenceSec), а не общим временем. */
const INIT_TIMEOUT_MS = 30_000
const SESSION_TIMEOUT_MS = 30_000
const AUTH_TIMEOUT_MS = 10_000
const SELECT_TIMEOUT_MS = 15_000
/** Проба для списка моделей: реестр ждёт listModels не дольше 15 с. */
const PROBE_TIMEOUT_MS = 12_000
/** Что узнали о входе и моделях, верно столько. */
const KNOWLEDGE_TTL_MS = 10 * 60_000

const withTimeout = <T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms)
    }),
  ])
}

/* ---------- процесс и рукопожатие ---------- */

interface ConnectionHooks {
  /** любая строка stdout — признак жизни */
  onLine?(c: AcpConnection): void
  onUpdate?(c: AcpConnection, params: unknown): void
  /** процесс умер после initialize */
  onExit?(c: AcpConnection, err: LlmError): void
  /** разрешать ли агенту веб-инструменты; спрашивается на каждый запрос разрешения */
  allowWeb?(c: AcpConnection): boolean
}

/**
 * Один процесс агента и одна его сессия ACP. Ошибки процесса до initialize уходят в
 * промис open(), после — в hooks.onExit: так упавший на старте процесс не роняет
 * вопросы очереди дважды.
 */
class AcpConnection {
  readonly proc: ChildProcess
  readonly rpc: JsonRpcConnection
  readonly cwd: string
  init: AcpInit | null = null
  session: AcpSessionInfo | null = null
  /** модель, с которой агент открыл сессию: вернуться к ней, когда пользователь выбрал «по умолчанию» */
  defaultModel = ''
  /** идёт session/prompt — при гашении сначала session/cancel */
  prompting = false
  /** режим «только чтение» для текущей сессии включён или не требуется */
  modeApplied = false
  exited: LlmError | null = null
  private live = false
  private readonly rt: AcpRuntime
  private readonly hooks: ConnectionHooks
  private readonly tail: () => string

  constructor(rt: AcpRuntime, proc: ChildProcess, cwd: string, hooks: ConnectionHooks) {
    this.rt = rt
    this.proc = proc
    this.cwd = cwd
    this.hooks = hooks
    this.tail = stderrTail(proc.stderr, 3000)
    this.rpc = new JsonRpcConnection({
      withVersion: true,
      write: (line) => {
        if (!proc.stdin || proc.stdin.destroyed) throw new Error('stdin агента закрыт')
        proc.stdin.write(line)
      },
      onNotification: (method, params) => {
        if (method === 'session/update') {
          const u = this.session ? readUpdate(params, this.session.sessionId) : null
          // Агент сам сменил режим или настройки — держим переключатели в курсе.
          if (u && this.session && u.sessionUpdate === 'config_option_update') applyConfigOptions(this.session, u.configOptions)
          if (u && this.session?.mode && u.sessionUpdate === 'current_mode_update' && typeof u.currentModeId === 'string') {
            this.session.mode.current = u.currentModeId
          }
          // Агент ушёл из режима «только чтение» сам (инструмент switch_mode) — перед следующим вопросом вернём.
          if (u && this.session?.mode && this.modeApplied && (u.sessionUpdate === 'current_mode_update' || u.sessionUpdate === 'config_option_update')) {
            const target = pickReadOnlyMode(this.session.mode)
            if (target && this.session.mode.current !== target) this.modeApplied = false
          }
          this.hooks.onUpdate?.(this, params)
        }
      },
      onRequest: (method, params) => answerAgentRequest(method, params, { allowWeb: this.hooks.allowWeb?.(this) ?? false }),
    })
    // Процесс умер — запись в stdin даёт EPIPE. Без обработчика это необработанная ошибка main.
    proc.stdin?.on('error', () => {})
    readLines(proc.stdout, (line) => {
      this.hooks.onLine?.(this)
      this.rpc.handleLine(line)
    })
    proc.on('error', (e: Error) => {
      const err =
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new LlmError('not-installed', rt.provider, undefined, e.message)
          : new LlmError('crashed', rt.provider, llmErrorText('crashed', rt.provider, e.message), e.message)
      this.died(err)
    })
    proc.on('close', (code) => this.died(exitError(rt.provider, code, this.tail())))
  }

  stderr(): string {
    return this.tail()
  }

  private died(err: LlmError): void {
    if (this.exited) return
    this.exited = err
    this.rpc.close(err)
    if (this.live) this.hooks.onExit?.(this, err)
  }

  async initialize(): Promise<AcpInit> {
    const raw = await this.rpc.request('initialize', initializeParams(app.getVersion()), { timeoutMs: INIT_TIMEOUT_MS })
    const init = parseInitialize(raw)
    // Отвечает другой версией — значит, нашу не знает (так по спецификации). Продолжать нельзя.
    if (init.protocolVersion !== 1) {
      throw new LlmError('unknown', this.rt.provider, `${this.rt.info.agent} говорит на несовместимой версии протокола ACP (${init.protocolVersion}). Обновите программу.`)
    }
    this.init = init
    this.live = true
    return init
  }

  /**
   * Новая сессия. Без входа агент отвечает -32000: тогда один раз зовём authenticate —
   * только разрешённым способом (у Cursor cursor_login отмечает уже выполненный вход) — и
   * пробуем снова. Не вышло, в том числе authenticate не ответил, — «нужен вход»: сам вход
   * только в терминале. Разбор исходов — newSessionWithAuth в acpProtocol.ts (там и тесты).
   */
  async newSession(allowAuth: boolean): Promise<AcpSessionInfo> {
    const raw = await newSessionWithAuth(
      {
        provider: this.rt.provider,
        request: (method, params, timeoutMs) => this.rpc.request(method, params, { timeoutMs }),
        exited: () => this.exited,
        authMethod: allowAuth && this.init ? pickAuthMethod(this.init.authMethods, this.rt.opts.silentAuthMethods ?? []) : null,
        sessionTimeoutMs: SESSION_TIMEOUT_MS,
        authTimeoutMs: AUTH_TIMEOUT_MS,
      },
      { cwd: this.cwd, mcpServers: [] },
    )
    const info = parseNewSession(raw)
    this.session = info
    this.modeApplied = false
    this.defaultModel = info.model?.current ?? ''
    this.rt.learn(this)
    return info
  }

  /** Режим «только чтение». Не вышло, а агент без него правит файлы, — отвечать нельзя. */
  async readOnly(): Promise<void> {
    const s = this.session
    if (!s) return
    const target = pickReadOnlyMode(s.mode)
    const required = !!this.rt.opts.requireReadOnlyMode
    if (!target) {
      if (required) {
        throw new LlmError('unknown', this.rt.provider, `${this.rt.info.agent} не предложил режим «только ответы» (ask). Без него агент может менять файлы, поэтому подсказки через него выключены. Обновите ${this.rt.info.agent}.`)
      }
      this.modeApplied = true
      return
    }
    if (s.mode?.current !== target) {
      try {
        await this.select('mode', target)
      } catch (e) {
        if (required) {
          const err = toLlmError(this.rt.provider, e)
          throw new LlmError('unknown', this.rt.provider, `${this.rt.info.agent} не переключился в режим «только ответы» (ask): ${err.message}`, err.raw)
        }
        console.warn(`[acp:${this.rt.provider}] режим только для чтения не включился:`, e instanceof Error ? e.message : e)
      }
    }
    this.modeApplied = true
  }

  /** Модель пользователя. Пусто — модель, с которой агент открыл сессию. У агента нет переключателя — как есть. */
  async model(wanted: string): Promise<void> {
    const s = this.session
    if (!s?.model) {
      if (wanted) console.warn(`[acp:${this.rt.provider}] агент не даёт выбрать модель, отвечает своей по умолчанию`)
      return
    }
    const target = wanted ? matchModel(s.model, wanted) : this.defaultModel
    if (wanted && !target) throw new LlmError('model-unavailable', this.rt.provider, undefined, `нет модели ${wanted}`)
    if (!target || target === s.model.current) return
    try {
      await this.select('model', target)
    } catch (e) {
      const err = toLlmError(this.rt.provider, e)
      throw err.kind === 'unknown' ? new LlmError('model-unavailable', this.rt.provider, llmErrorText('model-unavailable', this.rt.provider), err.raw) : err
    }
  }

  private async select(kind: 'model' | 'mode', value: string): Promise<void> {
    const s = this.session!
    const sel = kind === 'model' ? s.model! : s.mode!
    const { method, params } = selectRequest(s.sessionId, sel, value, kind)
    const res = await this.rpc.request(method, params, { timeoutMs: SELECT_TIMEOUT_MS })
    if (sel.via === 'config' && res && typeof res === 'object') applyConfigOptions(s, (res as { configOptions?: unknown }).configOptions)
    // Ответ старых методов пустой; у новых — полный список, но и тогда фиксируем выбранное.
    const now = kind === 'model' ? s.model : s.mode
    if (now) now.current = value
  }

  /** Погасить процесс. Идёт ответ — сначала session/cancel: сервис перестанет тратить лимит. */
  close(): void {
    const s = this.session
    if (this.prompting && s && !this.exited) {
      try {
        this.rpc.notify('session/cancel', { sessionId: s.sessionId })
      } catch {
        /* stdin уже закрыт */
      }
    }
    this.live = false
    this.died(new LlmError('cancelled', this.rt.provider))
    treeKill(this.proc)
  }
}

/* ---------- общее на адаптер: поиск программы, проба, знание о входе и моделях ---------- */

export class AcpRuntime {
  readonly opts: AcpAdapterOptions
  readonly provider: ProviderId
  readonly info: ReturnType<typeof providerById>
  private auth: { at: number; state: 'ok' | 'not-logged-in' } | null = null
  private models: { at: number; list: ModelInfo[] } | null = null
  private version: string | undefined
  private probing: Promise<void> | null = null

  constructor(opts: AcpAdapterOptions) {
    this.opts = opts
    this.provider = opts.provider
    this.info = providerById(opts.provider)
  }

  async launch(): Promise<AcpLaunch | null> {
    if (this.opts.resolve) return this.opts.resolve()
    const cmd = await resolveCommand(this.opts.commands, this.opts.extraDirs?.() ?? [])
    return cmd ? { cmd, prefix: [] } : null
  }

  async env(): Promise<NodeJS.ProcessEnv> {
    return cliEnv(this.opts.env)
  }

  /** Короткий запуск программы для проверок (`--version`, `status`). */
  run(launch: AcpLaunch, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000): Promise<CliResult> {
    return runCli(launch.cmd, [...launch.prefix, ...args], { env, timeoutMs })
  }

  /** Живая сессия или проба узнали, что вход есть, и какие модели. */
  learn(c: AcpConnection): void {
    const now = Date.now()
    this.auth = { at: now, state: 'ok' }
    if (c.init?.agentVersion) this.version = c.init.agentVersion
    if (c.session?.model) this.models = { at: now, list: modelsFromSelector(c.session.model, this.info.models) }
  }

  learnNotLoggedIn(): void {
    this.auth = { at: Date.now(), state: 'not-logged-in' }
  }

  /** После входа в терминале прежний итог неверен. */
  forget(): void {
    this.auth = null
  }

  knownAuth(): 'ok' | 'not-logged-in' | null {
    return this.auth && Date.now() - this.auth.at < KNOWLEDGE_TTL_MS ? this.auth.state : null
  }

  knownVersion(): string | undefined {
    return this.version
  }

  knownModels(): ModelInfo[] | null {
    return this.models && Date.now() - this.models.at < KNOWLEDGE_TTL_MS ? this.models.list : null
  }

  /**
   * Запустить процесс и пройти initialize. Процесс с основными аргументами умер до
   * initialize и ругается на флаг — пробуем запасные: старая версия CLI.
   */
  async open(hooks: ConnectionHooks, onSpawn?: (c: AcpConnection) => void): Promise<AcpConnection> {
    let launch = await this.launch()
    if (!launch) throw new LlmError('not-installed', this.provider)
    const cwd = await providerWorkDir(this.provider)
    await this.opts.prepareWorkDir?.(cwd)
    const env = await this.env()
    let args = this.opts.args
    let usedFallbackArgs = false
    let relaunched = false
    for (;;) {
      const proc = spawnCli(launch.cmd, [...launch.prefix, ...args], { cwd, env })
      const c = new AcpConnection(this, proc, cwd, hooks)
      onSpawn?.(c)
      try {
        await c.initialize()
        return c
      } catch (e) {
        const early = !!c.exited && c.exited.kind !== 'cancelled'
        const stderr = c.stderr()
        c.close()
        if (early && !usedFallbackArgs && this.opts.fallbackArgs && /unknown (option|argument|flag)|unrecognized|invalid option|too many arguments/i.test(stderr)) {
          console.warn(`[acp:${this.provider}] CLI не принял флаги запуска, пробую без них:`, stderr.slice(-300))
          usedFallbackArgs = true
          args = this.opts.fallbackArgs
          continue
        }
        if (early && !relaunched && this.opts.onEarlyExit?.(launch)) {
          const next = await this.launch()
          if (next) {
            console.warn(`[acp:${this.provider}] процесс умер до initialize, пробую другой способ запуска:`, stderr.slice(-300))
            relaunched = true
            launch = next
            continue
          }
        }
        throw toLlmError(this.provider, e)
      }
    }
  }

  /**
   * Проба без вопроса: initialize и session/new — узнать вход, модели и картинки. Токенов
   * не тратит. Запросы в одну пробу склеиваются.
   */
  probe(timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
    this.probing ??= this.runProbe(timeoutMs).finally(() => {
      this.probing = null
    })
    return this.probing
  }

  private async runProbe(timeoutMs: number): Promise<void> {
    const spawned: AcpConnection[] = []
    let over = false
    const work = (async () => {
      const c = await this.open({}, (s) => {
        spawned.push(s)
        // Таймаут наступил, пока искали программу: процесс, поднятый после него, сразу гасим.
        if (over) s.close()
      })
      await c.newSession(true)
    })()
    try {
      await withTimeout(work, timeoutMs, () => new LlmError('timeout', this.provider, `${this.info.agent} не ответил за ${Math.round(timeoutMs / 1000)} с`))
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'not-logged-in') this.learnNotLoggedIn()
      throw e
    } finally {
      over = true
      for (const s of spawned) s.close()
      work.catch(() => {})
    }
  }
}

/* ---------- сессия подсказок ---------- */

interface Question {
  text: string
  images?: ImageInput[]
}

class AcpSession implements LlmSession {
  private readonly rt: AcpRuntime
  /** main — подсказки, verify — второй агент: веб можно разрешить только ему */
  private readonly role: SessionRole
  private readonly queue: TurnQueue<Question>
  private cfg: SessionConfig = { model: '', thinking: true }
  private conn: AcpConnection | null = null
  /** то же соединение, но уже с сессией в режиме «только чтение» */
  private ready: AcpConnection | null = null
  private opening: Promise<AcpConnection> | null = null
  /** Растёт при каждом гашении: поздние события и ответы погашенного процесса не трогают новые вопросы. */
  private gen = 0
  private turn: AcpTurn | null = null
  /** Какой системный промпт уже ушёл в текущую сессию ACP; null — ещё никакой. */
  private sentSystem: string | null = null

  constructor(rt: AcpRuntime, role: SessionRole) {
    this.rt = rt
    this.role = role
    this.queue = new TurnQueue<Question>({
      provider: rt.provider,
      label: rt.info.agent,
      transport: {
        // Подъём процесса асинхронный (initialize, session/new) — он внутри send.
        ensure: () => {},
        send: (q) => this.send(q),
        kill: () => this.kill(),
      },
    })
  }

  /**
   * Всё, что здесь настраивается, применяется перед следующим вопросом без перезапуска
   * процесса: модель и режим — переключателями сессии, новый системный промпт — новой
   * сессией ACP в том же процессе. Идущий ответ не обрывается.
   */
  configure(cfg: SessionConfig): void {
    this.cfg = { ...cfg }
  }

  /**
   * Прогрев — процесс, initialize и session/new, без вопроса. В отличие от Claude Code,
   * ACP-агент готов к работе после рукопожатия; вопрос-прогрев тратил бы лимит подписки
   * и нёс бы в модель весь системный промпт впустую.
   */
  async warmup(): Promise<void> {
    if (this.ready && !this.ready.exited) return
    try {
      await this.connection()
    } catch {
      /* прогрев не удался — обычный вопрос попробует ещё раз и покажет ошибку */
    }
  }

  ask(input: TurnInput, h: TurnHandlers, o: AskOptions = {}): Promise<string> {
    return this.queue.ask({ text: input.text, images: input.images }, h, o)
  }

  stop(reason?: Error): void {
    this.queue.stop(reason)
  }

  get busy(): boolean {
    return this.queue.busy
  }

  private get system(): string {
    return suggestSystemPrompt(this.cfg.systemPrompt)
  }

  /**
   * Веб-инструменты — только второму агенту и только с включённым вебом. Настройку читаем
   * на каждый запрос разрешения, а не при старте процесса: переключатель «веб» действует
   * со следующего поиска без перезапуска агента. Запрос от погашенного процесса — отказ.
   */
  private allowWeb(c: AcpConnection): boolean {
    return this.role === 'verify' && this.cfg.web === true && this.conn === c
  }

  /**
   * Процесс с открытой сессией в режиме «только чтение». Параллельные вызовы ждут один
   * подъём. Готовым соединение считается только после режима: иначе вопрос, пришедший
   * посреди прогрева, ушёл бы в сессию, ещё не переключённую в ask.
   */
  private connection(): Promise<AcpConnection> {
    if (this.ready && this.ready === this.conn && !this.ready.exited) return Promise.resolve(this.ready)
    if (!this.opening) {
      const p = this.open().finally(() => {
        // Подъём, брошенный гашением, не должен затереть уже начатый новый.
        if (this.opening === p) this.opening = null
      })
      this.opening = p
    }
    return this.opening
  }

  private async open(): Promise<AcpConnection> {
    const gen = this.gen
    const hooks: ConnectionHooks = {
      onLine: (c) => {
        if (this.conn === c) this.queue.activity()
      },
      onUpdate: (c, params) => this.onUpdate(c, params),
      allowWeb: (c) => this.allowWeb(c),
      onExit: (c, err) => {
        if (this.conn !== c) return
        this.reset()
        this.queue.failAll(err)
      },
    }
    let spawned: AcpConnection | null = null
    try {
      const c = await this.rt.open(hooks, (s) => {
        spawned = s
        if (gen === this.gen) this.conn = s
      })
      if (gen !== this.gen) throw new CancelledError()
      await c.newSession(true)
      if (gen !== this.gen) throw new CancelledError()
      await c.readOnly()
      if (gen !== this.gen) throw new CancelledError()
      this.sentSystem = null
      this.ready = c
      return c
    } catch (e) {
      const s = spawned as AcpConnection | null
      if (s) {
        if (this.conn === s) this.conn = null
        s.close()
      }
      if (e instanceof LlmError && e.kind === 'not-logged-in') this.rt.learnNotLoggedIn()
      throw e instanceof CancelledError ? e : toLlmError(this.rt.provider, e)
    }
  }

  private async send(q: Question): Promise<void> {
    const gen = this.gen
    let conn: AcpConnection | null = null
    try {
      conn = await this.connection()
      if (gen !== this.gen) return
      // Свой промпт поменялся, а прежний уже в сессии: промпт живёт в истории сессии, нужна новая.
      if (this.sentSystem !== null && this.sentSystem !== this.system) {
        await conn.newSession(true)
        await conn.readOnly()
        if (gen !== this.gen) return
        this.sentSystem = null
      }
      // Прошлая попытка открыла сессию, но режим не включился: без него в модель не идём.
      if (!conn.modeApplied) await conn.readOnly()
      await conn.model(this.cfg.model?.trim() ?? '')
      if (gen !== this.gen) return
      if (q.images?.length && !conn.init?.image) throw new LlmError('images-unsupported', this.rt.provider)

      const system = this.sentSystem === null ? this.system : undefined
      const prompt = buildPrompt({ text: q.text, images: q.images, system })
      const turn = new AcpTurn()
      this.turn = turn
      conn.prompting = true
      const pending = this.rpcPrompt(conn, prompt)
      if (system !== undefined) this.sentSystem = system
      const res = await pending
      conn.prompting = false
      if (gen !== this.gen || this.turn !== turn) return
      this.turn = null
      const out = stopOutcome(this.rt.provider, (res as { stopReason?: unknown } | null)?.stopReason, !!this.queue.text.trim())
      if (out.ok) this.queue.finish()
      else this.queue.failTurn(out.kind === 'cancelled' ? new CancelledError() : new LlmError(out.kind, this.rt.provider, out.message))
    } catch (e) {
      if (conn) conn.prompting = false
      this.turn = null
      // Процесс уже погашен или умер — вопрос отклонила очередь, эта ошибка никому не нужна.
      if (gen !== this.gen) return
      throw toLlmError(this.rt.provider, e)
    }
  }

  private rpcPrompt(conn: AcpConnection, prompt: unknown): Promise<unknown> {
    // Без таймаута: долгий ответ ограничивает тишина очереди, а не общее время.
    return conn.rpc.request('session/prompt', { sessionId: conn.session!.sessionId, prompt })
  }

  private onUpdate(c: AcpConnection, params: unknown): void {
    if (this.conn !== c || !this.turn || !c.session) return
    const u = readUpdate(params, c.session.sessionId)
    if (!u) return
    for (const ev of this.turn.push(u)) {
      if (ev.type === 'delta') this.queue.delta(ev.text)
      else if (ev.type === 'break') this.queue.blockBreak()
      else if (ev.type === 'thinking') this.queue.thinking()
      else this.queue.tool(ev.name)
    }
  }

  /** Для очереди: погасить процесс немедленно, вопросы не трогать. */
  private kill(): void {
    const c = this.conn
    this.reset()
    c?.close()
  }

  /** Забыть процесс: всё, что от него ещё придёт (ответы, события, конец рукопожатия), — мимо. */
  private reset(): void {
    this.gen++
    this.conn = null
    this.ready = null
    this.opening = null
    this.turn = null
    this.sentSystem = null
  }
}

/* ---------- адаптер ---------- */

/** Проверка по умолчанию: проба ACP. Она же даёт версию, модели и знание о входе. */
async function probeDetect(rt: AcpRuntime): Promise<Availability> {
  const launch = await rt.launch()
  if (!launch) return { state: 'not-installed' }
  const cached = rt.knownAuth()
  if (cached === 'ok') return { state: 'ok', version: rt.knownVersion() }
  try {
    // Проба дольше пяти секунд бывает только на холодном старте CLI; реестр ждёт до восьми.
    await rt.probe(7000)
    return { state: 'ok', version: rt.knownVersion() }
  } catch (e) {
    if (e instanceof LlmError) {
      if (e.kind === 'not-logged-in') return { state: 'not-logged-in' }
      if (e.kind === 'not-installed') return { state: 'not-installed' }
      if (e.kind === 'timeout') return { state: 'unknown', message: e.message }
    }
    return { state: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** Команда для окна терминала: полный путь, кавычки — только если нужны. */
function terminalCommand(launch: AcpLaunch, args: string[]): string {
  const q = (s: string) => (/[\s&()^|<>]/.test(s) ? `"${s}"` : s)
  const tail = [...launch.prefix, ...args].map(q).join(' ')
  if (launch.cmd.kind === 'ps1') return `powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${q(launch.cmd.path)} ${tail}`
  return `${q(launch.cmd.path)} ${tail}`
}

export function createAcpAdapter(opts: AcpAdapterOptions): ProviderAdapter {
  const rt = new AcpRuntime(opts)
  return {
    id: opts.provider,
    async detect(): Promise<Availability> {
      try {
        return await (opts.detect ?? probeDetect)(rt)
      } catch (e) {
        return { state: 'error', message: e instanceof Error ? e.message : String(e) }
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      const known = rt.knownModels()
      if (known) return known
      // Живого списка нет — проба. Не вышла — бросаем: реестр отдаст запасной и не закэширует неудачу.
      await rt.probe()
      return rt.knownModels() ?? rt.info.models
    },
    createSession(role: SessionRole): LlmSession {
      return new AcpSession(rt, role)
    },
    async openLogin(): Promise<void> {
      rt.forget()
      const launch = await (opts.resolveLauncher ?? (() => rt.launch()))()
      if (!launch) throw new LlmError('not-installed', opts.provider)
      await openInTerminal(terminalCommand(launch, opts.loginArgs ?? ['login']))
    },
  }
}
