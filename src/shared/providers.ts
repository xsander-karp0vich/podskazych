/**
 * Кто может отвечать подсказками: каталог провайдеров.
 *
 * Все, кроме Ollama, — терминальные CLI на подписке пользователя. Ключей мы не
 * храним: вход идёт через их собственный login в окне терминала.
 *
 * Модуль чистый — без electron и node: его читают и окно, и main, и тесты под
 * голым Node. Поэтому импорты внутри shared — с расширением .ts (см. tests/README.md).
 *
 * Списки моделей здесь — запасные, пока не пришёл живой список от самого CLI
 * (registry.listModels в main). Идентификаторы — точные, какие понимает CLI.
 */

export type ProviderId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'ollama'

/** Порядок — как в выборе провайдера в окне. */
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'cursor', 'gemini', 'ollama']

export const DEFAULT_PROVIDER: ProviderId = 'claude'

export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelInfo {
  /** точный id для CLI */
  id: string
  /** «GPT-5.6 Sol» */
  name: string
  /** «самая сильная» */
  hint: string
  /** null — глубина размышлений не настраивается */
  efforts: Effort[] | null
  /** принимает снимки экрана; undefined — неизвестно, пробуем */
  images?: boolean
  /** «Sol» — в узком окне, где полное имя не помещается; нет — первое слово имени */
  short?: string
  /** развёрнутое пояснение для настроек */
  note?: string
}

export interface ProviderInfo {
  id: ProviderId
  /** «ChatGPT» — имя в окне и в тексте ошибок про лимиты */
  name: string
  /** «через Codex CLI» — подпись под именем */
  via: string
  /** «Codex CLI» — сама программа: «Codex CLI не установлен», «Codex CLI молчит…» */
  agent: string
  color: string
  /** приглушённый оттенок цвета — щёки и тени зверька */
  soft: string
  /** пояснение под списком моделей */
  note: string
  kind: 'cli' | 'http'
  /**
   * Умеет ли работать вторым агентом. Сейчас умеют все: у каждого провайдера своя
   * verify-сессия, независимая от сессии подсказок.
   */
  verifier: boolean
  /**
   * Может ли второй агент искать в интернете. Нет — переключатель «веб» у второго агента
   * неактивен, и main флаг веб-поиска такому провайдеру не передаёт.
   */
  webSearch: boolean
  /** как поставить: команда для терминала и страница с инструкцией */
  install: { command?: string; url: string }
  /** что запустить в терминале для входа; нет — входить не нужно */
  login?: { command: string }
  /** запасной список; живой — через registry.listModels */
  models: ModelInfo[]
  /** модель, с которой начинать, если пользователь ещё не выбирал; пусто — первая из живого списка */
  defaultModel: string
  /** список моделей приходит от самого CLI и может отличаться от запасного */
  dynamicModels: boolean
  /** что сказать, когда моделей нет совсем */
  modelsHint?: string
}

