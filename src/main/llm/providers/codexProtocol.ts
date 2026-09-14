import { LlmError, llmErrorText, type Availability, type Effort, type LlmErrorKind, type ModelInfo, type ProviderId } from '../types.ts'

/**
 * Протокол `codex app-server` (JSON-RPC 2.0 JSONL по stdio) — сборка сообщений и разбор
 * событий. Процесса здесь нет: его держит codex.ts, а этот модуль чистый и проверяется
 * тестами без Codex CLI (tests/codex-protocol.test.ts).
 *
 * Имена методов и полей сверены с исходниками тега rust-v0.154.0:
 * codex-rs/app-server-protocol/src/protocol/common.rs, v1.rs, v2/{thread,turn,item,model,
 * account,shared,notification,thread_data}.rs, protocol/src/openai_models.rs.
 * Что там неочевидно и уже стоило бы ошибки:
 * - approvalPolicy и sandbox — kebab-case («read-only»), хотя документация app-server
 *   показывает camelCase («readOnly»). Сервер у serde без псевдонимов: верна схема.
 * - Поля внутри вариантов UserInput не переименованы: `path` у localImage, `text_elements`
 *   у text (последнее не шлём — у него значение по умолчанию).
 * - codexErrorInfo — enum с rename_all camelCase: простой вид приходит строкой
 *   («usageLimitExceeded»), с кодом HTTP — объектом {"httpConnectionFailed":{"httpStatusCode":502}}.
 *   Регистр сравниваем без учёта: исследование и документация пишут PascalCase.
 * - Статус хода (TurnStatus) — camelCase: completed | interrupted | failed | inProgress.
 */

const P: ProviderId = 'codex'
const AGENT = 'Codex CLI'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/* ---------- запуск и нить ---------- */

/**
 * Что выключаем у Codex: суфлёру нужен только текст. Codex — агент для кода и по
 * умолчанию умеет запускать команды, править файлы, звать подагентов, приложения и
 * плагины. Песочница read-only и approvalPolicy never уже не дают ничего изменить,
 * но у Codex на Windows много открытых ошибок песочницы — надёжнее убрать сами
 * инструменты. Ключи — из codex-rs/features/src/lib.rs (FeatureSpec) и config.schema.json.
 * Незнакомый ключ features Codex только предупреждает в лог, запуск не ломает.
 */
export const CODEX_FEATURES_OFF: readonly string[] = [
  'shell_tool',
  // shell_tool=false не обязательно убирает единый exec_command: выключаем и его
  'unified_exec',
  'view_image',
  'sleep_tool',
  'multi_agent',
  'apps',
  'plugins',
  'tool_suggest',
  'image_generation',
  'browser_use',
  'computer_use',
  'hooks',
  'goals',
  'memories',
]

/**
 * С чем поднимать процесс и нить. Всё здесь влияет и на аргументы запуска, и на config нити.
 */
export interface CodexLaunch {
  /**
   * Веб-поиск — только второму агенту, которому его включили. Суфлёру (main) веб не нужен:
   * лишний инструмент — лишние секунды и соблазн модели «уточнить в интернете» посреди созвона.
   */
  web?: boolean
  /** MCP-серверы из config.toml пользователя, которые надо выключить (см. codexMcpServerNames) */
  mcpServers?: readonly string[]
}

/**
 * Режим веб-поиска Codex: верхнеуровневый ключ `web_search` = disabled | cached | indexed | live
 * (WebSearchMode в protocol/src/config_types.rs, rust-v0.154.0; по умолчанию cached — то есть
 * поиск включён, поэтому суфлёру выключаем явно). live — поиск с доступом к живым страницам,
 * как WebSearch/WebFetch у Claude. Это инструмент на стороне сервиса (ToolSpec::WebSearch в
 * core/src/tools/hosted_spec.rs): ни команд, ни файлов на компьютере он не трогает, так что
 * shell и прочие выключатели остаются выключенными и у второго агента.
 */
export const codexWebSearchMode = (web: boolean | undefined): 'live' | 'disabled' => (web ? 'live' : 'disabled')

