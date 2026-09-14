import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import { providerById } from '@shared/providers'
import { resolveCommand } from '../cli'
import { suggestSystemPrompt } from '../prompts'
import { TurnQueue } from '../queue'
import {
  LlmError,
  type AskOptions,
  type Availability,
  type LlmSession,
  type ModelInfo,
  type ProviderAdapter,
  type SessionConfig,
  type TurnHandlers,
  type TurnInput,
} from '../types'
import {
  DEFAULT_OLLAMA_URL,
  NdjsonSplitter,
  chatBody,
  classifyOllamaError,
  errorFromBody,
  isChatModel,
  loadBody,
  ollamaBaseUrl,
  ollamaErrorText,
  ollamaUnreachable,
  parseChatLine,
  parseShow,
  parseTags,
  startHeartbeat,
  thinkValue,
  toModelInfo,
  type OllamaTag,
  type ShowInfo,
} from './ollamaProtocol'

/**
 * Локальная модель через Ollama: HTTP API на этом компьютере, ответ потоком NDJSON.
 * Протокол и его источники — в ollamaProtocol.ts.
 *
 * Что здесь важно:
 * - Запросы идут через node:http со своим агентом, а не через глобальный fetch. main ставит
 *   глобальный прокси undici (configureProxy в claude.ts), и fetch к 127.0.0.1 ушёл бы в прокси
 *   и повис. Свой агент прокси из окружения не читает — для локального адреса это и нужно.
 * - Процесса нет: отмена, устаревший вопрос и зависание обрывают HTTP-запрос (AbortController).
 *   Очередь и таймаут по тишине — общие, из queue.ts.
 * - Сессия не хранит историю: каждый вопрос — системное сообщение и сам вопрос (почему — см. chatBody).
 * - Пока модель грузится и читает промпт, Ollama молчит; жизнь очереди подтверждает пульс
 *   (startHeartbeat), иначе таймаут по тишине обрывал бы медленную модель на каждом вопросе.
 * - Веб-поиска у локальной модели нет: SessionConfig.web здесь не действует, main его и не
 *   передаёт провайдерам без webSearch. Второй агент через Ollama проверяет без интернета.
 */

const INFO = providerById('ollama')

/** Сколько модель держится в памяти после вопроса. Ollama по умолчанию выгружает её через 5 минут —
 *  пауза в созвоне дольше, и следующий вопрос ждал бы загрузку. Своя настройка пользователя важнее. */
const KEEP_ALIVE = '20m'
const keepAlive = () => (process.env.OLLAMA_KEEP_ALIVE ? undefined : KEEP_ALIVE)

/** Прогретая модель считается загруженной, пока не истёк её keep_alive. */
const WARM_TTL_MS = 15 * 60_000
const SHOW_TTL_MS = 5 * 60_000

const baseUrl = () => ollamaBaseUrl(process.env.OLLAMA_HOST)

/* ---------- HTTP ---------- */

let httpAgent: http.Agent | null = null
let httpsAgent: https.Agent | null = null

function open(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<http.IncomingMessage> {
  const url = new URL(baseUrl() + path)
  const secure = url.protocol === 'https:'
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const headers: http.OutgoingHttpHeaders = { accept: 'application/json' }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = payload.length
  }
  return new Promise((resolve, reject) => {
    const options = { method, headers, signal }
    const req = secure
      ? https.request(url, { ...options, agent: (httpsAgent ??= new https.Agent({ keepAlive: true })) }, resolve)
      : http.request(url, { ...options, agent: (httpAgent ??= new http.Agent({ keepAlive: true })) }, resolve)
    req.on('error', reject)
    req.end(payload)
  })
}

function readAll(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c: string) => {
      text += c
    })
    res.on('end', () => resolve(text))
    res.on('error', reject)
  })
}

interface JsonReply {
  status: number
  text: string
  json: unknown
}

/** Короткий запрос за JSON: версия, список моделей, сведения о модели. */
async function requestJson(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<JsonReply> {
  const res = await open(method, path, body, AbortSignal.timeout(timeoutMs))
  const text = await readAll(res)
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* не JSON — вызывающий посмотрит на статус и текст */
  }
  return { status: res.statusCode ?? 0, text, json }
}

