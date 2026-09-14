import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { HOTKEYS, type AppSettings } from '@shared/settings'
import { isHaikuModel, modelEfforts, modelName, modelNote } from '@shared/models'
import { PROVIDERS, providerById, type ModelInfo, type ProviderId } from '@shared/providers'
import { topicLabel, type TopicGlossary } from '@shared/glossary'
import { promptCommands } from '@shared/promptCommands'
import type { HotkeyId, OverlayStatus } from '@shared/types'
import type { HotwordsInfo } from '../stt/client'
import type { JournalSummary, KbSnapshot } from '../../preload'
import { comboKeys, hotkeyCombo, statusHotkeyId } from '../keys'
import { Alert, Check, Close, Duo, EyeOff } from './Icons'
import { Dropdown, Seg, Switch, type Option } from './Controls'
import { Mascot } from './Mascot'
import { ProviderSetup, type ProvidersCtl } from './ProviderPicker'
import { chipOf, isReady, noteOf, promptReachesModel, verifyDepthNote, verifyEffortsOf, viaOf } from '../providerStatus'

type Tab = 'general' | 'prompt' | 'glossary' | 'records' | 'account' | 'hotkeys' | 'guide'

interface Props {
  settings: AppSettings
  perms: { mic: boolean; loopback: boolean }
  engine: string | null
  /** словарь из базы, текущая тема и то, что уходит в распознавание */
  glossary: TopicGlossary | null
  topic: string | null
  composed: string[]
  hotwords: HotwordsInfo | null
  /** клавиши, которые main занял на самом деле; undefined — статус ещё не пришёл */
  hotkeys?: OverlayStatus['hotkeys']
  /** кто может отвечать: состояние, живые списки моделей, вход и повторная проверка */
  providers: ProvidersCtl
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /** сменить провайдера — вместе с его последней моделью */
  onPickProvider: (id: ProviderId) => void
  /** модель текущего провайдера */
  onPickModel: (model: string) => void
  /** сменить того, кто проверяет, — вместе с его последней моделью второго агента */
  onPickVerifyProvider: (id: ProviderId) => void
  /** модель второго агента у того, кто проверяет */
  onPickVerifyModel: (model: string) => void
  onCopy: (text: string) => void
  onClose: () => void
  /** показать обучение заново — кнопка во вкладке «Инструкция» */
  onOpenTour?: () => void
}

const PROMPT_PLACEHOLDER = `Например:
Ты — суфлёр специалиста по 1С на рабочем созвоне.
Отвечай 3–5 тезисами, каждый — одна строка, без вступлений.
Если вопрос про производительность — сначала замер, потом гипотезы.
Термины 1С пиши как в конфигураторе.`

/**
 * Замерено на этой машине, на живой сессии, по три вопроса на сочетание:
 * секунды до первого слова и до конца ответа. Цифры стоят прямо в подписи,
 * потому что выбор здесь — это размен «успею прочитать» на «ответ точнее»,
 * и цена должна быть видна до того, как её заплатят на созвоне.
 *
 * Неочевидное: с размышлениями Opus доходит до первого слова быстрее Haiku
 * (1.7 с против 3.8). Быстрая модель думает дольше, чем сильная.
 */
const TIMINGS: Partial<Record<AppSettings['llmModel'], { think: [number, number]; plain: [number, number] }>> = {
  'claude-opus-5': {
    think: [1.7, 9.5],
    // «Сразу» перемерено 11 сентября: теперь это усилие low, а не выключенное мышление.
    plain: [1.1, 9.4],
  },
  'claude-sonnet-5': {
    think: [2.8, 8.3],
    // Замер до перехода «сразу» на усилие low — на Sonnet ещё не перемерено.
    plain: [1.1, 5.8],
  },
  'claude-haiku-4-5': {
    think: [3.8, 7.1],
    plain: [1.1, 4.8],
  },
}

/**
 * Подписи к глубине размышлений. Цифры — замер 11 сентября на Opus 5, по три
 * вопроса: до первого слова и до конца ответа. Высокая глубина на живом
 * созвоне заметна — почти шесть секунд тишины до первого слова.
 */
const EFFORT_NOTE: Record<AppSettings['llmEffort'], string> = {
  default: 'Claude Code сам выбирает, сколько думать над вопросом.',
  low: 'Почти без раздумий: на Opus 5 первое слово через 1,1 с, ответ за 9,4 с.',
  medium: 'Между низкой и высокой.',
  high: 'Думает основательно: на Opus 5 первое слово через 5,9 с, ответ за 13,0 с.',
  xhigh: 'Глубже высокой — скорее для разбора после созвона, чем для живого ответа.',
  max: 'Предел глубины. Для живого созвона слишком медленно.',
}

/**
 * Замеры Opus 5 для явно выбранной глубины — те же, что в подписях выше.
 * Цифры в MODELS сняты с глубиной по умолчанию.
 */
