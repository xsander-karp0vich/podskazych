import type { Effort, ModelInfo } from '../../../shared/providers.ts'
import type { LlmErrorKind } from '../types.ts'

/**
 * Протокол Antigravity CLI (agy) в режиме живой сессии: stream-json в обе стороны.
 *
 * Модуль чистый — ни процесса, ни electron: разбор проверяется тестами без запуска CLI
 * (tests/gemini-protocol.test.ts). Процесс и очередь — в gemini.ts.
 *
 * Что взято из официальной документации (antigravity.google/docs/cli/headless):
 * - Живая сессия — `agy --input-format stream-json --output-format stream-json`, БЕЗ -p:
 *   у -p обязательный аргумент — текст промпта, и `-p --input-format` съел бы флаг как промпт.
 * - В stdin — строка на ход: {"event":"user","message":{"content":"..."}}. Один ход — одно
 *   событие result; conversation_id один на всю сессию.
 * - В stdout — NDJSON: init, step_update, result. step_update.text_delta — «incremental
 *   response text»: несколько ACTIVE с кусками, затем DONE (иногда и DONE несёт хвост).
 * - result.status: SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING; текст
 *   ошибки — result.error. Отдельного события error нет.
 * - Неверный JSON или незнакомая слеш-команда в stdin «terminates the session immediately».
 * - Системного промпта флагом нет — он идёт первым сообщением сессии, как у Claude Code.
 * - Снимков экрана документация не описывает — их не отправляем (images-unsupported).
 *
 * Что взято из чужих клиентов, а не из документации (поэтому разбор защитный):
 * - Формат `agy models`: с 1.1.11 «slug<TAB>подпись», раньше — подпись одна в строке
 *   (multica-ai/multica, server/pkg/agent/models.go).
 * - Хвостовая «There was a network issue…» после уже законченного ответа — не сбой ответа.
 * - По --print-timeout agy пишет в stdout не JSON, а «Error: timed out waiting for response».
 */

/**
 * --print-timeout по умолчанию 5 минут, «выключить» его нельзя. Считается ли он на ход или на
 * всю сессию, документация не говорит; живая сессия длится весь созвон, поэтому ставим с запасом.
 * Зависший ход всё равно гасит наш таймаут по тишине, он короче.
 */
export const AGY_PRINT_TIMEOUT = '12h'

export type AgyEffort = 'low' | 'medium' | 'high'

/**
 * Аргументы живой сессии. Флагов, снимающих разрешения (--dangerously-skip-permissions), нет и не будет.
 * sandbox — `--sandbox` из справочника флагов headless: команды агента, если он всё же до них
 * доберётся, идут в песочнице ОС. Это запасной слой: главное — проверка настроек разрешений
 * (agyPermissionProblem), потому что песочница agy описана только для Linux и macOS.
 */
export function agyArgs(opts: { model?: string; effort?: AgyEffort; sandbox?: boolean }): string[] {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', AGY_PRINT_TIMEOUT]
  if (opts.sandbox) args.push('--sandbox')
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  return args
}

/**
 * agy умер на старте из-за --sandbox: флага нет в этой сборке или песочница на этой системе не
 * поднимается. Тогда запускаем без флага — настройки разрешений всё равно проверены до запуска.
 */
export function isSandboxRejection(stderr: string): boolean {
  if (!/sandbox/i.test(stderr)) return false
  return /not (supported|available|implemented|defined)|unsupported|unavailable|unknown (flag|option)|flag provided|failed|cannot|could not|error/i.test(stderr)
}

/* ---------- старт процесса ---------- */

/**
 * Один старт процесса на всех ждущих, с поколениями. Старт асинхронный (найти программу,
 * прочитать PATH из реестра и настройки agy), и сессию могут погасить посреди него.
 *
 * cancel() и сдвигает поколение, и забывает идущий старт. Раньше гашение старт не забывало:
 * вопрос, заданный сразу после (переключились на другого провайдера и обратно), присоединялся
 * к брошенному старту, получал CancelledError и пропадал как «отменён», хотя его никто не
 * отменял. Брошенный старт доживает сам и видит по isCurrent(gen), что его процесс не нужен.
 */
