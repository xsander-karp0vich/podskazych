import type { ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { app } from 'electron'
import { providerById } from '@shared/providers'
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
  writeTempImages,
  type ResolvedCommand,
} from '../cli'
import { JsonRpcConnection, RpcRemoteError } from '../jsonrpc'
import { suggestSystemPrompt } from '../prompts'
import { TurnQueue } from '../queue'
import {
  CancelledError,
  LlmError,
  llmErrorText,
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
import {
  CodexTurnRouter,
  buildInitializeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  codexMcpServerNames,
  codexServerArgs,
  errorFromText,
  isAddressableMcpName,
  isContextOverflow,
  isSandboxCasingError,
  parseAccountRead,
  parseLoginStatus,
  parseModelList,
  pickEffort,
  serverRequestReply,
  threadIdOf,
  turnIdOf,
  versionFrom,
  type CodexLaunch,
  type TurnEnd,
} from './codexProtocol'

/**
 * ChatGPT через Codex CLI — живой `codex app-server` (JSON-RPC 2.0 JSONL по stdio).
 *
 * Почему app-server, а не `codex exec --json`: exec отдаёт ответ только целиком, а
 * суфлёру нужны куски текста по мере генерации (item/agentMessage/delta). Устройство
 * как у Claude Code: один процесс на созвон, одна нить (thread/start) с системным
 * промптом, по ходу (turn/start) на вопрос. Очередь, тишина и устаревшие вопросы —
 * общие, из queue.ts. Разбор сообщений — в codexProtocol.ts (там же сверка с исходниками).
 *
 * Что здесь выбрано и почему:
 * - Запускаем сам codex.exe без оболочки. npm ставит обёртку codex.cmd → node → codex.exe:
 *   лишний node, лишний cmd.exe, kill гасил бы только оболочку. Бинарник лежит рядом
 *   с обёрткой, в vendor платформенного пакета; не нашли — запускаем обёртку.
 * - Прогрев — без вопроса: процесс, initialize, thread/start и список моделей. Вопрос-
 *   прогрев, как у Claude, тратил бы сообщение из лимита подписки ChatGPT при каждом старте.
 * - Модель и системный промпт задаются нитью: сменились — следующий вопрос откроет новую
 *   нить в том же процессе (перезапуск процесса не нужен, идущий ответ не обрывается).
 *   Глубина — параметр хода, её смена нить не трогает.
 * - Гасим процесс (тишина, смена провайдера, выход) с turn/interrupt перед этим:
 *   сервер перестаёт писать ответ, и лимит не тратится на то, что никто не прочтёт.
 * - Веб-поиск (web_search=live) — только у второго агента с включённым вебом; у подсказок он
 *   выключен. Режим задаётся и процессу, и нити: сменился — процесс перезапускается между
 *   вопросами, идущий ответ не обрывается.
 * - MCP-серверы из config.toml пользователя выключены поимённо (codexMcpServerNames).
 */

const INFO = providerById('codex')
const AGENT = INFO.agent

/** initialize у холодного codex.exe на Windows: антивирус проверяет бинарник в сотню мегабайт. */
const INIT_TIMEOUT_MS = 20_000
const THREAD_START_TIMEOUT_MS = 30_000
/** turn/start отвечает сразу, сам ответ идёт уведомлениями: долгое ожидание — зависание. */
const TURN_START_TIMEOUT_MS = 30_000
const MODELS_TIMEOUT_MS = 10_000
/** Проверка: app-server + account/read, затем запасной `codex login status`. Реестр ждёт 8 с. */
const DETECT_APP_SERVER_MS = 3_500
const DETECT_BUDGET_MS = 6_500
const LIST_MODELS_BUDGET_MS = 12_000
/** Процесс для проверок живёт немного после последней: detect и listModels идут подряд. */
const PROBE_IDLE_MS = 20_000

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/* ---------- где codex.exe ---------- */

interface CodexCommand {
  cmd: ResolvedCommand
  /** добавки к окружению запуска */
  env?: NodeJS.ProcessEnv
}

const WIN_ARM = process.arch === 'arm64'
const TRIPLE = WIN_ARM ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
const PLATFORM_PACKAGE = WIN_ARM ? 'codex-win32-arm64' : 'codex-win32-x64'

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Папки автономной установки (install.ps1 из репозитория Codex): видимая папка
 * %LOCALAPPDATA%\Programs\OpenAI\Codex\bin (или CODEX_INSTALL_DIR) — ссылка на
 * %CODEX_HOME%\packages\standalone\current, где codex.exe лежит в bin или в корне.
 */
function standaloneDirs(): string[] {
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const codexHome = process.env.CODEX_HOME || join(home, '.codex')
  return [
    ...(process.env.CODEX_INSTALL_DIR ? [process.env.CODEX_INSTALL_DIR] : []),
    join(local, 'Programs', 'OpenAI', 'Codex', 'bin'),
    join(codexHome, 'packages', 'standalone', 'current', 'bin'),
    join(codexHome, 'packages', 'standalone', 'current'),
  ]
}

/**
 * codex.exe из npm-установки. Обёртка codex.cmd лежит в папке npm, пакет — в её
 * node_modules. bin/codex.js ищет бинарник в vendor платформенного пакета
 * (@openai/codex-win32-x64), а если его нет — в vendor самого пакета; раскладка
 * vendor/<triple>/bin/codex.exe, у старых версий — vendor/<triple>/codex/codex.exe.
 */
async function npmVendorExe(wrapper: string): Promise<{ exe: string; packageRoot: string } | null> {
  const modules = join(dirname(wrapper), 'node_modules', '@openai')
  const packageRoot = join(modules, 'codex')
  const vendors = [
    join(packageRoot, 'node_modules', '@openai', PLATFORM_PACKAGE, 'vendor'),
    join(modules, PLATFORM_PACKAGE, 'vendor'),
    join(packageRoot, 'vendor'),
  ]
  for (const vendor of vendors) {
    for (const rel of [join(TRIPLE, 'bin', 'codex.exe'), join(TRIPLE, 'codex', 'codex.exe')]) {
      const exe = join(vendor, rel)
      if (await isFile(exe)) return { exe, packageRoot }
    }
  }
  return null
}

async function resolveCodex(): Promise<CodexCommand | null> {
  if (process.platform !== 'win32') {
    const cmd = await resolveCommand(['codex'])
    return cmd ? { cmd } : null
  }
  const found = await resolveCommand(['codex'], standaloneDirs())
  if (!found) return null
  if (found.kind === 'exe') return { cmd: found }
  const vendor = await npmVendorExe(found.path)
  if (vendor) {
    return {
      cmd: { path: vendor.exe, shell: false, kind: 'exe' },
      // Так бинарник запускает сама npm-обёртка: по этим переменным Codex знает, как он установлен.
      env: { CODEX_MANAGED_BY_NPM: '1', CODEX_MANAGED_PACKAGE_ROOT: vendor.packageRoot },
    }
  }
  // Обёртка есть, а бинарника рядом нет (pnpm, bun, другая раскладка): может, есть автономная установка.
  const standalone = await resolveCommand(standaloneDirs().map((d) => join(d, 'codex.exe')))
  return { cmd: standalone ?? found }
}

/**
 * MCP-серверы пользователя из $CODEX_HOME/config.toml (по умолчанию ~/.codex). Читаем при каждом
 * запуске процесса: сервер, добавленный в настройки посреди дня, иначе поднялся бы у суфлёра.
 * Файла нет или не читается — выключать нечего, запускаемся как есть.
 */
async function userMcpServers(): Promise<string[]> {
  const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const names = codexMcpServerNames(text)
  const skipped = names.filter((n) => !isAddressableMcpName(n))
  if (skipped.length) console.warn(`[codex] MCP-серверы с такими именами выключить ключом -c нельзя, у суфлёра они останутся: ${skipped.join(', ')}`)
  return names.filter(isAddressableMcpName)
}

/* ---------- процесс app-server ---------- */

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

function lastLine(text: string): string {
  return (
    text
      .replace(ANSI, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
      ?.slice(0, 200) ?? ''
  )
}

function exitError(code: number | null, tail: string, startError?: NodeJS.ErrnoException): LlmError {
  if (startError?.code === 'ENOENT') return new LlmError('not-installed', 'codex', undefined, startError.message)
  const raw = `${startError?.message ?? `код ${code}`}\n${tail}`
  // Старый Codex CLI без app-server: clap отвечает «unrecognized subcommand».
  if (/unrecognized subcommand|unexpected argument|invalid value/i.test(tail)) {
    return new LlmError(
      'crashed',
      'codex',
      `Эта версия ${AGENT} не умеет работать с приложениями. Обновите его командой ${INFO.install.command ?? 'установки'} и повторите.`,
      raw,
    )
  }
  const line = lastLine(tail) || startError?.message || ''
  return new LlmError('crashed', 'codex', llmErrorText('crashed', 'codex', line ? `(${line})` : ''), raw)
}

interface ServerHooks {
  onNotification?(method: string, params: unknown): void
  /** любая строка stdout — признак жизни */
  onLine?(): void
  /** процесс завершился сам, не по kill() */
  onExit?(err: LlmError): void
}

class AppServer {
  readonly rpc: JsonRpcConnection
  readonly init: Promise<void>
  /** с чем запущен процесс: веб и выключенные MCP-серверы; нити берут то же */
  readonly launch: CodexLaunch
  initialized = false
  userAgent: string | undefined
  private readonly proc: ChildProcess
  private readonly tail: () => string
  private readonly hooks: ServerHooks
  /** погашен нами или умер: события больше не слушаем */
  private dead = false
  private exited = false

  constructor(c: CodexCommand, cwd: string, env: NodeJS.ProcessEnv, launch: CodexLaunch, hooks: ServerHooks) {
    this.hooks = hooks
    this.launch = launch
    const proc = spawnCli(c.cmd, codexServerArgs(launch), { cwd, env })
    this.proc = proc
    this.tail = stderrTail(proc.stderr)
    this.rpc = new JsonRpcConnection({
      // «header omitted on the wire»: Codex не пишет и не ждёт поле jsonrpc.
      withVersion: false,
      write: (line) => {
        if (!this.dead) proc.stdin?.write(line)
      },
      onNotification: (method, params) => {
        if (!this.dead) this.hooks.onNotification?.(method, params)
      },
      onRequest: (method) => {
        const reply = serverRequestReply(method)
        if (reply === undefined) throw new RpcRemoteError(-32601, `Method not supported by client: ${method}`)
        return reply
      },
    })
    // Запись в stdin умершего процесса — EPIPE событием потока; без обработчика он уронил бы main.
    proc.stdin?.on('error', () => {})
    readLines(proc.stdout, (line) => {
      if (this.dead) return
      this.hooks.onLine?.()
      this.rpc.handleLine(line)
    })
    proc.once('error', (e) => this.died(null, e as NodeJS.ErrnoException))
    proc.once('close', (code) => this.died(code))

    this.init = this.rpc.request<Record<string, unknown>>('initialize', buildInitializeParams(appVersion()), { timeoutMs: INIT_TIMEOUT_MS }).then((res) => {
      this.userAgent = typeof res?.userAgent === 'string' ? res.userAgent : undefined
      // До initialized сервер отвечает на всё «Not initialized».
      this.rpc.notify('initialized')
      this.initialized = true
    })
    // Ждут init все, кто им пользуется; это — чтобы неудача без ждущих не стала необработанной.
    this.init.catch(() => {})
  }

  get alive(): boolean {
    return !this.dead
  }

  /** Прервать ход на сервере, не дожидаясь ответа: сразу после этого процесс гасят. */
  interrupt(threadId: string, turnId: string): void {
    if (this.dead || !this.initialized) return
    this.rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }

  kill(): void {
    if (this.dead) return
    this.dead = true
    this.rpc.close(new CancelledError())
    treeKill(this.proc)
  }

  private died(code: number | null, startError?: NodeJS.ErrnoException): void {
    if (this.exited) return
    this.exited = true
    const byUs = this.dead
    this.dead = true
    const err = exitError(code, this.tail(), startError)
    this.rpc.close(err)
    if (!byUs) this.hooks.onExit?.(err)
  }
}

/** Ошибка из запроса к серверу → LlmError для окна. */
function toLlmError(e: unknown): Error {
  if (e instanceof LlmError || e instanceof CancelledError) return e
  if (e instanceof RpcRemoteError) return errorFromText(e.message, `rpc ${e.code}: ${e.message}`)
  const msg = errText(e)
  // Таймаут запроса из jsonrpc.ts: «turn/start: нет ответа за 30 с».
  if (/нет ответа за/.test(msg)) return new LlmError('timeout', 'codex', undefined, msg)
  return new LlmError('unknown', 'codex', `${AGENT} вернул ошибку: ${msg}`, msg)
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout()
        reject(new LlmError('timeout', 'codex', `${AGENT} не ответил за ${Math.round(ms / 1000)} с`))
      }, ms)
    }),
  ])
}