const OPUS_EFFORT: Partial<Record<AppSettings['llmEffort'], [number, number]>> = {
  low: [1.1, 9.4],
  high: [5.9, 13.0],
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'Основные' },
  { id: 'prompt', label: 'Свой промпт' },
  { id: 'glossary', label: 'Словарь' },
  { id: 'records', label: 'Записи созвонов' },
  { id: 'account', label: 'Аккаунт' },
  { id: 'hotkeys', label: 'Горячие клавиши' },
  { id: 'guide', label: 'Инструкция' },
]

const PROVIDER_OPTIONS: Option<ProviderId>[] = PROVIDERS.map((p) => ({ value: p.id, label: p.name }))

/**
 * Модели провайдера для выпадающего списка — у того, кто отвечает, и у того, кто проверяет.
 * Claude — семействами (Fable, Opus…). Выбранная модель могла пропасть из живого списка:
 * она остаётся в списке, иначе выбор «пропал бы».
 */
function modelOptionsOf(id: ProviderId, models: readonly ModelInfo[], selected: string): Option<string>[] {
  const claude = id === 'claude'
  return [
    ...models.map((m) => ({ value: m.id, label: m.name, hint: m.hint, group: claude ? m.name.split(' ')[0] : undefined })),
    ...(selected && !models.some((m) => m.id === selected) ? [{ value: selected, label: selected, hint: 'нет в списке' }] : []),
  ]
}