export class StartGate<T> {
  private pending: Promise<T> | null = null
  private gen = 0

  /** Идёт старт, к которому можно присоединиться. */
  get starting(): boolean {
    return this.pending !== null
  }

  /** Присоединиться к идущему старту или начать новый. start получает поколение, с которым начат. */
  join(start: (gen: number) => Promise<T>): Promise<T> {
    if (this.pending) return this.pending
    const p = start(this.gen)
    this.pending = p
    // Забываем только свой промис: брошенный старт, закончившись позже, не стирает новый.
    const clear = () => {
      if (this.pending === p) this.pending = null
    }
    p.then(clear, clear)
    return p
  }

  /** Старт этого поколения ещё нужен. */
  isCurrent(gen: number): boolean {
    return gen === this.gen
  }

  cancel(): void {
    this.gen++
    this.pending = null
  }
}

/* ---------- настройки разрешений agy ---------- */

/** Путь для текстов в окне: без имени пользователя, как в документации agy. */
export const AGY_SETTINGS_HINT = '~/.gemini/antigravity-cli/settings.json'

/**
 * JSON с комментариями и висячими запятыми → значение. agy пишет обычный JSON, но файл
 * правят руками, и из-за комментария суфлёр не должен считать настройки нечитаемыми.
 * Бросает, если это не JSON и после чистки.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else {
      out += ch
    }
  }
  // Блокнот Windows сохраняет UTF-8 с BOM, а JSON.parse на нём спотыкается.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1').replace(/^\uFEFF/, ''))
}

/** Режимы, в которых agy спрашивает разрешения, а headless без окна мягко отказывает сам. */
const SAFE_TOOL_PERMISSIONS = new Set(['request-review', 'strict'])

/**
 * Правило allow, при котором agy сделает что-то на компьютере без спроса: команду, запись
 * файла, действие на сайте, инструмент MCP. Чтение по звёздочке — тоже: чужая речь в
 * расшифровке могла бы попросить прочитать любой файл или открыть любой адрес.
 */
function isRiskyAllow(rule: string): boolean {
  const m = /^\s*([a-z_]+)\s*\((.*)\)\s*$/i.exec(rule)
  if (!m) return true
  const action = m[1]!.toLowerCase()
  if (action === 'read_file' || action === 'read_url') return m[2]!.trim() === '*'
  return true
}

/**
 * Можно ли запускать agy суфлёром при таких настройках. null — можно; строка — почему нельзя,
 * готовым текстом для окна.
 *
 * Зачем: в headless agy «respects the permission mode in your settings» (документация headless).
 * Суфлёр отдаёт модели расшифровку созвона — то есть речь собеседника. Если пользователь для
 * своей работы включил always-proceed или разрешил команды, эта речь могла бы запустить команду
 * на его компьютере. У Codex и ACP запрет держит сам клиент; у agy способа запретить из клиента
 * нет, поэтому отказываемся запускаться и говорим, что поправить.
 *
 * settingsText null — файла нет: действуют умолчания agy (request-review). readError — файл есть,
 * но не прочитался.
 */