/* ---------- общее состояние адаптера ---------- */

class CodexState {
  /** живой список последней удачной выборки: по нему глубина и снимки для модели */
  models: ModelInfo[] | null = null
  readonly sessions = new Set<CodexSession>()

  /** model/list постранично. Пустой ответ — запасной каталог, но его не запоминаем как живой. */
  async fetchModels(server: AppServer): Promise<ModelInfo[]> {
    const all: ModelInfo[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const res: unknown = await server.rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, { timeoutMs: MODELS_TIMEOUT_MS })
      const { models, nextCursor } = parseModelList(res, INFO.models)
      for (const m of models) if (!all.some((x) => x.id === m.id)) all.push(m)
      if (!nextCursor) break
      cursor = nextCursor
    }
    if (!all.length) return INFO.models
    this.models = all
    return all
  }
}

/**
 * Процесс для проверок (account/read, model/list) отдельно от сессии: проверка идёт
 * при открытии окна, когда сессии ещё нет, и не должна мешать идущему ответу.
 */
class Probe {
  private server: AppServer | null = null
  private starting: Promise<AppServer> | null = null
  private users = 0
  private idle: ReturnType<typeof setTimeout> | undefined

  async use<T>(fn: (s: AppServer) => Promise<T>): Promise<T> {
    clearTimeout(this.idle)
    this.users++
    try {
      return await fn(await this.get())
    } catch (e) {
      this.drop()
      throw e
    } finally {
      this.users--
      if (!this.users) {
        clearTimeout(this.idle)
        this.idle = setTimeout(() => this.drop(), PROBE_IDLE_MS)
      }
    }
  }

