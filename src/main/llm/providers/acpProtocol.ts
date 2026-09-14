import { providerById } from '../../../shared/providers.ts'
import { RpcRemoteError } from '../jsonrpc.ts'
import { LlmError, llmErrorText, type ImageInput, type LlmErrorKind, type ModelInfo, type ProviderId } from '../types.ts'

/**
 * Agent Client Protocol (ACP) — разбор и сборка сообщений, без процесса.
 *
 * Модуль чистый: его проверяют тесты под голым Node (tests/acp-protocol.test.ts).
 * Процесс, потоки и electron — в acp.ts.
 *
 * Сверено со схемой протокола v1 (github.com/agentclientprotocol/agent-client-protocol,
 * schema/v1/schema.json, выпуск 1.21.0 от 20.08.2026) и с тем, что реально отвечает
 * Cursor Agent 2026.09.10 (матрица реестра ACP от 14.09.2026):
 * - initialize → { protocolVersion, agentCapabilities.promptCapabilities.image, authMethods[] };
 *   у способа входа поле type: нет — «agent» (вход делает сам агент), 'terminal' — только
 *   в терминале, 'env_var' — через переменную окружения.
 * - session/new без входа — ошибка -32000 «Authentication required».
 * - Выбор модели: в стабильной схеме — configOptions с category 'model' и
 *   session/set_config_option. Старый нестабильный путь (models.availableModels +
 *   session/set_model) из схемы убран 01.06.2026, но Cursor его ещё отвечает —
 *   поддерживаем оба.
 * - Режим: configOptions с category 'mode' или modes.availableModes + session/set_mode.
 * - Веб-инструменты Cursor (форум Cursor, отчёт по 2026.07.09): поиск приходит как
 *   tool_call с kind 'search', toolCallId «web_search_N» и title «Web search: …» и в ACP
 *   всегда спрашивает разрешение; чтение страницы — WebFetch, без разрешения в настройках
 *   тоже спрашивает (документация Cursor, CLI → Permissions).
 */

export const ACP_PROTOCOL_VERSION = 1

/* ---------- initialize ---------- */

export interface AcpAuthMethod {
  id: string
  name: string
  /** 'agent' — вход делает сам агент по authenticate; 'terminal', 'env_var' — нам недоступны */
  type: string
}

export interface AcpInit {
  protocolVersion: number
  /** агент принимает картинки в session/prompt */
  image: boolean
  authMethods: AcpAuthMethod[]
  agentName?: string
  agentVersion?: string
}

/**
 * Параметры initialize. Файловой системы и терминала клиенту не даём: суфлёру нечего
 * читать и запускать, а без этих возможностей агент не пришлёт fs/* и terminal/*.
 */
export function initializeParams(clientVersion: string): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'podskazych', title: 'Подсказыч', version: clientVersion },
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function parseInitialize(result: unknown): AcpInit {
  const r = isObj(result) ? result : {}
  const caps = isObj(r.agentCapabilities) ? r.agentCapabilities : {}
  const prompt = isObj(caps.promptCapabilities) ? caps.promptCapabilities : {}
  const info = isObj(r.agentInfo) ? r.agentInfo : {}
  const authMethods: AcpAuthMethod[] = []
  for (const m of Array.isArray(r.authMethods) ? r.authMethods : []) {
    if (!isObj(m) || typeof m.id !== 'string') continue
    authMethods.push({ id: m.id, name: str(m.name) ?? m.id, type: str(m.type) ?? 'agent' })
  }
  return {
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : -1,
    image: prompt.image === true,
    authMethods,
    agentName: str(info.title) ?? str(info.name),
    agentVersion: str(info.version),
  }
}

/**
 * Каким способом войти без участия пользователя. Только type 'agent' и только из
 * разрешённого списка: authenticate у незалогиненного агента может открыть браузер или
 * повиснуть в ожидании входа — это должно происходить в терминале по кнопке «Войти».
 */