export function agyPermissionProblem(settingsText: string | null, readError?: string): string | null {
  const fix = `Поправьте это в agy (команда /config) или в файле ${AGY_SETTINGS_HINT} либо выберите другого провайдера.`
  if (readError) {
    return `Не удалось прочитать настройки Antigravity CLI (${AGY_SETTINGS_HINT}): ${readError}. Без них нельзя убедиться, что agy не запускает команды без спроса, поэтому подсказки через него выключены.`
  }
  if (settingsText === null || !settingsText.trim()) return null
  let raw: unknown
  try {
    raw = parseJsonc(settingsText)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return `Настройки Antigravity CLI (${AGY_SETTINGS_HINT}) не читаются как JSON: ${why}. Без них нельзя убедиться, что agy не запускает команды без спроса, поэтому подсказки через него выключены.`
  }
  if (!isRecord(raw)) return null
  const mode = raw.toolPermission
  if (mode !== undefined && !(typeof mode === 'string' && SAFE_TOOL_PERMISSIONS.has(mode))) {
    const shown = typeof mode === 'string' ? mode : JSON.stringify(mode)
    const why =
      mode === 'always-proceed'
        ? 'agy выполняет команды и правит файлы без спроса'
        : mode === 'proceed-in-sandbox'
          ? 'agy сам запускает команды в песочнице, а песочница agy на Windows не описана'
          : 'этот режим разрешений суфлёру неизвестен'
    return `В настройках Antigravity CLI стоит toolPermission «${shown}»: ${why}. Суфлёр передаёт модели речь собеседника, поэтому подсказки через agy выключены — нужен режим request-review или strict. ${fix}`
  }
  const perms = isRecord(raw.permissions) ? raw.permissions : {}
  const allow = Array.isArray(perms.allow) ? perms.allow : []
  const risky = allow.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).filter(isRiskyAllow)
  if (risky.length) {
    const list = risky.slice(0, 5).join(', ') + (risky.length > 5 ? ` и ещё ${risky.length - 5}` : '')
    return `В настройках Antigravity CLI без спроса разрешено: ${list}. Суфлёр передаёт модели речь собеседника, и с такими правилами она могла бы запускать команды или менять файлы, поэтому подсказки через agy выключены. Уберите эти правила из permissions.allow. ${fix}`
  }
  return null
}

const LEVEL_RE = /-(high|medium|low)$/i

/**
 * Модель для режима «сразу». У agy глубина зашита в slug: gemini-3.8-flash-high/-medium/-low.
 * «Сразу» берёт -low того же семейства, но только если такая модель известна: agy падает на
 * незнакомом slug, и выдуманный id сломал бы подсказки.
 */
export function quickModel(model: string, known: readonly string[]): string {
  const m = LEVEL_RE.exec(model)
  if (!m || m[1]!.toLowerCase() === 'low') return model
  const low = model.slice(0, m.index) + '-low'
  return known.includes(low) ? low : model
}

/**
 * --effort для agy (low|medium|high). «Сразу» — всегда low. «Думает» — выбранная глубина,
 * а если её нет — та, что зашита в slug модели. Неизвестно — флаг не передаём, решает сам agy.
 */
export function agyEffort(thinking: boolean, effort: Effort | 'default' | undefined, model: string): AgyEffort | undefined {
  if (!thinking) return 'low'
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
  }
  const m = LEVEL_RE.exec(model)
  return m ? (m[1]!.toLowerCase() as AgyEffort) : undefined
}

/**
 * Текст хода. Первый ход сессии несёт системный промпт. Строку, которая начинается с «/»,
 * agy принял бы за слеш-команду, а незнакомая команда гасит всю сессию — такой текст
 * предваряем пояснением.
 */
export function composeAgyMessage(text: string, system?: string): string {
  const body = /^\s*\//.test(text) ? `Сообщение пользователя:\n${text}` : text
  return system ? `${system}\n\n${body}` : body
}

/** Строка для stdin: одно сообщение — одна строка JSON. */
export function agyUserLine(content: string): string {
  return JSON.stringify({ event: 'user', message: { content } }) + '\n'
}

/* ---------- разбор stdout ---------- */

export interface AgyStepUpdate {
  conversation_id?: string
  step_index?: number
  /** ACTIVE — шаг идёт, DONE — закончен */
  state?: string
  /** user_input, agent_response, tool, checkpoint… */
  step_type?: string
  text_delta?: string
  tool_name?: string
}

export interface AgyResult {
  conversation_id?: string
  status?: string
  response?: string
  error?: string
}

export type AgyEvent =
  | { type: 'init'; conversationId?: string; model?: string }
  | { type: 'step'; step: AgyStepUpdate }
  | { type: 'result'; result: AgyResult }
  /** строка не JSON: диагностика, «Error: timed out…», приглашение ко входу */
  | { type: 'text'; line: string }
  /** JSON, но не событие agy: пропускаем, как и сам agy пропускает незнакомое */
  | { type: 'other' }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Одна строка stdout. null — пустая строка. */