  /** Не обрывать чужую проверку: список моделей мог запроситься параллельно. */
  dropIfIdle(): void {
    if (!this.users) this.drop()
  }

  drop(): void {
    clearTimeout(this.idle)
    this.server?.kill()
    this.server = null
    this.starting = null
  }

  private get(): Promise<AppServer> {
    if (this.server?.alive && this.server.initialized) return Promise.resolve(this.server)
    if (this.starting) return this.starting
    const p = (async () => {
      const c = await resolveCodex()
      if (!c) throw new LlmError('not-installed', 'codex')
      const [cwd, env, mcpServers] = await Promise.all([providerWorkDir('codex'), cliEnv(c.env), userMcpServers()])
      const server = new AppServer(c, cwd, env, { mcpServers }, {
        onExit: () => {
          if (this.server === server) this.server = null
        },
      })
      this.server = server
      await server.init
      return server
    })()
    this.starting = p
    const clear = () => {
      if (this.starting === p) this.starting = null
    }
    p.then(clear, clear)
    return p
  }
}

/* ---------- сессия ---------- */

class CodexSession implements LlmSession {
  private readonly state: CodexState
  /** main — подсказки, verify — второй агент: веб-поиск бывает только у него */
  private readonly role: SessionRole
  private readonly queue: TurnQueue<TurnInput>
  private readonly router: CodexTurnRouter
  private cfg: SessionConfig = { model: '', thinking: true }
  private server: AppServer | null = null
  private starting: Promise<AppServer> | null = null
  /** с каким режимом веба поднимается процесс из starting */
  private startingWeb = false
  /** поколение процесса: события и ожидания старого процесса после kill() не в счёт */
  private gen = 0
  private thread: { id: string; key: string; server: AppServer } | null = null
  private threadStarting: { key: string; server: AppServer; p: Promise<string> } | null = null
  private releaseShots: (() => Promise<void>) | null = null

