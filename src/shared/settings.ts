import { DEFAULT_MODEL, isClaudeChoice, normalizeModel } from './models.ts'
import { DEFAULT_PROVIDER, PROVIDER_IDS, isProviderId, providerById, type ProviderId } from './providers.ts'
import { contextFilesOf, type ContextFile } from './contextFiles.ts'

/** Как обращаться к Claude: живая сессия Claude Code на подписке или API по ключу. */
export type ClaudeSource = 'cli' | 'api'

export interface AppSettings {
  /** deviceId микрофона; пусто — устройство по умолчанию */
  micDeviceId: string
  /** плотность подложки, 0.3..1: прозрачна только подложка, текст — никогда */
  opacity: number
  /** размер шрифта ответа, px */
  fontSize: number
  /** скрывать окно от захвата экрана и скриншотов */
  contentProtected: boolean
  /**
   * Спрятать значок из трея. Значок возвращается сам, пока без него приложением не управлять:
   * клики сквозь панель без своей клавиши или панель спрятана без клавиши (см. main/trayVisibility).
   */
  hideTray: boolean
  /** язык распознавания и ответов */
  language: 'ru' | 'en'
  /** подкладывать в запрос найденное во встроенной базе вопросов */
  useKnowledgeBase: boolean
  /** готовить подсказку самому, не дожидаясь хоткея */
  autoSuggest: boolean
  /** показывать панель расшифровки под ответом */
  showTranscript: boolean
  /** масштаб интерфейса, 0.6..2 */
  zoom: number
  /** id экрана для снимков; пусто — основной */
  displayId: string
  /** Кто отвечает подсказками: провайдер из каталога @shared/providers. */
  llmProvider: ProviderId
  /**
   * Как обращаться к Claude, когда отвечает он.
   * 'cli' — живая сессия Claude Code на вашей подписке, ключ не нужен.
   * 'api' — прямые вызовы API, нужен ANTHROPIC_API_KEY и оплата по токенам.
   */
  claudeSource: ClaudeSource
  /**
   * Свои слова для распознавания: коллеги, проекты, заказчики, конфигурации.
   * По одному на строку. Их нет ни в какой базе, поэтому они идут в словарь
   * первыми и при обрезке по бюджету не теряются.
   */
  glossaryNames: string
  /** Термины, которые словарь из базы подобрал зря. По одному на строку. */
  glossaryExclude: string
  /**
   * Писать ли созвоны в журнал. Запись лежит только на этом компьютере,
   * рядом с настройками приложения, и выгружается файлом по кнопке.
   */
  journalEnabled: boolean
  /**
   * Какой моделью отвечать — точный id модели текущего провайдера. Меняется на
   * лету: сессия перезапускается, первый вопрос после смены стоит лишние пару секунд.
   */
  llmModel: string
  /** Последний выбор модели у каждого провайдера: вернулись к провайдеру — вернулась и его модель. */
  llmModelByProvider: Partial<Record<ProviderId, string>>
  /**
   * Размышления перед ответом. Включённые дают ответ точнее, но добавляют
   * секунды: модель сначала думает и только потом начинает писать.
   */
  llmThinking: boolean
  /**
   * Глубина размышлений в режиме «думает». 'default' — как решит Claude Code.
   * Режим «сразу» от неё не зависит: там всегда минимальная глубина.
   * На Haiku 4.5 глубины нет, настройка игнорируется.
   */
  llmEffort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Сколько ждать ответа суфлёра, секунд. Дольше — считаем, что сессия зависла. */
  llmTimeoutSec: number
  /** Сколько записей из базы знаний подавать модели вместе с вопросом. */
  kbTopK: number
  /**
   * Проверка подсказки вторым агентом: после ответа он сверяет утверждения
   * с базой и своими знаниями и показывает под ответом «проверено» или
   * уточнение. Работает с любым провайдером и расходует его лимиты.
   */
  verifyEnabled: boolean
  /**
   * Кто проверяет. Не обязан совпадать с тем, кто отвечает: у второго агента своя сессия.
   * Новому пользователю — тот же провайдер, что отвечает; до провайдеров второй агент был Claude.
   */
  verifyProvider: ProviderId
  /**
   * Провайдера второго агента выбрали сами. Пока нет — он следует за тем, кто отвечает:
   * иначе новый пользователь с ChatGPT получал бы проверку через Claude, которого у него нет.
   */
  verifyProviderChosen: boolean
  /** Модель второго агента — точный id модели провайдера verifyProvider. */
  verifyModel: string
  /** Последний выбор модели второго агента у каждого провайдера. */
  verifyModelByProvider: Partial<Record<ProviderId, string>>
  verifyEffort: 'low' | 'medium' | 'high'
  /**
   * Разрешить проверяющему искать в интернете: точнее на редких фактах, но заметно дольше.
   * Действует только у провайдеров, которые это умеют (ProviderInfo.webSearch).
   */
  verifyWeb: boolean
  /**
   * Свой системный промпт. Пусто — используется встроенный.
   * Задаёт роль и формат ответа: сюда же удобно класть контекст про домен,
   * компанию и то, как вы хотите слышать подсказку.
   */
  customPrompt: string
  /**
   * Файлы для контекста: резюме, описание проекта. Здесь только список и флаги, сам текст —
   * в папке данных приложения. Текст включённых уходит основной модели подсказок — со встроенным
   * промптом и со своим одинаково; второму агенту — нет.
   */
  contextFiles: ContextFile[]
  /** обучение при первом запуске пройдено или пропущено — само больше не показывается */
  onboardingDone: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  micDeviceId: '',
  opacity: 1,
  fontSize: 17,
  contentProtected: true,
  // Значок в трее — привычный способ найти приложение без панели задач: прячут его только сами.
  hideTray: false,
  language: 'ru',
  // База встроена в приложение — новому пользователю она нужна сразу: ответы из неё и мгновенные карточки.
  useKnowledgeBase: true,
  autoSuggest: true,
  showTranscript: true,
  zoom: 1,
  displayId: '',
  llmProvider: DEFAULT_PROVIDER,
  claudeSource: 'cli',
  glossaryNames: '',
  glossaryExclude: '',
  journalEnabled: true,
  llmModel: DEFAULT_MODEL,
  llmModelByProvider: {},
  llmThinking: true,
  llmEffort: 'default',
  llmTimeoutSec: 45,
  kbTopK: 3,
  verifyEnabled: false,
  verifyProvider: DEFAULT_PROVIDER,
  verifyProviderChosen: false,
  verifyModel: DEFAULT_MODEL,
  verifyModelByProvider: {},
  verifyEffort: 'high',
  verifyWeb: false,
  customPrompt: '',
  contextFiles: [],
  onboardingDone: false,
}

