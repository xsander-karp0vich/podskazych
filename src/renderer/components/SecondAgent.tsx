import { useRef, type ReactNode } from 'react'
import type { AppSettings } from '@shared/settings'
import type { KbHit, VerifyStage, VerifyStatus } from '../../preload'
import { Answer } from './Answer'
import { parseTask } from '@shared/answerFormat'
import { isPromptCommand } from '@shared/promptCommands'
import { modelEfforts, modelName } from '@shared/models'
import { providerById, type ProviderId } from '@shared/providers'
import { Dropdown, type Option } from './Controls'
import { Alert, Check, Globe } from './Icons'
import type { CritterMode } from './Mascot'
import { ProviderPicker, ProviderSetup, type ProvidersCtl } from './ProviderPicker'
import { chipOf, needsSetup, verifyDepthNote, verifyEffortsOf } from '../providerStatus'

/**
 * Окно второго агента — рядом с ответом основного, как второй диалог.
 * Разметка по макету Claude Design (CallCopilotWindow, сцены 18–31).
 *
 * Два правила отсюда важнее прочих. Кто проверяет, модель, глубина и «веб» стоят в
 * заголовке: их меняют по ходу созвона, и лезть за этим в настройки нельзя. Уточнения ⚠
 * стоят первыми и вне прокрутки тела: их читают до того, как произнесут ответ
 * вслух, поэтому проскроллить мимо них не должно получаться.
 *
 * Голубой — цвет второго агента: таймер, точки и курсор голубые, чтобы не
 * путать его с лаймовым основным.
 */

/** Ход и итог проверки одной подсказки. */
export interface VerifyState {
  status: VerifyStatus
  notes: string[]
  tookMs?: number
  /** когда проверка началась — от этого момента идёт счётчик */
  startedAt?: number
  stage?: VerifyStage
  /** что второй агент успел написать; после итога — весь его ответ */
  text?: string
  /** вопросы записей базы, с которыми он сверялся */
  refs?: string[]
  error?: string
}

/** То, что окну нужно знать о подсказке основного агента. */
export interface CheckedSuggestion {
  id: number
  question: string
  answer: string
  pending: boolean
  tookMs?: number
  preview?: string
  /** готовый ответ из базы — его не проверяют */
  kb?: KbHit
  verify?: VerifyState
}

interface Props {
  suggestion: CheckedSuggestion | undefined
  settings: AppSettings
  /** уже 1000 px — короткие имена моделей */
  mid: boolean
  /** уже 780 px — у «веб» остаётся только глобус */
  compact: boolean
  /** состояние провайдеров: готов ли проверяющий, его живой список моделей */
  providers: ProvidersCtl
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /** проверить текущую подсказку сейчас */
  onVerifyNow: () => void
  /** кто проверяет и какой моделью — провайдер и модель меняются только вместе */
  onPickVerifier: (provider: ProviderId, model: string) => void
  onCopy: (text: string) => void
}

const STAGE_LABEL: Record<VerifyStage, string> = {
  queued: 'Жду очереди — сессия ещё занята',
  working: 'Сверяю с базой знаний',
  thinking: 'Размышляю над ответом',
  searching: 'Ищу в интернете',
  writing: 'Пишу вердикт',
}

const EFFORT_OPTIONS: Option<AppSettings['verifyEffort']>[] = [
  { value: 'low', label: 'Низкая' },
  { value: 'medium', label: 'Средняя' },
  { value: 'high', label: 'Высокая' },
]
/** На кнопке — строчными: это подпись, а не заголовок. */
const EFFORT_LOWER: Record<AppSettings['verifyEffort'], string> = {
  low: 'низкая',
  medium: 'средняя',
  high: 'высокая',
}

const ERROR_PREFIX = 'Ошибка: '

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return one
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few
  return many
}

/** 4200 -> «4,2»: подписи читают по-русски. */
const sec1 = (ms: number) => (ms / 1000).toFixed(1).replace('.', ',')