export function parseAgyLine(line: string): AgyEvent | null {
  const text = line.trim()
  if (!text) return null
  if (!text.startsWith('{')) return { type: 'text', line: text }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { type: 'text', line: text }
  }
  if (!isRecord(raw)) return { type: 'other' }
  switch (raw.event) {
    case 'init': {
      const init = isRecord(raw.init) ? raw.init : {}
      return {
        type: 'init',
        conversationId: typeof raw.conversation_id === 'string' ? raw.conversation_id : undefined,
        model: typeof init.model === 'string' ? init.model : undefined,
      }
    }
    case 'step_update':
      return isRecord(raw.step_update) ? { type: 'step', step: raw.step_update as AgyStepUpdate } : { type: 'other' }
    case 'result':
      return isRecord(raw.result) ? { type: 'result', result: raw.result as AgyResult } : { type: 'other' }
    default:
      return { type: 'other' }
  }
}

/** Куда разбор хода отдаёт события — это вызовы TurnQueue. */
export interface AgySink {
  delta(text: string): void
  blockBreak(): void
  thinking(): void
  tool(name: string): void
}

export type AgyOutcome =
  | { ok: true; response: string }
  | { ok: false; kind: LlmErrorKind; detail: string }

const NETWORK_TRAILER = /there was a network issue connecting to the server/i

/**
 * Разбор одного хода. Состояние — на ход: reset() перед отправкой вопроса.
 * handle() возвращает итог, когда ход закончился, иначе null.
 */
export class AgyTurn {
  private emitted = ''
  private readonly stepText = new Map<number, string>()
  private readonly toolSteps = new Set<number>()
  private lastTextStep: number | null = null
  private lastResponseStep = -1
  private lastResponseDone = false

  reset(): void {
    this.emitted = ''
    this.stepText.clear()
    this.toolSteps.clear()
    this.lastTextStep = null
    this.lastResponseStep = -1
    this.lastResponseDone = false
  }

  /** Что уже ушло в окно за этот ход. */
  get text(): string {
    return this.emitted
  }

  handle(ev: AgyEvent, sink: AgySink): AgyOutcome | null {
    switch (ev.type) {
      case 'step':
        this.step(ev.step, sink)
        return null
      case 'result':
        return this.result(ev.result, sink)
      case 'text':
        return textOutcome(ev.line)
      default:
        return null
    }
  }

  private step(s: AgyStepUpdate, sink: AgySink): void {
    const index = typeof s.step_index === 'number' ? s.step_index : -1
    const done = typeof s.state === 'string' && s.state.toUpperCase() === 'DONE'
    const type = s.step_type ?? ''

    if (s.tool_name || type === 'tool') {
      if (!this.toolSteps.has(index)) {
        this.toolSteps.add(index)
        sink.tool(s.tool_name || 'tool')
      }
      return
    }

    if (type === 'agent_response') {
      if (index >= this.lastResponseStep) {
        // Законченность ответа решает только последний шаг ответа: после DONE может начаться
        // новый, и его обрыв сетевой ошибкой — уже неполный ответ.
        this.lastResponseStep = index
        this.lastResponseDone = done
      }
      const raw = typeof s.text_delta === 'string' ? s.text_delta : ''
      if (!raw) {
        // Шаг ответа идёт, а текста ещё нет — модель думает. Окну важно знать, что пауза осмысленная.
        if (!done && !this.stepText.get(index)) sink.thinking()
        return
      }
      const chunk = this.fresh(index, raw, done)
      if (!chunk) return
      // Новый шаг ответа после уже написанного — отдельный абзац: иначе рассказ «сначала
      // посмотрю…» и сам ответ склеиваются в одну строку.
      if (this.lastTextStep !== null && this.lastTextStep !== index && this.emitted) {
        this.emitted += '\n\n'
        sink.blockBreak()
      }
      this.lastTextStep = index
      this.emitted += chunk
      sink.delta(chunk)
      return
    }

    // Служебные шаги (user_input, checkpoint) — не размышления. Остальные идущие шаги без
    // текста — работа модели, и паузу стоит объяснить.
    if (!done && type !== 'user_input' && type !== 'checkpoint') sink.thinking()
  }

