import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { MicCapture, listMicrophones } from './audio/capture'
import { SttClient, type SttMessage, type HotwordsInfo } from './stt/client'
import { Menu } from './components/Menu'
import { Settings } from './components/Settings'
import { Answer } from './components/Answer'
import { SecondAgent, type VerifyState } from './components/SecondAgent'
import { Dropdown, Keys } from './components/Controls'
import { Critter, Mascot, type CritterMode } from './components/Mascot'
import { ProviderPicker, useProviders } from './components/ProviderPicker'
import { notReadyText, promptReachesModel, resumeModel, resumeVerifyModel } from './providerStatus'
import { Tour } from './components/Tour'
import { comboKeys, hotkeyCombo } from './keys'
import { codeLineCount, isTaskText } from '@shared/answerFormat'
import { modelFamily, modelName } from '@shared/models'
import { providerById, type ModelInfo, type ProviderId } from '@shared/providers'
import { promptCommands } from '@shared/promptCommands'
import {
  Alert,
  Bars,
  Bubble,
  Burger,
  Camera,
  Chevron,
  Chip,
  Close as Cross,
  Duo,
  Eye,
  EyeOff,
  Grip,
  Play,
  Plus,
  Pointer,
  Spinner,
  Stop,
} from './components/Icons'
import { DEFAULT_SETTINGS, migrateSettings, type AppSettings } from '@shared/settings'
import { composeTerms, splitLines, topicLabel, type TopicGlossary } from '@shared/glossary'
import type { OverlayStatus, Speaker } from '@shared/types'
import type { KbHit, LlmTarget } from '../preload'

const STORE_KEY = 'copilot.settings.v1'

/**
 * Кто отвечает и с какими настройками — для подсказки, снимка и прогрева.
 * Глубину выбирают только у Claude (в окне она подписана «только у Claude»),
 * поэтому остальным уходит 'default': выбранная для Claude «максимальная»
 * не должна молча доставаться ChatGPT, у которого такого уровня нет.
 */
function llmTarget(s: AppSettings): LlmTarget {
  return {
    provider: s.llmProvider,
    claudeSource: s.claudeSource,
    customPrompt: s.customPrompt,
    model: s.llmModel,
    thinking: s.llmThinking,
    effort: s.llmProvider === 'claude' ? s.llmEffort : 'default',
  }
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    // Старые настройки — в нынешний вид: источник 'claude-code' | 'api' стал провайдером и
    // способом обращения к Claude, модели-псевдонимы «opus / sonnet / haiku» — точными id.
    return migrateSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}

function rmsDb(pcm: ArrayBuffer): number {
  const v = new Int16Array(pcm)
  if (v.length === 0) return -100
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const s = v[i]! / 32768
    sum += s * s
  }
  const rms = Math.sqrt(sum / v.length)
  return rms > 0 ? 20 * Math.log10(rms) : -100
}

/** −60…0 dBFS -> доля 0..1 для высоты столбца волны */
const dbToUnit = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60))

/** Сколько столбцов в трассе уровня. */
const WAVE_LEN = 30
/** В узком окне трасса короче: иначе кнопкам не хватает строки. */
const WAVE_LEN_COMPACT = 14

/** Сколько последних реплик смотреть, определяя тему разговора. */
const TOPIC_WINDOW = 4
/**
 * Минимальное покрытие совпадения, чтобы оно голосовало за тему.
 *
 * Подобрано замером на 328 формулировках из базы с известной темой: при 0.3
 * тема угадывается в 84% случаев, при 0.5 — в 91%, при 0.6 — в 97%. Выше порог —
 * точнее, но на живой речи совпадения слабее, и при слишком высоком пороге тема
 * могла бы не определяться вовсе. Взято 0.5: ошибиться с темой бесполезно,
 * а промолчать дёшево — постоянная часть словаря работает и без темы.
 */
const TOPIC_MIN_COVERAGE = 0.5

/**
 * Где окно начинает ужиматься. Уже 1000 px с кнопок уходят клавиши, с волн —
 * подписи; уже 780 px кнопки остаются иконками, строка распознавания уходит
 * из строки состояния. Ниже 300 px остаются только ответ и управление.
 */
const MID_W = 1000
const COMPACT_W = 780
const TINY_H = 300
/** Уже этой ширины два окна агентов встают друг под другом. */
const STACK_W = 1100
/** Сколько высоты держим под расшифровку, пока она показана. */
const TR_RESERVE = 72

/** Сколько подложка держится плотной после того, как ответ допечатан: дочитать последнюю строку. */
const AFTERGLOW_MS = 2000
/** Сколько горят клавиши на кнопке после горячей клавиши. */
const FLASH_MS = 380
/** Сколько висит строка «провайдер не готов» после выбора его модели — как в макете. */
const NOTICE_MS = 5000

interface Line {
  id: number
  speaker: Speaker
  text: string
}

interface Suggestion {
  id: number
  question: string
  answer: string
  pending: boolean
  /** миниатюра снимка экрана — только для ответов по скриншоту */
  preview?: string
  /** миниатюры всех снимков серии по порядку; у одиночного снимка — одна */
  previews?: string[]
  /** сколько снимков ушло в вопрос: подпись ожидания и ответа говорит «3 снимка» */
  shots?: number
  /** момент отправки: от него идёт счётчик ожидания */
  startedAt: number
  /** сколько заняло, когда ответ пришёл целиком */
  tookMs?: number
  /** модель ушла размышлять — пауза осмысленная, а не зависание */
  reasoning?: boolean
  /** проверка вторым агентом: приходит позже самого ответа */
  verify?: VerifyState
  /** ответ оборвался на середине: напечатанное остаётся, причина — подписью */
  error?: string
  /** готовый ответ из базы: встаёт в историю сразу, раньше ответа модели */
  kb?: KbHit
  /** кто и чем отвечал — для подписи под ответом и зверька в ней */
  provider?: ProviderId
  model?: AppSettings['llmModel']
  thinking?: boolean
  /** сколько строк кода в ответе отмечено набранными: клик по строке или Ctrl ↓ */
  mark?: number
}

const nowMs = () => Date.now()

const WHO: Record<Speaker, string> = { me: 'Я', them: 'Собеседник' }
/** Метка канала в узком окне: «Собеседник» целиком съел бы полстроки реплики. */
const WHO_SHORT: Record<Speaker, string> = { me: 'Я', them: 'С' }

const ERROR_PREFIX = 'Ошибка: '

/** 4200 -> «4,2»: подписи читают по-русски. */
const sec1 = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',')

/** Серия снимков: больше шести модель в одном вопросе читает хуже, а ответ ждать дольше. */
const SERIES_MAX = 6

interface SeriesShot {
  id: string
  preview: string
  /** «Экран 1» — с какого экрана снято */
  screen: string
}

/** «1 снимок», «3 снимка», «5 снимков»; withN — с числом впереди. */
function pluralRu(n: number, one: string, few: string, many: string, withN = false): string {
  const a = n % 10
  const b = n % 100
  const w = a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many
  return withN ? `${n} ${w}` : w
}

/**
 * Ответ не дошёл до конца. Напечатанное не стираем: его, может быть, уже
 * читают вслух, и замена на «Ошибка: …» посреди фразы хуже недосказанности.
 */
function failed(x: Suggestion, error: string, tookMs: number): Suggestion {
  return x.answer.trim()
    ? { ...x, pending: false, tookMs, error }
    : { ...x, answer: `${ERROR_PREFIX}${error}`, pending: false, tookMs }
}

/**
 * Подпись под ответом: «ChatGPT · GPT-5.6 Sol · думает · 9,5 с» — кто, чем и сколько.
 * В узком окне имя провайдера уходит: его и так видно по зверьку в подписи.
 */
function metaLine(
  s: Suggestion | undefined,
  live: (id: ProviderId) => readonly ModelInfo[],
  compact: boolean,
): { text: string; alert: boolean } | null {
  if (!s || s.pending) return null
  if (s.kb) return { text: 'мгновенно · без ожидания модели', alert: false }
  if (s.tookMs === undefined) return null
  const shot = !!s.preview || s.question === 'Снимок экрана'
  const provider = s.provider ?? 'claude'
  // Снимок у Claude по API не знает своей модели — только «снимок».
  const shotWord = (s.shots ?? 1) > 1 ? pluralRu(s.shots!, 'снимок', 'снимка', 'снимков', true) : 'снимок'
  const who = s.model
    ? `${modelName(s.model, provider, live(provider))} · ${shot ? shotWord : s.thinking ? 'думает' : 'сразу'}`
    : shot
      ? shotWord
      : ''
  const name = compact || !s.provider ? '' : providerById(provider).name
  const text = [name, who, `${sec1(s.tookMs)} с`].filter(Boolean).join(' · ')
  return s.error ? { text: `${text} · ответ оборван: ${s.error}`, alert: true } : { text, alert: false }
}

/** Готовый ответ из базы: «Кратко» и опорные пункты — ровно для взгляда вскользь. */
function KbAnswer({ hit }: { hit: KbHit }) {
  const points = hit.anchors.split(' • ').filter(Boolean).slice(0, 5)
  return (
    <div className="kb">
      <div className="kb-head">
        <span className="eyebrow">Кратко</span>
        <span className="badge-accent">{hit.topic ? `из базы · ${topicLabel(hit.topic)}` : 'из базы'}</span>
      </div>
      <p className="kb-brief">{hit.short}</p>
      {points.map((a, i) => (
        <p key={i} className="point">
          {a}
        </p>
      ))}
    </div>
  )
}