/** Короткий итог в заголовке: он виден, даже когда тело окна прокручено. */
function headline(v: VerifyState | undefined): { text: string; tone: '' | 'ok' | 'warn' | 'danger' } {
  switch (v?.status) {
    case 'checking':
      return { text: 'проверяет…', tone: '' }
    case 'ok':
      return { text: '✓ верно', tone: 'ok' }
    case 'issues':
      return {
        text: `⚠ ${v.notes.length} ${plural(v.notes.length, 'уточнение', 'уточнения', 'уточнений')}`,
        tone: 'warn',
      }
    case 'unclear':
      return { text: 'без вердикта', tone: '' }
    case 'error':
      return { text: 'не удалась', tone: 'danger' }
    case 'skipped':
      return { text: 'пропущена', tone: '' }
    case 'cancelled':
      return { text: 'остановлена', tone: '' }
    default:
      return { text: '', tone: '' }
  }
}

/**
 * Второй агент у Claude всегда идёт через Claude Code, даже когда подсказки идут по ключу:
 * у API зашитый промпт, вердикт в нужном виде он не напишет. Поэтому чип и готовность
 * проверяющего Claude — по Claude Code.
 */
const VERIFY_SOURCE: AppSettings['claudeSource'] = 'cli'

/** Зверёк на выборе проверяющего повторяет ход проверки: думает, пишет, гаснет при сбое. */
function critterOf(v: VerifyState | undefined): CritterMode {
  if (v?.status === 'checking') return v.text?.trim() ? 'type' : 'think'
  return v?.status === 'error' ? 'off' : 'idle'
}