  /**
   * Новая часть текста шага. Документация обещает приращения, но сторонние клиенты пишут,
   * что DONE бывает с полным текстом. Кусок, который начинается со всего уже написанного
   * в этом шаге (не короче 16 символов), считаем снимком и берём только новое.
   */
  private fresh(index: number, raw: string, done: boolean): string {
    const prev = this.stepText.get(index) ?? ''
    if (prev && done && raw === prev) return ''
    if (prev.length >= 16 && raw.startsWith(prev)) {
      this.stepText.set(index, raw)
      return raw.slice(prev.length)
    }
    this.stepText.set(index, prev + raw)
    return raw
  }

  private result(r: AgyResult, sink: AgySink): AgyOutcome {
    const status = (r.status ?? '').toUpperCase()
    const response = typeof r.response === 'string' ? r.response : ''
    const error = typeof r.error === 'string' ? r.error.trim() : ''
    const trailingNetwork = NETWORK_TRAILER.test(error) && !!response.trim() && this.lastResponseDone
    if (status === '' || status === 'SUCCESS' || trailingNetwork) {
      // result.response — канонический ответ. Если дельты потерялись по дороге, дописываем хвост.
      const tail = missingTail(this.emitted, response)
      if (tail) {
        this.emitted += tail
        sink.delta(tail)
      }
      return { ok: true, response }
    }
    if (status === 'CANCELED' || status === 'CANCELLED' || status === 'INTERRUPTED') {
      return { ok: false, kind: 'unknown', detail: error || 'Antigravity CLI прервал ответ.' }
    }
    if (status === 'WAITING') {
      // Ход остановился, ожидая разрешения на действие. Суфлёр разрешений не даёт.
      return { ok: false, kind: 'unknown', detail: error || 'Antigravity CLI остановился и ждёт разрешения на действие — суфлёр такие разрешения не даёт.' }
    }
    return { ok: false, kind: classifyAgyError(error), detail: error || `Antigravity CLI завершил ход со статусом ${status}.` }
  }
}

/** Недостающий хвост ответа: только если уже написанное — его начало. */
export function missingTail(emitted: string, response: string): string {
  if (!response || response.length <= emitted.length) return ''
  return response.startsWith(emitted) ? response.slice(emitted.length) : ''
}

/** Строка не JSON посреди хода: таймаут печати или приглашение ко входу. Остальное — шум. */
function textOutcome(line: string): AgyOutcome | null {
  if (/timed out waiting for response/i.test(line)) return { ok: false, kind: 'timeout', detail: line }
  if (looksLikeLoginPrompt(line)) return { ok: false, kind: 'not-logged-in', detail: line }
  return null
}

/**
 * Приглашение ко входу. Без сохранённого входа agy открывает браузер или печатает ссылку
 * для ручного входа и ждёт код — из stdin, куда мы пишем вопросы. Узнаём по ссылке рядом
 * со словами о входе, чтобы не спутать с обычной диагностикой.
 */
export function looksLikeLoginPrompt(line: string): boolean {
  return /https?:\/\//i.test(line) && /(sign[\s-]?in|log[\s-]?in|authori[sz]|authenticat|verification code|enter (the )?code)/i.test(line)
}

/**
 * Из хвоста stderr — только то, что похоже на ошибку. agy пишет в stderr и диагностику glog
 * («I0528 13:36:23.318877 … printmode.go:130] …»); в информационных строках попадаются слова
 * вроде oauth и proxy, и по ним обычный сбой выглядел бы как «нужен вход».
 */
export function agyStderrErrors(tail: string): string {
  return tail
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^[IW]\d{4}\s/.test(l.trim()))
    .join('\n')
    .trim()
}