const errCode = (e: unknown) => (e as { code?: unknown } | null)?.code
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Нет сервера по адресу: не запущена, не установлена или неверный OLLAMA_HOST. */
function isUnreachable(e: unknown): boolean {
  const code = errCode(e)
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'EADDRNOTAVAIL' || code === 'ENETUNREACH'
}

/** Установщик Ollama для Windows ставит её сюда и добавляет в PATH пользователя. */
const extraDirs = () => [join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'Ollama')]

/** Сетевая ошибка запроса — в ошибку для окна. */
async function transportError(e: unknown): Promise<LlmError> {
  if (e instanceof LlmError) return e
  const msg = errText(e)
  if (isUnreachable(e)) {
    // Не установлена ли — решаем, как detect: установленная, но не запущенная — не «не установлена».
    const installed = !!(await resolveCommand(['ollama'], extraDirs()).catch(() => null))
    const { kind, message } = ollamaUnreachable(baseUrl(), installed)
    return new LlmError(kind, 'ollama', message, msg)
  }
  if (errCode(e) === 'ECONNRESET' || /socket hang up|aborted/i.test(msg)) {
    return new LlmError('crashed', 'ollama', 'Ollama оборвала соединение посреди ответа. Повторите вопрос.', msg)
  }
  return new LlmError('unknown', 'ollama', `Ollama: ${msg}`, msg)
}

/* ---------- сведения о моделях ---------- */

/** Общее для адаптера и его сессий: что знаем о скачанных моделях. */
class OllamaCatalog {
  private readonly tags = new Map<string, OllamaTag>()
  private readonly shows = new Map<string, { at: number; info: ShowInfo }>()
  private models: ModelInfo[] = []

  rememberTags(list: OllamaTag[]): void {
    this.tags.clear()
    for (const t of list) this.tags.set(t.name, t)
  }

  rememberModels(list: ModelInfo[]): void {
    this.models = list
  }

  /** Модель по умолчанию, если пользователь её ещё не выбирал: первая скачанная. */
  firstModel(): string | undefined {
    return this.models[0]?.id
  }

  /**
   * Что умеет модель: зрение, размышления. Новые версии Ollama отдают это прямо в /api/tags,
   * старые — только в /api/show. Не узнали — capabilities: null, и решение «пробовать или нет»
   * принимает вызывающий. Неудачу не кэшируем.
   */
  async info(model: string): Promise<ShowInfo> {
    const cached = this.shows.get(model)
    if (cached && Date.now() - cached.at < SHOW_TTL_MS) return cached.info
    const tag = this.tags.get(model)
    if (tag?.capabilities) {
      const info = { capabilities: tag.capabilities, family: tag.family }
      this.shows.set(model, { at: Date.now(), info })
      return info
    }
    try {
      // Старые версии называли поле name, новые — model: лишнее поле Ollama игнорирует.
      const r = await requestJson('POST', '/api/show', { model, name: model }, 5000)
      if (r.status !== 200) return { capabilities: null, family: tag?.family }
      const info = parseShow(r.json)
      if (!info.family && tag?.family) info.family = tag.family
      this.shows.set(model, { at: Date.now(), info })
      return info
    } catch {
      return { capabilities: null, family: tag?.family }
    }
  }
}

/* ---------- сессия ---------- */

class OllamaSession implements LlmSession {
  private cfg: SessionConfig = { model: '', thinking: true }
  private readonly catalog: OllamaCatalog
  private readonly q: TurnQueue<TurnInput>
  /** Растёт при каждом обрыве: события старого запроса после этого игнорируются. */
  private seq = 0
  private ctrl: AbortController | null = null
  private warm: { model: string; at: number } | null = null
  private warming: Promise<void> | null = null

  constructor(catalog: OllamaCatalog) {
    this.catalog = catalog
    this.q = new TurnQueue<TurnInput>({
      provider: 'ollama',
      label: INFO.agent,
      transport: {
        ensure: () => {
          /* поднимать нечего: сервер Ollama живёт сам по себе */
        },
        send: (input) => this.send(input),
        kill: () => this.kill(),
      },
    })
  }

  get busy(): boolean {
    return this.q.busy
  }

  /** HTTP без состояния: новая модель или промпт действуют со следующего вопроса, перезапускать нечего. */
  configure(cfg: SessionConfig): void {
    this.cfg = { ...cfg }
  }

