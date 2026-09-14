/**
 * Иконки инлайном, из макета Claude Design. Внешние шрифты и спрайты оверлею
 * не нужны: он запускается без сети.
 */

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const }

export const Play = () => (
  <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
    <path d="M4.5 2.5v11l9-5.5z" fill="currentColor" />
  </svg>
)

export const Stop = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
    <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
  </svg>
)

export const Spinner = () => (
  <svg data-keep className="spin" width="22" height="22" viewBox="0 0 22 22" aria-hidden>
    <circle cx="11" cy="11" r="8" fill="none" stroke="rgb(200 245 58 / .25)" strokeWidth="2.5" />
    <circle
      cx="11"
      cy="11"
      r="8"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeDasharray="18 40"
    />
  </svg>
)

export const Burger = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <rect x="2" y="3" width="12" height="1.8" rx=".9" fill="currentColor" />
    <rect x="2" y="7.1" width="12" height="1.8" rx=".9" fill="currentColor" />
    <rect x="2" y="11.2" width="12" height="1.8" rx=".9" fill="currentColor" />
  </svg>
)

export const Close = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
    <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

/** «+» серии снимков: две скруглённые планки, как в макете. */
export const Plus = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
    <rect x="6" y="1.5" width="2" height="11" rx="1" fill="currentColor" />
    <rect x="1.5" y="6" width="11" height="2" rx="1" fill="currentColor" />
  </svg>
)

export const Camera = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <rect x="1.5" y="3.5" width="13" height="10" rx="2.5" {...stroke} />
    <circle cx="8" cy="8.5" r="2.6" {...stroke} />
  </svg>
)

/** «Спросить» в компактном окне, когда подписи не помещаются. */
export const Bubble = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <path d="M3 3h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" />
  </svg>
)

export const Chevron = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M1.5 3.5L5 7l3.5-3.5" {...stroke} />
  </svg>
)

export const Mic = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" {...stroke} />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" {...stroke} />
  </svg>
)

export const Screen = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <rect x="1.5" y="2.5" width="13" height="9" rx="2" {...stroke} />
    <path d="M5 14h6" {...stroke} />
  </svg>
)

export const Gear = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.2" />
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  </svg>
)

export const Exit = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <path d="M5.5 3H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" {...stroke} />
    <path d="M9 4.5L12.5 8 9 11.5M12 8H6" {...stroke} strokeLinejoin="round" />
  </svg>
)

/** «скрыт от захвата»: глаз перечёркнут. */
export const EyeOff = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
    <path
      d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
      style={{ fill: 'none', stroke: 'var(--text-2)', strokeWidth: 1.5 }}
    />
    <circle cx="8" cy="8" r="2" style={{ fill: 'var(--text-2)' }} />
    <path d="M2.5 13.5l11-11" style={{ stroke: 'var(--text)', strokeWidth: 1.6 }} />
  </svg>
)

/** «виден в захвате»: открытый глаз на коралловой пилюле. */
export const Eye = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" {...stroke} />
    <circle cx="8" cy="8" r="2.2" fill="currentColor" />
  </svg>
)

/** Модель распознавания: чип. */
export const Chip = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <rect x="4" y="4" width="4" height="4" rx="1" fill="currentColor" />
  </svg>
)

/** «звук собеседника есть». */
export const Bars = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect x="1" y="4" width="2" height="4" rx="1" fill="currentColor" />
    <rect x="5" y="1.5" width="2" height="9" rx="1" fill="currentColor" />
    <rect x="9" y="3" width="2" height="6" rx="1" fill="currentColor" />
  </svg>
)

/** Клики сквозь панель. */
export const Pointer = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path d="M2 1.5l8 3.5-3.5 1.2L5.3 10z" fill="currentColor" />
  </svg>
)

/**
 * Ошибка и оборванный ответ: треугольник. Форма дублирует цвет.
 * Янтарный — там, где это не авария: пропущенная и остановленная проверка.
 */
export const Alert = ({ size = 18, tone = 'danger' }: { size?: number; tone?: 'danger' | 'warn' }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden className="alert-icon">
    <path d="M9 2l7.5 13H1.5z" style={{ fill: tone === 'warn' ? 'var(--warn)' : 'var(--danger)' }} />
    <rect x="8.1" y="7" width="1.8" height="4.2" rx=".9" style={{ fill: 'var(--danger-ink)' }} />
    <circle cx="9" cy="12.9" r="1" style={{ fill: 'var(--danger-ink)' }} />
  </svg>
)

/** «проверено»: галочка рисуется 0,3 с и замирает. */
export const Check = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="check">
    <path
      d="M1.5 6.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** Кнопка «2 агента»: два окна, второе поверх первого. */
export const Duo = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
    <rect x="1.5" y="1.5" width="9" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <rect
      x="5.5"
      y="5.5"
      width="9"
      height="9"
      rx="2.5"
      className="duo-front"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
  </svg>
)

/** «веб» у второго агента: поиск в интернете. */
export const Globe = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <ellipse cx="6" cy="6" rx="2" ry="4.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <line x1="1.4" y1="6" x2="10.6" y2="6" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

/** Ручка изменения размера окна. */
export const Grip = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    {[
      [10, 2],
      [10, 6],
      [6, 6],
      [10, 10],
      [6, 10],
      [2, 10],
    ].map(([x, y]) => (
      <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />
    ))}
  </svg>
)
