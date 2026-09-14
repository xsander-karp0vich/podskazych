import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Keys } from './Controls'
import { Mascot } from './Mascot'

/**
 * Обучение при первом запуске — ведёт зверёк. Макет Claude Design, сцена 00.
 *
 * Идёт само, как ролик: шаг за шагом подсвечивает элемент и объясняет его.
 * На «Начнём с сессии» и «Главная кнопка» зверёк сам нажимает кнопку — так
 * понятнее, чем любой текст. Курсор на карточке ставит паузу, Enter листает
 * дальше. «Пропустить» и Esc спрашивают подтверждение: пропуск случайным
 * нажатием потерял бы обучение насовсем.
 *
 * Шаг выпадает, если его элемента нет на экране: расшифровка скрыта,
 * подсказок ещё нет, окно слишком узкое для пилюли приватности.
 */

type StepId = 'welcome' | 'start' | 'waves' | 'transcript' | 'ask' | 'answer' | 'nav' | 'shot' | 'privacy' | 'menu' | 'done'

interface Step {
  id: StepId
  /** значение data-tour у подсвечиваемого элемента */
  target?: string
  radius?: string
  /** сколько шаг стоит на экране, мс */
  dur: number
  /** через сколько мс зверёк сам нажимает цель */
  demo?: number
  title: string
  next?: string
}

const STEPS: Step[] = [
  { id: 'welcome', dur: 6500, title: 'Привет! Я ваш суфлёр.' },
  { id: 'start', target: 'start', radius: '999px', dur: 8000, demo: 1800, title: 'Начнём с сессии' },
  { id: 'waves', target: 'waves', radius: '14px', dur: 7000, title: 'Две волны — два голоса' },
  { id: 'transcript', target: 'transcript', radius: '20px', dur: 6500, title: 'Расшифровка' },
  { id: 'ask', target: 'ask', radius: '999px', dur: 7500, demo: 2200, title: 'Главная кнопка' },
  { id: 'answer', target: 'answer', radius: '14px', dur: 9500, title: 'Ответ печатается по словам' },
  { id: 'nav', target: 'nav', radius: '999px', dur: 6500, title: 'История подсказок' },
  { id: 'shot', target: 'shot', radius: '999px', dur: 6500, title: 'Скриншот' },
  { id: 'privacy', target: 'privacy', radius: '999px', dur: 7000, title: 'Вас не видно' },
  { id: 'menu', target: 'menu', radius: '999px', dur: 6500, title: 'Остальное — в меню' },
  { id: 'done', dur: 10000, title: 'Готово!', next: 'Начать работу' },
]

export interface TourContext {
  phase: 'idle' | 'starting' | 'running'
  hints: number
  transcriptVisible: boolean
  compact: boolean
  /** в расшифровке уже есть реплики — «Спросить» есть о чём нажимать */
  canAsk: boolean
  /** клавиши, которые main занял на самом деле; пусто — не удалось занять */
  keys: { session: string[]; ask: string[]; shot: string[]; hide: string[]; clickThrough: string[] }
}