  /**
   * Загрузить модель в память заранее: первая загрузка большой модели — десятки секунд, их
   * лучше заплатить до созвона. Мимо очереди: Ollama сама дождётся загрузки, если вопрос
   * придёт раньше. Не бросает.
   */
  warmup(): Promise<void> {
    const model = this.model()
    if (!model) return Promise.resolve()
    if (this.warm?.model === model && Date.now() - this.warm.at < WARM_TTL_MS) return Promise.resolve()
    this.warming ??= (async () => {
      try {
        void this.catalog.info(model)
        const r = await requestJson('POST', '/api/chat', loadBody(model, keepAlive()), 180_000)
        if (r.status === 200) this.warm = { model, at: Date.now() }
      } catch {
        /* не прогрелась — первый вопрос загрузит модель сам */
      } finally {
        this.warming = null
      }
    })()
    return this.warming
  }

  ask(input: TurnInput, h: TurnHandlers, o: AskOptions = {}): Promise<string> {
    return this.q.ask(input, h, o)
  }

  stop(reason?: Error): void {
    this.q.stop(reason)
  }

  private model(): string {
    return this.cfg.model || this.catalog.firstModel() || ''
  }

  private system(): string {
    // «Не рассуждай» — в режиме «сразу»: небольшие локальные модели без него рассуждают прямо в ответе.
    return suggestSystemPrompt(this.cfg.systemPrompt, !this.cfg.thinking)
  }

  private async send(input: TurnInput): Promise<void> {
    const seq = ++this.seq
    const ctrl = new AbortController()
    this.ctrl = ctrl
    const model = this.model()
    if (!model) throw new LlmError('model-unavailable', 'ollama', INFO.modelsHint)
    // Пульс — с самого начала: и сведения о модели (/api/show), и загрузка модели, и чтение
    // промпта идут до первого байта ответа, а таймаут по тишине считает и их.
    const stopBeat = startHeartbeat({ beat: () => this.q.activity(), alive: () => seq === this.seq })
    try {
      const info = await this.catalog.info(model)
      if (seq !== this.seq) return
      // Модель без зрения картинку молча проигнорирует и ответит «на снимке ничего нет» — хуже ошибки.
      if (input.images?.length && info.capabilities && !info.capabilities.includes('vision')) {
        throw new LlmError('images-unsupported', 'ollama', ollamaErrorText('images-unsupported', '', model))
      }
      const body = chatBody({
        model,
        system: this.system(),
        text: input.text,
        images: input.images,
        think: thinkValue(model, info, this.cfg.thinking, this.cfg.effort),
        keepAlive: keepAlive(),
      })
      let res: http.IncomingMessage
      try {
        res = await open('POST', '/api/chat', body, ctrl.signal)
      } catch (e) {
        if (seq !== this.seq) return
        const err = await transportError(e)
        if (seq !== this.seq) return
        throw err
      }
      if (seq !== this.seq) {
        res.destroy()
        return
      }
      this.q.activity()
      if (res.statusCode !== 200) {
        stopBeat()
        const text = await readAll(res).catch(() => '')
        if (seq !== this.seq) return
        const msg = errorFromBody(text) || `HTTP ${res.statusCode}`
        const kind = classifyOllamaError(res.statusCode, msg)
        throw new LlmError(kind, 'ollama', ollamaErrorText(kind, msg, model), msg)
      }
      await this.pump(res, seq, model, stopBeat)
    } finally {
      stopBeat()
    }
  }