const EFFORT_OPTIONS: Option<AppSettings['llmEffort']>[] = [
  { value: 'default', label: 'Как решит Claude Code' },
  { value: 'low', label: 'Низкая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'high', label: 'Высокая' },
  { value: 'xhigh', label: 'Очень высокая' },
  { value: 'max', label: 'Максимальная' },
]

const VERIFY_EFFORT_OPTIONS: Option<AppSettings['verifyEffort']>[] = [
  { value: 'low', label: 'Низкая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'high', label: 'Высокая' },
]

const LANG_OPTIONS: Option<AppSettings['language']>[] = [
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' },
]

const KB_COUNT_OPTIONS: Option<number>[] = [1, 2, 3, 5].map((n) => ({ value: n, label: String(n) }))
const TIMEOUT_OPTIONS: Option<number>[] = [30, 45, 60, 90].map((n) => ({ value: n, label: `${n} с` }))

const HOTKEY_LABEL: Record<string, string> = { hide: 'Скрыть или показать панель' }

/** 1.7 -> «1,7»: запятая, потому что подпись читают по-русски. */
const sec = (n: number) => n.toFixed(1).replace('.', ',')

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return one
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few
  return many
}

/** «12 сентября, 14:32» — заголовок карточки записи. */
function when(at: number): string {
  return new Date(at).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function span(from: number, to: number | null): string {
  if (!to) return 'не завершён'
  const m = Math.round((to - from) / 60000)
  if (m < 1) return 'меньше минуты'
  if (m < 60) return `${m} мин`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

/** «2026-09-13» -> «13 сентября 2026» — версия встроенной базы. */
function kbVersion(v: string): string {
  const d = new Date(`${v}T00:00:00`)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Строка настройки: название, пояснение под ним, элемент управления справа.
 * wide — широкий элемент (шесть провайдеров): в узком окне он встаёт под название.
 */
function Row({
  name,
  desc,
  control,
  last,
  wide,
}: {
  name: ReactNode
  desc?: ReactNode
  control?: ReactNode
  last?: boolean
  wide?: boolean
}) {
  return (
    <div className={`row ${last ? 'last' : ''} ${wide ? 'wide' : ''}`}>
      <div className="name">{name}</div>
      {control && <div className="control">{control}</div>}
      {desc && <div className="desc">{desc}</div>}
    </div>
  )
}

export function Settings({
  settings,
  perms,
  engine,
  glossary,
  topic,
  composed,
  hotwords,
  hotkeys,
  providers,
  onChange,
  onPickProvider,
  onPickModel,
  onPickVerifyProvider,
  onPickVerifyModel,
  onCopy,
  onClose,
  onOpenTour,
}: Props) {
  const [tab, setTab] = useState<Tab>('general')
  const [records, setRecords] = useState<JournalSummary[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  // Какие кнопки дадут команды из промпта — видно прямо под полем, пока его пишут.
  const promptCmds = promptCommands(settings.customPrompt)
  // Claude по ключу держит зашитый промпт: кнопок на панели не будет, и обещать их нельзя.
  const promptUsed = promptReachesModel(settings)
  const commandsLine =
    promptUsed && promptCmds.length ? ` · кнопки на панели: ${promptCmds.map((c) => c.command).join(' ')}` : ''
  /** undefined — ещё не спросили, null — встроенная база не загрузилась */
  const [snap, setSnap] = useState<KbSnapshot | null | undefined>(undefined)

  // Крупные темы первыми: по ним чаще всего и спрашивают.
  const topicOrder = glossary
    ? Object.keys(glossary.topics).sort((a, b) => (glossary.sizes[b] ?? 0) - (glossary.sizes[a] ?? 0))
    : []

  // Список тянем при открытии вкладки, а не при монтировании окна: читать
  // папку с записями ради вкладки, куда могут и не зайти, незачем.
  const reload = useCallback(() => {
    void window.copilot.journalList().then(setRecords)
  }, [])
  useEffect(() => {
    if (tab !== 'records') return
    reload()
    void window.copilot.journalDir().then(setDir)
  }, [tab, reload])

  useEffect(() => {
    if (tab !== 'glossary') return
    void window.copilot.getKbSnapshot().then(setSnap)
    // Вкладку открыли, пока база грузится при старте: итог придёт следом.
    return window.copilot.onKbSnapshot(setSnap)
  }, [tab])


  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  // Состояние провайдеров могло устареть, пока окно висело: вошли в CLI в терминале.
  const { refresh: refreshProviders } = providers
  useEffect(() => {
    refreshProviders()
  }, [refreshProviders])

  const provider = providerById(settings.llmProvider)
  const isClaude = provider.id === 'claude'
  const provStatus = providers.statuses[provider.id]
  const provChecking = providers.checking.has(provider.id)
  const provChip = chipOf(provStatus, provChecking, settings.claudeSource)
  const provModels = provStatus.models
  const modelOptions = modelOptionsOf(provider.id, provModels, settings.llmModel)
  // Подпись к модели не-Claude: своё пояснение, если есть, иначе «GPT-5.6 Sol — сильная».
  const curModel = provModels.find((m) => m.id === settings.llmModel)
  const modelAbout = curModel ? (curModel.note ?? `${curModel.name} — ${curModel.hint}`) : settings.llmModel
  // Cursor глубину выбирает сам — переключатель ему не передаётся, и подпись говорит это прямо.
  const serviceThinks = provider.id === 'cursor'

  // Второй агент: свой провайдер и своя модель, независимо от того, кто отвечает.
  // У Claude он всегда идёт через Claude Code (API по ключу вердикт не напишет) — чип и готовность по нему.
  const verifier = providerById(settings.verifyProvider)
  const verStatus = providers.statuses[verifier.id]
  const verChecking = providers.checking.has(verifier.id)
  const verChip = chipOf(verStatus, verChecking, 'cli')
  const verModels = verStatus.models
  const verModelOptions = modelOptionsOf(verifier.id, verModels, settings.verifyModel)
  const verModel = verModels.find((m) => m.id === settings.verifyModel)
  const verModelName = modelName(settings.verifyModel, verifier.id, verModels)
  const verEfforts = verifyEffortsOf(modelEfforts(settings.verifyModel, verifier.id, verModels))

  // Цифры режима «думает» зависят от глубины: с высокой первое слово через 5,9 с, а не 1,7.
  // Для сочетаний без замера подпись обходится без цифр. Замеры есть только у Claude.
  const model = settings.llmModel
  const measured = isClaude ? TIMINGS[model] : undefined
  const thinkTiming =
    isHaikuModel(model) || settings.llmEffort === 'default'
      ? measured?.think
      : model === 'claude-opus-5'
        ? OPUS_EFFORT[settings.llmEffort]
        : undefined
  const plainTiming = measured?.plain
  const timing = settings.llmThinking ? thinkTiming : plainTiming
  const mode = settings.llmThinking ? 'думает' : 'сразу'

  const exportRecord = async (id: string, format: 'md' | 'json') => {
    const res = await window.copilot.journalExport(id, format)
    if (res.ok) setNote(`Сохранено: ${res.path}`)
    else if (!res.canceled) setNote(`Не сохранилось: ${res.error}`)
  }

  const title = TABS.find((t) => t.id === tab)?.label ?? 'Настройки'

  // Инструкция называет клавиши, которые достались на самом деле: основные мог занять другой процесс.
  const keysText = (id: HotkeyId) => comboKeys(hotkeyCombo(hotkeys, id)).join(' ')
  const askText = keysText('ask')
  const shotText = keysText('screenshot')
  const hideText = keysText('hide')
  const throughText = keysText('clickThrough')

  return (
    <>
      <div className="modal-layer" onMouseDown={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Настройки">
        <nav className="modal-tabs" aria-label="Разделы настроек">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="modal-main">
          <header className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Закрыть настройки" title="Закрыть · Esc">
              <Close size={14} />
            </button>
          </header>

          <div className="modal-body">
            {tab === 'general' && (
              <>
                <h3 className="section-title first">Язык</h3>
                <Row
                  name="Язык распознавания и ответов"
                  control={<Seg value={settings.language} options={LANG_OPTIONS} onChange={(v) => onChange('language', v)} />}
                />

                <h3 className="section-title">Откуда берутся подсказки</h3>
                <Row
                  wide
                  name={
                    <span className="name-chip">
                      Кто отвечает
                      <span className={`prov-chip ${provChip.tone}`} title={provChip.title}>
                        {provChip.text}
                      </span>
                    </span>
                  }
                  control={<Seg value={provider.id} options={PROVIDER_OPTIONS} onChange={onPickProvider} />}
                  desc={`${viaOf(provider.id, settings.claudeSource)} · ${noteOf(provider.id, settings.claudeSource)}`}
                />
                {/* Неготовый провайдер — сразу здесь же войти или поставить: иначе настройка ведёт в тупик. */}
                {!isReady(provStatus, settings.claudeSource) && !(provChecking && provStatus.available.state === 'unknown') && (
                  <div className="setup-plate">
                    <ProviderSetup
                      key={provider.id}
                      status={provStatus}
                      checking={provChecking}
                      claudeSource={settings.claudeSource}
                      ctl={providers}
                      onCopy={onCopy}
                    />
                  </div>
                )}

                {/* Моделей у Claude больше десятка: сегментами из макета они заняли бы пол-окна, поэтому список. */}
                <Row
                  name="Модель"
                  control={
                    <Dropdown
                      value={model}
                      options={modelOptions}
                      wide
                      disabled={!modelOptions.length}
                      label={modelOptions.length ? undefined : provChecking ? 'проверяю…' : 'нет моделей'}
                      onChange={onPickModel}
                    />
                  }
                  desc={
                    !isClaude
                      ? !modelOptions.length
                        ? (provider.modelsHint ?? 'Список моделей пуст.')
                        : `${modelAbout.replace(/\.$/, '')}. Скорость этой модели на созвоне не замеряли.`
                      : timing
                        ? `Первое слово через ${sec(timing[0])} с, ответ целиком за ${sec(timing[1])} с — замер для ${modelName(model)} в режиме «${mode}».`
                        : `${modelNote(model)} ${measured ? 'Для этой глубины замера нет.' : 'Скорость этой модели на созвоне не замерялась.'}`
                  }
                />

                {isClaude && (
                  <div className="row">
                    <div className="name" style={{ marginBottom: 8 }}>
                      Как обращаться к Claude
                    </div>
                    <div className="source-grid" style={{ gridColumn: '1 / -1' }}>
                      {(
                        [
                          [
                            'cli',
                            'Claude Code (подписка)',
                            'Через установленный Claude Code, в рамках лимитов подписки.',
                          ],
                          [
                            'api',
                            'API по ключу',
                            'Прямой вызов по ключу ANTHROPIC_API_KEY, оплата за токены. Свой промпт и команды из него здесь не действуют.',
                          ],
                        ] as const
                      ).map(([value, label, desc]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={settings.claudeSource === value}
                          className={`source ${settings.claudeSource === value ? 'on' : ''}`}
                          onClick={() => onChange('claudeSource', value)}
                        >
                          <span className="title">
                            <span className="radio" />
                            {label}
                          </span>
                          <span className="desc">{desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <Row
                  name="Размышления перед ответом"
                  control={
                    <Switch
                      on={settings.llmThinking}
                      label="Размышления перед ответом"
                      onClick={() => onChange('llmThinking', !settings.llmThinking)}
                    />
                  }
                  desc={
                    serviceThinks
                      ? `Глубину размышлений ${provider.name} выбирает сам: «думает» и «сразу» на его ответ не влияют.`
                      : !isClaude
                        ? settings.llmThinking
                          ? 'Включено: модель сначала размышляет, ответ приходит позже, но точнее. То же, что «думает» в строке запроса.'
                          : 'Выключено: модель отвечает сразу, без размышлений. То же, что «сразу» в строке запроса.'
                        : settings.llmThinking
                          ? `Включено: ответ точнее и длиннее.${thinkTiming && plainTiming ? ` Первое слово через ${sec(thinkTiming[0])} с вместо ${sec(plainTiming[0])} с.` : ''} То же, что «думает» в строке запроса.`
                          : `Выключено: ${plainTiming ? `первое слово через ${sec(plainTiming[0])} с, ` : ''}${isHaikuModel(model) ? 'без размышлений' : 'размышления по минимуму'}. То же, что «сразу» в строке запроса.`
                  }
                />

                <Row
                  name="Глубина в режиме «думает»"
                  control={
                    <Dropdown
                      value={settings.llmEffort}
                      options={EFFORT_OPTIONS}
                      disabled={!isClaude || isHaikuModel(model)}
                      label={!isClaude ? 'только у Claude' : isHaikuModel(model) ? 'не настраивается' : undefined}
                      onChange={(v) => onChange('llmEffort', v)}
                    />
                  }
                  desc={
                    !isClaude
                      ? 'Глубину размышлений задаёт только Claude Code.'
                      : isHaikuModel(model)
                        ? 'Для Haiku 4.5 глубина не настраивается.'
                        : EFFORT_NOTE[settings.llmEffort]
                  }
                />

                <Row
                  name="Сколько записей из базы"
                  control={<Seg value={settings.kbTopK} options={KB_COUNT_OPTIONS} onChange={(v) => onChange('kbTopK', v)} />}
                  desc="Похожие вопросы из базы, которые попадут в запрос к модели."
                />

                <Row
                  name="Сколько ждать ответа"
                  control={
                    <Seg value={settings.llmTimeoutSec} options={TIMEOUT_OPTIONS} onChange={(v) => onChange('llmTimeoutSec', v)} />
                  }
                  desc="Столько модель может молчать, прежде чем сессия считается зависшей. Напечатанное останется, причина появится подписью."
                />
                <div className="note-line">Смена вступает в силу сразу</div>

                <h3 className="section-title">Второй агент</h3>
                <Row
                  name="Режим двух агентов"
                  control={
                    <Switch
                      on={settings.verifyEnabled}
                      label="Режим двух агентов"
                      onClick={() => onChange('verifyEnabled', !settings.verifyEnabled)}
                    />
                  }
                  desc="Второй агент — отдельная сессия модели: проверяет каждую подсказку по базе знаний и своим знаниям и показывает вердикт во втором окне рядом с ответом. Выключен — проверки нет вовсе."
                />
                {/* Плашка стоит и при выключенном режиме: иначе непонятно, где его включать. */}
                <div className="info-plate">
                  <Duo />
                  <span>
                    Режим включается и настраивается прямо на главном экране: кнопка «2 агента» рядом с выбором
                    модели, а кто проверяет, модель, глубина и «веб» — в заголовке окна второго агента. Здесь — те
                    же настройки. Каждая проверка — ещё один запрос к тому, кто проверяет, в рамках его лимитов.
                  </span>
                </div>
                {settings.verifyEnabled && (
                  <div style={{ animation: 'cc-slide-up .25s both' }}>
                    {/* Как «Кто отвечает»: сегменты провайдеров и чип состояния, неготовому — войти или поставить. */}
                    <Row
                      wide
                      name={
                        <span className="name-chip">
                          Кто проверяет
                          <span className={`prov-chip ${verChip.tone}`} title={verChip.title}>
                            {verChip.text}
                          </span>
                        </span>
                      }
                      control={<Seg value={verifier.id} options={PROVIDER_OPTIONS} onChange={onPickVerifyProvider} />}
                      desc={`${verifier.via} · своя сессия, отдельная от подсказок: проверять может не тот, кто отвечает.`}
                    />
                    {!isReady(verStatus, 'cli') && !(verChecking && verStatus.available.state === 'unknown') && (
                      <div className="setup-plate">
                        <ProviderSetup
                          key={verifier.id}
                          status={verStatus}
                          checking={verChecking}
                          claudeSource="cli"
                          ctl={providers}
                          onCopy={onCopy}
                        />
                      </div>
                    )}
                    <Row
                      name="Модель"
                      control={
                        <Dropdown
                          value={settings.verifyModel}
                          options={verModelOptions}
                          wide
                          disabled={!verModelOptions.length}
                          label={verModelOptions.length ? undefined : verChecking ? 'проверяю…' : 'нет моделей'}
                          onChange={onPickVerifyModel}
                        />
                      }
                      desc={
                        !verModelOptions.length
                          ? (verifier.modelsHint ?? 'Список моделей пуст.')
                          : verModel
                            ? (verModel.note ?? `${verModel.name} — ${verModel.hint}`)
                            : verModelName
                      }
                    />
                    <Row
                      name="Глубина проверки"
                      control={
                        <Seg
                          value={settings.verifyEffort}
                          // Модель умеет не все уровни — лишние не показываем; не умеет ни одного — все, но неактивные.
                          options={verEfforts.length ? VERIFY_EFFORT_OPTIONS.filter((o) => verEfforts.includes(o.value)) : VERIFY_EFFORT_OPTIONS}
                          disabled={!verEfforts.length}
                          onChange={(v) => onChange('verifyEffort', v)}
                        />
                      }
                      desc={
                        verEfforts.length
                          ? 'Высокая внимательнее к деталям, но вердикт приходит на несколько секунд позже.'
                          : verifyDepthNote(verifier.id, verModelName)
                      }
                    />
                    <Row
                      name="Искать в интернете"
                      control={
                        <Switch
                          on={settings.verifyWeb && verifier.webSearch}
                          disabled={!verifier.webSearch}
                          label="Искать в интернете"
                          onClick={() => onChange('verifyWeb', !settings.verifyWeb)}
                        />
                      }
                      desc={
                        !verifier.webSearch
                          ? `${verifier.name} искать в интернете не умеет: проверка — по базе знаний и знаниям модели.`
                          : verifier.id === 'claude'
                            ? 'Медленнее: в замере первое слово проверки пришло через 13,5 с вместо 3–6 с.'
                            : 'Точнее на редких фактах, но медленнее. Скорость с поиском у этого провайдера не замеряли.'
                      }
                    />
                  </div>
                )}

                <h3 className="section-title">Доступ</h3>
                <Row
                  name="Микрофон"
                  control={
                    <span className={`status-badge ${perms.mic ? 'ok' : 'bad'}`}>
                      <i />
                      {perms.mic ? 'Работает' : 'Нет доступа'}
                    </span>
                  }
                />
                <Row
                  name="Звук собеседника"
                  control={
                    <span className={`status-badge ${perms.loopback ? 'ok' : 'warn'}`}>
                      <i />
                      {perms.loopback ? 'Работает' : 'Не захвачен'}
                    </span>
                  }
                />

                <h3 className="section-title">Приватность</h3>
                <Row
                  name="Скрывать от захвата экрана"
                  control={
                    <Switch
                      on={settings.contentProtected}
                      label="Скрывать от захвата экрана"
                      onClick={() => onChange('contentProtected', !settings.contentProtected)}
                    />
                  }
                  desc="Без этого панель попадёт в демонстрацию экрана и в запись созвона. В строке состояния появится «виден в захвате»."
                />
                <Row
                  last
                  name="Распознавание речи"
                  control={
                    <span className="stt-info">
                      {engine ?? 'модель не загружена'}
                      <span className="badge-soft">Локально</span>
                    </span>
                  }
                  desc="Звук и распознавание не покидают компьютер."
                />
              </>
            )}

            {tab === 'prompt' && (
              <>
                <p className="muted-p">
                  Свой промпт заменяет встроенную инструкцию модели: как отвечать, о чём молчать, какой стиль
                  держать. Расшифровка, ваш вопрос и найденное в базе добавляются к нему автоматически. Команды
                  со слешем, например «/разбор», станут кнопками в строке запроса.
                </p>
                <textarea
                  className="textarea prompt"
                  value={settings.customPrompt}
                  placeholder={PROMPT_PLACEHOLDER}
                  aria-label="Свой промпт"
                  spellCheck={false}
                  onChange={(e) => onChange('customPrompt', e.target.value)}
                />
                <div className="prompt-foot">
                  <span>
                    {settings.customPrompt
                      ? `${settings.customPrompt.length.toLocaleString('ru-RU')} символов · ${
                          promptUsed
                            ? 'применится при следующем «Спросить»'
                            : 'Claude по ключу API его не читает: промпт действует у Claude Code и других провайдеров'
                        }`
                      : 'Используется встроенный промпт'}
                    {commandsLine}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!settings.customPrompt}
                    onClick={() => onChange('customPrompt', '')}
                  >
                    Вернуть встроенный
                  </button>
                </div>
              </>
            )}

            {tab === 'glossary' && (
              <>
                {snap ? (
                  <div className="kb-card">
                    <span className="text">
                      <span className="t">
                        База знаний ·{' '}
                        {snap.rows >= 0
                          ? `${snap.rows} ${plural(snap.rows, 'запись', 'записи', 'записей')}`
                          : 'загружена'}
                      </span>
                      <span className="s">
                        вопросы с собеседований 1С · встроена в приложение
                        {snap.version ? ` · версия от ${kbVersion(snap.version)}` : ''}
                      </span>
                    </span>
                  </div>
                ) : snap === null ? (
                  <div className="kb-card bad">
                    <span className="lead">
                      <Alert size={16} />
                      <span className="text">
                        <span className="t">База знаний не загрузилась</span>
                        <span className="s">
                          Файл встроенной базы не найден или повреждён — переустановите приложение. Подсказки идут без
                          базы, словарь — общий.
                        </span>
                      </span>
                    </span>
                  </div>
                ) : null}

                <h3 className="section-title first">Сейчас в распознавании</h3>
                <div className="dict-live-head">
                  {hotwords
                    ? `тема: ${topic ? topicLabel(topic) : 'общий'} · учтено ${hotwords.kept} из ${hotwords.total} · ${hotwords.tokens} из 222 токенов`
                    : `${composed.length} ${plural(composed.length, 'термин', 'термина', 'терминов')} · точный подсчёт после «Старт»`}
                </div>
                <div className="chips">
                  {composed.length === 0 ? (
                    <span className="chip cut">пока пусто</span>
                  ) : (
                    composed.map((t, i) => {
                      const cut = !!hotwords && i >= hotwords.kept
                      return (
                        <span
                          key={t}
                          className={`chip ${cut ? 'cut' : ''}`}
                          title={cut ? 'не влез в бюджет токенов' : 'уходит в распознавание'}
                        >
                          {t}
                        </span>
                      )
                    })
                  )}
                </div>

                <div className="two-col">
                  <label className="field">
                    <span className="name">Свои имена и названия</span>
                    <textarea
                      className="textarea"
                      value={settings.glossaryNames}
                      placeholder={'Например:\nПодсказыч\nЗУП КОРП\nЛюдмила Петровна'}
                      aria-label="Свои имена и названия"
                      onChange={(e) => onChange('glossaryNames', e.target.value)}
                    />
                    <span className="desc">По одному на строку — они всегда уходят в словарь</span>
                  </label>
                  <label className="field">
                    <span className="name">Убрать из словаря</span>
                    <textarea
                      className="textarea"
                      value={settings.glossaryExclude}
                      placeholder="По одному на строку"
                      aria-label="Убрать из словаря"
                      onChange={(e) => onChange('glossaryExclude', e.target.value)}
                    />
                    <span className="desc">Термины, которые база подобрала зря</span>
                  </label>
                </div>

                <h3 className="section-title">Термины из базы</h3>
                {glossary ? (
                  <>
                    <div className="always-row">
                      <b>Всегда</b>
                      <span className="terms">{glossary.base.join(' · ')}</span>
                    </div>
                    <div className="topic-list">
                      {topicOrder.map((t) => (
                        <div key={t} className={`topic-row ${t === topic ? 'active' : ''}`}>
                          <span className="topic-name">
                            <i />
                            <b>{topicLabel(t)}</b>
                            <span className="n">{glossary.sizes[t]}</span>
                          </span>
                          <span className="terms">{glossary.topics[t]?.join(' · ') || '—'}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="empty-card">База знаний ещё не загружена…</div>
                )}
              </>
            )}

            {tab === 'records' && (
              <>
                <Row
                  name="Вести журнал"
                  control={
                    <Switch
                      on={settings.journalEnabled}
                      label="Вести журнал"
                      onClick={() => onChange('journalEnabled', !settings.journalEnabled)}
                    />
                  }
                  desc="Расшифровка и подсказки каждого созвона сохраняются только на этом компьютере."
                />
                <Row
                  name="Папка с записями"
                  control={
                    <button type="button" className="btn-secondary" onClick={() => void window.copilot.journalOpenFolder()}>
                      Открыть папку
                    </button>
                  }
                  desc={dir ? <span className="path-line">{dir}</span> : undefined}
                />

                <h3 className="section-title">{records === null ? 'Записи' : `Записи · ${records.length}`}</h3>

                {note && (
                  <div className={`saved ${note.startsWith('Сохранено: ') ? '' : 'neutral'}`}>
                    {note.startsWith('Сохранено: ') && <Check size={14} />}
                    <span className="body">
                      {note.startsWith('Сохранено: ') ? (
                        <>
                          <b>Сохранено:</b> <span className="path">{note.slice('Сохранено: '.length)}</span>
                        </>
                      ) : (
                        note
                      )}
                    </span>
                  </div>
                )}

                {records !== null && records.length === 0 && (
                  <div className="empty-card">
                    Пока пусто. Первая запись появится после того, как вы проведёте созвон или зададите вопрос.
                  </div>
                )}

                <div className="records">
                  {records?.map((r) => (
                    <article className="record" key={r.id}>
                      <div className="record-head">
                        <span className="record-when">{when(r.startedAt)}</span>
                        <span className={`record-sum ${r.endedAt ? '' : 'open'}`}>
                          {span(r.startedAt, r.endedAt)} · реплик {r.lines} · подсказок {r.asks}
                        </span>
                      </div>
                      <div className="record-title">{r.title}</div>
                      <div className="record-actions">
                        <button type="button" className="btn-secondary ink4 small" onClick={() => void exportRecord(r.id, 'md')}>
                          Выгрузить текстом
                        </button>
                        <button type="button" className="btn-secondary ink4 small" onClick={() => void exportRecord(r.id, 'json')}>
                          JSON
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={async () => {
                            setRecords(await window.copilot.journalDelete(r.id))
                            setNote('Запись удалена')
                          }}
                        >
                          Удалить
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}

            {tab === 'account' && (
              <div className="info-list">
                <p className="info-lead">Аккаунта нет — приложение работает на этом компьютере без регистрации.</p>
                <div className="info-item">
                  <i style={{ background: 'var(--accent)' }} />
                  <span>
                    <strong>Остаётся на компьютере:</strong> звук обоих каналов и распознавание речи — модель
                    whisper работает локально, на видеокарте.
                  </span>
                </div>
                <div className="info-item">
                  <i style={{ background: 'var(--them)' }} />
                  <span>
                    <strong>Уходит в сеть:</strong> только текст запроса к модели — расшифровка, ваш вопрос и
                    найденное в базе. И запрос ко второму агенту, если режим двух агентов включён.
                  </span>
                </div>
                <div className="info-item">
                  <i style={{ background: 'var(--warn)' }} />
                  <span>
                    <strong>Хранится локально:</strong> журнал созвонов — расшифровка и подсказки — лежит в папке
                    записей на этом компьютере, пока вы его не удалите. Выключается в «Записях созвонов».
                  </span>
                </div>
              </div>
            )}

            {tab === 'hotkeys' && (
              <>
                <div className="hk-list">
                  {HOTKEYS.map((h) => {
                    // Глобальные — какие достались на самом деле; стрелки ловит само окно, у них всегда свои.
                    const id = statusHotkeyId(h.id)
                    const combo = id ? hotkeyCombo(hotkeys, id) : h.combo
                    return (
                      <div className="hk-row" key={h.id}>
                        <span>{HOTKEY_LABEL[h.id] ?? h.label}</span>
                        {combo === null ? (
                          <span className="status-badge warn" title="Все запасные комбинации заняты другими программами">
                            <i />
                            не удалось занять
                          </span>
                        ) : (
                          <span className="keys">
                            {comboKeys(combo).map((k) => (
                              <kbd key={k}>{k}</kbd>
                            ))}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="hint-p">
                  Комбинации перехватывает система раньше Zoom и Teams: они срабатывают, даже когда в фокусе окно
                  созвона. Если комбинацию занял другой процесс, приложение возьмёт следующую свободную — здесь
                  показаны те, что достались на самом деле.
                </p>
                <p className="hint-p">
                  Локальные клавиши: Esc закрывает меню и настройки, Enter отправляет вопрос из строки запроса,
                  Ctrl + / − / 0 меняет масштаб.
                </p>
              </>
            )}

            {tab === 'guide' && (
              <>
                <div className="guide-hero">
                  <Mascot size={64} live />
                  <span className="text">
                    <span className="t">Суфлёр слушает разговор и подсказывает</span>
                    <span className="s">
                      Голубые наушники — канал собеседника, лаймовый — вы. Те же цвета у волн уровня и реплик в
                      расшифровке.
                    </span>
                  </span>
                  {onOpenTour && (
                    <button type="button" className="btn-tour" onClick={onOpenTour}>
                      Пройти обучение
                    </button>
                  )}
                </div>
                <ol className="steps">
                  <li>
                    <span className="step-n">1</span>
                    <span>
                      Нажмите круглую кнопку слева — модель распознавания загрузится за 3–10 с. В строке состояния
                      появится «сессия идёт», словарь подстроится под тему разговора.
                    </span>
                  </li>
                  <li>
                    <span className="step-n">2</span>
                    <span>
                      Проверьте волны уровня: <span className="c-them">голубая</span> — собеседник,{' '}
                      <span className="c-me">лаймовая</span> — вы. Теми же цветами подписаны реплики в расшифровке.
                      Если волна собеседника молчит, проверьте устройство вывода.
                    </span>
                  </li>
                  <li>
                    <span className="step-n">3</span>
                    <span>
                      Когда нужна подсказка — «Спросить»{askText ? ` или ${askText}` : ''}. Тезисы печатаются по
                      словам: начинайте читать с первого. Готовый ответ из базы появляется сразу.
                    </span>
                  </li>
                  <li>
                    <span className="step-n">4</span>
                    <span>{shotText || 'Кнопка «Скриншот»'} снимает экран и разбирает, что на нём — это дольше текстового ответа.</span>
                  </li>
                  <li>
                    <span className="step-n">5</span>
                    <span>
                      Кнопка «2 агента» включает второго агента: он проверяет каждую подсказку в соседнем окне.
                      Жёлтые уточнения читайте до того, как произнесёте ответ вслух.
                    </span>
                  </li>
                  <li>
                    <span className="step-n">6</span>
                    <span>
                      {`Ctrl ← / → листает подсказки${hideText ? `, ${hideText} скрывает панель` : ''}. ` +
                        'В решении задачи со снимка Ctrl ↓ / ↑ отмечает набранные строки кода. ' +
                        'Задача не влезла в экран — снимайте её по частям кнопкой «+» и отправляйте одной серией. ' +
                        `«Клики сквозь окно» — в меню${throughText ? ` и на клавишах ${throughText}` : ''}: клики ` +
                        'уходят в окно под панелью, режим виден в строке состояния. ' +
                        `Выйти — ${throughText ? 'теми же клавишами или ' : ''}из меню значка в трее.`}
                    </span>
                  </li>
                </ol>
                <div className="callout">
                  <EyeOff size={16} />
                  <span>
                    Панель скрыта от захвата экрана: в Teams, Zoom, Телемосте и Meet её не видят, скриншот окна тоже
                    не снять. Пока в строке состояния «скрыт от захвата» — можно показывать экран. Если появилось
                    красное «виден в захвате», остановите демонстрацию и включите скрытие в «Основных».
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