  constructor(state: CodexState, role: SessionRole) {
    this.state = state
    this.role = role
    this.queue = new TurnQueue<TurnInput>({
      provider: 'codex',
      label: AGENT,
      transport: {
        // Процесс поднимается асинхронно, внутри send: ensure синхронный по контракту очереди.
        ensure: () => {},
        send: (q) => this.send(q),
        kill: () => this.kill(),
      },
    })
    this.router = new CodexTurnRouter(this.queue, (end) => this.turnEnded(end))
  }

  get busy(): boolean {
    return this.queue.busy
  }

  configure(cfg: SessionConfig): void {
    // Ничего не перезапускаем: модель и промпт возьмёт следующая нить, глубину — следующий ход.
    this.cfg = { ...cfg }
  }

  async warmup(): Promise<void> {
    try {
      this.dropIfWebChanged()
      const server = await this.getServer()
      const jobs: Array<Promise<unknown>> = []
      if (!this.queue.busy) jobs.push(this.ensureThread(server))
      // Список моделей нужен до первого вопроса: по нему глубина и снимки. К тому же Codex
      // обновляет свой кэш моделей при первом запросе — пусть это случится до созвона.
      if (!this.state.models) jobs.push(this.state.fetchModels(server))
      await Promise.all(jobs)
    } catch {
      /* прогрев не удался — обычный вопрос попробует ещё раз и покажет понятную ошибку */
    }
  }

