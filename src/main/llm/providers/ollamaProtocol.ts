import type { Effort, ModelInfo } from '../../../shared/providers.ts'
import type { ImageInput, LlmErrorKind } from '../types.ts'

/**
 * Протокол Ollama: HTTP API на этом компьютере (docs/api.md и docs/api/*.mdx в ollama/ollama).
 *
 * Модуль чистый — без сети и electron: разбор проверяется тестами (tests/ollama-protocol.test.ts).
 * Сами запросы — в ollama.ts.
 *
 * Что взято из документации и исходников Ollama:
 * - Адрес — OLLAMA_HOST, по умолчанию http://127.0.0.1:11434. Разбор повторяет envconfig.Host;
 *   адрес «слушать всё» (0.0.0.0, ::) клиенту не годится — на Windows к нему не подключиться,
 *   поэтому, как envconfig.ConnectableHost, меняем его на loopback.
 * - GET /api/tags — скачанные модели; в новых версиях у каждой есть capabilities.
 *   POST /api/show — сведения о модели, capabilities: completion, vision, thinking, embedding…
 * - POST /api/chat — поток NDJSON: {message:{content, thinking}, done}. Ошибка посреди потока —
 *   строка {"error": "..."}, код ответа при этом уже 200.
 * - think — только для думающих моделей (capability thinking). GPT-OSS булево значение
 *   игнорирует и понимает только уровни low/medium/high.
 * - images — массив base64 в сообщении, для моделей со зрением (capability vision).
 * - Пустой messages у /api/chat — просто загрузить модель в память (прогрев).
 */

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

/* ---------- сервер не отвечает ---------- */

/**
 * Ошибка вопроса, когда по адресу Ollama никто не слушает. Решает, что сказать, так же, как
 * проверка провайдера (detect в ollama.ts): программа установлена или адрес задан в
 * OLLAMA_HOST — значит, сервер не запущен или адрес неверный, это не «не установлена», и
 * «Как установить» тут не помог бы. Только без программы на стандартном адресе — «не установлена».
 */
export function ollamaUnreachable(base: string, installed: boolean): { kind: LlmErrorKind; message: string } {
  if (installed) {
    return { kind: 'network', message: `Ollama установлена, но не отвечает по адресу ${base}: запустите её из меню «Пуск» и повторите вопрос.` }
  }
  if (base !== DEFAULT_OLLAMA_URL) {
    return { kind: 'network', message: `Ollama не отвечает по адресу ${base} (из OLLAMA_HOST): проверьте, что сервер запущен и адрес верный.` }
  }
  return { kind: 'not-installed', message: `Ollama не отвечает по адресу ${base} и не найдена на этом компьютере. Установите Ollama или выберите другого провайдера.` }
}

/* ---------- ожидание первого байта ---------- */

/** Как часто сообщать очереди «сервер жив», пока Ollama грузит модель и читает промпт. */
export const LOAD_HEARTBEAT_MS = 5_000
/**
 * Дольше этого загрузку и чтение промпта жизнью не считаем: дальше действует обычный таймаут
 * по тишине, и по-настоящему зависший сервер всё-таки обрывается. Четыре минуты — с запасом на
 * холодную загрузку большой модели с медленного диска и длинную расшифровку на процессоре.
 */
export const LOAD_HEARTBEAT_CAP_MS = 4 * 60_000

/**
 * Пульс ожидания. Ollama до первого сгенерированного слова не шлёт ничего, даже заголовков:
 * scheduleRunner (загрузка модели) и разбор промпта идут раньше streamResponse
 * (server/routes.go). Без пульса таймаут по тишине (45 с) обрывал медленную локальную
 * модель на каждом вопросе. beat зовётся каждые everyMs, пока alive() и не истёк cap;
 * вернувшаяся функция останавливает пульс (первый байт, конец, обрыв).
 */