/**
 * Имя MCP-сервера, которое можно выключить ключом `mcp_servers.<имя>.enabled`. Codex делит путь
 * ключа по точкам (config/src/overrides.rs), а `-c` — по первому «=»: имя с точкой, «=» или
 * кавычками адресовать нельзя. Пробелы и знаки cmd.exe тоже не берём — только буквы, цифры, «_», «-».
 */
export const isAddressableMcpName = (name: string): boolean => /^[\p{L}\p{N}_-]+$/u.test(name)

/**
 * Настройки нити: ключи через точку, как у `-c` (app-server отдаёт `config` из thread/start
 * в тот же разбор, что и переопределения командной строки, — config_manager.rs).
 */
export function codexThreadConfig(launch: CodexLaunch = {}): Record<string, string | number | boolean> {
  const cfg: Record<string, string | number | boolean> = {}
  for (const f of CODEX_FEATURES_OFF) cfg[`features.${f}`] = false
  Object.assign(cfg, {
    web_search: codexWebSearchMode(launch.web),
    // AGENTS.md из рабочей папки не нужен: папка пустая, а лишние байты — лишние токены.
    project_doc_max_bytes: 0,
    // Служебные блоки о рабочей папке, песочнице и приложениях — модели суфлёра не нужны,
    // а каждый вопрос платил бы за них токенами и временем.
    include_environment_context: false,
    include_permissions_instructions: false,
    include_apps_instructions: false,
    'history.persistence': 'none',
  })
  // Свои MCP-серверы пользователя суфлёру не нужны и опасны: инструменты с пометкой «только
  // чтение» Codex зовёт без спроса даже при approvalPolicy never (core/src/mcp_tool_call.rs),
  // а упавший сервер с required=true ломает thread/start. Пустая таблица `mcp_servers={}` не
  // помогла бы — слои настроек сливаются рекурсивно, — поэтому выключаем каждый по имени.
  for (const name of launch.mcpServers ?? []) {
    if (isAddressableMcpName(name)) cfg[`mcp_servers.${name}.enabled`] = false
  }
  return cfg
}

/**
 * Аргументы запуска `codex -c ... app-server`. Те же выключатели ещё и на весь процесс:
 * приложения, плагины и MCP Codex поднимает по настройкам процесса. Строки — без кавычек:
 * значение, которое не разбирается как TOML, Codex берёт как строку (utils/cli/src/
 * config_override.rs), а кавычки пришлось бы экранировать для командной строки. Поэтому
 * строкой идут только простые слова (disabled, live, none).
 */
export function codexServerArgs(launch: CodexLaunch = {}): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(codexThreadConfig(launch))) {
    if (typeof value === 'string' && !/^[a-z_-]+$/i.test(value)) continue
    args.push('-c', `${key}=${value}`)
  }
  args.push('app-server')
  return args
}

/**
 * Имена MCP-серверов из config.toml Codex — только тех, у кого задан способ запуска
 * (command или url). Выключатель `enabled=false` для имени, которого в настройках нет, создал
 * бы пустую запись без command и url, а такую Codex отвергает («invalid transport»,
 * config/src/mcp_types.rs) — и не запустился бы вовсе. Поэтому разбор осторожный: берём
 * [mcp_servers.<имя>] (и вложенные таблицы), ключи через точку и встроенные таблицы
 * `<имя> = { command = … }`. Чего не поняли — пропускаем.
 */