interface Props {
  rootRef: RefObject<HTMLDivElement | null>
  ctx: TourContext
  onStartSession: () => void
  onAsk: () => void
  onEnd: () => void
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const or = (keys: string[]) => (keys.length ? ` или ${keys.join(' ')}` : '')

function available(ctx: TourContext): Step[] {
  return STEPS.filter(
    (s) =>
      !(s.id === 'transcript' && !ctx.transcriptVisible) &&
      !(s.id === 'nav' && ctx.hints === 0) &&
      !(s.id === 'privacy' && ctx.compact),
  )
}

/** Текст шага. Где идёт показ, текст подстраивается под то, что уже случилось. */
function textFor(id: StepId, ctx: TourContext, tapped: boolean): string {
  const { keys } = ctx
  switch (id) {
    case 'welcome':
      return 'Покажу, что здесь где — две минуты. Нажимать ничего не нужно: всё покажу сам. Чтобы остановиться и дочитать — наведите курсор на эту карточку.'
    case 'start':
      if (ctx.phase === 'starting') return 'Нажал. Загружается… Точка в строке состояния сейчас жёлтая — станет лаймовой, когда модель готова.'
      if (ctx.phase === 'running')
        return tapped
          ? `Готово: точка лаймовая, волны ожили, расшифровка пошла. Остановить сессию — та же кнопка${or(keys.session)}.`
          : `Сессия уже идёт — та же кнопка теперь останавливает её${keys.session.length ? `. Горячая клавиша — ${keys.session.join(' ')}` : ''}.`
      return `Круглая кнопка включает слушание — сейчас нажму её сам. Модель распознавания загрузится за 3–10 с${keys.session.length ? `. Горячая клавиша — ${keys.session.join(' ')}` : ''}.`
    case 'waves':
      return 'Голубая — собеседник, лаймовая — вы. Теми же цветами подписаны реплики внизу. Если голубая молчит — проверьте устройство вывода звука.'
    case 'transcript':
      return 'Сюда попадает всё, что сказано. Черновик — серым с курсором, готовая реплика — белым. Скрыть расшифровку можно в меню.'
    case 'ask':
      if (ctx.phase !== 'running') return 'Сессии сейчас нет, поэтому кнопка неактивна. Спрашивать можно и без неё — набрав вопрос в строке ниже.'
      if (tapped) return 'Нажал. Первым мгновенно приходит готовый ответ из базы знаний, следом модель думает и печатает тезисы.'
      if (!ctx.canAsk)
        return `Когда нужна подсказка — «Спросить»${or(keys.ask)}. Модель прочитает разговор и ответит тезисами. Пока в разговоре пусто — нажмёте сами, когда будет что спросить.`
      return `Когда нужна подсказка — «Спросить»${or(keys.ask)}. Модель прочитает разговор и ответит тезисами. Нажимаю.`
    case 'answer':
      return 'Готовый ответ из базы знаний, если нашёлся, приходит первым и мгновенно. Следом модель: таймер, потом тезисы по слову — читайте с первого, не ждите конца. Внизу подпись: модель, режим, время.'
    case 'nav':
      return `Ctrl ← и Ctrl → листают подсказки за сессию: сейчас их ${ctx.hints}. Готовый ответ из базы всегда первый.`
    case 'shot':
      return `${keys.shot.length ? keys.shot.join(' ') : '«Скриншот»'} снимает экран и разбирает, что на нём: отчёт, ошибку, код. Это дольше текстового ответа — таймер подскажет.`
    case 'privacy':
      return 'Пока здесь «скрыт от захвата», панель не попадает в демонстрацию экрана и в запись созвона. Появится красное «виден в захвате» — остановите показ.'
    case 'menu':
      return 'Прозрачность, размер шрифта, микрофон, настройки. Там же инструкция с горячими клавишами и это обучение — если захотите повторить.'
    case 'done':
      return 'Ещё пара клавиш на память — и удачного созвона. Карточка закроется сама.'
  }
}

const STEP_BY_ID = Object.fromEntries(STEPS.map((s) => [s.id, s])) as Record<StepId, Step>
const ORDER = STEPS.map((s) => s.id)

interface Cur {
  id: StepId
  elapsed: number
  paused: boolean
  /** когда зверёк нажал цель; null — на этом шаге ещё не нажимал */
  tapAt: number | null
  demoDone: boolean
  /** сколько подсказок было в начале шага: «Спросить» второй раз не жмём */
  hintsAt: number
  /** номер показа шага: смена перезапускает прыжок зверька и появление текста */
  n: number
}

export function Tour({ rootRef, ctx, onStartSession, onAsk, onEnd }: Props) {
  const [cur, setCur] = useState<Cur>({
    id: 'welcome',
    elapsed: 0,
    paused: false,
    tapAt: null,
    demoDone: false,
    hintsAt: ctx.hints,
    n: 0,
  })
  const [skipAsk, setSkipAsk] = useState(false)
  const [rect, setRect] = useState<Rect | null>(null)
  const [box, setBox] = useState({ w: 1140, h: 470 })
  const [cardH, setCardH] = useState(170)
  const cardRef = useRef<HTMLDivElement>(null)
  const skipTimer = useRef(0)

  // Таймер и клавиши подписаны один раз, свежие данные берут отсюда.
  const live = useRef({ cur, ctx, skipAsk, onStartSession, onAsk, onEnd })
  live.current = { cur, ctx, skipAsk, onStartSession, onAsk, onEnd }

  const steps = available(ctx)
  const idx = Math.max(0, steps.findIndex((s) => s.id === cur.id))
  const step = STEP_BY_ID[cur.id]

  const next = useCallback(() => {
    const { cur: c, ctx: x, onEnd: end } = live.current
    const at = ORDER.indexOf(c.id)
    // Следующий по порядку из тех, что сейчас на экране: текущий мог выпасть и сам.
    const nxt = available(x).find((s) => ORDER.indexOf(s.id) > at)
    setSkipAsk(false)
    if (!nxt) {
      end()
      return
    }
    setCur({ id: nxt.id, elapsed: 0, paused: c.paused, tapAt: null, demoDone: false, hintsAt: x.hints, n: c.n + 1 })
  }, [])

  const askSkip = useCallback(() => {
    setSkipAsk(true)
    window.clearTimeout(skipTimer.current)
    // Вопрос не висит вечно: не ответили за 6 с — обучение идёт дальше.
    skipTimer.current = window.setTimeout(() => setSkipAsk(false), 6000)
  }, [])
  useEffect(() => () => window.clearTimeout(skipTimer.current), [])

  useEffect(() => {
    const t = window.setInterval(() => {
      const { cur: c, ctx: x } = live.current
      if (c.paused) return
      const s = STEP_BY_ID[c.id]
      const elapsed = c.elapsed + 100
      let { tapAt, demoDone } = c
      if (s.demo && !demoDone && elapsed >= s.demo) {
        demoDone = true
        // Кольцо нажатия — только если зверёк правда нажал, иначе оно соврало бы.
        if (s.id === 'start' && x.phase === 'idle') {
          live.current.onStartSession()
          tapAt = elapsed
        }
        if (s.id === 'ask' && x.phase === 'running' && x.canAsk && x.hints === c.hintsAt) {
          live.current.onAsk()
          tapAt = elapsed
        }
      }
      if (elapsed >= s.dur) {
        next()
        return
      }
      setCur({ ...c, elapsed, tapAt, demoDone })
    }, 100)
    return () => window.clearInterval(t)
  }, [next])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (live.current.skipAsk) live.current.onEnd()
        else askSkip()
        return
      }
      const tag = (e.target as HTMLElement | null)?.tagName ?? ''
      if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !/INPUT|TEXTAREA/.test(tag)) {
        e.preventDefault()
        next()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [next, askSkip])

  // Где цель и сколько места у окна. Меряем после каждой отрисовки: цель может
  // сдвинуться — появилась расшифровка, окно потянули за уголок.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (root.clientWidth !== box.w || root.clientHeight !== box.h) setBox({ w: root.clientWidth, h: root.clientHeight })
    let found: Rect | null = null
    if (step.target) {
      const rr = root.getBoundingClientRect()
      let x1 = Infinity
      let y1 = Infinity
      let x2 = -Infinity
      let y2 = -Infinity
      root.querySelectorAll<HTMLElement>(`[data-tour="${step.target}"]`).forEach((el) => {
        const r = el.getBoundingClientRect()
        if (!r.width) return
        x1 = Math.min(x1, r.left)
        y1 = Math.min(y1, r.top)
        x2 = Math.max(x2, r.right)
        y2 = Math.max(y2, r.bottom)
      })
      if (x2 > x1) found = { x: Math.round(x1 - rr.left), y: Math.round(y1 - rr.top), w: Math.round(x2 - x1), h: Math.round(y2 - y1) }
    }
    const same =
      found === rect ||
      (!!found && !!rect && Math.abs(found.x - rect.x) <= 1 && Math.abs(found.y - rect.y) <= 1 && Math.abs(found.w - rect.w) <= 1 && Math.abs(found.h - rect.h) <= 1)
    if (!same) setRect(found)
    const ch = cardRef.current?.offsetHeight
    if (ch && Math.abs(ch - cardH) > 1) setCardH(ch)
  })

  const pad = 6
  const cardW = Math.min(392, box.w - 24)
  const spot = rect
    ? { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), w: Math.min(box.w, rect.w + pad * 2), h: Math.min(box.h, rect.h + pad * 2) }
    : null
  let cardX: number
  let cardY: number
  let tail: 'up' | 'down' | null = null
  let tailX = 0
  if (spot) {
    const below = spot.y + spot.h + 14 + cardH <= box.h - 8
    const above = spot.y - 14 - cardH >= 8
    cardX = Math.round(Math.min(Math.max(8, spot.x + spot.w / 2 - cardW / 2), box.w - cardW - 8))
    if (below) {
      cardY = spot.y + spot.h + 14
      tail = 'up'
    } else if (above) {
      cardY = spot.y - 14 - cardH
      tail = 'down'
    } else {
      // Ни под целью, ни над ней не влезает — в правый нижний угол, без хвостика.
      cardY = Math.max(8, box.h - cardH - 8)
      cardX = Math.max(8, box.w - cardW - 12)
    }
    cardX = Math.max(0, Math.min(cardX, box.w - cardW))
    tailX = Math.round(Math.min(Math.max(20, spot.x + spot.w / 2 - cardX - 8), cardW - 36))
  } else {
    cardX = Math.round((box.w - cardW) / 2)
    cardY = Math.round(Math.max(8, (box.h - cardH) / 2))
  }
  const sc = spot ?? { x: 0, y: 0, w: 0, h: 0 }
  const showTap = !!spot && cur.tapAt !== null && cur.elapsed - cur.tapAt < 900
  const keyRows =
    step.id === 'done'
      ? (
          [
            ['Скрыть или показать панель', ctx.keys.hide],
            ['Клики сквозь панель', ctx.keys.clickThrough],
            ['Спросить', ctx.keys.ask],
          ] as Array<[string, string[]]>
        ).filter(([, k]) => k.length > 0)
      : []

  return (
    <div className="tour">
      <div className="tour-scrim" style={{ left: 0, top: 0, width: box.w, height: sc.y }} />
      <div className="tour-scrim" style={{ left: 0, top: sc.y, width: sc.x, height: sc.h }} />
      <div
        className="tour-scrim"
        style={{ left: sc.x + sc.w, top: sc.y, width: Math.max(0, box.w - sc.x - sc.w), height: sc.h }}
      />
      <div
        className="tour-scrim"
        style={{ left: 0, top: sc.y + sc.h, width: box.w, height: Math.max(0, box.h - sc.y - sc.h) }}
      />
      {spot && (
        <div
          className="tour-spot"
          data-keep
          style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h, borderRadius: step.radius ?? '14px' }}
        />
      )}
      {showTap && (
        <span key={`tap-${cur.n}`} className="tour-tap" data-keep style={{ left: sc.x + sc.w / 2, top: sc.y + sc.h / 2 }} />
      )}
      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-label="Обучение"
        style={{ left: cardX, top: cardY, width: cardW }}
        onMouseEnter={() => setCur((c) => ({ ...c, paused: true }))}
        onMouseLeave={() => setCur((c) => ({ ...c, paused: false }))}
      >
        {tail && <span className={`tour-tail ${tail}`} style={{ left: tailX }} />}
        <div className="tour-body">
          <span className="tour-mascot" key={`m-${cur.n}`}>
            <Mascot size={64} live />
          </span>
          <div className="tour-text" key={`t-${cur.n}`}>
            <div className="tour-title">{step.title}</div>
            <div className="tour-desc">{textFor(cur.id, ctx, cur.tapAt !== null)}</div>
            {keyRows.length > 0 && (
              <div className="tour-keys">
                {keyRows.map(([action, k]) => (
                  <div key={action}>
                    <span>{action}</span>
                    <Keys keys={k} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {skipAsk ? (
          <span className="tour-confirm" role="alertdialog">
            Пропустить обучение?
            <button type="button" className="yes" onClick={onEnd}>
              Да
            </button>
            <button type="button" className="no" onClick={() => setSkipAsk(false)}>
              Нет
            </button>
          </span>
        ) : (
          <button type="button" className="tour-skip" title="Пропустить обучение · Esc" onClick={askSkip}>
            пропустить
          </button>
        )}
        <div className="tour-foot">
          <span className="tour-dots" aria-label={`${idx + 1} / ${steps.length}`}>
            {steps.map((s, i) => (
              <span key={s.id} className={i <= idx ? 'on' : ''} />
            ))}
          </span>
          <span className="tour-status">
            {cur.paused ? 'пауза · уберите курсор, чтобы продолжить' : `${idx + 1} из ${steps.length}`}
          </span>
          <button
            type="button"
            className={`tour-next ${step.id === 'done' ? 'final' : ''}`}
            title="Дальше · Enter"
            onClick={next}
          >
            {step.next ?? 'Дальше'}
          </button>
        </div>
        <div className="tour-prog" aria-hidden>
          <span
            className={cur.paused ? 'paused' : ''}
            style={{ width: `${Math.min(100, (cur.elapsed / step.dur) * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}