/** Вид ошибки по тексту agy. Порядок важен: «model not found for this login» — про модель. */
export function classifyAgyError(text: string): LlmErrorKind {
  if (/quota|resource[_ ]exhausted|rate[ -]?limit|too many requests|\b429\b|usage limit|limit reached/i.test(text)) return 'rate-limit'
  if (/not recognized as a known model|unknown model|invalid model|model .*not (found|available|supported)|no such model/i.test(text)) return 'model-unavailable'
  if (/not (signed|logged) in|sign[\s-]?in required|log[\s-]?in required|authenticat|unauthori[sz]ed|oauth|credential|\b401\b|please (log|sign) ?in/i.test(text)) return 'not-logged-in'
  if (/network|connection (refused|reset)|econn|enotfound|dns|unreachable|tls handshake|proxy/i.test(text)) return 'network'
  if (/timed? ?out|deadline exceeded/i.test(text)) return 'timeout'
  return 'unknown'
}

/* ---------- agy models ---------- */

const LEVEL_HINT: Record<string, string> = { high: 'думает глубже', medium: 'баланс', low: 'самая быстрая' }
const LEVEL_SHORT: Record<string, string> = { high: '', medium: ' M', low: ' L' }

function modelFromEntry(id: string, label: string): ModelInfo {
  const level = /[-(\s](high|medium|low)\)?$/i.exec(id)?.[1]?.toLowerCase() ?? /\((high|medium|low)\)/i.exec(label)?.[1]?.toLowerCase()
  const family = /\b(flash|pro|opus|sonnet|haiku|gpt-oss)\b/i.exec(label)?.[1] ?? /\b(flash|pro|opus|sonnet|haiku|gpt-oss)\b/i.exec(id)?.[1]
  const thinkingLabel = /thinking/i.test(label)
  return {
    id,
    name: label,
    short: family ? `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()}${level ? LEVEL_SHORT[level] : ''}` : undefined,
    hint: level ? LEVEL_HINT[level]! : thinkingLabel ? 'думает' : '',
    efforts: null,
    // Снимки экрана в agy не отправляем: способ не описан в документации.
    images: false,
  }
}

/** Строка похожа на заголовок, ошибку или пояснение, а не на модель. */
function isNoise(line: string): boolean {
  return /[:：]$/.test(line) || /^(error|warning|warn|usage|available|note|hint|tip|failed|please|run |use |try )/i.test(line) || /https?:\/\//i.test(line)
}

/**
 * Вывод `agy models`. Понимает «slug<TAB>подпись[<TAB>…]», старый формат «подпись в строке»
 * и, на всякий случай, JSON (массив строк или объектов, или {models:[…]}). Дубли id — прочь.
 * Пустой результат — не список: вызывающий возьмёт запасной.
 */
export function parseAgyModels(stdout: string): ModelInfo[] {
  const out: ModelInfo[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string) => {
    const i = id.trim()
    if (!i || seen.has(i)) return
    seen.add(i)
    out.push(modelFromEntry(i, label.trim() || i))
  }
  const trimmed = stdout.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const raw: unknown = JSON.parse(trimmed)
      const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.models) ? raw.models : []
      for (const item of list) {
        if (typeof item === 'string') add(item, item)
        else if (isRecord(item)) {
          const id = [item.slug, item.id, item.model, item.name].find((v): v is string => typeof v === 'string' && !!v.trim())
          const label = [item.label, item.display_name, item.displayName, item.name].find((v): v is string => typeof v === 'string' && !!v.trim())
          if (id) add(id, label ?? id)
        }
      }
      return out
    } catch {
      /* не JSON целиком — разбираем построчно */
    }
  }
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    if (rawLine.includes('\t')) {
      const [id = '', label = ''] = rawLine.split('\t')
      if (!isNoise(id.trim())) add(id, label)
      continue
    }
    const line = rawLine.trim().replace(/^[-*•]\s+/, '')
    if (isNoise(line)) continue
    add(line, line)
  }
  return out
}
