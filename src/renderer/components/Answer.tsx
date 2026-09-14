import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { codeLineCount, isTaskText, parseTask, splitBlocks, type Task } from '@shared/answerFormat'
import { AnswerTable, CodeCard, langLabel } from './Code'

/**
 * Ответ, который печатается на глазах.
 *
 * Модель отдаёт текст рывками: пришло тридцать символов, тишина двести
 * миллисекунд, пришло ещё сорок. Если рисовать это как есть, текст дёргается —
 * читать неприятно, а на созвоне ещё и мешает.
 *
 * Поэтому между сетью и экраном стоит буфер. Пришедшее копится, а показывается
 * ровным потоком: скорость подбирается так, чтобы разобрать накопленное
 * примерно за LAG_S секунд. Рывок сети превращается в короткое ускорение, а не
 * в скачок. Отставание от модели держится в пределах трети секунды — на глаз
 * незаметно.
 *
 * Показываем словами целиком, а не буквами: полуслово в ответе, который читают
 * вслух, выглядит как ошибка. Каждое новое слово проявляется за 0.22 с, они
 * накладываются друг на друга и складываются в непрерывное движение.
 *
 * Код в ответе рисуется карточкой, как в IDE, таблица — таблицей. Решение задачи
 * со снимка (ответ начинается с «ЗАДАЧА:») — отдельным видом: условие, фраза
 * «сказать сразу», куски кода с тем, что говорить, и что проверить перед отправкой.
 */

/** За сколько секунд разбирается накопленное. Меньше — резче, больше — вяло. */
const LAG_S = 0.26
/** Пол скорости: медленнее живой речи текст идти не должен. */
const MIN_CPS = 45
/** Потолок: на добивке в конце текст не должен смазываться в мельтешение. */
const MAX_CPS = 900

const BULLET = /^\s*(?:[-*•—]|\d+[.)])\s+/
/** Строка, где приехал только маркер списка: отступ занимаем сразу. */
const BULLET_ONLY = /^\s*(?:[-*•—]|\d+[.)])\s*$/

/**
 * Незакрытая разметка в хвосте. Без этого в тексте на долю секунды мелькают
 * звёздочки: `**Пла` показалось бы как есть, пока не приедет закрывающая пара.
 */
function trimDangling(text: string): string {
  let out = text
  // нечётное число ** — последняя пара ещё не закрыта
  if ((out.match(/\*\*/g)?.length ?? 0) % 2 === 1) out = out.slice(0, out.lastIndexOf('**'))
  if ((out.match(/`/g)?.length ?? 0) % 2 === 1) out = out.slice(0, out.lastIndexOf('`'))
  return out
}

interface Piece {
  kind: 'text' | 'bold' | 'code'
  text: string
}

/** Разбор строки на куски. Полноценный markdown тут не нужен и вреден. */
function pieces(line: string): Piece[] {
  const out: Piece[] = []
  const re = /\*\*([^*]+?)\*\*|`([^`]+?)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ kind: 'text', text: line.slice(last, m.index) })
    out.push(m[1] !== undefined ? { kind: 'bold', text: m[1] } : { kind: 'code', text: m[2]! })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) })
  return out
}

/**
 * Строка — словами, каждое в своём span.
 *
 * Класс анимации ставится раз и навсегда и больше не снимается. Это не
 * мелочь: первая версия вычисляла «слово новое?» на каждой отрисовке и
 * убирала класс на следующем же кадре — анимация обрывалась через
 * шестнадцать миллисекунд, и слова просто возникали. Ключ у слова
 * стабильный, поэтому React переиспользует узел и не запускает анимацию
 * заново; проигрывается она ровно один раз, при появлении.
 */
function inlineNodes(line: string, prefix: string, reduced: boolean): ReactNode[] {
  let ord = 0
  const nodes: ReactNode[] = []
  const unit = (node: ReactNode, span: number) => {
    const key = `${prefix}:${ord}`
    ord += span
    nodes.push(
      <span key={key} className={reduced ? 'w' : 'w in'}>
        {node}
      </span>,
    )
  }
  for (const piece of pieces(line)) {
    if (piece.kind === 'text') {
      // Пробелы оставляем обычным текстом: между inline-block они и дают
      // нормальные отбивки и переносы.
      for (const token of piece.text.split(/(\s+)/)) {
        if (!token) continue
        if (/^\s+$/.test(token)) nodes.push(token)
        else unit(token, 1)
      }
    } else {
      const span = piece.text.trim().split(/\s+/).length
      unit(piece.kind === 'bold' ? <strong>{piece.text}</strong> : <code>{piece.text}</code>, span)
    }
  }
  return nodes
}