export function pickAuthMethod(methods: AcpAuthMethod[], allowed: readonly string[]): AcpAuthMethod | null {
  return methods.find((m) => m.type === 'agent' && allowed.includes(m.id)) ?? null
}

/* ---------- session/new: модели и режимы ---------- */

export interface AcpChoice {
  id: string
  name: string
  description?: string
}

/**
 * Переключатель модели или режима. via 'config' — session/set_config_option с configId,
 * via 'legacy' — session/set_model или session/set_mode.
 */
export interface AcpSelector {
  via: 'config' | 'legacy'
  configId?: string
  current: string
  options: AcpChoice[]
}

export interface AcpSessionInfo {
  sessionId: string
  model: AcpSelector | null
  mode: AcpSelector | null
}

/** Варианты select-опции: бывают плоским списком и сгруппированными. */
function flattenOptions(options: unknown): AcpChoice[] {
  const out: AcpChoice[] = []
  for (const o of Array.isArray(options) ? options : []) {
    if (!isObj(o)) continue
    if (Array.isArray(o.options)) {
      out.push(...flattenOptions(o.options))
      continue
    }
    if (typeof o.value !== 'string') continue
    out.push({ id: o.value, name: str(o.name) ?? o.value, description: str(o.description) })
  }
  return out
}

function configSelector(configOptions: unknown, category: 'model' | 'mode'): AcpSelector | null {
  for (const o of Array.isArray(configOptions) ? configOptions : []) {
    if (!isObj(o) || o.type !== 'select' || typeof o.id !== 'string') continue
    // category необязательна: агент без неё, но с id 'model' тоже считается переключателем модели.
    if (o.category !== category && !(o.category == null && o.id === category)) continue
    const options = flattenOptions(o.options)
    if (!options.length) continue
    return { via: 'config', configId: o.id, current: str(o.currentValue) ?? '', options }
  }
  return null
}

function legacyModels(models: unknown): AcpSelector | null {
  if (!isObj(models) || !Array.isArray(models.availableModels)) return null
  const options: AcpChoice[] = []
  for (const m of models.availableModels) {
    if (!isObj(m) || typeof m.modelId !== 'string') continue
    options.push({ id: m.modelId, name: str(m.name) ?? m.modelId, description: str(m.description) })
  }
  return options.length ? { via: 'legacy', current: str(models.currentModelId) ?? '', options } : null
}

function legacyModes(modes: unknown): AcpSelector | null {
  if (!isObj(modes) || !Array.isArray(modes.availableModes)) return null
  const options: AcpChoice[] = []
  for (const m of modes.availableModes) {
    if (!isObj(m) || typeof m.id !== 'string') continue
    options.push({ id: m.id, name: str(m.name) ?? m.id, description: str(m.description) })
  }
  return options.length ? { via: 'legacy', current: str(modes.currentModeId) ?? '', options } : null
}

/** Ответ session/new: id сессии и переключатели. Стабильные configOptions важнее старых полей. */
export function parseNewSession(result: unknown): AcpSessionInfo {
  const r = isObj(result) ? result : {}
  if (typeof r.sessionId !== 'string' || !r.sessionId) throw new Error('session/new: агент не вернул sessionId')
  return {
    sessionId: r.sessionId,
    model: configSelector(r.configOptions, 'model') ?? legacyModels(r.models),
    mode: configSelector(r.configOptions, 'mode') ?? legacyModes(r.modes),
  }
}

/**
 * Свежие configOptions (ответ set_config_option или config_option_update) поверх
 * известного. Переключатель, который пришёл через старые поля, они не отменяют.
 */
export function applyConfigOptions(info: AcpSessionInfo, configOptions: unknown): void {
  const model = configSelector(configOptions, 'model')
  const mode = configSelector(configOptions, 'mode')
  if (model || info.model?.via === 'config') info.model = model ?? info.model
  if (mode || info.mode?.via === 'config') info.mode = mode ?? info.mode
}