export function startHeartbeat(opts: { beat: () => void; alive: () => boolean; everyMs?: number; capMs?: number }): () => void {
  const every = opts.everyMs ?? LOAD_HEARTBEAT_MS
  const cap = opts.capMs ?? LOAD_HEARTBEAT_CAP_MS
  const started = Date.now()
  const timer = setInterval(() => {
    if (!opts.alive() || Date.now() - started >= cap) {
      clearInterval(timer)
      return
    }
    opts.beat()
  }, every)
  return () => clearInterval(timer)
}

/* ---------- адрес ---------- */

function isIPv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
}

function isIPv6(s: string): boolean {
  return s.includes(':') && /^[0-9a-f:.]+$/i.test(s)
}

/** Разбор «host:port» как net.SplitHostPort в Go: null — не разобрать. */
function splitHostPort(s: string): { host: string; port: string } | null {
  if (s.startsWith('[')) {
    const m = /^\[([^\]]*)\]:(.*)$/.exec(s)
    return m ? { host: m[1]!, port: m[2]! } : null
  }
  const i = s.lastIndexOf(':')
  if (i < 0 || s.indexOf(':') !== i) return null
  return { host: s.slice(0, i), port: s.slice(i + 1) }
}

/**
 * Базовый адрес API из OLLAMA_HOST — без завершающего «/».
 * «0.0.0.0:11434» → http://127.0.0.1:11434; «example.com» → http://example.com:11434.
 */
export function ollamaBaseUrl(envValue: string | undefined): string {
  const s = (envValue ?? '').trim()
  let defaultPort = '11434'
  let scheme = 'http'
  let hostport = s
  const cut = s.indexOf('://')
  if (cut < 0) {
    if (s === 'ollama.com') {
      scheme = 'https'
      hostport = 'ollama.com:443'
    }
  } else {
    scheme = s.slice(0, cut).toLowerCase()
    hostport = s.slice(cut + 3)
    if (scheme === 'http') defaultPort = '80'
    else if (scheme === 'https') defaultPort = '443'
  }
  const slash = hostport.indexOf('/')
  const path = slash >= 0 ? hostport.slice(slash + 1) : ''
  if (slash >= 0) hostport = hostport.slice(0, slash)

  let host: string
  let port: string
  const split = splitHostPort(hostport)
  if (split) {
    host = split.host
    port = split.port
  } else {
    port = defaultPort
    const bare = hostport.replace(/^\[|\]$/g, '')
    host = isIPv4(bare) || isIPv6(bare) ? bare : hostport || '127.0.0.1'
  }
  const n = Number(port)
  if (!/^\d+$/.test(port) || n > 65535) port = defaultPort
  if (!host) host = '127.0.0.1'

  // Адрес для прослушивания, а не для подключения.
  if (host === '0.0.0.0') host = '127.0.0.1'
  else if (host.includes(':') && /^[0:]+$/.test(host)) host = '::1'

  const hostPart = isIPv6(host) ? `[${host}]` : host
  const tail = path.replace(/\/+$/, '')
  return `${scheme}://${hostPart}:${port}${tail ? `/${tail}` : ''}`
}

/** Адрес на этом компьютере — значит, запрос не уходит в сеть. */
export function isLoopbackUrl(url: string): boolean {
  const host = /^\w+:\/\/(\[[^\]]+\]|[^/:]+)/.exec(url)?.[1]?.replace(/^\[|\]$/g, '').toLowerCase() ?? ''
  return host === 'localhost' || host === '::1' || /^127\./.test(host)
}

/* ---------- модели ---------- */

export interface OllamaTag {
  /** «qwen3:8b» — id для API */
  name: string
  family?: string
  parameterSize?: string
  /** из /api/tags новых версий; нет — узнавать через /api/show */
  capabilities?: string[]
  /** облачная модель ollama.com: запрос уходит в сеть */
  remote: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function capsOf(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase()) : undefined
}

