/**
 * Разбор ответа модели на блоки: обычный текст, код, таблица — и отдельный
 * формат «решение задачи» для live coding.
 *
 * Разбор работает и на недописанном тексте: ответ показывается по мере
 * генерации, поэтому незакрытый блок кода — это код, который ещё пишется, а не
 * текст с тремя обратными кавычками. Модуль общий: окно рисует по нему ответ,
 * main решает, отдавать ли ответ по снимку второму агенту.
 */

export type Block =
  | { kind: 'text'; lines: string[] }
  | { kind: 'code'; lang: string; lines: string[]; open: boolean }
  | { kind: 'table'; head: string[]; rows: string[][] }

/** Открывающая или закрывающая строка блока кода. Язык может быть и кириллицей: «1с». */
const FENCE = /^\s*```\s*([^\s`]*)\s*$/
/** Хвост, который ещё дописывается: пара кавычек или строка «```яз» без перевода строки. */
const FENCE_PENDING = /^\s*`{1,2}\s*$|^\s*```[^\n`]*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** Пустые строки по краям кода — артефакт разметки, а не часть решения. */
function trimBlank(lines: string[], keepLast: boolean): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a]!.trim()) a++
  // В открытом блоке последняя пустая строка — это перевод строки, после которого пойдёт код.
  if (!keepLast) while (b > a && !lines[b - 1]!.trim()) b--
  return lines.slice(a, b)
}

/** Ответ из Windows-источника может прийти с \r\n: метки и комментарии не должны от этого ломаться. */
const norm = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * Текст подряд идущих строк: таблица, если вторая строка — разделитель, иначе обычный текст.
 * tail — это хвост всего показанного текста: последняя строка таблицы в нём может ещё печататься.
 */
function proseBlocks(lines: string[], out: Block[], tail = false): void {
  let buf: string[] = []
  const flush = () => {
    if (buf.length) out.push({ kind: 'text', lines: buf })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush()
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      // Недописанная строка «| Молоко | 90» остаётся в таблице и заполняется по ячейке,
      // а не выпрыгивает абзацем с палками на каждом слове.
      const row = (k: number) => TABLE_ROW.test(lines[k]!) || (tail && k === lines.length - 1 && /^\s*\|/.test(lines[k]!))
      while (i < lines.length && row(i)) rows.push(cells(lines[i++]!))
      i--
      out.push({ kind: 'table', head, rows })
      continue
    }
    buf.push(line)
  }
  flush()
}

export function splitBlocks(raw: string): Block[] {
  const text = norm(raw)
  const lines = text.split('\n')
  // Недописанная разметка в самом хвосте не показывается, пока не станет ясно, что это.
  if (lines.length && FENCE_PENDING.test(lines[lines.length - 1]!) && !FENCE.test(lines[lines.length - 1]!)) lines.pop()
  else if (lines.length && /^\s*```[^\s`]*\s*$/.test(lines[lines.length - 1]!) && !text.endsWith('\n')) {
    // «```sql» без перевода строки: может оказаться «```sqlite» — ждём конца строки.
    const opens = lines.filter((l) => FENCE.test(l)).length % 2 === 1
    if (opens) lines.pop()
  }

  const out: Block[] = []
  let prose: string[] = []
  let code: { lang: string; lines: string[] } | null = null
  for (const line of lines) {
    const fence = FENCE.exec(line)
    if (code) {
      if (fence && !fence[1]) {
        out.push({ kind: 'code', lang: code.lang, lines: trimBlank(code.lines, false), open: false })
        code = null
      } else code.lines.push(line)
      continue
    }
    if (fence) {
      proseBlocks(prose, out)
      prose = []
      code = { lang: fence[1] ?? '', lines: [] }
      continue
    }
    prose.push(line)
  }
  if (code) out.push({ kind: 'code', lang: code.lang, lines: trimBlank(code.lines, true), open: true })
  else proseBlocks(prose, out, true)
  return out
}

/* ---------- решение задачи ---------- */

export interface TaskChunk {
  /** «1 · Поля» */
  caption: string
  /** что сказать, пока набираешь этот кусок */
  say: string
  lang: string
  lines: string[]
  /** кусок ещё пишется */
  open: boolean
}

export interface Task {
  /** «запрос · язык запросов 1С» */
  kind: string
  /** как модель поняла условие */
  restate: string
  /** фраза, которую стоит сказать сразу */
  say: string
  chunks: TaskChunk[]
  checks: string[]
  follow: Array<{ q: string; a: string }>
}

type Section = 'kind' | 'restate' | 'say' | 'chunk' | 'chunkSay' | 'checks' | 'follow' | null

const MARKERS: Record<string, Exclude<Section, null>> = {
  ЗАДАЧА: 'kind',
  ПОНЯЛ: 'restate',
  СКАЗАТЬ: 'say',
  КУСОК: 'chunk',
  ГОВОРИТЬ: 'chunkSay',
  ПРОВЕРЬ: 'checks',
  СПРОСЯТ: 'follow',
}

/**
 * «**КУСОК:** 1 · Поля», «### ПОНЯЛ: …» — модель любит украшать метки. Метки — только
 * заглавными и не пунктом списка: «- Задача: вернуть остатки» — обычный тезис, а не решение.
 */
const MARKER = /^[\s>#*_]*(ЗАДАЧА|ПОНЯЛ|СКАЗАТЬ|КУСОК|ГОВОРИТЬ|ПРОВЕРЬ|СПРОСЯТ)[\s*_]*:[\s*_]*(.*)$/u
const HEAD = /^[\s>#*_]*ЗАДАЧА[\s*_]*:/u
const LIST_ITEM = /^\s*(?:[-*•—]|\d+[.)])\s+/

const clean = (s: string) => s.replace(/\*\*/g, '').trim()

/** Строка — начало метки, которая ещё печатается: «ПОН», «КУСО». */
function markerPrefix(line: string): boolean {
  const w = line.replace(/^[\s>#*_]*/, '').replace(/\*+$/, '')
  return /^[А-ЯЁ]{1,8}$/u.test(w) && Object.keys(MARKERS).some((k) => k.startsWith(w))
}

/**
 * Решение задачи узнаётся по заголовку: ЗАДАЧА первой строкой, и следом за ней —
 * ещё одна метка. Одного «ЗАДАЧА:» мало: так может начаться и разбор тикета на экране.
 * Пока пришла только первая строка или следующая метка ещё печатается, считаем решением —
 * иначе вид переключался бы на глазах.
 */
export function isTaskText(raw: string): boolean {
  const text = norm(raw).slice(0, 800)
  const lines = text.split('\n').filter((l) => l.trim())
  if (!lines.length || !HEAD.test(lines[0]!)) return false
  const rest = lines.slice(1, 4)
  if (!rest.length) return true
  const open = !text.endsWith('\n')
  return rest.some((l, k) => MARKER.test(l) || (open && k === rest.length - 1 && lines.length <= 4 && markerPrefix(l)))
}

export function parseTask(raw: string): Task | null {
  if (!isTaskText(raw)) return null
  const text = norm(raw)
  const task: Task = { kind: '', restate: '', say: '', chunks: [], checks: [], follow: [] }
  let section: Section = null
  let fence: TaskChunk | null = null

  const chunk = (): TaskChunk => {
    let c = task.chunks[task.chunks.length - 1]
    if (!c) {
      c = { caption: '', say: '', lang: '', lines: [], open: false }
      task.chunks.push(c)
    }
    return c
  }
  const append = (a: string, b: string) => (a ? `${a} ${b}` : b)

  const lines = text.split('\n')
  const tail = lines[lines.length - 1] ?? ''
  // Хвост «``» ещё не разметка — ждём, пока допишется. Так же и метка, пришедшая наполовину:
  // «ПРО» иначе на миг прилипло бы к пояснению куска.
  if ((FENCE_PENDING.test(tail) && !FENCE.test(tail)) || (!text.endsWith('\n') && lines.length > 1 && markerPrefix(tail))) {
    lines.pop()
  }

  /** Код внутри «Проверь» или «Спросят» — часть пункта, а не кусок решения. */
  let sink: { section: 'checks' | 'follow'; lines: string[] } | null = null

  for (const line of lines) {
    const f = FENCE.exec(line)
    if (sink) {
      if (f && !f[1]) {
        const code = sink.lines.map((l) => l.trim()).filter(Boolean).join(' ')
        if (code) {
          const snippet = `\`${code}\``
          if (sink.section === 'checks' && task.checks.length) {
            task.checks[task.checks.length - 1] = append(task.checks[task.checks.length - 1]!, snippet)
          } else if (sink.section === 'follow' && task.follow.length) {
            const last = task.follow[task.follow.length - 1]!
            last.a = append(last.a, snippet)
          }
        }
        sink = null
      } else sink.lines.push(line)
      continue
    }
    if (fence) {
      if (f && !f[1]) {
        fence.lines = trimBlank(fence.lines, false)
        fence.open = false
        fence = null
      } else fence.lines.push(line)
      continue
    }
    if (f && (section === 'checks' || section === 'follow')) {
      sink = { section, lines: [] }
      continue
    }
    if (f) {
      // Код после «Проверь» или без метки куска — всё равно кусок решения.
      let c = section === 'chunk' || section === 'chunkSay' ? chunk() : null
      if (!c || c.lines.length) {
        c = { caption: '', say: '', lang: '', lines: [], open: false }
        task.chunks.push(c)
      }
      c.lang = f[1] ?? ''
      c.open = true
      fence = c
      section = 'chunk'
      continue
    }

    const m = MARKER.exec(line)
    if (m) {
      section = MARKERS[m[1]!]!
      const value = clean(m[2] ?? '')
      if (section === 'kind') task.kind = value
      else if (section === 'restate') task.restate = value
      else if (section === 'say') task.say = value
      else if (section === 'chunk') task.chunks.push({ caption: value, say: '', lang: '', lines: [], open: false })
      else if (section === 'chunkSay') {
        const last = task.chunks[task.chunks.length - 1]
        // У куска уже есть и код, и пояснение — это ГОВОРИТЬ следующего куска, у которого пропустили КУСОК.
        if (last && last.lines.length && last.say) task.chunks.push({ caption: '', say: value, lang: '', lines: [], open: false })
        else chunk().say = value
      }
      else if (section === 'checks' && value) task.checks.push(value)
      else if (section === 'follow' && value) task.follow.push(followItem(value))
      continue
    }

    const value = clean(line)
    if (!value) continue
    const item = LIST_ITEM.test(line)
    const bare = clean(line.replace(LIST_ITEM, ''))
    switch (section) {
      case 'kind':
        task.kind = append(task.kind, value)
        break
      case 'restate':
        task.restate = append(task.restate, value)
        break
      case 'say':
        task.say = append(task.say, value)
        break
      case 'chunk':
      case 'chunkSay': {
        const c = chunk()
        c.say = append(c.say, value)
        break
      }
      case 'checks':
        if (item || !task.checks.length) task.checks.push(bare)
        else task.checks[task.checks.length - 1] = append(task.checks[task.checks.length - 1]!, value)
        break
      case 'follow':
        if (item || !task.follow.length) task.follow.push(followItem(bare))
        else {
          const last = task.follow[task.follow.length - 1]!
          last.a = append(last.a, value)
        }
        break
      default:
        break
    }
  }
  if (fence) fence.lines = trimBlank(fence.lines, true)

  task.chunks = task.chunks
    .filter((c) => c.lines.length || c.open || c.caption || c.say)
    .map((c, i) => ({ ...c, caption: c.caption && !/^\d/.test(c.caption) ? `${i + 1} · ${c.caption}` : c.caption }))
  return task
}