export function codexMcpServerNames(toml: string): string[] {
  const names = new Set<string>()
  let table: string[] = []
  let multiline: string | null = null
  for (const rawLine of toml.split(/\r?\n/)) {
    // Многострочные строки TOML: внутри них «ключи» — просто текст.
    if (multiline) {
      if (rawLine.split(multiline).length % 2 === 0) multiline = null
      continue
    }
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    const header = /^\[(?!\[)(.*)\]$/.exec(line)
    if (header) {
      table = splitTomlKey(header[1]!) ?? ['<непонятно>']
      continue
    }
    if (line.startsWith('[[')) {
      table = ['<массив>']
      continue
    }
    const kv = /^((?:"[^"]*"|'[^']*'|[\w-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[\w-]+))*)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const value = kv[2]!
    for (const q of ['"""', "'''"]) {
      if (value.split(q).length === 2) multiline = q
    }
    const key = splitTomlKey(kv[1]!)
    if (!key) continue
    const path = [...table, ...key]
    if (path[0] !== 'mcp_servers' || !path[1]) continue
    if (path.length >= 3 && (path[2] === 'command' || path[2] === 'url')) names.add(path[1])
    // Встроенная таблица одной строкой: github = { command = "npx", args = [...] }.
    if (path.length === 2 && /^\{(?:.*[,\s])?\s*(command|url)\s*=/.test(value)) names.add(path[1])
  }
  return [...names]
}

/** Комментарий TOML — «#» вне строки. */
function stripTomlComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#') return line.slice(0, i)
  }
  return line
}

/** Ключ TOML через точки → сегменты: a."b c".d → [a, b c, d]. null — не разобрать. */
function splitTomlKey(key: string): string[] | null {
  const out: string[] = []
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(\.|$)/y
  let pos = 0
  while (pos < key.length) {
    re.lastIndex = pos
    const m = re.exec(key)
    if (!m) return null
    out.push(m[1] ?? m[2] ?? m[3]!)
    pos = re.lastIndex
    if (!m[4]) break
  }
  return out.length && pos >= key.length ? out : null
}

export function buildInitializeParams(appVersion: string): Json {
  return {
    clientInfo: { name: 'podskazych', title: 'Подсказыч', version: appVersion || '0.0.0' },
  }
}

export interface ThreadStartInput {
  model?: string
  cwd: string
  developerInstructions: string
  /** запасное написание песочницы для старых версий, где enum был camelCase */
  legacyCasing?: boolean
  /** веб и выключенные MCP-серверы — те же, что у процесса */
  launch?: CodexLaunch
}

export function buildThreadStartParams(i: ThreadStartInput): Json {
  return {
    ...(i.model ? { model: i.model } : {}),
    cwd: i.cwd,
    approvalPolicy: 'never',
    sandbox: i.legacyCasing ? 'readOnly' : 'read-only',
    // developerInstructions добавляет наши правила к встроенным инструкциям Codex.
    // baseInstructions заменил бы их целиком — схема Codex прямо это не советует.
    developerInstructions: i.developerInstructions,
    // Эфемерная нить не пишет журнал разговора на диск: расшифровка созвона там ни к чему.
    ephemeral: true,
    config: codexThreadConfig(i.launch),
  }
}

/** Сервер не узнал написание песочницы — повторить со старым (camelCase). */
export function isSandboxCasingError(message: string): boolean {
  return /unknown variant/i.test(message) && /read-only|readOnly|sandbox/i.test(message)
}

export function threadIdOf(result: unknown): string | undefined {
  return isObj(result) && isObj(result.thread) ? str(result.thread.id) : undefined
}

export function turnIdOf(result: unknown): string | undefined {
  return isObj(result) && isObj(result.turn) ? str(result.turn.id) : undefined
}

export interface TurnStartInput {
  threadId: string
  text: string
  imagePaths?: string[]
  effort?: Effort
}

export function buildTurnStartParams(i: TurnStartInput): Json {
  return {
    threadId: i.threadId,
    // Снимки — перед текстом: модель сначала смотрит, потом читает вопрос о них.
    input: [...(i.imagePaths ?? []).map((path) => ({ type: 'localImage', path })), { type: 'text', text: i.text }],
    ...(i.effort ? { effort: i.effort } : {}),
  }
}

/* ---------- глубина размышлений ---------- */

const EFFORT_ORDER: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v)
}

/**
 * Глубина для turn/start. «Сразу» — low, «думает» — выбранная, по умолчанию medium.
 * supported — что умеет модель по model/list: undefined — неизвестно (шлём как есть),
 * null или пусто — глубина не настраивается (не шлём). Неподдержанную глубину сдвигаем
 * к ближайшей; при равенстве — к меньшей: на живом созвоне скорость важнее.
 */
