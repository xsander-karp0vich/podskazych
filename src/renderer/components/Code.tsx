import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { detectLang, langLabel, tokenizeLines } from '../code'

/**
 * Код в ответе — карточкой, как в IDE: моноширинный JetBrains Mono, номера
 * строк, подсветка, кнопка «Скопировать». Строку можно отметить набранной —
 * кликом или Ctrl ↓: набранное гаснет, следующая строка подсвечена лаймом.
 * Так на live coding видно, где остановился, пока смотришь то в редактор,
 * то на панель.
 */

export interface CodeSection {
  /** «1 · Поля» — у кусков решения; у обычного блока пусто */
  caption?: string
  /** что говорить, пока набираешь этот кусок */
  say?: ReactNode
  lang: string
  lines: string[]
}

/** Пробел нулевой ширины: пустая строка кода держит высоту строки. */
const EMPTY_LINE = String.fromCharCode(0x200b)

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10
  const b = n % 100
  return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`
}

interface CardProps {
  /** «Решение» у задачи; у обычного блока — язык */
  title: string
  sections: CodeSection[]
  /** сколько строк кода в ответе до этой карточки: нумерация «набрано» сквозная */
  start: number
  /** всего строк кода в ответе */
  total: number
  mark: number
  /** решение задачи: подсказка про Ctrl ↓ видна всегда, номера строк сквозные */
  task?: boolean
  /** ответ ещё пишется в эту карточку — курсор в конце */
  caret?: boolean
  onMark?: (n: number) => void
  onCopy?: (text: string) => void
}

export const CodeCard = memo(function CodeCard({
  title,
  sections,
  start,
  total,
  mark,
  task,
  caret,
  onMark,
  onCopy,
}: CardProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const count = sections.reduce((n, s) => n + s.lines.length, 0)
  const code = sections.map((s) => s.lines.join('\n')).join('\n')
  // Метку «набрано» показываем там, где сейчас курсор набора; у задачи — всегда.
  const here = mark > start && mark <= start + count
  const markLabel = task || (onMark && here)

  const copy = () => {
    onCopy?.(code)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  let n = start
  const lastSection = sections.length - 1
  // Язык — один на карточку, по всему коду: куски одного запроса иначе подсвечивались бы по-разному,
  // ведь «ИЗ … СОЕДИНЕНИЕ» без ВЫБРАТЬ по одному куску не узнать.
  const lang = detectLang(sections.find((s) => s.lang)?.lang ?? '', code)
  const markLine = (num: number) => {
    // Выделяли текст мышью, чтобы скопировать кусок, — это не отметка набранного.
    if (window.getSelection()?.toString()) return
    onMark?.(num === mark ? num - 1 : num)
  }
  return (
    <div className={`code-card ${task ? 'task-code' : ''}`}>
      <div className="code-head">
        {title && <span className="code-title">{title}</span>}
        <span>{plural(count, 'строка', 'строки', 'строк')}</span>
        {markLabel && (
          <span className="code-mark">
            набрано{' '}
            <b>
              {mark}/{total}
            </b>
            {onMark && <span className="code-hint"> · клик по строке или Ctrl ↓</span>}
          </span>
        )}
        {onCopy && (
          <button type="button" className="code-copy" onClick={copy} disabled={!count}>
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        )}
      </div>
      {sections.map((s, si) => {
        const toks = tokenizeLines(s.lines, lang)
        const lastLine = s.lines.length - 1
        return (
          <div key={si} className={`code-chunk ${s.caption || s.say ? 'with-say' : ''}`}>
            {(s.caption || s.say) && (
              <div className="code-say">
                {s.caption && <span className="cap">{s.caption}</span>}
                {s.say && <span className="say">{s.say}</span>}
              </div>
            )}
            <div className="code-lines">
              {s.lines.map((line, li) => {
                const num = ++n
                const done = num <= mark
                // Следующую строку подсвечиваем у задачи всегда, у обычного кода — когда уже начали отмечать.
                const next = num === mark + 1 && (task || mark > 0)
                const gutter = task ? num : li + 1
                return (
                  <div
                    key={li}
                    className={`code-line ${done ? 'done' : ''} ${next ? 'here' : ''} ${onMark ? 'markable' : ''}`}
                    onClick={onMark ? () => markLine(num) : undefined}
                    title={onMark ? 'Набрано до этой строки · Ctrl ↓ / ↑' : undefined}
                  >
                    <span className="gutter">{done ? '✓' : gutter}</span>
                    <span className="src">
                      {toks[li]!.map((t, ti) => (
                        <span key={ti} className={`tk-${t.k}`}>
                          {t.t}
                        </span>
                      ))}
                      {/* Пустая строка кода должна держать высоту. */}
                      {!line && EMPTY_LINE}
                      {caret && si === lastSection && li === lastLine && <span className="caret" aria-hidden />}
                    </span>
                  </div>
                )
              })}
              {caret && si === lastSection && !s.lines.length && (
                <div className="code-line">
                  <span className="gutter" />
                  <span className="src">
                    <span className="caret" aria-hidden />
                  </span>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
})

/** Таблица из ответа: числа и даты — моноширинным, чтобы столбцы читались. */
export function AnswerTable({ head, rows }: { head: string[]; rows: string[][] }) {
  const numeric = (c: string) => /^[−\-+]?[\d\s.,:%₽$€]+$|^—$/.test(c.trim())
  return (
    <div className="answer-table-wrap">
      <table className="answer-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {head.map((_, ci) => (
                <td key={ci} className={numeric(r[ci] ?? '') ? 'num' : undefined}>
                  {r[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export { langLabel }