  ask(input: TurnInput, h: TurnHandlers, o: AskOptions = {}): Promise<string> {
    return this.queue.ask(input, h, o)
  }

  stop(reason?: Error): void {
    this.queue.stop(reason)
  }

  /** После входа в терминале: простаивающий процесс мог запомнить, что входа нет. */
  resetIfIdle(): void {
    if (!this.queue.busy && (this.server || this.starting)) this.kill()
  }

  /* ---------- транспорт очереди ---------- */

  /** Веб-поиск второму агенту — только когда его включили; подсказкам — никогда. */
  private wantWeb(): boolean {
    return this.role === 'verify' && this.cfg.web === true
  }

  /**
   * Переключатель «веб» сменился, а процесс запущен с прежним режимом. Режим задан процессу
   * флагом -c (нить его тоже получает, но на нить одну не полагаемся: per-thread config у
   * 0.154 на Windows не проверен), поэтому процесс гасим и следующий вопрос поднимет новый.
   * Зовётся только между ответами: идущий ход не трогаем.
   */
  private dropIfWebChanged(): void {
    if (this.router.active) return
    const web = this.server ? !!this.server.launch.web : this.starting ? this.startingWeb : null
    if (web !== null && web !== this.wantWeb()) this.kill()
  }

  private async send(q: TurnInput): Promise<void> {
    this.dropIfWebChanged()
    const token = this.router.begin()
    try {
      const server = await this.getServer()
      if (!this.router.isCurrent(token)) return
      const threadId = await this.ensureThread(server)
      if (!this.router.isCurrent(token)) return

      const live = this.state.models?.find((m) => m.id === this.cfg.model)
      if (q.images?.length && live?.images === false) throw new LlmError('images-unsupported', 'codex')
      let imagePaths: string[] | undefined
      if (q.images?.length) {
        // Codex принимает снимок только путём к файлу (localImage). Файлы удаляются в конце хода.
        const shots = await writeTempImages(q.images)
        if (!this.router.isCurrent(token)) {
          await shots.cleanup()
          return
        }
        this.releaseShots = shots.cleanup
        imagePaths = shots.paths
      }

      this.router.threadId = threadId
      const res = await server.rpc.request(
        'turn/start',
        buildTurnStartParams({
          threadId,
          text: q.text,
          imagePaths,
          effort: pickEffort(this.cfg.thinking, this.cfg.effort, live ? live.efforts : undefined),
        }),
        { timeoutMs: TURN_START_TIMEOUT_MS },
      )
      this.router.started(token, turnIdOf(res))
    } catch (e) {
      // Ход уже закрыт — очередь отклонила вопрос сама (тишина, стоп) или он закончился событием.
      if (!this.router.isCurrent(token)) return
      const err = toLlmError(e)
      if (err instanceof LlmError && err.kind === 'timeout') this.kill()
      else {
        this.router.abandon()
        this.freeShots()
      }
      throw err
    }
  }