  /** Поток ответа: строки NDJSON → события очереди. firstByte — остановить пульс ожидания. */
  private pump(res: http.IncomingMessage, seq: number, model: string, firstByte: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const split = new NdjsonSplitter()
      let settled = false
      const live = () => !settled && seq === this.seq
      const onLine = (line: string) => {
        if (!live()) return
        this.q.activity()
        const ev = parseChatLine(line)
        if (!ev) return
        if (ev.type === 'error') {
          // Ошибка посреди потока: код ответа уже 200, текст — строкой {"error": …}.
          settled = true
          res.destroy()
          const kind = classifyOllamaError(undefined, ev.message)
          reject(new LlmError(kind, 'ollama', ollamaErrorText(kind, ev.message, model), ev.message))
          return
        }
        if (ev.thinking) this.q.thinking()
        if (ev.content) this.q.delta(ev.content)
        if (ev.done) {
          settled = true
          resolve()
          this.q.finish()
        }
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        // Пошли байты — дальше жизнь подтверждают сами строки ответа, пульс больше не нужен.
        firstByte()
        for (const line of split.push(chunk)) onLine(line)
      })
      res.on('end', () => {
        for (const line of split.flush()) onLine(line)
        if (!live()) return resolve()
        settled = true
        reject(new LlmError('crashed', 'ollama', 'Ollama оборвала ответ на полуслове. Повторите вопрос.'))
      })
      res.on('error', (e) => {
        if (!live()) return resolve()
        settled = true
        void transportError(e).then(reject)
      })
      res.on('close', () => {
        if (!live()) return resolve()
        if (res.complete) return
        settled = true
        reject(new LlmError('crashed', 'ollama', 'Ollama оборвала соединение посреди ответа. Повторите вопрос.'))
      })
    })
  }

  /** Оборвать идущий запрос, не трогая вопросы (зовёт очередь: отмена, зависание, устаревание). */
  private kill(): void {
    this.seq++
    this.ctrl?.abort()
    this.ctrl = null
  }
}

/* ---------- адаптер ---------- */

export function createOllamaAdapter(): ProviderAdapter {
  const catalog = new OllamaCatalog()

  async function detect(): Promise<Availability> {
    const base = baseUrl()
    try {
      const [ver, tags] = await Promise.all([
        requestJson('GET', '/api/version', undefined, 3000).catch(() => null),
        requestJson('GET', '/api/tags', undefined, 4000),
      ])
      if (tags.status !== 200) {
        return { state: 'error', message: `Ollama ответила ${tags.status}: ${errorFromBody(tags.text) || 'без описания'}` }
      }
      catalog.rememberTags(parseTags(tags.json))
      const version = ver && typeof (ver.json as { version?: unknown } | null)?.version === 'string' ? (ver.json as { version: string }).version : undefined
      return { state: 'ok', version }
    } catch (e) {
      // Таймаут запроса node:http отдаёт как AbortError (причина — TimeoutError): сервер молчит.
      const name = (e as { name?: unknown } | null)?.name
      const silent = name === 'AbortError' || name === 'TimeoutError'
      if (!isUnreachable(e) && !silent) return { state: 'error', message: `Ollama: ${errText(e)}` }
      // Сервер не отвечает. Программа есть — значит, не запущена; нет — не установлена.
      const installed = await resolveCommand(['ollama'], extraDirs()).catch(() => null)
      if (installed) return { state: 'error', message: `Ollama установлена, но не отвечает по адресу ${base}: запустите её из меню «Пуск».` }
      if (base !== DEFAULT_OLLAMA_URL) return { state: 'error', message: `Ollama не отвечает по адресу ${base} (из OLLAMA_HOST).` }
      return { state: 'not-installed' }
    }
  }

  async function listModels(): Promise<ModelInfo[]> {
    const r = await requestJson('GET', '/api/tags', undefined, 5000)
    if (r.status !== 200) throw new Error(`Ollama ответила ${r.status}: ${errorFromBody(r.text)}`)
    const tags = parseTags(r.json)
    catalog.rememberTags(tags)
    // Сведения о моделях без capabilities в /api/tags — по четыре запроса /api/show разом.
    const caps: Array<string[] | null> = new Array(tags.length).fill(null)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(4, tags.length) }, async () => {
        while (next < tags.length) {
          const i = next++
          const t = tags[i]!
          caps[i] = t.capabilities ?? (await catalog.info(t.name)).capabilities
        }
      }),
    )
    const models = tags.flatMap((t, i) => (isChatModel(caps[i]) ? [toModelInfo(t, caps[i])] : []))
    catalog.rememberModels(models)
    return models
  }

  return {
    id: 'ollama',
    detect,
    listModels,
    createSession: () => new OllamaSession(catalog),
    async openLogin(): Promise<void> {
      // Входить в локальную Ollama не нужно: кнопка ведёт на страницу установки.
      await shell.openExternal(INFO.install.url)
    },
  }
}