export function SecondAgent({
  suggestion: s,
  settings,
  mid,
  compact,
  providers,
  onChange,
  onVerifyNow,
  onPickVerifier,
  onCopy,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const v = s?.verify
  const vid = settings.verifyProvider
  const vInfo = providerById(vid)
  const vStatus = providers.statuses[vid]
  const vChecking = providers.checking.has(vid)
  const vLive = vStatus.models
  const vModelName = modelName(settings.verifyModel, vid, vLive)
  // Глубина — та, что умеет модель проверяющего; у Cursor, Gemini и Haiku её не выбрать.
  const efforts = verifyEffortsOf(modelEfforts(settings.verifyModel, vid, vLive))
  const depthOff = efforts.length === 0
  const depthOptions = EFFORT_OPTIONS.filter((o) => efforts.includes(o.value))
  const depthTitle = depthOff ? verifyDepthNote(vid, vModelName) : 'Глубина проверки'
  // Искать в интернете умеют не все: у Gemini и локальной модели «веб» неактивен, а не молча не работает.
  const webAble = vInfo.webSearch
  const webOn = settings.verifyWeb && webAble
  // Проверяющий не установлен или без входа: вместо обещаний — что сделать. Уже пришедший
  // вердикт важнее: его могли дать до смены провайдера, и он всё ещё про эту подсказку.
  const verdictShown = v?.status === 'checking' || v?.status === 'ok' || v?.status === 'issues' || v?.status === 'unclear'
  const setup = needsSetup(vStatus, vChecking, VERIFY_SOURCE) && !verdictShown
  const chip = chipOf(vStatus, vChecking, VERIFY_SOURCE)
  const head = setup && !v ? { text: chip.text, tone: 'warn' as const } : headline(v)
  // Решение задачи со снимка второй агент проверяет: снимок с условием у него есть. Обычный разбор
  // экрана — нет. Решение без кода — тоже нет: main такое не проверяет, сверять нечего.
  const shot = !!s && (!!s.preview || s.question === 'Снимок экрана') && !parseTask(s.answer)?.chunks.length
  const failed = !!s && s.answer.startsWith(ERROR_PREFIX)
  // Ответ на команду из своего промпта («/разбор») — не факты по вопросу, сверять нечего.
  const command = !!s && isPromptCommand(s.question)
  // Проверять есть что: ответ модели дописан, это не база, не снимок и не ошибка.
  const checkable =
    !!s && !s.kb && !s.pending && s.tookMs !== undefined && !shot && !failed && !command && s.answer.trim() !== ''

  /** «4,2 с · сверено с базой: 2 записи», по наведению — вопросы этих записей. */
  const refsMeta = (state: VerifyState) => {
    const n = state.refs?.length ?? 0
    const took = state.tookMs !== undefined ? `${sec1(state.tookMs)} с · ` : ''
    return (
      <span className="agent-meta refs" title={state.refs?.join(' · ')}>
        {took}
        {n ? `сверено с базой: ${n} ${plural(n, 'запись', 'записи', 'записей')}` : 'в базе по вопросу ничего'}
      </span>
    )
  }

  const again = (label: string, cls = 'btn-secondary xs') => (
    <button type="button" className={cls} onClick={onVerifyNow}>
      {label}
    </button>
  )

  const center = (text: string, extra?: string) => <div className={`agent-center ${extra ?? ''}`}>{text}</div>

  const issues = v?.status === 'issues'
  let body: ReactNode = null

  if (setup) {
    body = (
      <div className="agent-stack agent-setup">
        <div className="agent-line">
          <span className="warn-mark">⚠</span>
          <span>{`Проверяет ${vInfo.name}, но пока не может — подсказки останутся без проверки.`}</span>
        </div>
        <ProviderSetup
          key={vid}
          status={vStatus}
          checking={vChecking}
          claudeSource={VERIFY_SOURCE}
          ctl={providers}
          onCopy={onCopy}
        />
      </div>
    )
  } else if (!s) {
    body = center(
      `Проверю каждую подсказку: сверю факты с базой знаний${
        webOn ? ', своими знаниями и интернетом' : ' и своими знаниями'
      }. Найду ошибку — покажу здесь, до того как её скажут вслух.`,
      'intro',
    )
  } else if (s.kb) {
    body = center('Готовый ответ из базы второй агент не проверяет.')
  } else if (failed) {
    body = center('Проверять нечего: основной агент не ответил.')
  } else if (s.pending || s.tookMs === undefined) {
    // Раньше, чем «снимки не проверяю»: решение ли это задачи, станет ясно только по готовому ответу.
    body = center('Жду, пока основной агент допишет ответ.')
  } else if (shot) {
    // Снимок узнаём и по вопросу: превью приходит только вместе с ответом.
    body = center('Ответы по снимку экрана второй агент не проверяет.')
  } else if (command) {
    body = center('Ответы на команды из вашего промпта второй агент не проверяет.')
  } else if (v?.status === 'checking') {
    const elapsed = sec1(Date.now() - (v.startedAt ?? Date.now()))
    const stage = v.text?.trim() ? (v.stage ?? 'writing') : (v.stage ?? 'working')
    body = v.text?.trim() ? (
      <div className="answer-text">
        <Answer key={`${s.id}:${v.startedAt ?? 0}`} id={s.id} text={v.text} streaming scrollRef={bodyRef} />
        {/* Текст уже идёт, но агент может снова уйти в поиск — подпись говорит, чем он занят. */}
        <div className="stage-line stage-label" key={stage}>
          {STAGE_LABEL[stage]} · {elapsed} с
        </div>
      </div>
    ) : (
      <div className="waiting">
        <div className="timer">{elapsed} с</div>
        <div className="wait-label stage-label" key={stage}>
          {STAGE_LABEL[stage]}
        </div>
        <span className="breathe" data-keep aria-hidden>
          <i data-keep />
          <i data-keep />
          <i data-keep />
        </span>
      </div>
    )
  }
  else if (v?.status === 'ok') {
    body = (
      <div className="agent-stack">
        <p className="verdict-ok">
          <Check size={16} />
          Ошибок не нашёл
        </p>
        {refsMeta(v)}
        {checkable && again('Проверить ещё раз')}
      </div>
    )
  } else if (issues) {
    // Уточнения и низ с кнопкой живут вне прокрутки — они ниже, в разметке платы.
    body = null
  } else if (v?.status === 'unclear') {
    body = (
      <div className="agent-stack raw">
        <div className="agent-line strong">
          <span className="warn-mark">⚠</span>
          <span>Вердикт не по формату. Второй агент ответил так:</span>
        </div>
        {v.text && <p className="raw-quote">{v.text}</p>}
        {checkable && again('Проверить ещё раз')}
      </div>
    )
  } else if (v?.status === 'error' || v?.status === 'skipped' || v?.status === 'cancelled') {
    const text =
      v.status === 'skipped'
        ? 'Пропустил: пока проверка ждала очереди, прозвучал следующий вопрос.'
        : v.status === 'cancelled'
          ? 'Проверку остановили: второго агента выключали.'
          : `Проверка не удалась${v.error ? `: ${v.error}` : '.'}`
    body = (
      <div className="agent-stack">
        <div className="agent-line">
          <Alert size={16} tone={v.status === 'error' ? 'danger' : 'warn'} />
          <span>{text}</span>
        </div>
        {checkable && again('Проверить', 'btn-secondary m')}
      </div>
    )
  } else if (checkable) {
    body = (
      <div className="agent-stack">
        <span>Эту подсказку второй агент ещё не проверял.</span>
        {again('Проверить сейчас', 'btn-primary sm')}
      </div>
    )
  } else {
    body = center('Проверять нечего: основной агент не ответил.')
  }

  return (
    <section className="pane second" aria-label="Второй агент">
      <div className="pane-head">
        <span className="pill agent-title">
          <span>Второй агент</span>
          {head.text && <span className={`sum ${head.tone}`}>{head.text}</span>}
        </span>
        {/* Настройки второго агента — здесь, а не в окне настроек: их меняют по ходу созвона.
            Выбор проверяющего — тот же поповер, что у основного: провайдеры слева, модели справа. */}
        <span className="pane-tools">
          <ProviderPicker
            role="verify"
            small
            provider={vid}
            model={settings.verifyModel}
            claudeSource={VERIFY_SOURCE}
            ctl={providers}
            mode={critterOf(v)}
            compact={mid}
            onPick={onPickVerifier}
            onCopy={onCopy}
          />
          <Dropdown
            size="xs"
            value={settings.verifyEffort}
            options={depthOptions}
            disabled={depthOff}
            label={depthOff ? 'глубина —' : EFFORT_LOWER[settings.verifyEffort]}
            title={depthTitle}
            onChange={(e) => onChange('verifyEffort', e)}
          />
          {/* Неумеющему провайдеру «веб» в настройках не сбрасываем: вернутся к Claude — поиск вернётся с ним.
              aria-disabled, а не disabled: так подсказка «почему нельзя» доступна и с клавиатуры. */}
          <button
            type="button"
            className={`mini-toggle ${webOn ? 'on' : ''} ${webAble ? '' : 'unable'}`}
            aria-pressed={webOn}
            aria-disabled={!webAble}
            aria-label={compact ? 'Поиск в интернете' : undefined}
            title={
              webAble
                ? 'Поиск в интернете: точнее на редких фактах, но медленнее — в замере первое слово пришло через 13,5 с'
                : `${vInfo.name} искать в интернете не умеет: проверка — по базе знаний и знаниям модели`
            }
            onClick={() => webAble && onChange('verifyWeb', !settings.verifyWeb)}
          >
            <Globe />
            <span className="label">веб</span>
          </button>
        </span>
      </div>

      <div className="plate">
        {issues && v && (
          <div className="warn-list agent-warn" role="alert" data-a2warn>
            {v.notes.map((note, i) => (
              <div key={i}>
                <span>⚠</span>
                <span>{note.replace(/^⚠\s*/, '')}</span>
              </div>
            ))}
          </div>
        )}
        {/* В состоянии уточнений тело пустое: его поля съели бы строку самой платы. */}
        <div className={`plate-scroll agent ${issues ? 'empty' : ''}`} ref={bodyRef}>
          {body}
        </div>
        {issues && v && (
          <div className="agent-foot">
            {refsMeta(v)}
            {checkable && again('Проверить ещё раз')}
          </div>
        )}
      </div>
    </section>
  )
}