interface Props {
  /** id подсказки: смена сбрасывает состояние проявления */
  id: number
  text: string
  /** ответ ещё пишется — иначе показываем целиком и сразу */
  streaming: boolean
  /** контейнер прокрутки: за растущим текстом надо следовать */
  scrollRef: RefObject<HTMLDivElement | null>
  /** миниатюры снимков по порядку — у ответов по скриншоту или серии снимков */
  previews?: string[]
  /** сколько строк кода отмечено набранными */
  mark?: number
  /** отметить набранным до строки n; без обработчика строки не кликаются */
  onMark?: (n: number) => void
  /** скопировать код; без обработчика кнопки нет */
  onCopy?: (text: string) => void
}

const CARET = <span key="caret" className="caret" aria-hidden />

export function Answer({ text, streaming, scrollRef, previews = [], mark = 0, onMark, onCopy }: Props) {
  const reduced = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const textRef = useRef(text)
  textRef.current = text

  // Цель в символах — дробная и живёт в ref: перерисовка нужна не на каждый
  // символ, а только когда открылось очередное слово.
  const targetRef = useRef(reduced ? text.length : streaming ? 0 : text.length)
  const [cut, setCut] = useState(targetRef.current)
  const cutRef = useRef(cut)
  cutRef.current = cut

  /** Назад до границы слова: показываем слова целиком. */
  const wordCut = (target: number, full: string): number => {
    if (target >= full.length) return full.length
    let i = Math.floor(target)
    while (i > 0 && !/\s/.test(full[i]!)) i--
    return i
  }

  useEffect(() => {
    if (reduced) {
      setCut(textRef.current.length)
      return
    }
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // Кадр мог быть длинным (окно свернули) — не выдаём тогда рывок.
      const dt = Math.min(0.12, (now - last) / 1000)
      last = now

      const full = textRef.current
      if (targetRef.current >= full.length && cutRef.current >= full.length) return

      const backlog = full.length - targetRef.current
      const cps = Math.min(MAX_CPS, Math.max(MIN_CPS, backlog / LAG_S))
      targetRef.current = Math.min(full.length, targetRef.current + cps * dt)

      const next = wordCut(targetRef.current, full)
      if (next > cutRef.current) {
        cutRef.current = next
        setCut(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduced])

  // Ответ дописан и разобран — показываем остаток без ожидания.
  useEffect(() => {
    if (!streaming && cut >= 0 && text.length > 0 && targetRef.current >= text.length) {
      if (cutRef.current < text.length) setCut(text.length)
    }
  }, [streaming, text, cut])

  // Идём за текстом, пока пользователь сам не отлистал вверх.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (atBottom) el.scrollTop = el.scrollHeight
  }, [cut, scrollRef])

  // Отметили строку с клавиатуры — следующая строка должна остаться на виду.
  // Сравниваем с прошлой отметкой, а не с флагом «первый проход»: в StrictMode эффект
  // монтирования идёт дважды, и открытый ответ сам уезжал бы от начала к коду.
  const prevMark = useRef(mark)
  useEffect(() => {
    if (prevMark.current === mark) return
    prevMark.current = mark
    const root = scrollRef.current
    if (!root) return
    // Всё набрано — следующей строки нет, держим на виду последнюю набранную.
    const line = root.querySelector('.code-line.here') ?? [...root.querySelectorAll('.code-line.done')].pop()
    line?.scrollIntoView({ block: 'nearest' })
  }, [mark, scrollRef])

  const shown = text.slice(0, cut)
  // Курсор — пока показ не догнал текст: видно, что модель ещё пишет.
  const caretOn = !reduced && cut < text.length
  const total = codeLineCount(text)

  // Серия — стопка пронумерованных миниатюр в порядке склейки; одиночный снимок — одна крупнее.
  const many = previews.length > 1
  const shot = previews.length > 0 && (
    <div className={`shot ${many ? 'many' : ''}`}>
      <span className="shot-thumbs">
        {previews.map((src, i) => (
          <span key={i} className="shot-thumb">
            <img src={src} alt={many ? `Снимок ${i + 1} из серии` : 'Снимок экрана, отправленный модели'} />
            {many && <span className="n">{i + 1}</span>}
          </span>
        ))}
      </span>
      <span className="shot-caption">
        {many
          ? `Ответ по серии из ${previews.length} снимков · склеены по порядку`
          : 'Ответ по снимку экрана'}
      </span>
    </div>
  )

  if (isTaskText(text)) {
    const task = parseTask(shown)
    return (
      <TaskView
        task={task}
        previews={previews}
        mark={mark}
        total={total}
        caret={caretOn}
        reduced={reduced}
        onMark={onMark}
        onCopy={onCopy}
      />
    )
  }

  const blocks = splitBlocks(shown)
  const nodes: ReactNode[] = []
  let start = 0
  blocks.forEach((b, bi) => {
    const last = bi === blocks.length - 1
    if (b.kind === 'code') {
      nodes.push(
        <CodeCard
          key={`c${bi}`}
          title={langLabel(b.lang, b.lines)}
          sections={[{ lang: b.lang, lines: b.lines }]}
          start={start}
          total={total}
          mark={mark}
          caret={caretOn && last}
          onMark={onMark}
          onCopy={onCopy}
        />,
      )
      start += b.lines.length
      return
    }
    if (b.kind === 'table') {
      nodes.push(<AnswerTable key={`t${bi}`} head={b.head} rows={b.rows} />)
      if (caretOn && last) nodes.push(CARET)
      return
    }

    const body = last ? trimDangling(b.lines.join('\n')).split('\n') : b.lines
    const paras: Array<{ key: string; thesis: boolean; nodes: ReactNode[] }> = []
    body.forEach((raw, pIdx) => {
      const marker = BULLET.test(raw) || BULLET_ONLY.test(raw)
      const line = raw.replace(BULLET, '').replace(BULLET_ONLY, '').trim()
      if (!line && !marker) return
      paras.push({ key: `${bi}:${pIdx}`, thesis: marker, nodes: inlineNodes(line, `${bi}:${pIdx}`, reduced) })
    })
    // Курсор ставим в конец последнего абзаца, а не после него: отдельной
    // строкой он читался бы как лишний элемент, а не как место, где пишут.
    if (caretOn && last && paras.length) paras[paras.length - 1]!.nodes.push(CARET)
    for (const p of paras) {
      nodes.push(
        <p key={p.key} className={p.thesis ? 'thesis' : undefined}>
          {p.nodes}
        </p>,
      )
    }
  })

  return (
    <>
      {shot}
      {nodes}
    </>
  )
}