export function pickEffort(thinking: boolean, effort: Effort | 'default' | undefined, supported?: readonly Effort[] | null): Effort | undefined {
  const want: Effort = !thinking ? 'low' : !effort || effort === 'default' ? 'medium' : effort
  if (supported === undefined) return want
  if (!supported || !supported.length) return undefined
  if (supported.includes(want)) return want
  const at = EFFORT_ORDER.indexOf(want)
  let best: Effort | undefined
  let bestDist = Infinity
  for (const e of EFFORT_ORDER) {
    if (!supported.includes(e)) continue
    const d = Math.abs(EFFORT_ORDER.indexOf(e) - at)
    if (d < bestDist) {
      best = e
      bestDist = d
    }
  }
  return best
}

/* ---------- модели ---------- */

export interface ModelPage {
  models: ModelInfo[]
  nextCursor: string | null
}

function shortHint(description: string | undefined): string {
  const text = (description ?? '').trim().split(/(?<=[.!?])\s/)[0] ?? ''
  if (text.length <= 60) return text.replace(/\.$/, '')
  return `${text.slice(0, 57).replace(/\s+\S*$/, '')}…`
}

/**
 * Ответ model/list → модели для окна. Скрытые из выбора Codex не показываем. Имя и
 * подсказку по-русски берём из нашего каталога, если модель там есть; для новой — как
 * пришло от сервиса. Глубины — из supportedReasoningEfforts (none/ultra/persistent окну
 * не нужны: ultra — это подагенты). Снимки — по inputModalities; поля нет — по умолчанию
 * Codex это text+image.
 */
export function parseModelList(result: unknown, known: readonly ModelInfo[] = []): ModelPage {
  const data = isObj(result) && Array.isArray(result.data) ? result.data : []
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of data) {
    if (!isObj(raw) || raw.hidden === true) continue
    const id = str(raw.model) || str(raw.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const k = known.find((m) => m.id === id)
    let efforts: Effort[] | null
    if (Array.isArray(raw.supportedReasoningEfforts)) {
      const list = raw.supportedReasoningEfforts
        .map((o) => (isObj(o) ? o.reasoningEffort : o))
        .filter(isEffort)
      efforts = list.length ? EFFORT_ORDER.filter((e) => list.includes(e)) : null
    } else {
      efforts = k?.efforts ?? null
    }
    const images = Array.isArray(raw.inputModalities) ? raw.inputModalities.includes('image') : true
    const m: ModelInfo = {
      id,
      name: k?.name ?? (str(raw.displayName) || id),
      hint: k?.hint ?? shortHint(str(raw.description)),
      efforts,
      images,
    }
    if (k?.short) m.short = k.short
    if (k?.note) m.note = k.note
    models.push(m)
  }
  const next = isObj(result) ? str(result.nextCursor) : undefined
  return { models, nextCursor: next || null }
}

/* ---------- вход ---------- */

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/**
 * account/read → {account: {type:"chatgpt", email, planType} | {type:"apiKey"} | null,
 * requiresOpenaiAuth}. Почту не берём: в окне достаточно тарифа.
 */
export function parseAccountRead(result: unknown): Availability {
  if (!isObj(result)) return { state: 'unknown', message: `${AGENT} не сообщил, выполнен ли вход` }
  const acc = result.account
  if (isObj(acc)) {
    switch (acc.type) {
      case 'chatgpt': {
        const plan = str(acc.planType)
        return { state: 'ok', account: plan ? `ChatGPT ${capital(plan)}` : 'ChatGPT' }
      }
      case 'apiKey':
        return { state: 'ok', account: 'ключ API' }
      case 'amazonBedrock':
        return { state: 'ok', account: 'Amazon Bedrock' }
      default:
        return { state: 'ok', account: str(acc.type) }
    }
  }
  // Аккаунта нет, но провайдеру Codex вход и не нужен (свой сервер моделей в config.toml).
  if (result.requiresOpenaiAuth === false) return { state: 'ok' }
  return { state: 'not-logged-in' }
}

/**
 * `codex login status`: код 0 — вход выполнен, 1 — нет. Текст идёт в stderr:
 * «Logged in using ChatGPT», «Logged in using an API key - sk-…», «Not logged in»
 * (codex-rs/cli/src/login.rs). Ключ из текста не берём.
 */