function TrLine({ speaker, text, draft }: { speaker: Speaker; text: string; draft?: boolean }) {
  return (
    <div className={`tr-line ${speaker} ${draft ? 'draft' : ''}`}>
      <span className="tr-who">
        <span className="full">{WHO[speaker]}</span>
        <span className="short">{WHO_SHORT[speaker]}</span>
      </span>
      <span className="tr-text">{text}</span>
    </div>
  )
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [status, setStatus] = useState<OverlayStatus | null>(null)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [engine, setEngine] = useState<string | null>(null)
  const [loopbackOk, setLoopbackOk] = useState(false)

  const [lines, setLines] = useState<Line[]>([])
  const [draft, setDraft] = useState<Record<Speaker, string>>({ me: '', them: '' })
  // Трасса уровня: новые значения приходят справа, старые уезжают влево.
  const [wave, setWave] = useState<Record<Speaker, number[]>>({
    me: Array(WAVE_LEN).fill(0),
    them: Array(WAVE_LEN).fill(0),
  })

  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const suggestionsRef = useRef<Suggestion[]>([])
  suggestionsRef.current = suggestions
  /**
   * Ответ из базы открыт, а модель ещё думает. Как только модель начнёт
   * печатать, окно само переключится на её ответ — если пользователь всё ещё
   * смотрит на ответ из базы, а не ушёл листать историю.
   */
  const kbHandoff = useRef<{ kbId: number; modelId: number } | null>(null)
  /**
   * Найденное в базе по последним репликам собеседника. Ищем НЕ по хоткею:
   * вопрос уже прозвучал и распознан за секунды до того, как пользователь
   * потянулся к клавишам. К моменту нажатия ответ уже лежит здесь.
   */
  const [staged, setStaged] = useState<{ hits: KbHit[]; confident: boolean } | null>(null)
  /** словарь распознавания из базы, тема разговора и что из словаря реально влезло */
  const [glossary, setGlossary] = useState<TopicGlossary | null>(null)
  const [topic, setTopic] = useState<string | null>(null)
  const [hotwords, setHotwords] = useState<HotwordsInfo | null>(null)
  const topicRef = useRef<string | null>(null)
  const topicVotes = useRef<{ candidate: string | null; streak: number }>({ candidate: null, streak: 0 })
  const [cursor, setCursor] = useState(0)
  const [query, setQuery] = useState('')

  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** обучение: номер показа, 0 — закрыто. Номер нужен, чтобы повтор начинался с первого шага. */
  const [tourRun, setTourRun] = useState(0)
  const tourCount = useRef(0)
  const openTour = useCallback(() => {
    setMenuOpen(false)
    setSettingsOpen(false)
    tourCount.current += 1
    setTourRun(tourCount.current)
  }, [])
  // Первый запуск: обучение начинается само, когда окно уже на экране.
  useEffect(() => {
    if (settings.onboardingDone) return
    const t = window.setTimeout(openTour, 900)
    return () => window.clearTimeout(t)
  }, [])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [screens, setScreens] = useState<Array<{ id: string; label: string; primary: boolean }>>([])

  /* ---------- вид окна: плотность, размер, режимы ---------- */

  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ compact: false, mid: false, tiny: false, w: 1140, h: 470 })
  const [clickThrough, setClickThrough] = useState(false)
  const [afterglow, setAfterglow] = useState(false)
  const [dictHover, setDictHover] = useState(false)
  const [flash, setFlash] = useState<'ask' | 'shot' | 'add' | null>(null)
  const flashTimer = useRef(0)

  const micRef = useRef<MicCapture | null>(null)
  const sttRef = useRef<SttClient | null>(null)
  const pending = useRef<Record<Speaker, number>>({ me: -100, them: -100 })
  const nextId = useRef(1)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const answerRef = useRef<HTMLDivElement>(null)

  const running = phase === 'running'
  /** Идёт или поднимается сессия — только тогда смена провайдера и модели сразу греет CLI. */
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const current = suggestions[cursor]
  /** Режим двух агентов: второй проверяет каждую подсказку в соседнем окне. */
  const duo = settings.verifyEnabled
  const { compact, mid, tiny } = layout

  /**
   * Настройки второго агента одним объектом: уходят в прогрев и в main при каждой смене.
   * Проверяет любой провайдер, независимо от того, кто и как отвечает. «Веб» — только тем,
   * кто умеет искать: main и сам не передаст его неумеющему, а здесь флаг не врёт.
   */
  const verifyConfig = useMemo(
    () => ({
      enabled: settings.verifyEnabled,
      provider: settings.verifyProvider,
      model: settings.verifyModel,
      effort: settings.verifyEffort,
      web: settings.verifyWeb && providerById(settings.verifyProvider).webSearch,
    }),
    [settings.verifyEnabled, settings.verifyProvider, settings.verifyModel, settings.verifyEffort, settings.verifyWeb],
  )

  /** Провайдеры: установлен ли, выполнен ли вход, живой список моделей. */
  const providers = useProviders()
  const providersRef = useRef(providers.statuses)
  providersRef.current = providers.statuses
  const liveModels = useCallback((id: ProviderId) => providers.statuses[id].models, [providers.statuses])

  /**
   * Поднять сессию под заданные настройки. Провайдер, модель и размышления задаются
   * при запуске CLI, поэтому смена перезапускает сессию — и делать это надо
   * сразу, а не в момент вопроса, иначе пользователь оплатит старт ожиданием.
   * Настройки передаются целиком: после смены провайдера замыкание ещё помнит старые.
   */
  const warm = useCallback((s: AppSettings) => {
    // У API по ключу греть нечего: каждый запрос — отдельный вызов.
    // Не установлен или без входа — поднимать нечего: CLI запускался бы только ради ошибки.
    const state = providersRef.current[s.llmProvider].available.state
    const skipMain =
      (s.llmProvider === 'claude' && s.claudeSource === 'api') || state === 'not-installed' || state === 'not-logged-in'
    // Второй агент живёт у своего провайдера: основной не готов — его всё равно стоит прогреть.
    // Готов ли он сам, main проверяет по своему кэшу статусов.
    if (skipMain && !s.verifyEnabled) return
    void window.copilot.warmupLlm({ ...llmTarget(s), skipMain })
  }, [])

  // start() секундами ждёт распознавание и только потом греет сессию. Греть надо
  // под настройки, какие стали к этому моменту, а не какие были при нажатии «Старт».
  const warmNow = useRef(() => {})
  warmNow.current = () => warm(settings)

  // По этим настройкам main решает, проверять ли готовый ответ, — шлём каждую смену, и вне сессии тоже.
  // Эффект стоит раньше прогрева: main должен узнать настройки до того, как станет греть второго агента.
  useEffect(() => {
    void window.copilot.setVerifyConfig(verifyConfig)
  }, [verifyConfig])

  // Глубина и проверка тоже задаются при запуске CLI. Поменяли их в настройках
  // посреди созвона — поднимаем сессию сразу, а не на следующем вопросе.
  const warmedWith = useRef({ effort: settings.llmEffort, verify: verifyConfig })
  useEffect(() => {
    const prev = warmedWith.current
    warmedWith.current = { effort: settings.llmEffort, verify: verifyConfig }
    if (running && (prev.effort !== settings.llmEffort || prev.verify !== verifyConfig)) warmNow.current()
  }, [running, settings.llmEffort, verifyConfig])

  /** Проверить текущую подсказку по кнопке из окна второго агента. */
  const verifyNow = useCallback(() => {
    if (!current || current.kb) return
    void window.copilot.verifyNow({
      requestId: current.id,
      question: current.question,
      answer: current.answer,
      verify: { ...verifyConfig, enabled: true },
      kbTopK: settings.kbTopK,
    })
  }, [current, verifyConfig, settings.kbTopK])

  /** Отметить набранными строки кода подсказки до n-й включительно; 0 — снять отметку. */
  const markLines = useCallback((id: number, n: number) => {
    setSuggestions((s) => s.map((x) => (x.id === id ? { ...x, mark: Math.max(0, n) } : x)))
  }, [])

  // Копируем через main: буфер обмена из окна требует фокуса, а панель поверх созвона его часто не держит.
  const copyText = useCallback((text: string) => {
    void window.copilot.copyText(text)
  }, [])

  /* ---------- настройки ---------- */

  /** Несколько настроек разом: провайдер и его модель меняются только вместе. */
  const patch = useCallback((changes: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...changes }
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch {
        /* приватный режим — не критично */
      }
      return next
    })
  }, [])

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => patch({ [key]: value } as Partial<AppSettings>),
    [patch],
  )

  /**
   * Отвечать этим провайдером и этой моделью. Выбор запоминается за провайдером:
   * вернулись к нему — вернулась и его модель.
   *
   * Сессия поднимается сразу, но только пока идёт созвон. Вне сессии перебор провайдеров в
   * настройках иначе гасил бы прогретый Claude Code и запускал чужой CLI на каждый щелчок,
   * а прогрев Claude — это настоящий вопрос из лимитов. «Старт» и так греет под итоговый выбор.
   */
  const choose = useCallback(
    (provider: ProviderId, model: string) => {
      const changes: Partial<AppSettings> = {
        llmProvider: provider,
        llmModel: model,
        llmModelByProvider: { ...settings.llmModelByProvider, [provider]: model },
      }
      // Пока второму агенту не выбрали провайдера сами, он проверяет тем же, кто отвечает.
      if (!settings.verifyProviderChosen && settings.verifyProvider !== provider) {
        const verifyModel = resumeVerifyModel(settings, provider, providersRef.current[provider].models)
        changes.verifyProvider = provider
        changes.verifyModel = verifyModel
        changes.verifyModelByProvider = { ...settings.verifyModelByProvider, [provider]: verifyModel }
      }
      patch(changes)
      if (phaseRef.current !== 'idle') warm({ ...settings, ...changes })
    },
    [settings, patch, warm],
  )

  /** Модель, с которой вернуться к провайдеру: прошлый выбор, иначе его модель по умолчанию, иначе первая живая. */
  const modelToResume = useCallback(
    (id: ProviderId) => resumeModel(settings, id, providers.statuses[id].models),
    [settings, providers.statuses],
  )

  const switchProvider = useCallback((id: ProviderId) => choose(id, modelToResume(id)), [choose, modelToResume])

  /**
   * Кто проверяет и какой моделью. Выбор тоже запоминается за провайдером — отдельно от того,
   * чем этот провайдер отвечает. Прогревать не нужно: смена настроек второго агента уходит в main
   * эффектом ниже, а посреди созвона сессию поднимает тот же эффект, что и для глубины.
   */
  const chooseVerifier = useCallback(
    (provider: ProviderId, model: string) =>
      patch({
        verifyProvider: provider,
        verifyProviderChosen: true,
        verifyModel: model,
        verifyModelByProvider: { ...settings.verifyModelByProvider, [provider]: model },
      }),
    [settings.verifyModelByProvider, patch],
  )

  const switchVerifier = useCallback(
    (id: ProviderId) => chooseVerifier(id, resumeVerifyModel(settings, id, providers.statuses[id].models)),
    [chooseVerifier, settings, providers.statuses],
  )

  // Модели по умолчанию у Ollama нет — берём первую из живого списка, как только он пришёл.
  const firstLive = providers.statuses[settings.llmProvider].models[0]?.id
  useEffect(() => {
    if (settings.llmModel || !firstLive) return
    patch({
      llmModel: firstLive,
      llmModelByProvider: { ...settings.llmModelByProvider, [settings.llmProvider]: firstLive },
    })
  }, [settings.llmModel, settings.llmProvider, settings.llmModelByProvider, firstLive, patch])

  // То же у второго агента: проверять Ollama без модели нечем.
  const firstVerifyLive = providers.statuses[settings.verifyProvider].models[0]?.id
  useEffect(() => {
    if (settings.verifyModel || !firstVerifyLive) return
    patch({
      verifyModel: firstVerifyLive,
      verifyModelByProvider: { ...settings.verifyModelByProvider, [settings.verifyProvider]: firstVerifyLive },
    })
  }, [settings.verifyModel, settings.verifyProvider, settings.verifyModelByProvider, firstVerifyLive, patch])

  // Прозрачность окна больше не трогаем: окно всегда непрозрачно, а прозрачна
  // только подложка — через --d на корне. Иначе вместе с подложкой бледнел бы текст.

  useEffect(() => {
    void window.copilot.setContentProtection(settings.contentProtected)
  }, [settings.contentProtected])

  useEffect(() => {
    void window.copilot.setZoom(settings.zoom)
  }, [settings.zoom])

  useEffect(() => {
    void window.copilot.journalSetEnabled(settings.journalEnabled)
  }, [settings.journalEnabled])

  // Ctrl +/-/0 — привычная комбинация масштаба, работает пока окно в фокусе.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        update('zoom', Math.min(2, Math.round((settings.zoom + 0.1) * 10) / 10))
      } else if (e.key === '-') {
        e.preventDefault()
        update('zoom', Math.max(0.6, Math.round((settings.zoom - 0.1) * 10) / 10))
      } else if (e.key === '0') {
        e.preventDefault()
        update('zoom', 1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settings.zoom, update])

  // Режимы по размеру окна. Меняем состояние только при переходе через порог,
  // а не на каждый пиксель, пока окно тянут за уголок.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const w = Math.round(entry.contentRect.width)
      const h = Math.round(entry.contentRect.height)
      const next = { compact: w < COMPACT_W, mid: w < MID_W, tiny: h < TINY_H, w, h }
      setLayout((prev) => (prev.w === w && prev.h === h ? prev : next))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Режим держит main, панель его только показывает. При загрузке спрашиваем: после
  // перезагрузки в dev он может быть уже включён. Сами не выставляем даже после своего
  // же запроса — не переключилось окно, не должна переключиться и панель.
  useEffect(() => {
    // Строго true: всё, что не булево, — не ответ main, и режим по нему не включаем.
    const apply = (on: boolean) => setClickThrough(on === true)
    void window.copilot.getClickThrough().then(apply)
    return window.copilot.onClickThroughChanged(apply)
  }, [])

  // Меню и настройки остались бы висеть открытыми, а нажать в них в этом режиме уже ничего нельзя.
  useEffect(() => {
    if (!clickThrough) return
    setMenuOpen(false)
    setSettingsOpen(false)
  }, [clickThrough])

  /* ---------- статус и уровни ---------- */

  useEffect(() => {
    window.copilot.getStatus().then(setStatus)
    void window.copilot.listScreens().then(setScreens)
    return window.copilot.onStatus(setStatus)
  }, [])

  // Уровни копим в ref и отдаём в state раз в четыре кадра: иначе десятки
  // ререндеров в секунду на ровном месте, а волна проносится слишком быстро,
  // чтобы её можно было прочитать.
  useEffect(() => {
    let raf = 0
    let frame = 0
    const tick = () => {
      if (frame++ % 4 === 0) {
        setWave((w) => ({
          me: [...w.me.slice(1), dbToUnit(pending.current.me)],
          them: [...w.them.slice(1), dbToUnit(pending.current.them)],
        }))
      }
      // затухание, чтобы столбцы гасли, а не залипали
      pending.current.me = Math.max(-100, pending.current.me - 1.5)
      pending.current.them = Math.max(-100, pending.current.them - 1.5)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [lines, draft])

  /* ---------- расшифровка ---------- */

  const onStt = useCallback((m: SttMessage) => {
    if (m.type === 'level') {
      pending.current[m.channel] = m.db ?? -100
      return
    }
    if (m.type === 'partial') {
      setDraft((d) => ({ ...d, [m.channel]: m.text }))
      return
    }
    setDraft((d) => ({ ...d, [m.channel]: '' }))
    if (m.text.trim()) {
      window.copilot.journalLine(m.channel, m.text)
      setLines((ls) => [...ls.slice(-200), { id: nextId.current++, speaker: m.channel, text: m.text }])
    }
  }, [])

  /** Ответ модели пошёл — открываем его, если пользователь всё ещё смотрит на ответ из базы. */
  const handoff = useCallback((requestId: number) => {
    const h = kbHandoff.current
    if (!h || h.modelId !== requestId) return
    kbHandoff.current = null
    setCursor((c) => {
      const list = suggestionsRef.current
      const to = list.findIndex((x) => x.id === requestId)
      return list[c]?.id === h.kbId && to >= 0 ? to : c
    })
  }, [])

  // Дельты ответа приходят по мере генерации — дописываем их в подсказку,
  // чтобы первый тезис читался уже через секунду.
  useEffect(
    () =>
      window.copilot.onDelta(({ requestId, chunk }) => {
        setSuggestions((s) =>
          // Подсказка уже закрыта ошибкой или таймаутом — поздний хвост не дописываем.
          s.map((x) =>
            x.id === requestId && x.tookMs === undefined ? { ...x, answer: x.answer + chunk, pending: false } : x,
          ),
        )
        handoff(requestId)
      }),
    [handoff],
  )

  // Размышления идут молча. Без отметки такая пауза читается как зависание,
  // а с ней — как работа, за которую пользователь сам и заплатил секундами.
  useEffect(
    () =>
      window.copilot.onThinking(({ requestId }) => {
        setSuggestions((s) => s.map((x) => (x.id === requestId ? { ...x, reasoning: true } : x)))
      }),
    [],
  )

  // Ход и итог проверки приходят позже ответа: окно второго агента обновляется на месте.
  useEffect(
    () =>
      window.copilot.onVerify(({ requestId, ...u }) => {
        setSuggestions((s) =>
          s.map((x) => {
            if (x.id !== requestId) return x
            // Тот же ответ проверяют заново — окно начинается с чистого листа, а не дописывает старое.
            const again = u.startedAt !== undefined && u.startedAt !== x.verify?.startedAt
            return { ...x, verify: { ...(again ? undefined : x.verify), ...u } }
          }),
        )
      }),
    [],
  )

  // Счётчик ожидания: пока подсказка в работе, тикаем раз в 100 мс.
  // Ожидание с цифрой переносится легче, чем ожидание без неё.
  const [, setTick] = useState(0)
  // Счётчик нужен и окну второго агента, пока идёт проверка.
  const anyPending = suggestions.some((x) => x.pending || x.verify?.status === 'checking')
  useEffect(() => {
    if (!anyPending) return
    const t = setInterval(() => setTick((n) => n + 1), 100)
    return () => clearInterval(t)
  }, [anyPending])

  /**
   * Текст печатается — подложка уплотняется до 100 %, чтобы его можно было
   * прочитать на любом фоне, и держится ещё две секунды после последнего слова.
   */
  const printing = suggestions.some(
    (x) =>
      (!x.kb && !x.pending && x.tookMs === undefined && x.answer !== '') ||
      (x.verify?.status === 'checking' && !!x.verify.text),
  )
  const wasPrinting = useRef(false)
  useEffect(() => {
    if (printing) {
      wasPrinting.current = true
      setAfterglow(false)
      return
    }
    if (!wasPrinting.current) return
    wasPrinting.current = false
    setAfterglow(true)
    const t = setTimeout(() => setAfterglow(false), AFTERGLOW_MS)
    return () => clearTimeout(t)
  }, [printing])

  /* ---------- сессия ---------- */

  const stop = useCallback(async () => {
    await micRef.current?.stop()
    micRef.current = null
    sttRef.current?.close()
    // Новый созвон — новая тема: прошлая не должна подсказывать чужие слова.
    setHotwords(null)
    topicRef.current = null
    topicVotes.current = { candidate: null, streak: 0 }
    setTopic(null)
    sttRef.current = null
    await window.copilot.stopStt()
    pending.current = { me: -100, them: -100 }
    setDraft({ me: '', them: '' })
    setLoopbackOk(false)
    setPhase('idle')
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setPhase('starting')
    try {
      const res = await window.copilot.startStt({ language: settings.language })
      if (!res.ok) throw new Error(res.error)
      setEngine(res.info.label)
      setLoopbackOk(Boolean(res.info.loopbackDevice) && !res.info.loopbackError)
      if (res.info.loopbackError) setError(`Звук собеседника: ${res.info.loopbackError}`)

      const stt = new SttClient(res.info.port, res.info.token, onStt, setError, setHotwords)
      await stt.connect(['me', 'them'])
      sttRef.current = stt
      // Словарь — сразу, не дожидаясь первой смены темы: имена и постоянная
      // часть нужны с первой же реплики.
      stt.sendHotwords(termsRef.current)

      const mic = new MicCapture((pcm) => {
        pending.current.me = rmsDb(pcm)
        stt.send('me', pcm)
      })
      await mic.start(settings.micDeviceId || undefined)
      micRef.current = mic

      setMics(await listMicrophones())
      setPhase('running')

      // Сессия Клода поднимается в фоне: стартовые секунды платим сейчас,
      // а не в момент, когда понадобится подсказка.
      warmNow.current()
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      console.error('[start] ' + msg)
      setError(msg)
      setPhase('idle')
      await stop().catch(() => {})
    }
  }, [
    settings.language,
    settings.micDeviceId,
    settings.llmProvider,
    settings.llmModel,
    settings.llmThinking,
    onStt,
    stop,
  ])

  const toggleSession = useCallback(() => {
    if (phase === 'starting') return
    void (running ? stop() : start())
  }, [phase, running, start, stop])

  /**
   * Поиск по базе на каждой завершённой реплике собеседника.
   *
   * Окно из нескольких последних реплик, а не одна: вопрос часто разбит на
   * две-три фразы («а вот смотри… у нас отчёт по продажам… чего он так долго?»).
   * Поиск стоит доли миллисекунды, поэтому дёргать его так часто не жалко.
   */
  useEffect(() => {
    if (!settings.autoSuggest) {
      setStaged(null)
      return
    }
    const them = lines.filter((l) => l.speaker === 'them').slice(-3)
    const q = them.map((l) => l.text).join(' ').trim()
    if (q.length < 12) return
    let alive = true
    // Небольшая задержка: пока человек договаривает, реплики идут пачкой,
    // и искать на каждой промежуточной незачем.
    const t = setTimeout(() => {
      void window.copilot
        .searchKb(q, 3)
        .then((r) => {
          if (alive) setStaged(r)
        })
        .catch(() => {
          /* база знаний не обязана быть доступной */
        })
    }, 350)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [lines, settings.autoSuggest])

  /* ---------- словарь распознавания ---------- */

  useEffect(() => {
    void window.copilot.getKbGlossary().then(setGlossary)
    return window.copilot.onKbGlossary(setGlossary)
  }, [])

  /**
   * Тема разговора для словаря.
   *
   * Отдельный поиск, а не тот, что выше: тот работает только при включённой
   * «Готовить ответ заранее», а словарь нужен всегда. Поиск стоит доли
   * миллисекунды, второй проход по базе ничего не стоит.
   *
   * Тема — та, у чьих совпадений больше суммарный вес. Меняем её, только
   * когда новая тема победила дважды подряд: одна случайная реплика не должна
   * перетряхивать словарь посреди разговора.
   */
  useEffect(() => {
    if (!running || !glossary) return
    // Каждую реплику ищем отдельно, а голоса складываем. Одним склеенным
    // запросом нельзя: покрытие считается от всех слов запроса, и на четырёх
    // репликах сразу оно почти никогда не дотянуло бы до порога.
    const recent = lines
      .slice(-TOPIC_WINDOW)
      .map((l) => l.text.trim())
      .filter((q) => q.length >= 12)
    if (!recent.length) return
    let alive = true
    const t = setTimeout(() => {
      void Promise.all(recent.map((q) => window.copilot.searchKb(q, 3)))
        .then((results) => {
          if (!alive) return
          const weight = new Map<string, number>()
          for (const { hits } of results) {
            for (const h of hits) {
              if (!h.topic || h.coverage < TOPIC_MIN_COVERAGE) continue
              weight.set(h.topic, (weight.get(h.topic) ?? 0) + h.score)
            }
          }
          const best = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0]
          if (!best) return

          const cur = topicRef.current
          const votes = topicVotes.current
          let next = cur
          if (cur === null || cur === best) {
            next = best
            votes.candidate = null
            votes.streak = 0
          } else {
            votes.streak = votes.candidate === best ? votes.streak + 1 : 1
            votes.candidate = best
            if (votes.streak >= 2) {
              next = best
              votes.candidate = null
              votes.streak = 0
            }
          }
          if (next !== cur) {
            topicRef.current = next
            setTopic(next)
          }
        })
        .catch(() => {
          /* база знаний не обязана быть доступной */
        })
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [lines, running, glossary])

  const composedTerms = useMemo(
    () =>
      composeTerms(
        glossary,
        topic,
        splitLines(settings.glossaryNames),
        splitLines(settings.glossaryExclude),
      ),
    [glossary, topic, settings.glossaryNames, settings.glossaryExclude],
  )
  const termsRef = useRef<string[]>([])
  termsRef.current = composedTerms

  // Словарь уходит в распознаватель при каждой смене — темы, своих слов, базы.
  // Небольшая задержка — чтобы не слать его на каждую букву, пока человек
  // печатает имена в настройках.
  useEffect(() => {
    const t = setTimeout(() => sttRef.current?.sendHotwords(composedTerms), 250)
    return () => clearTimeout(t)
  }, [composedTerms])

  /* ---------- подсказки ---------- */

  const transcript = useMemo(
    () => lines.slice(-40).map((l) => `[${WHO[l.speaker]}] ${l.text}`).join('\n'),
    [lines],
  )

  const ask = useCallback(
    async (manual?: string) => {
      const question = manual?.trim() || lines.filter((l) => l.speaker === 'them').slice(-1)[0]?.text || ''
      if (!question && !transcript) {
        setError('Пока нечего спрашивать — расшифровка пуста')
        return
      }
      const history = suggestionsRef.current
      // Уверенное совпадение из базы встаёт в историю раньше ответа модели: его
      // читают, пока модель думает. Один и тот же ответ второй раз не добавляем.
      const hit = !manual && settings.autoSuggest && staged?.confident ? staged.hits[0] : undefined
      const kb = hit && !history.some((x) => x.kb?.uid === hit.uid) ? hit : undefined
      const startedAt = nowMs()
      const kbId = kb ? nextId.current++ : 0
      const id = nextId.current++
      const added: Suggestion[] = []
      if (kb) added.push({ id: kbId, question: kb.question, answer: kb.short, pending: false, startedAt, tookMs: 0, kb })
      added.push({
        id,
        question,
        answer: '',
        pending: true,
        startedAt,
        provider: settings.llmProvider,
        model: settings.llmModel,
        thinking: settings.llmThinking,
      })
      setSuggestions((s) => [...s, ...added])
      setCursor(history.length)
      kbHandoff.current = kb ? { kbId, modelId: id } : null

      try {
        const out = await window.copilot.suggest({
          transcript,
          question,
          useKnowledgeBase: settings.useKnowledgeBase,
          ...llmTarget(settings),
          requestId: id,
          kbTopK: settings.kbTopK,
          timeoutSec: settings.llmTimeoutSec,
        })
        setSuggestions((s) =>
          s.map((x) => {
            if (x.id !== id) return x
            const tookMs = nowMs() - x.startedAt
            // Текст мог уже прийти дельтами — тогда не перетираем его.
            if (out.ok) return { ...x, answer: out.text || x.answer, pending: false, tookMs }
            return failed(x, out.error, tookMs)
          }),
        )
        // Без дельт (API) ответ приходит целиком — открываем его так же, как напечатанный.
        if (out.ok) handoff(id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setSuggestions((s) => s.map((x) => (x.id === id ? failed(x, msg, nowMs() - x.startedAt) : x)))
      }
    },
    [lines, transcript, settings, staged, handoff],
  )

  /**
   * Серия снимков: задача не влезла в один экран. Ctrl ⇧ + снимает экран сразу и
   * кладёт снимок в лоток, «Скриншот» превращается в «Отправить» — вся серия уходит
   * одним вопросом. Картинки держит main, здесь только миниатюры и порядок.
   */
  const [series, setSeries] = useState<SeriesShot[]>([])
  const seriesRef = useRef<SeriesShot[]>([])
  seriesRef.current = series
  /** снимок только что лёг в серию — кнопка на миг вспыхивает лаймовым кольцом */
  const [snapFlash, setSnapFlash] = useState(false)
  const snapTimer = useRef<number | undefined>(undefined)

  const addShot = useCallback(async () => {
    if (seriesRef.current.length >= SERIES_MAX) {
      setError('В серии не больше шести снимков — отправьте эти, следующие снимите отдельно')
      return
    }
    const out = await window.copilot.addToSeries({ displayId: settings.displayId || undefined })
    if (!out.ok) {
      setError(out.error)
      return
    }
    setError(null)
    setSeries((s) => [...s, { id: out.id, preview: out.preview, screen: out.screen }])
    setSnapFlash(true)
    window.clearTimeout(snapTimer.current)
    snapTimer.current = window.setTimeout(() => setSnapFlash(false), 180)
  }, [settings.displayId])

  const removeShot = useCallback((id: string) => {
    setSeries((s) => s.filter((x) => x.id !== id))
    void window.copilot.removeFromSeries(id)
  }, [])

  const clearSeries = useCallback(() => {
    setSeries([])
    void window.copilot.clearSeries()
  }, [])

  const askScreen = useCallback(async () => {
    const id = nextId.current++
    // Модель снимка известна у всех, кроме Claude по API: там снимок уходит своей моделью.
    const knowsModel = !(settings.llmProvider === 'claude' && settings.claudeSource === 'api')
    // Серия уходит целиком и сразу освобождает лоток: следующий снимок — уже новая серия.
    const ids = seriesRef.current.map((x) => x.id)
    const shots = Math.max(1, ids.length)
    setSeries([])
    setSuggestions((s) => [
      ...s,
      {
        id,
        question: 'Снимок экрана',
        answer: '',
        pending: true,
        startedAt: nowMs(),
        shots,
        provider: settings.llmProvider,
        ...(knowsModel && { model: settings.llmModel, thinking: settings.llmThinking }),
      },
    ])
    setCursor(suggestionsRef.current.length)

    try {
      const out = await window.copilot.askScreen({
        question: query.trim(),
        transcript,
        displayId: settings.displayId || undefined,
        seriesIds: ids.length ? ids : undefined,
        ...llmTarget(settings),
        requestId: id,
        timeoutSec: settings.llmTimeoutSec,
      })
      setSuggestions((s) =>
        s.map((x) => {
          if (x.id !== id) return x
          const tookMs = nowMs() - x.startedAt
          const shotsOut = { previews: out.previews, preview: out.previews?.[0] }
          // Текст мог уже прийти дельтами — тогда не перетираем его. Оборвалось посреди решения —
          // напечатанное остаётся: его, может быть, уже набирают, причина уходит в подпись.
          if (out.ok) return { ...x, ...shotsOut, answer: out.text || x.answer, pending: false, tookMs }
          return { ...failed(x, out.error, tookMs), ...shotsOut }
        }),
      )
      if (out.ok) setQuery('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSuggestions((s) => s.map((x) => (x.id === id ? failed(x, msg, nowMs() - x.startedAt) : x)))
    }
  }, [query, transcript, settings])

  /* ---------- хоткеи из main ---------- */

  /** Сработала горячая клавиша — клавиши на кнопке вспыхивают: видно, что нажатие дошло. */
  const flashKeys = useCallback((which: 'ask' | 'shot' | 'add') => {
    setFlash(which)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS)
  }, [])

  useEffect(
    () =>
      window.copilot.onAsk(() => {
        flashKeys('ask')
        void ask()
      }),
    [ask, flashKeys],
  )
  useEffect(() => window.copilot.onToggleSession(() => toggleSession()), [toggleSession])
  useEffect(
    () =>
      window.copilot.onScreenshot(() => {
        flashKeys('shot')
        void askScreen()
      }),
    [askScreen, flashKeys],
  )
  useEffect(
    () =>
      window.copilot.onAddShot(() => {
        flashKeys('add')
        void addShot()
      }),
    [addShot, flashKeys],
  )

  // Крючок для автоматической отладки: main вызывает его через
  // executeJavaScript(..., userGesture=true), что снимает требование
  // настоящего клика мышью у браузерных API захвата.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__copilotStart = () => void start()
    w.__copilotStop = () => void stop()
    w.__copilotAsk = (q?: string) => void ask(q)
    // Настройки — модальное окно: снимок экрана его не берёт, а посмотреть,
    // как оно выглядит, надо. Открываем крючком перед съёмкой.
    w.__copilotSettings = (open = true) => setSettingsOpen(open)
    /**
     * Отладка проявления: гоним текст теми же дельтами, что и модель, но с
     * заданной скоростью. Без этого проверить анимацию можно только вживую,
     * подгадывая момент снимка, — а модель отвечает когда захочет.
     */
    w.__copilotStreamDemo = (text: string, cps = 70) => {
      const id = nextId.current++
      setSuggestions((prev) => [
        ...prev,
        { id, question: 'Демо', answer: '', pending: true, startedAt: nowMs(), provider: settings.llmProvider, model: settings.llmModel, thinking: settings.llmThinking },
      ])
      setCursor(suggestionsRef.current.length)
      let i = 0
      const step = () => {
        if (i >= text.length) {
          setSuggestions((prev) =>
            prev.map((x) => (x.id === id ? { ...x, tookMs: nowMs() - x.startedAt } : x)),
          )
          return
        }
        // Куски неровные — как у модели: то тридцать символов, то три.
        const take = 3 + Math.floor(Math.random() * 30)
        const chunk = text.slice(i, i + take)
        i += take
        setSuggestions((prev) =>
          prev.map((x) => (x.id === id ? { ...x, answer: x.answer + chunk, pending: false } : x)),
        )
        setTimeout(step, (chunk.length / cps) * 1000)
      }
      step()
    }

    // Отладка вида: подставить готовый ответ, не дожидаясь модели.
    w.__copilotFakeAnswer = (text: string) => {
      setSuggestions((prev) => [
        ...prev,
        {
          id: nextId.current++,
          question: 'Тест',
          answer: text,
          pending: false,
          startedAt: nowMs(),
          tookMs: 1840,
          provider: settings.llmProvider,
          model: settings.llmModel,
          thinking: settings.llmThinking,
        },
      ])
      setCursor(suggestionsRef.current.length)
    }
    // Отладка вида: ответ из базы в истории.
    w.__copilotKbDemo = (hit: KbHit) => {
      setSuggestions((prev) => [
        ...prev,
        { id: nextId.current++, question: hit.question, answer: hit.short, pending: false, startedAt: nowMs(), tookMs: 0, kb: hit },
      ])
      setCursor(suggestionsRef.current.length)
    }
  })

  useEffect(() => {
    const nav = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, c - 1))
      if (e.key === 'ArrowRight') setCursor((c) => Math.min(suggestions.length - 1, c + 1))
      // Ctrl ↓ / ↑ — «набрано до сюда» в коде открытого ответа: на live coding
      // взгляд уходит в редактор, и без отметки легко потерять строку.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // В поле ввода и в открытых меню и настройках стрелки принадлежат им, а не ответу за ними.
        const t = e.target as HTMLElement | null
        if (menuOpen || settingsOpen || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return
        const cur = suggestions[cursor]
        const total = cur && !cur.kb ? codeLineCount(cur.answer) : 0
        if (!total) return
        e.preventDefault()
        // Шаг — от текущей отметки в самом обновлении: при зажатой клавише события идут чаще перерисовок.
        const step = e.key === 'ArrowDown' ? 1 : -1
        const id = cur!.id
        setSuggestions((list) =>
          list.map((x) => (x.id === id ? { ...x, mark: Math.max(0, Math.min(total, (x.mark ?? 0) + step)) } : x)),
        )
      }
    }
    document.addEventListener('keydown', nav)
    return () => document.removeEventListener('keydown', nav)
  }, [suggestions, cursor, menuOpen, settingsOpen])

  /* ---------- изменение размера ---------- */

  const onGrip = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.screenX
    const y0 = e.screenY
    void window.copilot.beginResize()

    const move = (ev: MouseEvent) => {
      void window.copilot.resizeBy(ev.screenX - x0, ev.screenY - y0)
    }
    const up = () => {
      void window.copilot.endResize()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  /* ---------- разметка ---------- */

  /**
   * Плотность подложки — ровно как на слайдере. Уплотняется панель, только пока
   * печатается ответ, и ещё две секунды после: текст читают на любом фоне.
   * От курсора плотность не зависит: пользователь выставил прозрачность и ждёт,
   * что она останется такой, а над «ручкой» окна Windows к тому же не присылает
   * наведение — подложка мигала бы, пока курсор ходит по панели.
   */
  const density = Math.max(0.3, Math.min(1, settings.opacity))
  const boost = printing || afterglow
  const rootStyle = { '--d': boost ? 1 : density, '--fs-answer': `${settings.fontSize}px` } as CSSProperties

  const exposed = !settings.contentProtected || status?.contentProtected === false
  const meta = metaLine(current, liveModels, compact)

  /* ---------- сколько места отдать ответу ---------- */

  // Высоту сцены считает App, а не CSS: только отсюда видно, сколько просит
  // плата уточнений второго агента — её нельзя ни ужать, ни проскроллить мимо.
  const [metrics, setMetrics] = useState({ fixedH: 178, a2Raw: 0 })
  useLayoutEffect(() => {
    const card = cardRef.current
    const stage = stageRef.current
    if (!card || !stage) return
    const warn = stage.querySelector('[data-a2warn]')
    const foot = stage.querySelector<HTMLElement>('.pane.second .agent-foot')
    const head = stage.querySelector<HTMLElement>('.pane.second .pane-head')
    const fixedH = Math.round(card.scrollHeight - stage.offsetHeight)
    // Плата целиком, её отступ сверху, низ с кнопкой и заголовок окна. Низ и
    // заголовок меряем, а не считаем: их высота зависит от режима и кегля.
    const a2Raw = warn
      ? Math.round(
          warn.scrollHeight +
            (layout.h < TINY_H ? 4 : 8) +
            (foot?.offsetHeight ?? 40) +
            (head ? head.offsetHeight + 4 : 28) +
            4,
        )
      : 0
    // Пишем, только когда цифра изменилась: иначе замер запускал бы сам себя.
    setMetrics((prev) =>
      Math.abs(prev.fixedH - fixedH) < 2 && Math.abs(prev.a2Raw - a2Raw) < 2 ? prev : { fixedH, a2Raw },
    )
  })

  const [trHidden, setTrHidden] = useState(false)
  const stacked = duo && layout.w < STACK_W
  /**
   * Пока открыто решение задачи, расшифровка сворачивается сама: решению нужны
   * все строки окна. Вернуть её — пилюлей «показать» внизу; выбор помнится для
   * этой подсказки, а у следующего решения расшифровка снова свернётся.
   */
  const [trShownFor, setTrShownFor] = useState<number | null>(null)
  const taskOpen = !!current && !current.kb && !current.pending && isTaskText(current.answer)
  const trCollapsed = taskOpen && trShownFor !== current!.id
  const trWanted = settings.showTranscript && !tiny && !(duo && trHidden)
  const showTranscript = trWanted && !trCollapsed
  const fourLines = Math.round(settings.fontSize * 1.42 * 4 + 24)

  /**
   * Сколько высоты просит сцена, если ей достанется avail. Четыре строки ответа
   * основному, остальное — плате уточнений второго агента целиком: её читают
   * до того, как произнесут ответ вслух, и проскроллить мимо неё нельзя.
   */
  const planStage = (avail: number) => {
    const mainMin = tiny
      ? duo
        ? 24
        : 36
      : Math.max(duo ? 96 : 64, Math.min(duo && !stacked ? fourLines + 28 : fourLines, avail))
    const a2Need = duo ? Math.min(metrics.a2Raw, Math.max(0, stacked ? avail - mainMin - 8 : avail)) : 0
    const minH = !duo
      ? mainMin
      : stacked
        ? Math.max(tiny ? 0 : 200, mainMin + 8 + (a2Need || (tiny ? 88 : 96)))
        : Math.max(mainMin, a2Need)
    return { mainMin, a2Need, minH, fits: !duo || metrics.a2Raw <= a2Need + 2 }
  }

  const plan = planStage(Math.max(0, layout.h - metrics.fixedH - (showTranscript ? TR_RESERVE : 0)))
  const { a2Need, minH: answerMinH } = plan
  // Тот же расчёт, но как если бы расшифровка была на экране: по нему решаем,
  // возвращать ли её. Иначе она мигала бы — спряталась, места хватило, вернулась.
  const withTr = planStage(Math.max(0, layout.h - metrics.fixedH - TR_RESERVE))
  // Решение, свернувшее расшифровку, не должно решать, хватает ли ей места: иначе в режиме двух
  // агентов она пряталась бы и после того, как решение закрыли, — до смены размера окна.
  const trPlanMinH = planStage(Math.max(0, layout.h - metrics.fixedH - (trWanted ? TR_RESERVE : 0))).minH

  // Место двум окнам отдаёт расшифровка: сначала уточнения, потом лента.
  useEffect(() => {
    if (!duo) {
      setTrHidden(false)
      return
    }
    const room = layout.h - metrics.fixedH - trPlanMinH - 8
    setTrHidden((hidden) => (hidden ? room < 76 || !withTr.fits : room < 56 || !withTr.fits))
  }, [duo, layout.h, metrics.fixedH, trPlanMinH, withTr.fits])

  // Клавиши — те, что main занял на самом деле: основную комбинацию мог держать другой процесс.
  const askKeys = comboKeys(hotkeyCombo(status?.hotkeys, 'ask'))
  const shotKeys = comboKeys(hotkeyCombo(status?.hotkeys, 'screenshot'))
  const addKeys = comboKeys(hotkeyCombo(status?.hotkeys, 'addShot'))
  const sessionKeys = comboKeys(hotkeyCombo(status?.hotkeys, 'session'))
  const throughKeys = comboKeys(hotkeyCombo(status?.hotkeys, 'clickThrough'))
  /** « · Ctrl ⇧ Space» в подсказку у кнопки; клавиш нет — нет и хвоста. */
  const keysTail = (keys: string[]) => (keys.length ? ` · ${keys.join(' ')}` : '')

  /**
   * Команды из своего промпта («/разбор») — кнопками прямо в строке запроса, пока она пустая.
   * Свой промпт уходит любому провайдеру, поэтому и кнопки есть у всех — кроме Claude по ключу:
   * у API промпт зашитый, и команда ушла бы модели, которая о ней не знает.
   * Сколько влезает: в узком окне одна, в среднем две, в широком три; остальные — в «ещё».
   */
  const commands = useMemo(
    () =>
      promptReachesModel({ llmProvider: settings.llmProvider, claudeSource: settings.claudeSource })
        ? promptCommands(settings.customPrompt)
        : [],
    [settings.llmProvider, settings.claudeSource, settings.customPrompt],
  )
  const cmdSlots = compact ? 1 : mid ? 2 : 3
  const cmdOverflow = commands.length > cmdSlots
  const cmdShown = cmdOverflow ? commands.slice(0, cmdSlots - 1) : commands
  const cmdMore = cmdOverflow ? commands.slice(cmdSlots - 1) : []
  const showCmds = commands.length > 0 && !query
  // Текст запроса не должен уезжать под кнопки: отступ справа — по их настоящей ширине.
  const cmdRef = useRef<HTMLSpanElement>(null)
  const [cmdW, setCmdW] = useState(0)
  useLayoutEffect(() => {
    const w = showCmds ? (cmdRef.current?.offsetWidth ?? 0) : 0
    setCmdW((prev) => (Math.abs(prev - w) < 1 ? prev : w))
  })

  const meter = (ch: Speaker, cap: string) => (
    <span className={`meter ${ch}`} data-tour="waves" title={ch === 'me' ? 'Микрофон' : 'Звук собеседника'}>
      <span className="cap">{cap}</span>
      <span className="bars" aria-hidden>
        {wave[ch].slice(compact ? -WAVE_LEN_COMPACT : 0).map((v, i) => (
          <i
            key={i}
            style={{ '--v': Math.max(0.12, v).toFixed(2), '--o': v < 0.06 ? 0.4 : 1 } as CSSProperties}
          />
        ))}
      </span>
    </span>
  )

  const setThinking = (on: boolean) => {
    if (on === settings.llmThinking) return
    update('llmThinking', on)
    // Как и смена модели: вне сессии CLI не трогаем, «Старт» прогреет под итоговый режим.
    if (phaseRef.current !== 'idle') warm({ ...settings, llmThinking: on })
  }

  /**
   * Выбор в поповере. Модель неготового провайдера выбирается всё равно — человек мог
   * поставить CLI заранее, — а строка ошибки пять секунд говорит, чего не хватает.
   * У второго агента то же самое. Проверяющий Claude идёт через Claude Code при любом источнике
   * подсказок (API по ключу вердикт не напишет), поэтому его готовность — по Claude Code.
   */
  const notice = useRef<{ text: string; timer: number } | null>(null)
  useEffect(() => () => window.clearTimeout(notice.current?.timer), [])
  const pickFromPopover = (provider: ProviderId, model: string) => {
    choose(provider, model)
    noticeNotReady(provider, settings.claudeSource)
  }
  const pickVerifierFromPopover = (provider: ProviderId, model: string) => {
    chooseVerifier(provider, model)
    noticeNotReady(provider, 'cli')
  }
  const noticeNotReady = (provider: ProviderId, source: AppSettings['claudeSource']) => {
    const prev = notice.current
    if (prev) window.clearTimeout(prev.timer)
    notice.current = null
    const text = providers.checking.has(provider) ? null : notReadyText(providers.statuses[provider], source)
    // Прошлое «не готов» уже не про этот выбор — убираем, чужие ошибки не трогаем.
    if (!text) {
      if (prev) setError((e) => (e === prev.text ? null : e))
      return
    }
    setError(text)
    const timer = window.setTimeout(() => {
      setError((e) => (e === text ? null : e))
      notice.current = null
    }, NOTICE_MS)
    notice.current = { text, timer }
  }

  const activeProvider = providerById(settings.llmProvider)
  const activeLive = liveModels(settings.llmProvider)

  // Зверёк провайдера у выбора модели повторяет состояние ответа: думает, печатает, гаснет при ошибке.
  const critterMode: CritterMode =
    !current || current.kb
      ? 'idle'
      : current.pending
        ? 'think'
        : current.tookMs === undefined
          ? 'type'
          : current.answer.startsWith(ERROR_PREFIX)
            ? 'off'
            : 'idle'

  let answerBody: ReactNode
  if (current?.kb) {
    answerBody = <KbAnswer hit={current.kb} />
  } else if (current?.pending) {
    answerBody = (
      <div className="waiting">
        <div className="timer">{sec1(nowMs() - current.startedAt)} с</div>
        <div className="wait-label">
          {current.question === 'Снимок экрана'
            ? (current.shots ?? 1) > 1
              ? `Смотрю на ${pluralRu(current.shots!, 'снимок', 'снимка', 'снимков', true)} — это дольше одного`
              : 'Смотрю на экран — это дольше текста'
            : current.reasoning
              ? 'Размышляю — так ответ точнее'
              : 'Думаю над ответом'}
        </div>
        <span className="breathe" data-keep aria-hidden>
          <i data-keep />
          <i data-keep />
          <i data-keep />
        </span>
      </div>
    )
  } else if (current?.answer.startsWith(ERROR_PREFIX)) {
    answerBody = (
      <div className="error-block" role="alert">
        <Alert />
        <p>
          <strong>Ошибка:</strong> {current.answer.slice(ERROR_PREFIX.length)}
        </p>
      </div>
    )
  } else if (current) {
    const id = current.id
    answerBody = (
      <div className={`answer-text ${taskOpen ? 'wide' : ''}`}>
        <Answer
          key={id}
          id={id}
          text={current.answer}
          streaming={current.tookMs === undefined}
          scrollRef={answerRef}
          previews={current.previews ?? (current.preview ? [current.preview] : undefined)}
          mark={current.mark ?? 0}
          onMark={(n) => markLines(id, n)}
          onCopy={copyText}
        />
      </div>
    )
  } else if (running && staged?.confident && staged.hits[0]) {
    // Уверенное совпадение показываем СРАЗУ, ещё до «Спросить»: ноль миллисекунд
    // против секунд на ответ модели. Модель — для случаев, когда база вопрос не опознала.
    answerBody = <KbAnswer hit={staged.hits[0]} />
  } else {
    answerBody = (
      <div className="empty-msg">
        <Mascot size={tiny ? 32 : 48} live={running} />
        <p>
          {running
            ? 'Слушаю разговор. Нажмите «Спросить», когда понадобится подсказка.'
            : phase === 'starting'
              ? 'Загружаю модель распознавания…'
              : 'Нажмите круглую кнопку слева, чтобы начать сессию.'}
        </p>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`app ${mid ? 'mid' : ''} ${compact ? 'compact' : ''} ${tiny ? 'tiny' : ''} ${duo ? 'duo' : ''} ${showTranscript ? '' : 'no-transcript'}`}
      style={rootStyle}
    >
      <div className={`card top ${clickThrough ? 'through' : ''} ${exposed ? 'exposed' : ''}`} ref={cardRef}>
        {/* Строка состояния — она же ручка окна: только показатели, ни одной кнопки. */}
        <div className="status">
          <span className="pill" title={`Сессия${keysTail(sessionKeys)}`}>
            <span className={`dot ${running ? 'live' : phase === 'starting' ? 'starting' : ''}`} data-keep />
            {running ? 'сессия идёт' : phase === 'starting' ? 'запускается…' : 'остановлена'}
          </span>
          {!compact && (
            <span className={`pill stt ${engine ? 'ok' : ''}`} title="Распознавание речи">
              <Chip />
              {engine ?? (phase === 'starting' ? 'модель загружается…' : 'модель не загружена')}
            </span>
          )}
          {exposed ? (
            <span
              className="pill alert"
              data-tour="privacy"
              title="Панель попадает в демонстрацию экрана — остановите показ или включите скрытие в настройках"
            >
              <Eye />
              виден в захвате
            </span>
          ) : (
            // Норма в узком окне — одной иконкой; тревога «виден в захвате» остаётся словами.
            <span className="pill" data-tour="privacy" title="Панель скрыта от захвата экрана: коллеги её не видят">
              <EyeOff />
              {!compact && 'скрыт от захвата'}
            </span>
          )}
          {loopbackOk && (
            <span className="pill audio" title="Захват системного звука работает">
              <Bars />
              {!mid && 'звук собеседника есть'}
            </span>
          )}
          {running && hotwords && !compact && (
            <span
              className="pill dict"
              onMouseEnter={() => setDictHover(true)}
              onMouseLeave={() => setDictHover(false)}
            >
              <span className="muted">словарь:</span>
              {!mid && (
                <span className="roll" key={topic ?? ''}>
                  {topic ? topicLabel(topic) : 'общий'}
                </span>
              )}
              {!mid && <span className="muted">·</span>}
              <span>{hotwords.kept}</span>
            </span>
          )}
          {clickThrough && (
            <span className="pill through" title="Клики проходят сквозь панель к окну под ней">
              <Pointer />
              сквозь
              {throughKeys.length ? (
                <>
                  <span className="quiet">· выйти</span>
                  <Keys keys={throughKeys} />
                </>
              ) : (
                // Клавишу занять не удалось — выйти можно только из меню значка в трее.
                <span className="quiet tray">· выйти через трей</span>
              )}
            </span>
          )}
        </div>

        {dictHover && running && hotwords && (
          <div className="dict-pop" role="tooltip">
            <div className="head">
              тема: {topic ? topicLabel(topic) : 'общий'} · учтено {hotwords.kept} из {hotwords.total} ·{' '}
              {hotwords.tokens} из 222 токенов
            </div>
            <div className="chips">
              {composedTerms.map((t, i) => (
                <span key={t} className={`chip ${i >= hotwords.kept ? 'cut' : ''}`}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="controls">
          <button
            type="button"
            data-tour="start"
            className={`session-btn ${running ? 'live' : ''}`}
            onClick={toggleSession}
            title={`${running ? 'Остановить сессию' : 'Начать сессию'}${keysTail(sessionKeys)}`}
            aria-label={running ? 'Остановить сессию' : 'Начать сессию'}
          >
            {phase === 'starting' ? <Spinner /> : running ? <Stop /> : <Play />}
            {running && <span className="ring" />}
          </button>

          {meter('them', 'Он')}
          {meter('me', 'Я')}

          <span className="spacer" />

          <button
            type="button"
            data-tour="ask"
            className={`btn-ask ${flash === 'ask' ? 'flash' : ''}`}
            onClick={() => void ask()}
            disabled={!running}
            title={running ? `Подсказка по разговору${keysTail(askKeys)}` : 'Сначала начните сессию'}
            aria-label="Спросить"
          >
            <span className="icon-compact">
              <Bubble />
            </span>
            <span className="btn-label">Спросить</span>
            {askKeys.length > 0 && <Keys keys={askKeys} />}
          </button>

          {/* «Скриншот» и «+» — одна пилюля: снимок сразу или в серию. Пока серия набирается,
              левая половина отправляет её, на «+» — счётчик, вокруг — лаймовое кольцо. */}
          <div
            data-tour="shot"
            className={`shot-group ${series.length ? 'on' : ''} ${snapFlash ? 'snap' : ''}`}
          >
            <button
              type="button"
              className={`btn-shot ${flash === 'shot' ? 'flash' : ''}`}
              onClick={() => void askScreen()}
              title={
                series.length
                  ? `Отправить серию из ${pluralRu(series.length, 'снимка', 'снимков', 'снимков')}${keysTail(shotKeys)}`
                  : `Снять экран и разобрать, что на нём${keysTail(shotKeys)}`
              }
              aria-label={series.length ? 'Отправить серию' : 'Скриншот'}
            >
              <Camera />
              <span className="btn-label">{series.length ? 'Отправить' : 'Скриншот'}</span>
              {shotKeys.length > 0 && <Keys keys={shotKeys} />}
            </button>
            <button
              type="button"
              className={`btn-add-shot ${flash === 'add' ? 'flash' : ''}`}
              onClick={() => void addShot()}
              title={`Добавить снимок в серию — когда задача не помещается на один экран${keysTail(addKeys)}`}
              aria-label="Добавить снимок в серию"
            >
              <Plus />
              {series.length > 0 && (
                <span className="count" key={series.length}>
                  {series.length}
                </span>
              )}
            </button>
          </div>

          <button
            type="button"
            data-tour="menu"
            className={`btn-icon ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="Меню"
            aria-label="Меню"
            aria-expanded={menuOpen}
          >
            <Burger />
          </button>
        </div>

        {series.length > 0 && (
          <div className="series" aria-label="Серия снимков">
            <span className="series-head">
              <span className="series-title">Серия · {pluralRu(series.length, 'снимок', 'снимка', 'снимков', true)}</span>
              <span className="series-hint">
                {series.length >= SERIES_MAX
                  ? 'максимум — шесть'
                  : `ещё — ${addKeys.length ? addKeys.join(' ') : '«+»'}, все уйдут одним вопросом`}
              </span>
            </span>
            <div className="series-shots">
              {series.map((sh, i) => (
                <div key={sh.id} className="series-shot" title={`Снимок ${i + 1} · ${sh.screen}`}>
                  <img src={sh.preview} alt="" />
                  <span className="n">{i + 1}</span>
                  <button
                    type="button"
                    className="remove"
                    onClick={() => removeShot(sh.id)}
                    title={`Убрать снимок ${i + 1}`}
                    aria-label={`Убрать снимок ${i + 1}`}
                  >
                    <Cross size={8} />
                  </button>
                </div>
              ))}
              {series.length < SERIES_MAX && (
                <button
                  type="button"
                  className="series-more"
                  onClick={() => void addShot()}
                  title={`Ещё снимок${keysTail(addKeys)}`}
                  aria-label="Ещё снимок"
                >
                  <Plus />
                </button>
              )}
            </div>
            <button type="button" className="series-clear" onClick={clearSeries} title="Сбросить серию" aria-label="Сбросить серию">
              <Cross size={12} />
              <span className="btn-label">Сбросить</span>
            </button>
            <button type="button" className="series-send" onClick={() => void askScreen()} title={`Отправить серию${keysTail(shotKeys)}`}>
              {compact ? 'Отправить' : `Отправить ${pluralRu(series.length, 'снимок', 'снимка', 'снимков', true)}`}
              {shotKeys.length > 0 && <Keys keys={shotKeys} />}
            </button>
          </div>
        )}

        <div className="query">
          <div className="query-field">
            <input
              className="query-input"
              placeholder="Введите запрос вручную…"
              aria-label="Свой запрос"
              value={query}
              style={cmdW ? { paddingRight: cmdW + 10 } : undefined}
              onChange={(e) => setQuery(e.target.value)}
              // Клик в поле — уже намерение спросить. Поднимаем сессию, пока
              // человек печатает: иначе первые секунды ожидания достанутся ему.
              onFocus={() => warm(settings)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim()) {
                  void ask(query)
                  setQuery('')
                }
              }}
            />
            {showCmds && (
              // Нажатие отправляет команду сразу — как если бы её набрали в поле и нажали Enter.
              <span className="query-cmds" ref={cmdRef} aria-label="Команды из вашего промпта">
                {cmdShown.map((c) => (
                  <button
                    key={c.command}
                    type="button"
                    className="cmd-chip"
                    aria-label={`Команда ${c.command}`}
                    title={`${c.hint} · нажмите — команда уйдёт модели`}
                    onClick={() => void ask(c.command)}
                  >
                    {c.command}
                  </button>
                ))}
                {cmdMore.length > 0 && (
                  <Dropdown
                    size="xs"
                    value=""
                    options={cmdMore.map((c) => ({ value: c.command, label: c.command }))}
                    label={cmdShown.length ? 'ещё' : 'команды'}
                    title="Остальные команды из вашего промпта"
                    onChange={(c) => void ask(c)}
                  />
                )}
              </span>
            )}
          </div>

          {/* Провайдер, модель, размышления и второй агент живут здесь, а не в настройках: их
              меняют между вопросами, и ради этого не должно открываться окно.
              Смена сразу поднимает новую сессию — к следующему вопросу она уже прогрета. */}
          <ProviderPicker
            provider={settings.llmProvider}
            model={settings.llmModel}
            claudeSource={settings.claudeSource}
            ctl={providers}
            mode={critterMode}
            compact={compact}
            onPick={pickFromPopover}
            onCopy={copyText}
          />
          <div
            className={`segment ${settings.llmThinking ? '' : 'second'}`}
            role="group"
            aria-label="Режим ответа"
            title={
              settings.llmProvider === 'cursor'
                ? `Глубину размышлений ${activeProvider.name} выбирает сам: «думает» и «сразу» на его ответ не влияют.`
                : '«думает» — первое слово позже, но ответ точнее. «сразу» — быстрее, без размышлений.'
            }
          >
            <span className="thumb" />
            <button type="button" aria-pressed={settings.llmThinking} onClick={() => setThinking(true)}>
              думает
            </button>
            <button type="button" aria-pressed={!settings.llmThinking} onClick={() => setThinking(false)}>
              сразу
            </button>
          </div>
          <button
            type="button"
            className={`duo-toggle ${duo ? 'on' : ''}`}
            aria-pressed={duo}
            aria-label={compact ? '2 агента' : undefined}
            title={
              duo
                ? 'Выключить второго агента — проверки не будет'
                : `Включить второго агента: ${providerById(settings.verifyProvider).name} проверит каждую подсказку`
            }
            onClick={() => update('verifyEnabled', !duo)}
          >
            <Duo />
            <span className="label">2 агента</span>
          </button>
        </div>

        <div
          className={`stage ${duo ? 'duo' : ''} ${stacked ? 'stacked' : ''}`}
          ref={stageRef}
          style={{ '--answer-min-h': `${answerMinH}px`, '--a2-need': `${a2Need}px` } as CSSProperties}
        >
          <section className="pane main" aria-label="Основной агент">
            {duo && !tiny && (
              <div className="pane-head">
                {/* Кто отвечает — именем провайдера, а не «Основной»: рядом второй агент, и провайдеры у них бывают разные. */}
                <span className="pill">
                  {mid
                    ? modelFamily(settings.llmModel, settings.llmProvider, activeLive)
                    : `${activeProvider.name} · ${modelName(settings.llmModel, settings.llmProvider, activeLive)}`}{' '}
                  · {settings.llmThinking ? 'думает' : 'сразу'}
                </span>
              </div>
            )}
            <div className="plate" data-tour="answer">
              <div className="plate-scroll" ref={answerRef} aria-live="polite">
                {answerBody}
              </div>
            </div>
          </section>

          {duo && (
            <SecondAgent
              suggestion={current}
              settings={settings}
              mid={mid}
              compact={compact}
              providers={providers}
              onChange={update}
              onVerifyNow={verifyNow}
              onPickVerifier={pickVerifierFromPopover}
              onCopy={copyText}
            />
          )}
        </div>

        {suggestions.length > 0 && (
          <div className="footer">
            <span className="pill nav-pill" data-tour="nav">
              <button
                type="button"
                onClick={() => setCursor((c) => Math.max(0, c - 1))}
                disabled={cursor === 0}
                title="Предыдущая подсказка · Ctrl ←"
                aria-label="Предыдущая подсказка"
              >
                <span className="chev left">
                  <Chevron />
                </span>
              </button>
              <span className="nav-count">
                {cursor + 1}/{suggestions.length}
              </span>
              <button
                type="button"
                onClick={() => setCursor((c) => Math.min(suggestions.length - 1, c + 1))}
                disabled={cursor >= suggestions.length - 1}
                title="Следующая подсказка · Ctrl →"
                aria-label="Следующая подсказка"
              >
                <span className="chev right">
                  <Chevron />
                </span>
              </button>
            </span>
            {trCollapsed && trWanted && (
              <button
                type="button"
                className="pill tr-pill"
                title="Расшифровка свёрнута, пока читаете решение"
                onClick={() => setTrShownFor(current!.id)}
              >
                расшифровка свёрнута · <span className="show">показать</span>
              </button>
            )}
            {meta && (
              <span className="pill meta-pill" title={meta.text}>
                {meta.alert ? (
                  <Alert size={12} />
                ) : (
                  !current?.kb && <Critter mode="idle" size={14} still provider={current?.provider} />
                )}
                <span>{meta.text}</span>
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="error-line" role="alert">
            <Alert size={14} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {showTranscript && (
        <div className="card transcript" data-tour="transcript">
          <div className="transcript-scroll" ref={transcriptRef}>
            {lines.length === 0 && !draft.me && !draft.them ? (
              <div className="tr-empty">{running ? 'Слушаю…' : 'Расшифровка появится здесь после старта сессии'}</div>
            ) : (
              <>
                {lines.map((l) => (
                  <TrLine key={l.id} speaker={l.speaker} text={l.text} />
                ))}
                {(['them', 'me'] as Speaker[]).map((ch) =>
                  draft[ch] ? <TrLine key={`d-${ch}`} speaker={ch} text={draft[ch]} draft /> : null,
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="grip" onMouseDown={onGrip} title="Изменить размер окна">
        <Grip />
      </div>

      {tourRun > 0 && (
        <Tour
          key={tourRun}
          rootRef={rootRef}
          ctx={{
            phase,
            hints: suggestions.length,
            transcriptVisible: showTranscript,
            compact,
            canAsk: lines.length > 0,
            keys: {
              session: sessionKeys,
              ask: askKeys,
              shot: shotKeys,
              hide: comboKeys(hotkeyCombo(status?.hotkeys, 'hide')),
              clickThrough: throughKeys,
            },
          }}
          onStartSession={() => void start()}
          onAsk={() => void ask()}
          onEnd={() => {
            setTourRun(0)
            // Пройдено или пропущено — само больше не показываем; повторить можно из меню.
            update('onboardingDone', true)
          }}
        />
      )}

      {menuOpen && (
        <Menu
          settings={settings}
          mics={mics}
          screens={screens}
          onChange={update}
          clickThrough={clickThrough}
          clickThroughKeys={throughKeys}
          onClickThrough={() => {
            setMenuOpen(false)
            // Не выставляем режим сами: панель переключится, когда main подтвердит смену окна.
            void window.copilot.setClickThrough(true)
          }}
          onOpenSettings={() => {
            setMenuOpen(false)
            setSettingsOpen(true)
          }}
          onOpenTour={openTour}
          onQuit={() => void window.copilot.quit()}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {settingsOpen && (
        <Settings
          settings={settings}
          perms={{ mic: micRef.current?.running ?? false, loopback: loopbackOk }}
          engine={engine}
          glossary={glossary}
          topic={topic}
          composed={composedTerms}
          hotwords={hotwords}
          hotkeys={status?.hotkeys}
          providers={providers}
          onChange={update}
          onPickProvider={switchProvider}
          onPickModel={(m) => choose(settings.llmProvider, m)}
          onPickVerifyProvider={switchVerifier}
          onPickVerifyModel={(m) => chooseVerifier(settings.verifyProvider, m)}
          onCopy={copyText}
          onOpenTour={openTour}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