  private kill(): void {
    this.gen++
    const server = this.server
    const turnId = this.router.activeTurnId
    const threadId = this.router.threadId
    this.server = null
    this.starting = null
    this.thread = null
    this.threadStarting = null
    this.router.abandon()
    this.freeShots()
    if (!server) return
    if (turnId && threadId) server.interrupt(threadId, turnId)
    server.kill()
  }

  private turnEnded(end: TurnEnd): void {
    this.freeShots()
    if (!end.error) return
    // Разговор не влезает в окно модели: следующий вопрос — в новой нити.
    if (isContextOverflow(end.error)) this.thread = null
    // Вход слетел: процесс мог закэшировать старые токены — следующий вопрос поднимет новый.
    if (end.error.kind === 'not-logged-in') this.kill()
  }

  private freeShots(): void {
    const release = this.releaseShots
    this.releaseShots = null
    void release?.()
  }

  private getServer(): Promise<AppServer> {
    if (this.server?.alive && this.server.initialized) return Promise.resolve(this.server)
    if (this.starting) return this.starting
    const gen = this.gen
    const web = this.wantWeb()
    this.startingWeb = web
    const p = (async () => {
      const c = await resolveCodex()
      if (!c) throw new LlmError('not-installed', 'codex')
      const [cwd, env, mcpServers] = await Promise.all([providerWorkDir('codex'), cliEnv(c.env), userMcpServers()])
      if (gen !== this.gen) throw new CancelledError()
      const server = new AppServer(c, cwd, env, { web, mcpServers }, {
        onLine: () => {
          if (gen === this.gen) this.queue.activity()
        },
        onNotification: (method, params) => {
          if (gen === this.gen) this.router.handle(method, params)
        },
        onExit: (err) => this.serverExited(gen, err),
      })
      this.server = server
      try {
        await server.init
      } catch (e) {
        if (gen === this.gen && this.server === server) {
          server.kill()
          this.server = null
        }
        throw e
      }
      if (gen !== this.gen) throw new CancelledError()
      this.queue.processStarted()
      return server
    })()
    this.starting = p
    const clear = () => {
      if (this.starting === p) this.starting = null
    }
    p.then(clear, clear)
    return p
  }

  /** Процесс умер сам: вопросы в работе и в очереди падают с понятной ошибкой, следующий поднимет новый. */
  private serverExited(gen: number, err: LlmError): void {
    if (gen !== this.gen) return
    console.warn(`[codex] app-server завершился: ${err.raw ?? err.message}`)
    this.server = null
    this.starting = null
    this.thread = null
    this.threadStarting = null
    this.router.abandon()
    this.freeShots()
    this.queue.failAll(err)
  }

  private threadKey(): string {
    return JSON.stringify([this.cfg.model || '', this.instructions()])
  }

  private instructions(): string {
    return suggestSystemPrompt(this.cfg.systemPrompt)
  }

  private async ensureThread(server: AppServer): Promise<string> {
    const key = this.threadKey()
    if (this.thread && this.thread.server === server && this.thread.key === key) return this.thread.id
    const pending = this.threadStarting
    if (pending && pending.server === server && pending.key === key) return pending.p
    const p = this.startThread(server, key)
    this.threadStarting = { key, server, p }
    try {
      return await p
    } finally {
      if (this.threadStarting?.p === p) this.threadStarting = null
    }
  }