/**
 * Подсказки идут через Claude Code, а не через API по ключу. У API свой зашитый промпт,
 * поэтому команды из своего промпта там ничего не значат.
 */
export function viaClaudeCode(s: Pick<AppSettings, 'llmProvider' | 'claudeSource'>): boolean {
  return s.llmProvider === 'claude' && s.claudeSource === 'cli'
}

const VERIFY_EFFORTS: readonly AppSettings['verifyEffort'][] = ['low', 'medium', 'high']

const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** «Модель по провайдеру» из сохранённого: только известные провайдеры и непустые строки, у Claude — точный id. */
function modelsByProvider(raw: unknown): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const id of PROVIDER_IDS) {
    const v = textOf((raw as Record<string, unknown>)[id])
    if (v) out[id] = id === 'claude' ? normalizeModel(v) : v
  }
  return out
}

/**
 * Модель провайдера из сохранённого: сама модель, иначе запомненная у провайдера, иначе
 * fallback, иначе модель провайдера по умолчанию. byProvider дополняется на месте.
 */
function resolveModel(
  provider: ProviderId,
  rawModel: string | undefined,
  byProvider: Partial<Record<ProviderId, string>>,
  fallback?: string,
): string {
  if (provider === 'claude') return normalizeModel(rawModel ?? byProvider.claude)
  // Модель Claude у другого провайдера — след старых настроек, а не выбор: CLI её не примет.
  const claudeLeftover = rawModel !== undefined && isClaudeChoice(rawModel)
  // До провайдеров модель была моделью Claude: пусть она вернётся, когда пользователь переключится назад.
  if (claudeLeftover && !byProvider.claude) byProvider.claude = normalizeModel(rawModel)
  return (claudeLeftover ? undefined : rawModel) ?? byProvider[provider] ?? fallback ?? providerById(provider).defaultModel
}