/** Запрос на переключение: метод зависит от того, как агент объявил переключатель. */
export function selectRequest(
  sessionId: string,
  sel: AcpSelector,
  value: string,
  kind: 'model' | 'mode',
): { method: string; params: Record<string, unknown> } {
  if (sel.via === 'config') {
    return { method: 'session/set_config_option', params: { sessionId, configId: sel.configId, value } }
  }
  return kind === 'model'
    ? { method: 'session/set_model', params: { sessionId, modelId: value } }
    : { method: 'session/set_mode', params: { sessionId, modeId: value } }
}

/** Последний сегмент id: режимы бывают и «ask», и URI вида «…/session-modes#ask». */
const idTail = (id: string) => id.toLowerCase().replace(/^.*[#/]/, '')

/**
 * Режим «только чтение» для суфлёра. Cursor объявляет agent/plan/ask: ask — вопросы и
 * ответы без правок. plan тоже без правок, но он строит план работ и ждёт его
 * одобрения — отвечать на вопрос созвона так нельзя, поэтому plan не берём.
 */
export function pickReadOnlyMode(sel: AcpSelector | null): string | null {
  if (!sel) return null
  const byTail = (names: string[]) => sel.options.find((o) => names.includes(idTail(o.id)))
  const byName = (names: string[]) => sel.options.find((o) => names.includes(o.name.trim().toLowerCase()))
  const hit = byTail(['ask']) ?? byName(['ask']) ?? byTail(['read-only', 'readonly', 'read_only']) ?? byName(['read-only', 'read only'])
  return hit?.id ?? null
}

/**
 * Модель из выбора пользователя — в значение переключателя агента. Точный id, потом
 * без учёта регистра, потом по имени («Auto»), потом параметризованный вариант
 * («gpt-5.5[effort=high]» для «gpt-5.5»). null — такой модели у агента нет.
 */
export function matchModel(sel: AcpSelector, wanted: string): string | null {
  const w = wanted.trim()
  if (!w) return null
  const lower = w.toLowerCase()
  const hit =
    sel.options.find((o) => o.id === w) ??
    sel.options.find((o) => o.id.toLowerCase() === lower) ??
    sel.options.find((o) => o.name.trim().toLowerCase() === lower) ??
    sel.options.find((o) => o.id.toLowerCase().startsWith(`${lower}[`))
  return hit?.id ?? null
}

/**
 * Живой список моделей для окна. Подписи и подсказки из каталога сохраняем там, где id
 * совпал: «сам выберет модель» у Auto лучше голого имени. Глубину у ACP-агентов
 * выбирает сам сервис — efforts null.
 */
export function modelsFromSelector(sel: AcpSelector, catalog: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const o of sel.options) {
    if (seen.has(o.id)) continue
    seen.add(o.id)
    const known = catalog.find((m) => m.id === o.id || m.id.toLowerCase() === o.id.toLowerCase())
    out.push(
      known
        ? { ...known, id: o.id }
        : { id: o.id, name: o.name || o.id, hint: o.description?.trim() || '', efforts: null },
    )
  }
  return out
}

/* ---------- session/prompt ---------- */

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * Содержимое вопроса. Системный промпт — первым текстовым блоком только в первом
 * вопросе сессии: отдельного поля для него в ACP нет. Порядок как у Claude Code:
 * промпт, снимки, вопрос — вопрос ссылается на снимки «выше», и слабая модель,
 * увидев промпт после картинок, отвечает на промпт.
 */
export function buildPrompt(input: { text: string; images?: ImageInput[]; system?: string }): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = []
  if (input.system?.trim()) blocks.push({ type: 'text', text: input.system })
  for (const img of input.images ?? []) blocks.push({ type: 'image', data: img.data, mimeType: img.mediaType })
  blocks.push({ type: 'text', text: input.text })
  return blocks
}

/* ---------- session/update ---------- */

export type AcpTurnEvent =
  | { type: 'delta'; text: string }
  | { type: 'break' }
  | { type: 'thinking' }
  | { type: 'tool'; name: string }