/* ---------- решение задачи со снимка ---------- */

interface TaskProps {
  task: Task | null
  previews: string[]
  mark: number
  total: number
  caret: boolean
  reduced: boolean
  onMark?: (n: number) => void
  onCopy?: (text: string) => void
}

function TaskView({ task, previews, mark, total, caret, reduced, onMark, onCopy }: TaskProps) {
  const t = task ?? { kind: '', restate: '', say: '', chunks: [], checks: [], follow: [] }
  const words = (s: string, key: string) => inlineNodes(s, key, reduced)
  const foot = t.checks.length > 0 || t.follow.length > 0
  // Где сейчас пишет модель: в подвале, в коде или ещё во вступлении.
  const caretAt = !caret ? null : foot ? 'foot' : t.chunks.length ? 'code' : t.say ? 'say' : 'restate'

  const lastFollow = t.follow.length - 1
  const lastCheck = t.checks.length - 1
  return (
    <div className="task">
      <div className="task-top">
        {previews.length > 0 && (
          // Серия — столбик узких миниатюр по порядку, одиночный снимок — одна миниатюра 96×54.
          <span className={`task-thumbs ${previews.length > 1 ? 'many' : ''}`}>
            {previews.map((src, i) => (
              <img
                key={i}
                className="task-thumb"
                src={src}
                alt={previews.length > 1 ? `Снимок ${i + 1} с задачей` : 'Снимок экрана с задачей'}
              />
            ))}
          </span>
        )}
        <div className="task-intro">
          <div className="task-eyebrow">
            <span className="task-label">Задача на экране</span>
            {t.kind && <span className="task-kind">{t.kind}</span>}
          </div>
          {(t.restate || caretAt === 'restate') && (
            <p className="task-restate">
              {words(t.restate, 'r')}
              {caretAt === 'restate' && CARET}
            </p>
          )}
          {t.say && (
            <p className="task-say">
              <span className="lead">Сказать сразу: </span>
              {words(t.say, 's')}
              {caretAt === 'say' && CARET}
            </p>
          )}
        </div>
      </div>

      {t.chunks.length > 0 && (
        <CodeCard
          title="Решение"
          task
          sections={t.chunks.map((c, i) => ({
            caption: c.caption,
            say: c.say ? words(c.say, `k${i}`) : undefined,
            lang: c.lang,
            lines: c.lines,
          }))}
          start={0}
          total={total}
          mark={mark}
          caret={caretAt === 'code'}
          onMark={onMark}
          onCopy={onCopy}
        />
      )}

      {foot && (
        <div className="task-foot">
          {t.checks.length > 0 && (
            <div className="task-col">
              <span className="task-label">Проверь перед отправкой</span>
              {t.checks.map((c, i) => (
                <p key={i} className="task-check">
                  {words(c, `ch${i}`)}
                  {caretAt === 'foot' && !t.follow.length && i === lastCheck && CARET}
                </p>
              ))}
            </div>
          )}
          {t.follow.length > 0 && (
            <div className="task-col">
              <span className="task-label">Спросят дальше</span>
              {t.follow.map((f, i) => (
                <div key={i} className="task-follow">
                  <p className="q">
                    {words(f.q, `fq${i}`)}
                    {caretAt === 'foot' && i === lastFollow && !f.a && CARET}
                  </p>
                  {f.a && (
                    <p className="a">
                      {words(f.a, `fa${i}`)}
                      {caretAt === 'foot' && i === lastFollow && CARET}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
