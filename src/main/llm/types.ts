import { providerById, type Effort, type ModelInfo, type ProviderId } from '../../shared/providers.ts'

/**
 * Контракт между main и провайдерами подсказок.
 *
 * index.ts не знает, кто отвечает: он берёт сессию у registry и задаёт вопрос.
 * Как поднять CLI, как говорить с ним и как понять, что он завис, — дело адаптера
 * в providers/*. Очередь, тишина и устаревшие вопросы у всех общие — queue.ts.
 *
 * Модуль чистый (без electron и node): его импортируют тесты под голым Node.
 */

export type { Effort, ModelInfo, ProviderId }

export type SessionRole = 'main' | 'verify'

export interface SessionConfig {
  /** точный id модели; пусто — модель провайдера по умолчанию */
  model: string
  /** «думает» (true) или «сразу» (false) */
  thinking: boolean
  /** глубина в режиме «думает»; 'default' и undefined — как решит сам сервис */
  effort?: Effort | 'default'
  /** свой системный промпт; пусто — встроенный промпт суфлёра */
  systemPrompt?: string
  /**
   * Разрешить веб-поиск — только второму агенту. main передаёт true лишь провайдерам с
   * ProviderInfo.webSearch; остальным — false. undefined — сессия подсказок, про инструменты
   * ничего не сказано: суфлёру веб не нужен.
   */
  web?: boolean
}

export interface ImageInput {
  /** 'image/jpeg' | 'image/png' */
  mediaType: string
  /** base64 без префикса data: */
  data: string
}

/**
 * Части вопроса к снимку экрана. Текст вопроса (TurnInput.text) уже собран из них
 * вместе с правилами разбора — CLI-сессиям этого достаточно. Части нужны тем, у кого
 * правила разбора уходят отдельной системной ролью, а не в сообщении: API Claude.
 */
export interface ScreenParts {
  /** пояснение к серии снимков; пусто — снимок один */
  intro: string
  /** что спросил пользователь; пусто — вопрос по умолчанию */
  question: string
  /** последние реплики разговора */
  transcript: string
}

export interface TurnInput {
  text: string
  /** снимки — перед текстом: модель сначала смотрит, потом читает */
  images?: ImageInput[]
  screen?: ScreenParts
}

export interface TurnHandlers {
  /** очередной кусок ответа */
  onDelta(t: string): void
  /** модель начала размышлять, а не писать; дёргается сколько угодно раз */
  onThinking?(): void
  /** модель вызвала инструмент, например веб-поиск */
  onTool?(name: string): void
  /** вопрос ушёл в модель — сразу или когда подошла очередь */
  onStart?(): void
  /** проверяется, когда подходит очередь: устаревший вопрос в модель не уходит */
  isStale?(): boolean
}

export interface AskOptions {
  /**
   * Таймаут по тишине: столько секунд без единого события от сессии — и она
   * считается зависшей. Живой длинный ответ он не обрывает.
   */
  silenceSec?: number
  silenceMessage?: string
}

export type LlmErrorKind =
  | 'not-installed'
  | 'not-logged-in'
  | 'rate-limit'
  | 'model-unavailable'
  | 'images-unsupported'
  | 'timeout'
  | 'crashed'
  | 'network'
  | 'cancelled'
  | 'skipped'
  | 'unknown'

/**
 * Ошибка провайдера. message — уже готовый текст для окна, по-русски: панель
 * показывает его вместо ответа. kind — чтобы окно могло предложить действие
 * («Войти», «Как установить»), а не только текст.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly provider: ProviderId
  /** сырой текст от CLI — для лога, не для окна */
  readonly raw?: string

  constructor(kind: LlmErrorKind, provider: ProviderId, message?: string, raw?: string) {
    super(message || llmErrorText(kind, provider))
    this.name = 'LlmError'
    this.kind = kind
    this.provider = provider
    this.raw = raw
  }
}