export function parseLoginStatus(code: number | null, stdout: string, stderr: string): Availability {
  const text = `${stderr}\n${stdout}`
  if (/not logged in/i.test(text)) return { state: 'not-logged-in' }
  if (code === 0) {
    if (/chatgpt/i.test(text)) return { state: 'ok', account: 'ChatGPT' }
    if (/api key/i.test(text)) return { state: 'ok', account: 'ключ API' }
    return { state: 'ok' }
  }
  if (code === 1) return { state: 'not-logged-in' }
  const tail = text.trim().split(/\r?\n/).filter(Boolean).pop()
  return { state: 'unknown', message: tail ? tail.slice(0, 200) : `${AGENT} не ответил, выполнен ли вход` }
}

/** «codex_app_server/0.154.0 (Windows …)» или «codex-cli 0.154.0» → «0.154.0». */
export function versionFrom(text: string | undefined): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/.exec(text ?? '')?.[0]
}

/* ---------- ошибки ---------- */

export interface TurnErrorWire {
  message?: unknown
  codexErrorInfo?: unknown
  additionalDetails?: unknown
}

/** codexErrorInfo → имя вида в нижнем регистре и код HTTP, если он есть. */
export function errorInfoOf(info: unknown): { name?: string; status?: number } {
  if (typeof info === 'string') return { name: info.toLowerCase() }
  if (!isObj(info)) return {}
  if (typeof info.httpStatusCode === 'number') return { status: info.httpStatusCode }
  const key = Object.keys(info)[0]
  if (!key) return {}
  const inner = info[key]
  const status = isObj(inner) && typeof inner.httpStatusCode === 'number' ? inner.httpStatusCode : undefined
  return { name: key.toLowerCase(), status }
}

const make = (kind: LlmErrorKind, message: string | undefined, raw: string) => new LlmError(kind, P, message, raw || undefined)

/** Разбор по тексту — когда вида нет: ошибка RPC, старый CLI или неизвестный вид. */
export function errorFromText(message: string, raw = message): LlmError {
  const m = message.trim()
  if (/usage limit|rate.?limit|too many requests|\b429\b|quota/i.test(m)) {
    return make('rate-limit', llmErrorText('rate-limit', P, m), raw)
  }
  if (/unauthori[sz]ed|\b401\b|not logged in|log ?in again|sign in again|re-?authenticat|refresh token|token (has )?expired/i.test(m)) {
    return make('not-logged-in', undefined, raw)
  }
  // Снимки — раньше моделей: «model does not support image input» подходит под оба.
  if (/image/i.test(m) && /not support|unsupported|does not accept|cannot (process|accept)/i.test(m)) {
    return make('images-unsupported', undefined, raw)
  }
  if (/model/i.test(m) && /not supported|unsupported|does not exist|not found|not available|unavailable|unknown model|no access|do not have access/i.test(m)) {
    return make('model-unavailable', undefined, raw)
  }
  if (/stream disconnected|error sending request|connection (refused|reset|closed|failed)|timed? ?out|dns|proxy|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(m)) {
    return make('network', undefined, raw)
  }
  return make('unknown', m ? `${AGENT} вернул ошибку: ${m}` : `${AGENT} вернул ошибку`, raw)
}

/** Разговор не помещается в окно модели: нить надо начать заново. */
export function isContextOverflow(e: unknown): boolean {
  return e instanceof LlmError && e.raw !== undefined && /contextwindowexceeded|context window|context length|maximum context/i.test(e.raw)
}

/**
 * TurnError из уведомления error или turn/completed → LlmError с понятным текстом.
 * raw — сырой текст с видом ошибки: для лога и чтобы понять, не переполнен ли контекст.
 */