/**
 * Сохранённые настройки — в нынешний вид. Старые не должны ломаться: до провайдеров
 * источник хранился как llmProvider 'claude-code' | 'api', а модель — всегда моделью
 * Claude, ещё раньше — псевдонимом «opus». Незнакомые и битые значения молча
 * заменяются значениями по умолчанию: из-за одной настройки окно не должно падать.
 */
export function migrateSettings(raw: unknown): AppSettings {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const saved = { ...DEFAULT_SETTINGS, ...(src as Partial<AppSettings>) }

  const legacy = src.llmProvider
  const llmProvider: ProviderId =
    legacy === 'claude-code' || legacy === 'api' ? 'claude' : isProviderId(legacy) ? legacy : DEFAULT_PROVIDER
  const claudeSource: ClaudeSource =
    src.claudeSource === 'cli' || src.claudeSource === 'api' ? src.claudeSource : legacy === 'api' ? 'api' : 'cli'

  const llmModelByProvider = modelsByProvider(src.llmModelByProvider)
  const llmModel = resolveModel(llmProvider, textOf(src.llmModel), llmModelByProvider)
  llmModelByProvider[llmProvider] = llmModel

  // Второй агент. До провайдеров он был только Claude, и его модель хранилась моделью Claude:
  // сохранённая модель без провайдера — это Claude, даже если подсказки уже идут через другого.
  // Совсем нового пользователя проверяет тот же провайдер, что отвечает.
  // Сохранённый verifyProvider ещё не выбор: окно сохраняет настройки целиком при первой же правке.
  // Выбором считаем явный флаг или настройки до провайдеров — там проверял Claude, и так и остаётся.
  const verifyProviderChosen =
    src.verifyProviderChosen === true || (!('verifyProviderChosen' in src) && typeof src.verifyModel === 'string')
  // Не выбран — второй агент следует за тем, кто отвечает.
  const verifyProvider: ProviderId = !verifyProviderChosen
    ? llmProvider
    : isProviderId(src.verifyProvider)
      ? src.verifyProvider
      : 'claude'
  const verifyModelByProvider = modelsByProvider(src.verifyModelByProvider)
  // У Ollama своей модели по умолчанию нет: скачанная модель, которой уже отвечают, лучше пустой.
  const verifyModel = resolveModel(
    verifyProvider,
    textOf(src.verifyModel),
    verifyModelByProvider,
    verifyProvider === 'claude' ? undefined : llmModelByProvider[verifyProvider],
  )
  verifyModelByProvider[verifyProvider] = verifyModel

  return {
    ...saved,
    llmProvider,
    claudeSource,
    llmModel,
    llmModelByProvider,
    verifyProvider,
    verifyProviderChosen,
    verifyModel,
    verifyModelByProvider,
    verifyEffort: VERIFY_EFFORTS.includes(saved.verifyEffort) ? saved.verifyEffort : DEFAULT_SETTINGS.verifyEffort,
    verifyWeb: saved.verifyWeb === true,
    // Строго true: спрятать значок по битому значению — оставить приложение без запасного выхода.
    hideTray: saved.hideTray === true,
    // Список файлов правят руками и сбои записи: битые строки отбрасываем, остальные оставляем.
    contextFiles: contextFilesOf(src.contextFiles),
  }
}

export interface HotkeyDef {
  id: string
  label: string
  combo: string
  /** true — уже работает, false — место зарезервировано */
  live: boolean
}

export const HOTKEYS: HotkeyDef[] = [
  { id: 'ask', label: 'Спросить', combo: 'Ctrl+Shift+Space', live: true },
  { id: 'screenshot', label: 'Скриншот экрана — или отправить серию', combo: 'Ctrl+Shift+Enter', live: true },
  { id: 'addshot', label: 'Добавить снимок в серию', combo: 'Ctrl+Shift+Plus', live: true },
  { id: 'prev', label: 'Предыдущая подсказка', combo: 'Ctrl+Left', live: true },
  { id: 'next', label: 'Следующая подсказка', combo: 'Ctrl+Right', live: true },
  { id: 'session', label: 'Старт/стоп сессии', combo: 'Ctrl+Shift+S', live: true },
  { id: 'hide', label: 'Скрыть панель', combo: 'Ctrl+Shift+H', live: true },
  { id: 'clickthrough', label: 'Клики сквозь панель', combo: 'Ctrl+Shift+X', live: true },
  { id: 'markLine', label: 'Набранная строка решения — вперёд / назад', combo: 'Ctrl+Down+Up', live: true },
]