  private async startThread(server: AppServer, key: string): Promise<string> {
    const cwd = await providerWorkDir('codex')
    const input = { model: this.cfg.model || undefined, cwd, developerInstructions: this.instructions(), launch: server.launch }
    let res: unknown
    try {
      res = await server.rpc.request('thread/start', buildThreadStartParams(input), { timeoutMs: THREAD_START_TIMEOUT_MS })
    } catch (e) {
      // В 0.154 песочница пишется «read-only»; документация показывает «readOnly». Не узнал — пробуем второе.
      if (!(e instanceof RpcRemoteError) || !isSandboxCasingError(e.message)) throw toLlmError(e)
      try {
        res = await server.rpc.request('thread/start', buildThreadStartParams({ ...input, legacyCasing: true }), { timeoutMs: THREAD_START_TIMEOUT_MS })
      } catch (e2) {
        throw toLlmError(e2)
      }
    }
    const id = threadIdOf(res)
    if (!id) throw new LlmError('unknown', 'codex', `${AGENT} не открыл разговор: в ответе нет id нити`)
    if (this.server === server) this.thread = { id, key, server }
    return id
  }
}

/* ---------- адаптер ---------- */

export function createCodexAdapter(): ProviderAdapter {
  const state = new CodexState()
  const probe = new Probe()

  async function detect(): Promise<Availability> {
    try {
      const c = await resolveCodex()
      if (!c) return { state: 'not-installed' }
      const t0 = Date.now()
      // Проверка — всегда свежим процессом: старый мог запомнить состояние входа до `codex login`.
      // Реестр зовёт detect не чаще раза в минуту, а listModels следом возьмёт этот же процесс.
      probe.dropIfIdle()
      try {
        return await withTimeout(
          probe.use(async (s) => {
            const res = await s.rpc.request('account/read', {}, { timeoutMs: DETECT_APP_SERVER_MS })
            const a = parseAccountRead(res)
            const version = versionFrom(s.userAgent)
            return a.state === 'ok' && version ? { ...a, version } : a
          }),
          DETECT_APP_SERVER_MS,
          () => probe.drop(),
        )
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'not-installed') return { state: 'not-installed' }
        // app-server не поднялся (старая версия, сбой запуска) — спросим проще, если время есть.
        const left = DETECT_BUDGET_MS - (Date.now() - t0)
        if (left < 1_000) return { state: 'unknown', message: `${AGENT} не ответил на проверку` }
        const r = await runCli(c.cmd, ['login', 'status'], { env: await cliEnv(c.env), timeoutMs: Math.min(left, 3_000) })
        if (r.timedOut) return { state: 'unknown', message: `${AGENT} не ответил на проверку` }
        if (r.error) return { state: 'error', message: r.error.message }
        return parseLoginStatus(r.code, r.stdout, r.stderr)
      }
    } catch (e) {
      return { state: 'error', message: errText(e) }
    }
  }

  return {
    id: 'codex',
    detect,
    // Бросает при неудаче намеренно: registry тогда отдаёт запасной каталог и не кэширует
    // его как живой — следующий запрос попробует снова.
    listModels: () => withTimeout(probe.use((s) => state.fetchModels(s)), LIST_MODELS_BUDGET_MS, () => probe.drop()),
    createSession: (role: SessionRole) => {
      const s = new CodexSession(state, role)
      state.sessions.add(s)
      return s
    },
    async openLogin(): Promise<void> {
      const c = await resolveCodex()
      const extra: NodeJS.ProcessEnv = { ...c?.env }
      const env = await cliEnv(extra)
      // `codex` из окна терминала должен найти тот же бинарник, что нашли мы, — даже если
      // его папки ещё нет в PATH (автономная установка минуту назад).
      if (c) {
        const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
        env[key] = `${dirname(c.cmd.path)}${delimiter}${env[key] ?? ''}`
      }
      await openInTerminal(INFO.login?.command ?? 'codex login', { env })
      // Процессы, поднятые до входа, могли запомнить «входа нет».
      probe.dropIfIdle()
      for (const s of state.sessions) s.resetIfIdle()
    },
  }
}
