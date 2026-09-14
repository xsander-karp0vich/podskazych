import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Chevron } from './Icons'

/**
 * Общие элементы управления дизайн-системы: выпадающий список, сегментный
 * переключатель, переключатель и клавиши-подсказки.
 *
 * Нативный select не подходит: его список рисует Windows, со своими цветами,
 * кеглем и радиусами, — посреди тёмной панели он выглядит чужим.
 */

export interface Option<T> {
  value: T
  label: string
  /** пояснение справа в списке: «самая сильная» */
  hint?: string
  /** семейство пункта: между разными семействами в списке — тонкий разделитель */
  group?: string
}

export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  label,
  title,
  size = 'md',
  align = 'right',
  wide,
  prefix,
}: {
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  /** подпись на кнопке, если нужна не та, что у выбранного пункта */
  label?: string
  /** что стоит на кнопке перед подписью: значок Claude у выбора модели */
  prefix?: ReactNode
  title?: string
  /** xs — мини-селектор в заголовке окна второго агента */
  size?: 'md' | 'sm' | 'xs'
  /** список шире кнопки: длинные имена моделей */
  wide?: boolean
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // Esc закрывает только список, а не окно настроек, в котором он открыт.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])

  // Список не должен уходить за нижний край окна: высота — сколько осталось под кнопкой.
  // Моделей больше десятка, а панель бывает высотой в пару сотен пикселей.
  const listRef = useRef<HTMLDivElement>(null)
  const [maxH, setMaxH] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const bottom = ref.current.getBoundingClientRect().bottom
    setMaxH(Math.max(120, window.innerHeight - bottom - 12))
    listRef.current?.querySelector('.option.active')?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const current = options.find((o) => o.value === value)
  return (
    <div className={`picker ${size} ${wide ? 'wide' : ''}`} ref={ref}>
      <button
        type="button"
        className="picker-btn"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {prefix}
        <span className="picker-label">{label ?? current?.label}</span>
        <Chevron />
      </button>
      {open && (
        <div role="listbox" className={`listbox ${align}`} ref={listRef} style={{ maxHeight: maxH }}>
          {options.map((o, i) => {
            const on = o.value === value
            const newGroup = i > 0 && o.group !== undefined && o.group !== options[i - 1]!.group
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={on}
                className={`option ${on ? 'active' : ''} ${newGroup ? 'group-start' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span>{o.label}</span>
                {o.hint ? <span className="hint">{o.hint}</span> : on ? <span className="mark">✓</span> : null}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Сегментный выбор из нескольких значений: язык, число записей, таймаут. */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            className={on ? 'on' : ''}
            disabled={disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Switch({
  on,
  onClick,
  disabled,
  label,
}: {
  on: boolean
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch ${on ? 'on' : ''}`}
      onClick={onClick}
    >
      <span className="knob" />
    </button>
  )
}

/** Тот же переключатель без своей кнопки — для строки меню, которая сама кнопка. */
export function SwitchMark({ on }: { on: boolean }) {
  return (
    <span className={`switch ${on ? 'on' : ''}`} aria-hidden>
      <span className="knob" />
    </span>
  )
}

/** Сочетание клавиш клавишами: на кнопках действий, в навигации, в таблице. */
export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  )
}