export function classifyTurnError(err: TurnErrorWire | null | undefined): LlmError {
  const message = str(err?.message)?.trim() ?? ''
  const details = str(err?.additionalDetails)?.trim() ?? ''
  const { name, status } = errorInfoOf(err?.codexErrorInfo)
  const raw = [name, status, message, details].filter((x) => x !== undefined && x !== '').join(' | ')
  switch (name) {
    case 'usagelimitexceeded':
    case 'ratelimitexceeded':
      // Текст Codex говорит, когда лимит обновится, — это стоит показать.
      return make('rate-limit', llmErrorText('rate-limit', P, message), raw)
    case 'unauthorized':
      return make('not-logged-in', undefined, raw)
    case 'contextwindowexceeded':
      return make('unknown', 'Разговор стал длиннее, чем помещается в модель. Codex CLI начнёт его заново — повторите вопрос.', raw)
    case 'serveroverloaded':
      return make('unknown', 'Серверы ChatGPT сейчас перегружены. Повторите вопрос через минуту или выберите модель попроще.', raw)
    case 'internalservererror':
      return make('unknown', 'Сбой на стороне ChatGPT. Повторите вопрос.', raw)
    case 'cyberpolicy':
    case 'misalignmentpolicyviolation':
      return make('unknown', 'ChatGPT отказался отвечать: вопрос задел его правила безопасности. Переформулируйте или выберите другую модель.', raw)
    case 'httpconnectionfailed':
    case 'responsestreamconnectionfailed':
    case 'responsestreamdisconnected':
    case 'responsetoomanyfailedattempts':
      if (status === 401) return make('not-logged-in', undefined, raw)
      if (status === 429) return make('rate-limit', llmErrorText('rate-limit', P, message), raw)
      if (status !== undefined && status >= 500) {
        return make('unknown', 'Серверы ChatGPT сейчас не отвечают. Повторите вопрос через минуту.', raw)
      }
      return make('network', undefined, raw)
    default:
      if (status === 401) return make('not-logged-in', undefined, raw)
      if (status === 429) return make('rate-limit', llmErrorText('rate-limit', P, message), raw)
      return errorFromText(message || details, raw)
  }
}

/* ---------- встречные запросы сервера ---------- */

/**
 * Ответ на встречный запрос app-server. С approvalPolicy never и выключенными
 * инструментами их быть не должно; если всё же пришёл — отказ. Промолчать нельзя:
 * сервер ждал бы ответа вечно. undefined — ответить ошибкой JSON-RPC.
 */
export function serverRequestReply(method: string): Json | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      // «decline» — отказ, ход продолжается; «cancel» оборвал бы и сам ответ.
      return { decision: 'decline' }
    default:
      return undefined
  }
}

/* ---------- события хода ---------- */

/** Что роутер сообщает очереди. Совпадает с событиями TurnQueue из queue.ts. */
export interface TurnSink {
  delta(text: string): void
  blockBreak(): void
  thinking(): void
  tool(name: string): void
  finish(fallback?: string): void
  failTurn(err: Error): void
}

export interface TurnEnd {
  turnId: string | null
  error?: LlmError
}

/**
 * Элемент хода → имя инструмента для очереди. main показывает «ищу в интернете» по словам
 * web/search/fetch в имени: веб-поиск Codex (и встроенный, и отдельный web.run) приходит
 * элементом webSearch — он становится web_search.
 */
const TOOL_ITEMS: Record<string, string> = {
  commandExecution: 'shell',
  fileChange: 'apply_patch',
  webSearch: 'web_search',
  imageView: 'view_image',
  imageGeneration: 'image_generation',
  collabAgentToolCall: 'agent',
}

function agentTexts(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items.filter((i) => isObj(i) && i.type === 'agentMessage').map((i) => str((i as Json).text) ?? '').filter(Boolean)
}

/**
 * Уведомления app-server → события очереди для одного хода за раз.
 *
 * Ход начинается turn/start, но его id приходит ответом, а уведомления хода могут
 * опередить ответ. Поэтому begin() открывает ход без id, и первое событие нашей нити
 * с ещё не виденным turnId его назначает. События чужой нити, завершённого хода и хода,
 * брошенного по abandon(), молча отбрасываются: иначе хвост старого ответа дописался бы
 * в следующий вопрос.
 */
export class CodexTurnRouter {
  /** нить, в которой идут ходы; события других нитей не наши */
  threadId: string | null = null
  private readonly sink: TurnSink
  private readonly onEnd?: (end: TurnEnd) => void
  private token = 0
  private open = false
  private turnId: string | null = null
  private readonly done = new Set<string>()
  private lastItem: string | null = null
  private wrote = false
  private completed: string[] = []

  constructor(sink: TurnSink, onEnd?: (end: TurnEnd) => void) {
    this.sink = sink
    this.onEnd = onEnd
  }

  /** Ход ещё идёт (id может быть неизвестен). */
  get active(): boolean {
    return this.open
  }