/** params уведомления session/update → само обновление, если оно для этой сессии. */
export function readUpdate(params: unknown, sessionId: string): Record<string, unknown> | null {
  if (!isObj(params) || params.sessionId !== sessionId || !isObj(params.update)) return null
  return typeof params.update.sessionUpdate === 'string' ? params.update : null
}

/**
 * Сборка одного ответа из session/update. Текст после вызова инструмента или из нового
 * сообщения (другой messageId) — новый абзац: иначе «Проверю через поиск.» и
 * следующий абзац склеиваются в одну строку, как было у Claude Code.
 */
export class AcpTurn {
  private wrote = false
  private gap = false
  private messageId: string | undefined

  push(u: Record<string, unknown>): AcpTurnEvent[] {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = isObj(u.content) ? u.content : null
        // Картинки и ресурсы в ответе суфлёру не нужны: окно показывает только текст.
        if (!c || c.type !== 'text' || typeof c.text !== 'string' || !c.text) return []
        const mid = str(u.messageId)
        const events: AcpTurnEvent[] = []
        if (this.wrote && (this.gap || (mid !== undefined && this.messageId !== undefined && mid !== this.messageId))) {
          events.push({ type: 'break' })
        }
        this.gap = false
        if (mid !== undefined) this.messageId = mid
        this.wrote = true
        events.push({ type: 'delta', text: c.text })
        return events
      }
      case 'agent_thought_chunk':
        // Сам текст размышлений не показываем, как и у Claude: важно только, что пауза осмысленная.
        return [{ type: 'thinking' }]
      case 'tool_call':
        if (this.wrote) this.gap = true
        return [{ type: 'tool', name: acpToolName(u) }]
      default:
        return []
    }
  }
}

/* ---------- инструменты и встречные запросы агента ---------- */

/** Виды инструментов, которые трогают компьютер пользователя: их веб-инструментом не считаем, как бы ни назывались. */
const LOCAL_TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'execute', 'switch_mode', 'think'])

/**
 * Веб-инструмент ли это: поиск в интернете или чтение страницы. Аргумент — toolCall из
 * session/request_permission или само обновление tool_call (поля те же: title, kind,
 * toolCallId). Поиск у Cursor — kind 'search' с «Web search» в title и «web_search» в id;
 * kind 'search' без этих слов — поиск по файлам, он не веб. kind 'fetch' по схеме ACP —
 * «получение внешних данных», это чтение адреса.
 */
export function webToolOf(toolCall: unknown): 'web_search' | 'web_fetch' | null {
  if (!isObj(toolCall)) return null
  const kind = (str(toolCall.kind) ?? '').toLowerCase()
  if (LOCAL_TOOL_KINDS.has(kind)) return null
  const label = `${str(toolCall.title) ?? ''} ${str(toolCall.toolCallId) ?? ''}`
  if (/\bweb[\s_-]?search/i.test(label)) return 'web_search'
  if (/\bweb[\s_-]?fetch/i.test(label)) return 'web_fetch'
  return kind === 'fetch' ? 'web_fetch' : null
}

/**
 * Имя инструмента для очереди (TurnHandlers.onTool). main узнаёт этап «ищу в интернете» по
 * словам web/search/fetch в имени, поэтому веб-инструменты зовём единообразно (web_search,
 * web_fetch), а локальным эти слова не отдаём: поиск по файлам — не поиск в интернете.
 */
export function acpToolName(u: Record<string, unknown>): string {
  const web = webToolOf(u)
  if (web) return web
  const kind = str(u.kind)
  if (kind === 'search') return 'grep'
  const title = str(u.title)
  if (title && !/web|search|fetch/i.test(title)) return title
  return kind || 'tool'
}

export interface PermissionPolicy {
  /** Разрешить веб-поиск и чтение страниц — только второму агенту, которому веб включили. */
  allowWeb?: boolean
}

type PermissionReply = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }

/**
 * Ответ на session/request_permission. Суфлёр только отвечает текстом: ни правок, ни команд —
 * на всё отказ. Единственное исключение — веб-инструменты второго агента с включённым вебом:
 * им allow_once. Никогда не allow_always и не reject_always: «всегда» агент может запомнить
 * в настройках пользователя. Отказного варианта нет — outcome cancelled, это тоже отказ.
 */
export function permissionResponse(params: unknown, policy: PermissionPolicy = {}): PermissionReply {
  const options = isObj(params) && Array.isArray(params.options) ? params.options.filter(isObj) : []
  const byKind = (k: string) => options.find((o) => o.kind === k && typeof o.optionId === 'string')
  const selected = (o: Record<string, unknown>): PermissionReply => ({ outcome: { outcome: 'selected', optionId: o.optionId as string } })
  if (policy.allowWeb && isObj(params) && webToolOf(params.toolCall)) {
    const allow = byKind('allow_once') ?? options.find((o) => typeof o.optionId === 'string' && /^allow[-_ ]?once$/i.test(o.optionId))
    if (allow) return selected(allow)
  }
  const pick = byKind('reject_once') ?? byKind('reject_always') ?? options.find((o) => typeof o.optionId === 'string' && /reject|deny/i.test(o.optionId))
  return pick ? selected(pick) : { outcome: { outcome: 'cancelled' } }
}

/**
 * Любой встречный запрос агента. Без ответа агент ждёт вечно, поэтому отвечаем всегда:
 * - session/request_permission — отказ (веб второму агенту — по policy);
 * - cursor/ask_question и cursor/create_plan (расширения Cursor, блокирующие) — отмена.
 *   Форма ответа по документации Cursor: { outcome: { outcome: "cancelled" } }; вложенность
 *   для «cancelled» там показана неоднозначно, взята как у варианта «answered»;
 * - fs/*, terminal/* и прочее — «метод не найден»: этих возможностей мы не объявляли.
 */
export function answerAgentRequest(method: string, params: unknown, policy: PermissionPolicy = {}): unknown {
  if (method === 'session/request_permission') return permissionResponse(params, policy)
  if (method === 'cursor/ask_question' || method === 'cursor/create_plan') return { outcome: { outcome: 'cancelled' } }
  throw new RpcRemoteError(-32601, `Method not found: ${method}`)
}

/* ---------- новая сессия и вход ---------- */

export interface NewSessionIo {
  provider: ProviderId
  /** запрос к агенту: session/new или authenticate */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
  /** процесс агента уже умер — его ошибка важнее ошибки запроса */
  exited(): LlmError | null
  /** способ входа без пользователя; null — звать authenticate нельзя */
  authMethod: AcpAuthMethod | null
  sessionTimeoutMs: number
  authTimeoutMs: number
}

/**
 * session/new с одним тихим входом. Без входа агент отвечает -32000: тогда один раз зовём
 * authenticate разрешённым способом и пробуем снова.
 *
 * Любой сбой authenticate — «нужен вход», и таймаут тоже: у Cursor cursor_login без
 * выполненного `agent login` не открывает браузер (NO_OPEN_BROWSER) и молча висит, так что
 * истёкшее ожидание и есть «нужен вход». Раньше таймаут уходил в окно как «не отвечает»:
 * каждый вопрос ждал 10 с и не предлагал войти. Лимит, сеть и прочие понятные виды
 * оставляем как есть. У повторного session/new таймаут — по-прежнему «не отвечает».
 */