/** «Почему не полное соединение? — Резерв без остатка…» → вопрос и короткий ответ. */
function followItem(s: string): { q: string; a: string } {
  const dash = s.search(/\s[—–-]\s/)
  const qm = s.indexOf('?')
  // Вопрос кончается на первом из двух: «?» или тире. Тире внутри ответа вопрос не режет.
  if (qm > 0 && (dash < 0 || qm < dash)) {
    const a = s.slice(qm + 1).replace(/^\s*[—–-]\s*/, '').trim()
    return { q: s.slice(0, qm + 1).trim(), a }
  }
  if (dash > 0) return { q: s.slice(0, dash).trim(), a: s.slice(dash + 3).trim() }
  return { q: s, a: '' }
}

/* ---------- строки кода ответа ---------- */

/** Код ответа по порядку: куски решения или блоки кода. По нему нумеруются набранные строки. */
export function codeGroups(text: string): string[][] {
  const task = parseTask(text)
  if (task) return task.chunks.map((c) => c.lines)
  return splitBlocks(text)
    .filter((b): b is Extract<Block, { kind: 'code' }> => b.kind === 'code')
    .map((b) => b.lines)
}

/** Сколько строк кода в ответе: до стольких можно отметить «набрано». */
export function codeLineCount(text: string): number {
  return codeGroups(text).reduce((n, g) => n + g.length, 0)
}