/** Вопрос устарел, пока ждал очереди, и в модель не уходил. */
export class SkippedError extends Error {
  constructor() {
    super('Вопрос устарел, пока ждал очереди')
    this.name = 'SkippedError'
  }
}

/** Вопрос отменили намеренно — например, выключили второго агента. Это не сбой. */
export class CancelledError extends Error {
  constructor() {
    super('Вопрос отменён')
    this.name = 'CancelledError'
  }
}

/** Отмена — не сбой: в журнал её не пишем. */
export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof LlmError && e.kind === 'cancelled')
}

export function isSkipped(e: unknown): boolean {
  return e instanceof SkippedError || (e instanceof LlmError && e.kind === 'skipped')
}

/**
 * Текст ошибки по её виду — для адаптеров, которым нечего добавить от себя.
 * Про установку и вход говорим именем программы («Codex CLI»), про лимиты — именем
 * сервиса («ChatGPT»): лимит у подписки, а не у программы.
 */
export function llmErrorText(kind: LlmErrorKind, provider: ProviderId, detail?: string): string {
  const p = providerById(provider)
  const tail = detail?.trim() ? ` ${detail.trim()}` : ''
  switch (kind) {
    case 'not-installed':
      return `${p.agent} не установлен на этом компьютере. Установите его или выберите другой источник подсказок.${tail}`
    case 'not-logged-in':
      return `${p.agent} ждёт входа в аккаунт. Нажмите «Войти» в выборе провайдера и повторите вопрос.${tail}`
    case 'rate-limit':
      return `Лимит ${p.name} исчерпан.${tail} Пока лимит не обновится, подсказок не будет — можно вести созвон без суфлёра.`
    case 'model-unavailable':
      return `Эта модель недоступна в ${p.agent}: её нет на вашем тарифе или она больше не выпускается. Выберите другую.${tail}`
    case 'images-unsupported':
      return `${p.name} с этой моделью не принимает снимки экрана. Для снимка выберите другую модель или провайдера.${tail}`
    case 'timeout':
      return `${p.agent} не отвечает, сессия перезапущена.${tail}`
    case 'crashed':
      return `${p.agent} неожиданно завершился.${tail}`
    case 'network':
      return `Нет связи с ${p.name}. Проверьте интернет или VPN.${tail}`
    case 'cancelled':
      return 'Вопрос отменён'
    case 'skipped':
      return 'Вопрос устарел, пока ждал очереди'
    default:
      return detail?.trim() || `${p.agent} вернул ошибку`
  }
}

export interface LlmSession {
  /** Применить настройки. Сессия сама решает, нужен ли перезапуск; идущий ответ не обрывается. */
  configure(cfg: SessionConfig): void
  /** Поднять сессию заранее, чтобы первый вопрос созвона не платил за старт. Не бросает. */
  warmup(): Promise<void>
  ask(input: TurnInput, h: TurnHandlers, o?: AskOptions): Promise<string>
  /** Погасить сессию. reason — чем отклонить вопросы: отмену стоит отличать от сбоя. */
  stop(reason?: Error): void
  /** Занята ответом: новый вопрос встанет в очередь. */
  readonly busy: boolean
}

export type Availability =
  | { state: 'ok'; version?: string; account?: string }
  | { state: 'not-installed' }
  | { state: 'not-logged-in' }
  | { state: 'unknown'; message?: string }
  | { state: 'error'; message: string }

export interface ProviderAdapter {
  id: ProviderId
  /** Установлен ли и выполнен ли вход. Не дольше ~5 с, не бросает. */
  detect(): Promise<Availability>
  /** Живой список моделей или запасной из каталога. Не бросает. */
  listModels(): Promise<ModelInfo[]>
  createSession(role: SessionRole): LlmSession
  /** Открыть окно терминала с командой входа. Вход — только в самом CLI, пароли через нас не идут. */
  openLogin(): Promise<void>
}