export async function newSessionWithAuth(io: NewSessionIo, params: unknown): Promise<unknown> {
  let first: unknown
  try {
    return await io.request('session/new', params, io.sessionTimeoutMs)
  } catch (e) {
    if (!isAuthRequired(e)) throw toLlmError(io.provider, e)
    first = e
  }
  const method = io.authMethod
  if (!method) throw new LlmError('not-logged-in', io.provider, undefined, first instanceof Error ? first.message : String(first))
  try {
    await io.request('authenticate', { methodId: method.id }, io.authTimeoutMs)
  } catch (e) {
    const exited = io.exited()
    if (exited) throw exited
    const err = toLlmError(io.provider, e)
    if (err.kind === 'timeout' || err.kind === 'unknown' || err.kind === 'not-logged-in') {
      throw new LlmError('not-logged-in', io.provider, undefined, err.raw ?? err.message)
    }
    throw err
  }
  try {
    return await io.request('session/new', params, io.sessionTimeoutMs)
  } catch (e) {
    const exited = io.exited()
    if (exited) throw exited
    const err = toLlmError(io.provider, e)
    throw err.kind === 'unknown' ? new LlmError('not-logged-in', io.provider, undefined, err.raw ?? err.message) : err
  }
}

/* ---------- конец ответа и ошибки ---------- */

export type StopOutcome = { ok: true } | { ok: false; kind: LlmErrorKind; message: string }

/**
 * stopReason из ответа session/prompt. Обрезанный по лимиту ответ лучше, чем ничего:
 * отдаём, что успело прийти. Пустой ответ — ошибка: у Cursor неверный id модели
 * «молча» даёт пустой результат, и пустая панель читалась бы как зависание.
 */
export function stopOutcome(provider: ProviderId, stopReason: unknown, hasText: boolean): StopOutcome {
  const p = providerById(provider)
  switch (stopReason) {
    case 'cancelled':
      return { ok: false, kind: 'cancelled', message: llmErrorText('cancelled', provider) }
    case 'refusal':
      return hasText ? { ok: true } : { ok: false, kind: 'unknown', message: `${p.name} отказался отвечать на этот вопрос.` }
    case 'max_tokens':
    case 'max_turn_requests':
      return hasText ? { ok: true } : { ok: false, kind: 'unknown', message: `${p.agent} остановился по лимиту длины, не написав ответа.` }
    default:
      return hasText ? { ok: true } : { ok: false, kind: 'unknown', message: `${p.agent} вернул пустой ответ. Если повторится — выберите другую модель.` }
  }
}