  get activeTurnId(): string | null {
    return this.open ? this.turnId : null
  }

  /** Открыть ход. Возвращает метку: по ней send проверяет, что его ход ещё тот. */
  begin(): number {
    this.open = true
    this.turnId = null
    this.lastItem = null
    this.wrote = false
    this.completed = []
    return ++this.token
  }

  isCurrent(token: number): boolean {
    return this.open && this.token === token
  }

  /** id хода из ответа на turn/start. Ход мог уже закончиться — тогда ничего. */
  started(token: number, turnId: string | undefined): void {
    if (!turnId || !this.isCurrent(token) || this.done.has(turnId)) return
    if (!this.turnId) this.turnId = turnId
  }

  /** Бросить ход без событий очереди: процесс гасят или turn/start не удался. */
  abandon(): void {
    if (this.turnId) this.remember(this.turnId)
    this.open = false
    this.turnId = null
    this.token++
  }

  /** Уведомление сервера. true — оно относилось к текущему ходу. */
  handle(method: string, params: unknown): boolean {
    if (!this.open || !isObj(params)) return false
    const threadId = str(params.threadId)
    if (!threadId || threadId !== this.threadId) return false
    const turn = isObj(params.turn) ? params.turn : undefined
    const turnId = str(params.turnId) ?? str(turn?.id)
    if (!turnId || this.done.has(turnId)) return false
    if (this.turnId && turnId !== this.turnId) return false
    this.turnId ??= turnId

    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = str(params.delta)
        if (!delta) return true
        const item = str(params.itemId) ?? null
        // Новое сообщение после уже написанного — отдельным абзацем, а не склейкой.
        if (this.wrote && item !== this.lastItem) this.sink.blockBreak()
        this.lastItem = item
        this.wrote = true
        this.sink.delta(delta)
        return true
      }
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
        // Сам текст размышлений не показываем — окну важно знать, что пауза осмысленная.
        this.sink.thinking()
        return true
      case 'item/started': {
        const item = isObj(params.item) ? params.item : undefined
        const type = str(item?.type)
        if (type === 'reasoning') this.sink.thinking()
        else if (type === 'mcpToolCall' || type === 'dynamicToolCall') this.sink.tool(str(item?.tool) ?? type)
        else if (type && TOOL_ITEMS[type]) this.sink.tool(TOOL_ITEMS[type]!)
        return true
      }
      case 'item/completed': {
        const item = isObj(params.item) ? params.item : undefined
        if (item?.type === 'agentMessage' && str(item.text)) this.completed.push(str(item.text)!)
        return true
      }
      case 'error': {
        // willRetry — Codex сам повторит запрос, ход живёт дальше.
        if (params.willRetry === true) return true
        this.fail(classifyTurnError(isObj(params.error) ? params.error : undefined))
        return true
      }
      case 'turn/completed': {
        const status = str(turn?.status)
        if (status === 'completed') {
          const fromTurn = agentTexts(turn?.items)
          this.finish((fromTurn.length ? fromTurn : this.completed).join('\n\n'))
        } else if (status === 'failed') {
          this.fail(classifyTurnError(isObj(turn?.error) ? turn.error : undefined))
        } else if (status === 'interrupted') {
          // Сами мы прерываем ход, только когда гасим процесс, — а его события уже не слушаем.
          this.fail(new LlmError('unknown', P, `${AGENT} прервал ответ. Повторите вопрос.`, 'interrupted'))
        }
        return true
      }
      default:
        return true
    }
  }

  private close(): string | null {
    const id = this.turnId
    if (id) this.remember(id)
    this.open = false
    this.turnId = null
    this.token++
    return id
  }

  /** Завершённые ходы помним, чтобы их поздние события не открыли новый. Созвон — сотни вопросов, не больше. */
  private remember(id: string): void {
    this.done.add(id)
    if (this.done.size > 500) this.done.delete(this.done.values().next().value!)
  }

  private finish(fallback: string): void {
    const turnId = this.close()
    this.onEnd?.({ turnId })
    this.sink.finish(fallback || undefined)
  }

  private fail(error: LlmError): void {
    const turnId = this.close()
    this.onEnd?.({ turnId, error })
    this.sink.failTurn(error)
  }
}