const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Модели Claude, которые можно выбрать для подсказок и второго агента.
 *
 * Идентификаторы точные, а не псевдонимы CLI: «opus» у Claude Code со временем
 * указывает на новую модель, и подпись «Opus 5» под ответом начала бы врать.
 * Каждая проверена 13 сентября запросом через Claude Code на подписке: ответила
 * именно она (modelUsage в ответе CLI), подмены нет.
 */
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1', hint: 'самая мощная', note: 'Claude Fable 5.1 — самая мощная модель Claude: сложные рассуждения, код, длинные документы. Отвечает дольше Opus и сильнее расходует лимиты подписки.' },
  { id: 'claude-fable-5', name: 'Fable 5', hint: 'прошлая Fable', note: 'Claude Fable 5 — предыдущая Fable. Фильтр безопасности у неё иногда ложно срабатывает на безобидный вопрос.' },
  { id: 'claude-opus-5', name: 'Opus 5', hint: 'сильная и быстрая', note: 'Claude Opus 5 — самые сильные ответы при скорости, пригодной для живого созвона.' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', hint: 'прошлая Opus', note: 'Claude Opus 4.8 — предыдущая Opus.' },
  { id: 'claude-opus-4-7', name: 'Opus 4.7', hint: 'старше', note: 'Claude Opus 4.7 — старшее поколение Opus.' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', hint: 'старше', note: 'Claude Opus 4.6 — старшее поколение Opus.' },
  { id: 'claude-opus-4-5', name: 'Opus 4.5', hint: 'старше', note: 'Claude Opus 4.5 — старшее поколение Opus.' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', hint: 'баланс', note: 'Claude Sonnet 5 — середина между силой и скоростью.' },
  { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', hint: 'прошлая Sonnet', note: 'Claude Sonnet 4.6 — предыдущая Sonnet.' },
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', hint: 'старше', note: 'Claude Sonnet 4.5 — старшее поколение Sonnet.' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', hint: 'самая быстрая', note: 'Claude Haiku 4.5 — для простых вопросов, ответы заметно короче.' },
] as const

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'claude',
    name: 'Claude',
    via: 'через Claude Code',
    agent: 'Claude Code',
    color: '#D97757',
    soft: '#EFA283',
    note: 'В рамках лимитов подписки.',
    kind: 'cli',
    verifier: true,
    // Встроенные инструменты Claude Code WebSearch и WebFetch — второму агенту по его настройке.
    webSearch: true,
    install: { command: 'irm https://claude.ai/install.ps1 | iex', url: 'https://code.claude.com/docs/en/setup' },
    login: { command: 'claude auth login' },
    models: CLAUDE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      hint: m.hint,
      note: m.note,
      // У Haiku глубины нет: флаг --effort не передаётся, «сразу» выключает мышление.
      efforts: /haiku/i.test(m.id) ? null : CLAUDE_EFFORTS,
      images: true,
    })),
    defaultModel: 'claude-opus-5',
    // Каталог Claude ведём сами: CLI не отдаёт список моделей подписки.
    dynamicModels: false,
  },
  {
    id: 'codex',
    name: 'ChatGPT',
    via: 'через Codex CLI',
    agent: 'Codex CLI',
    color: '#F1F7F7',
    soft: '#B9C6C9',
    note: 'Через установленный Codex CLI, в рамках подписки ChatGPT. Замеров скорости на созвоне не делали.',
    kind: 'cli',
    verifier: true,
    // Встроенный web_search Codex: включается только в потоке второго агента, суфлёру он выключен.
    webSearch: true,
    install: { command: 'npm install -g @openai/codex', url: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli' },
    login: { command: 'codex login' },
    models: [
      // Astra есть не на всех тарифах: живой список (model/list) скажет точно.
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', short: 'Astra', hint: 'самая сильная, не на всех тарифах', efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', short: 'Sol', hint: 'сильная', efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', short: 'Terra', hint: 'баланс', efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', short: 'Luna', hint: 'самая быстрая', efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
      { id: 'gpt-5.5', name: 'GPT-5.5', short: '5.5', hint: 'прошлая', efforts: ['low', 'medium', 'high', 'xhigh'], images: true },
    ],
    defaultModel: 'gpt-5.6-terra',
    dynamicModels: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    via: 'через Cursor Agent',
    agent: 'Cursor Agent',
    color: '#C9D2DE',
    soft: '#8B97A8',
    note: 'Через установленный Cursor Agent, в рамках его подписки. Глубину размышлений выбирает сам Cursor.',
    kind: 'cli',
    verifier: true,
    // Веб-инструменты самого Cursor Agent. Разрешение даётся только им и только второму агенту:
    // правки и команды по-прежнему получают отказ.
    webSearch: true,
    install: { command: "irm 'https://cursor.com/install?win32=true' | iex", url: 'https://cursor.com/docs/cli/installation' },
    // Не путать с `cursor` — это лаунчер редактора, а не агент.
    login: { command: 'agent login' },
    models: [
      { id: 'auto', name: 'Auto', hint: 'сам выберет модель', efforts: null },
      { id: 'composer-2.5', name: 'Composer 2.5', short: 'Composer', hint: 'быстрая', efforts: null },
    ],
    defaultModel: 'auto',
    dynamicModels: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    via: 'через Antigravity CLI',
    agent: 'Antigravity CLI',
    color: '#9AD8FF',
    soft: '#5FA8D8',
    note: 'Через установленный Antigravity CLI, вход аккаунтом Google, в рамках его лимитов.',
    kind: 'cli',
    verifier: true,
    // Веб-инструментов с разрешением «только веб» у agy в живой сессии нет.
    webSearch: false,
    install: { command: 'irm https://antigravity.google/cli/install.ps1 | iex', url: 'https://antigravity.google/docs/cli/install/' },
    // Отдельной команды входа нет: первый запуск agy сам открывает вход через браузер.
    login: { command: 'agy' },
    // Снимки экрана agy не принимает: документация их не описывает, адаптер отвечает images-unsupported.
    models: [
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', short: 'Flash', hint: 'думает глубже', efforts: null, images: false },
      { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash · medium', short: 'Flash M', hint: 'баланс', efforts: null, images: false },
      { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash · low', short: 'Flash L', hint: 'самая быстрая', efforts: null, images: false },
    ],
    defaultModel: 'gemini-3.8-flash-high',
    dynamicModels: true,
  },
  {
    id: 'ollama',
    name: 'Локальная',
    via: 'Ollama на этом компьютере',
    agent: 'Ollama',
    color: '#FFC24B',
    soft: '#C08F28',
    note: 'Работает без интернета: ни расшифровка, ни запрос не уходят в сеть. Модели — те, что скачаны в Ollama.',
    kind: 'http',
    verifier: true,
    // Локальная модель в интернет не ходит — в этом и смысл провайдера.
    webSearch: false,
    install: { url: 'https://ollama.com/download' },
    models: [],
    defaultModel: '',
    dynamicModels: true,
    modelsHint: 'В Ollama нет скачанных моделей. Скачайте модель (ollama pull <модель>) и проверьте снова.',
  },
]

const BY_ID = new Map<string, ProviderInfo>(PROVIDERS.map((p) => [p.id, p]))

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && BY_ID.has(value)
}

/** Сохранённое или пришедшее по IPC значение — в провайдера; незнакомое — Claude. */
export function providerById(id: unknown): ProviderInfo {
  return (typeof id === 'string' && BY_ID.get(id)) || BY_ID.get(DEFAULT_PROVIDER)!
}

/**
 * Модель провайдера по id: сначала в живом списке, потом в запасном.
 * Живой список может не знать модель, которую CLI всё равно примет, — тогда undefined.
 *
 * Живой список важнее запасного, но беднее: CLI отдаёт id, имя и глубину, а короткого
 * имени, подсказки и того, берёт ли модель снимки, обычно не знает. Эти поля
 * добираем из каталога — иначе в узком окне «Sol» превращался бы в «GPT-5.6», а
 * Gemini из живого списка снова «пробовал» бы снимки, которые agy не принимает.
 */
export function findModel(provider: ProviderId, id: string, live?: readonly ModelInfo[]): ModelInfo | undefined {
  const known = providerById(provider).models.find((m) => m.id === id)
  const fresh = live?.find((m) => m.id === id)
  if (!fresh || !known) return fresh ?? known
  return {
    ...fresh,
    hint: fresh.hint || known.hint,
    short: fresh.short ?? known.short,
    note: fresh.note ?? known.note,
    images: fresh.images ?? known.images,
  }
}