const AUTH_RE = /auth(entication)? required|not (logged|signed) in|unauthori[sz]ed|unauthenticated|not authenticated|log ?in required|please (log|sign) ?in|run [`'"]?\S*\s*login|\/login/i
const RATE_RE = /rate.?limit|quota|usage limit|limit (reached|exceeded)|too many requests|\b429\b|out of (credits|requests)|insufficient (credits|quota)|premium requests?/i
const MODEL_RE = /model\b.{0,60}\b(not found|not available|unavailable|not supported|unsupported|invalid|unknown|not allowed|not enabled|disabled)|(unknown|invalid|unsupported) model|ai model not found/i
const IMAGE_RE = /(image|vision|multimodal).{0,40}(not supported|unsupported|not allowed|disabled)|does not support (image|vision)/i
const NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed|network (error|unreachable)|connection (error|refused|reset)|offline/i

export function looksLikeAuth(text: string): boolean {
  return AUTH_RE.test(text)
}

/** Ошибка протокола «нужен вход»: код -32000 по схеме ACP или тот же смысл текстом. */
export function isAuthRequired(e: unknown): boolean {
  if (e instanceof RpcRemoteError && e.code === -32000) return true
  return e instanceof Error && looksLikeAuth(e.message)
}

const clip = (s: string, max = 300) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * Ошибка агента (JSON-RPC или текст) → LlmError с понятным видом. Сырой текст — в raw
 * для лога, в окно — нейтральная фраза с именем провайдера.
 */
export function toLlmError(provider: ProviderId, e: unknown): LlmError {
  if (e instanceof LlmError) return e
  const message = e instanceof Error ? e.message : String(e)
  const data = e instanceof RpcRemoteError && e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ''
  const text = `${message}${data}`
  const kind = classifyText(text, e instanceof RpcRemoteError ? e.code : undefined)
  const detail = kind === 'rate-limit' || kind === 'model-unavailable' ? clip(message, 200) : undefined
  const msg = kind === 'unknown' ? `${providerById(provider).agent}: ${clip(message) || 'ошибка без описания'}` : llmErrorText(kind, provider, detail)
  return new LlmError(kind, provider, msg, clip(text, 2000))
}

export function classifyText(text: string, code?: number): LlmErrorKind {
  if (code === -32000) return 'not-logged-in'
  // Так jsonrpc.ts называет истёкший запрос: агент жив, но не отвечает.
  if (code === undefined && /нет ответа за \d+ с/.test(text)) return 'timeout'
  if (IMAGE_RE.test(text)) return 'images-unsupported'
  if (MODEL_RE.test(text)) return 'model-unavailable'
  if (RATE_RE.test(text)) return 'rate-limit'
  if (AUTH_RE.test(text)) return 'not-logged-in'
  if (NETWORK_RE.test(text)) return 'network'
  return 'unknown'
}

/**
 * Процесс агента завершился сам. stderr — последние строки: по ним видно, не вход ли
 * это. Хвост в окно не тащим целиком — только последнюю строку, в нём бывают пути и почта.
 */
export function exitError(provider: ProviderId, code: number | null, stderr: string): LlmError {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  // Обёртку .cmd запускает cmd.exe: пропавшую программу он не находит сам и пишет об этом в stderr.
  if (/is not recognized as an internal or external command|не является внутренней или внешней/i.test(stderr)) {
    return new LlmError('not-installed', provider, undefined, clip(stderr, 2000))
  }
  if (AUTH_RE.test(stderr)) return new LlmError('not-logged-in', provider, undefined, clip(stderr, 2000))
  const detail = last ? clip(last, 200) : code !== null ? `Код выхода ${code}.` : ''
  return new LlmError('crashed', provider, llmErrorText('crashed', provider, detail), clip(stderr, 2000))
}

/* ---------- Cursor: проверка входа и папка версий ---------- */

/**
 * Вывод `agent status --format json`. Схема в документации Cursor не опубликована;
 * поля — как их читает сторонний Go SDK (cursor-agent-go, проверен на 2026.08.31):
 * { status, isAuthenticated, hasAccessToken, hasRefreshToken, userInfo }. Старый CLI без
 * --format json печатает текст — тогда ищем смысл словами. null — непонятно.
 */
export function parseCursorStatus(output: string): 'ok' | 'not-logged-in' | null {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
      if (typeof j.isAuthenticated === 'boolean') return j.isAuthenticated ? 'ok' : 'not-logged-in'
      if (typeof j.status === 'string') {
        if (/^(not|un)[_ -]?(authenticated|logged)|logged[_ -]?out/i.test(j.status)) return 'not-logged-in'
        if (/^(authenticated|logged[_ -]?in)$/i.test(j.status)) return 'ok'
      }
    } catch {
      /* не JSON — разбираем как текст */
    }
  }
  if (/not (logged|signed) in|not authenticated|unauthenticated|log ?in required/i.test(output)) return 'not-logged-in'
  if (/(logged|signed) in|authenticated/i.test(output)) return 'ok'
  return null
}

/**
 * Папка последней версии Cursor Agent в %LOCALAPPDATA%\cursor-agent\versions. Имена —
 * «2026.09.10-fd3934a», с лета 2026 ещё и со временем: «2026.06.15-03-48-54-da23e37»
 * (из-за этого формата в июне ломался сам лаунчер Cursor). Сортируем по дате, при
 * равной дате — по времени изменения папки.
 */
export function pickLatestVersionDir(dirs: Array<{ name: string; mtimeMs: number }>): string | null {
  const parsed = dirs
    .map((d) => {
      const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-[-a-z0-9]+$/i.exec(d.name)
      return m ? { name: d.name, key: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]), mtimeMs: d.mtimeMs } : null
    })
    .filter((d): d is { name: string; key: number; mtimeMs: number } => d !== null)
  parsed.sort((a, b) => b.key - a.key || b.mtimeMs - a.mtimeMs)
  return parsed[0]?.name ?? null
}