/** Ответ GET /api/tags. Незнакомое и битое пропускаем: одна странная запись не должна прятать остальные. */
export function parseTags(json: unknown): OllamaTag[] {
  const list = isRecord(json) && Array.isArray(json.models) ? json.models : []
  const out: OllamaTag[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isRecord(item)) continue
    const name = str(item.name) ?? str(item.model)
    if (!name || seen.has(name)) continue
    seen.add(name)
    const details = isRecord(item.details) ? item.details : {}
    out.push({
      name,
      family: str(details.family),
      parameterSize: str(details.parameter_size),
      capabilities: capsOf(item.capabilities),
      remote: !!str(item.remote_host) || !!str(item.remote_model),
    })
  }
  return out
}

export interface ShowInfo {
  /** null — сервер не сообщает capabilities (старая версия Ollama) */
  capabilities: string[] | null
  family?: string
}

/** Ответ POST /api/show. */
export function parseShow(json: unknown): ShowInfo {
  if (!isRecord(json)) return { capabilities: null }
  const details = isRecord(json.details) ? json.details : {}
  return { capabilities: capsOf(json.capabilities) ?? null, family: str(details.family) }
}

/** Модель для чата: без capabilities не знаем — берём; есть — нужна completion (эмбеддинги прочь). */
export function isChatModel(caps: readonly string[] | null | undefined): boolean {
  return !caps || caps.includes('completion')
}

/** «qwen3:latest» → «qwen3»: тег latest в подписи ничего не говорит. */
export function displayName(name: string): string {
  return name.replace(/:latest$/i, '')
}

export function toModelInfo(tag: OllamaTag, caps: readonly string[] | null | undefined): ModelInfo {
  const vision = caps ? caps.includes('vision') : undefined
  const parts = [tag.parameterSize, vision ? 'видит снимки' : undefined, caps?.includes('thinking') ? 'думает' : undefined]
  // Облачная модель нарушает обещание «запрос не уходит в сеть» — говорим об этом прямо в подписи.
  if (tag.remote) parts.push('облако ollama.com: запрос уходит в сеть')
  const name = displayName(tag.name)
  return {
    id: tag.name,
    name,
    // «library/qwen3:8b» → «qwen3»: в узком окне тег и пространство имён не помещаются.
    short: name.split(':')[0]!.split('/').pop() || name,
    hint: parts.filter(Boolean).join(' · '),
    // Глубину в окне даём только Claude; «думает/сразу» у Ollama — это think.
    efforts: null,
    images: vision,
  }
}

/* ---------- запрос ---------- */

export type ThinkValue = boolean | 'low' | 'medium' | 'high'

const isGptOss = (model: string, family?: string) => /gpt-?oss/i.test(model) || /gpt-?oss/i.test(family ?? '')

/**
 * Значение think. Не думающей модели поле не передаём: Ollama отвечает на него ошибкой
 * «does not support thinking». capabilities неизвестны (старый сервер) — тоже не передаём.
 */
export function thinkValue(
  model: string,
  info: ShowInfo | null | undefined,
  thinking: boolean,
  effort?: Effort | 'default',
): ThinkValue | undefined {
  if (!info?.capabilities?.includes('thinking')) return undefined
  if (!isGptOss(model, info.family)) return thinking
  // GPT-OSS не выключает размышления совсем: «сразу» — самый короткий след.
  if (!thinking) return 'low'
  if (effort === 'minimal' || effort === 'low') return 'low'
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'high'
  return 'medium'
}

export interface ChatBodyInput {
  model: string
  system: string
  text: string
  images?: ImageInput[]
  think?: ThinkValue
  keepAlive?: string
}

/**
 * Тело POST /api/chat. Каждый вопрос — отдельный запрос с системным сообщением: расшифровка и
 * найденное в базе уже стоят в тексте вопроса, а копить историю в маленьком контексте локальной
 * модели — значит, быстро вытеснить системный промпт.
 */
export function chatBody(i: ChatBodyInput): Record<string, unknown> {
  const user: Record<string, unknown> = { role: 'user', content: i.text }
  if (i.images?.length) user.images = i.images.map((img) => img.data)
  const body: Record<string, unknown> = {
    model: i.model,
    messages: [{ role: 'system', content: i.system }, user],
    stream: true,
  }
  if (i.think !== undefined) body.think = i.think
  if (i.keepAlive) body.keep_alive = i.keepAlive
  return body
}

/** Тело прогрева: пустой messages — только загрузить модель. */
export function loadBody(model: string, keepAlive?: string): Record<string, unknown> {
  return keepAlive ? { model, messages: [], keep_alive: keepAlive } : { model, messages: [] }
}

/* ---------- поток ---------- */

/** Строки NDJSON из кусков потока: кусок может оборваться посреди строки. */
export class NdjsonSplitter {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split('\n')
    this.buf = parts.pop() ?? ''
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim())
  }

  /** Остаток без перевода строки в конце потока. */
  flush(): string[] {
    const rest = this.buf.trim()
    this.buf = ''
    return rest ? [rest] : []
  }
}

export type ChatEvent =
  | { type: 'error'; message: string }
  | { type: 'chunk'; content: string; thinking: string; done: boolean; doneReason?: string }

/** Строка потока /api/chat. null — не JSON или не похоже на ответ. */
export function parseChatLine(line: string): ChatEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  if (typeof raw.error === 'string') return { type: 'error', message: raw.error }
  if (isRecord(raw.error) && typeof raw.error.message === 'string') return { type: 'error', message: raw.error.message }
  const msg = isRecord(raw.message) ? raw.message : {}
  return {
    type: 'chunk',
    content: typeof msg.content === 'string' ? msg.content : '',
    thinking: typeof msg.thinking === 'string' ? msg.thinking : '',
    done: raw.done === true,
    doneReason: typeof raw.done_reason === 'string' ? raw.done_reason : undefined,
  }
}

/** Текст ошибки из тела ответа с кодом не 200: {"error": "..."} или как есть. */
export function errorFromBody(body: string): string {
  try {
    const raw: unknown = JSON.parse(body)
    if (isRecord(raw) && typeof raw.error === 'string') return raw.error
  } catch {
    /* не JSON */
  }
  return body.trim().slice(0, 500)
}

/** Вид ошибки по коду ответа и тексту. status undefined — ошибка посреди потока. */
export function classifyOllamaError(status: number | undefined, message: string): LlmErrorKind {
  if (/does not support (images|vision)|image input is not supported|vision.*not supported|multimodal/i.test(message)) return 'images-unsupported'
  if (status === 404 || /model .*not found|not found, try pulling|pull the model|no such model/i.test(message)) return 'model-unavailable'
  if (status === 429 || /rate limit|too many requests|usage limit/i.test(message)) return 'rate-limit'
  if (status === 401 || status === 403 || /unauthori[sz]ed|sign ?in|signin/i.test(message)) return 'not-logged-in'
  if (status === 502 || status === 503 || /cannot be reached|connection refused|no such host|network/i.test(message)) return 'network'
  return 'unknown'
}

/** Готовый текст для окна. model — как выбрана, для «ollama pull». */
export function ollamaErrorText(kind: LlmErrorKind, message: string, model: string): string {
  const detail = message.trim().slice(0, 300)
  switch (kind) {
    case 'model-unavailable':
      return `Модели ${model || 'без имени'} нет в Ollama. Скачайте её (ollama pull ${model || '<модель>'}) или выберите другую.`
    case 'images-unsupported':
      return `Модель ${model} в Ollama не умеет смотреть на снимки экрана. Для снимка выберите модель с пометкой «видит снимки» или другого провайдера.`
    case 'rate-limit':
      return `Облачная модель Ollama упёрлась в лимит: ${detail}`
    case 'not-logged-in':
      return `Облачной модели Ollama нужен вход: выполните ollama signin в терминале. ${detail}`.trim()
    case 'network':
      return `Ollama не достучалась до облачной модели: ${detail}`
    default:
      if (/out of memory|requires more system memory|insufficient memory|cuda error/i.test(message)) {
        return `Модели ${model} не хватает памяти в Ollama: выберите модель поменьше или закройте другие программы. ${detail}`
      }
      return `Ollama вернула ошибку: ${detail || 'без описания'}`
  }
}
