import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isProviderId, providerById } from '@shared/providers'

/**
 * Журнал созвонов: что было сказано и что подсказал суфлёр.
 *
 * Формат — по файлу на созвон, JSONL, событие в строке. Так выбрано не ради
 * красоты: разговор пишется по ходу дела, и падение приложения посреди созвона
 * не должно уносить всё сказанное. Дописывание строки атомарно в пределах
 * записи такого размера, а один общий JSON пришлось бы перезаписывать целиком
 * и можно было бы застать его наполовину записанным.
 *
 * Всё лежит локально, в папке приложения. Расшифровка чужих голосов и так
 * никуда не уходит с машины — запись не должна это менять.
 */

export type JournalEvent =
  | { t: 'start'; at: number }
  | { t: 'line'; at: number; speaker: 'me' | 'them'; text: string }
  | {
      t: 'ask'
      at: number
      question: string
      answer: string
      /** кто отвечал: id из @shared/providers; в записях до провайдеров его нет — это Claude */
      provider?: string
      model?: string
      thinking?: boolean
      /** усилие, с которым отвечала модель: low в режиме «сразу», иначе выбранное */
      effort?: string
      /** UID записей базы знаний, поданных модели вместе с вопросом */
      kb?: string[]
      tookMs: number
      error?: string
    }
  | {
      /** проверка подсказки вторым агентом — пишется позже самой подсказки */
      t: 'verify'
      at: number
      /** время подсказки, к которой относится проверка */
      askAt?: number
      question: string
      status: 'ok' | 'issues' | 'unclear' | 'error'
      notes: string[]
      tookMs: number
      kb?: string[]
      error?: string
      /** кто проверял: id из @shared/providers; в записях, где его нет, проверял Claude */
      provider?: string
      /** модель второго агента — подписью, как у подсказки */
      model?: string
    }
  | { t: 'end'; at: number }

/** Подсказка в журнале: к ней позже дописывается проверка. */
export interface JournalRef {
  id: string
  at: number
}

export interface JournalSummary {
  id: string
  startedAt: number
  endedAt: number | null
  /** реплик в расшифровке */
  lines: number
  /** сколько раз спрашивали суфлёра */
  asks: number
  /** первая строка для списка: вопрос или первая реплика собеседника */
  title: string
  bytes: number
}

const WHO: Record<'me' | 'them', string> = { me: 'Я', them: 'Собеседник' }

/** `2026-09-09T14-32-05` — имя файла и одновременно идентификатор записи. */
function newId(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  )
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** «9 сентября 2026» — без «г.», которое подставляет локаль. */
const day = (at: number) =>
  new Date(at)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    .replace(/\s*г\.$/, '')

/**
 * Имя провайдера для выгрузки — только у не-Claude: «Opus 5» и так однозначен, а старые
 * записи не меняются. Провайдера, которого больше нет в каталоге, называем его id: имя
 * Claude вместо него соврало бы, кто отвечал.
 */
function providerLabel(provider: string | undefined): string | null {
  if (!provider || provider === 'claude') return null
  return isProviderId(provider) ? providerById(provider).name : provider
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'меньше минуты'
  if (m < 60) return `${m} мин`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

export class Journal {
  private current: string | null = null
  /** Выключается настройкой: запись разговоров — не то, что навязывают. */
  enabled = true

  get dir(): string {
    const d = join(app.getPath('userData'), 'journal')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  private path(id: string): string {
    return join(this.dir, `${id}.jsonl`)
  }

  /**
   * Пишем синхронно. Это десятки байт несколько раз в минуту — на фоне
   * созвона незаметно, зато запись оказывается на диске сразу, а не в буфере,
   * который потеряется вместе с процессом.
   */
  private write(ev: JournalEvent): string | null {
    if (!this.enabled) return null
    const id = this.current ?? this.open()
    try {
      appendFileSync(this.path(id), JSON.stringify(ev) + '\n', 'utf8')
    } catch (e) {
      console.error('[journal] не записалось:', e)
    }
    return id
  }

  /** Новая запись. Возвращает её id. */
  open(at = Date.now()): string {
    if (this.current) return this.current
    const id = newId(at)
    this.current = id
    try {
      appendFileSync(this.path(id), JSON.stringify({ t: 'start', at }) + '\n', 'utf8')
    } catch (e) {
      console.error('[journal] не создалась:', e)
    }
    return id
  }

  close(at = Date.now()): void {
    if (!this.current) return
    const id = this.current
    // Обнуляем до записи конца, иначе write() откроет запись заново.
    this.current = null
    if (!this.enabled) return
    try {
      appendFileSync(this.path(id), JSON.stringify({ t: 'end', at }) + '\n', 'utf8')
    } catch {
      /* запись уже могла быть удалена руками */
    }
  }

  line(speaker: 'me' | 'them', text: string, at = Date.now()): void {
    const t = text.trim()
    if (t) this.write({ t: 'line', at, speaker, text: t })
  }

  ask(p: Omit<Extract<JournalEvent, { t: 'ask' }>, 't' | 'at'>, at = Date.now()): JournalRef | null {
    const id = this.write({ t: 'ask', at, ...p })
    return id ? { id, at } : null
  }

  /**
   * Проверка приходит через секунды после подсказки, иногда уже после «Стоп».
   * Поэтому пишется в запись подсказки и новую не открывает: раньше одинокая
   * проверка заводила запись, и следующий созвон дописывался в неё.
   */
  verify(
    ref: JournalRef,
    p: Omit<Extract<JournalEvent, { t: 'verify' }>, 't' | 'at' | 'askAt'>,
    at = Date.now(),
  ): void {
    if (!this.enabled) return
    const file = this.path(ref.id)
    // Запись удалили, пока шла проверка, — не воскрешаем её одной строкой.
    if (!existsSync(file)) return
    const ev: JournalEvent = { t: 'verify', at, askAt: ref.at, ...p }
    try {
      appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8')
    } catch (e) {
      console.error('[journal] не записалось:', e)
    }
  }

  /** Событий в записи по порядку. Битые строки пропускаем, а не роняем разбор. */
  read(id: string): JournalEvent[] {
    const p = this.path(id)
    if (!existsSync(p)) return []
    const out: JournalEvent[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as JournalEvent)
      } catch {
        /* оборванная строка после падения — остальное всё ещё читается */
      }
    }
    return out
  }

  list(): JournalSummary[] {
    let files: string[]
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return []
    }

    const out: JournalSummary[] = []
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '')
      const events = this.read(id)
      if (events.length === 0) continue

      let startedAt = 0
      let endedAt: number | null = null
      let lines = 0
      let asks = 0
      let firstAsk = ''
      let firstThem = ''

      for (const ev of events) {
        if (ev.t === 'start') startedAt = ev.at
        else if (ev.t === 'end') endedAt = ev.at
        else if (ev.t === 'line') {
          lines++
          if (!firstThem && ev.speaker === 'them') firstThem = ev.text
        } else if (ev.t === 'ask') {
          asks++
          if (!firstAsk && ev.question) firstAsk = ev.question
        }
      }

      const raw = firstAsk || firstThem || 'Без реплик'
      out.push({
        id,
        startedAt: startedAt || events[0]!.at,
        endedAt,
        lines,
        asks,
        title: raw.length > 70 ? raw.slice(0, 69) + '…' : raw,
        bytes: (() => {
          try {
            return readFileSync(this.path(id)).length
          } catch {
            return 0
          }
        })(),
      })
    }

    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  remove(id: string): void {
    try {
      unlinkSync(this.path(id))
    } catch {
      /* уже удалена */
    }
    if (this.current === id) this.current = null
  }

  /**
   * Разговор в читаемом виде. Подсказки суфлёра идут цитатой — их не
   * произносили вслух, и в выгрузке это должно быть видно с первого взгляда.
   */
  toMarkdown(id: string): string {
    const events = this.read(id)
    if (events.length === 0) return `# Запись ${id}\n\nПусто.\n`

    const startedAt = events.find((e) => e.t === 'start')?.at ?? events[0]!.at
    const endedAt = [...events].reverse().find((e) => e.t === 'end')?.at ?? events[events.length - 1]!.at
    const lines = events.filter((e) => e.t === 'line').length
    const asks = events.filter((e) => e.t === 'ask').length

    const head = [
      `# Созвон ${day(startedAt)}, ${clock(startedAt).slice(0, 5)}`,
      '',
      `Длительность ${minutes(endedAt - startedAt)} · реплик ${lines} · подсказок ${asks}`,
      '',
      '---',
      '',
    ]

    // Проверка пишется позже подсказки, часто уже после следующих реплик. В
    // выгрузке она стоит сразу под своей подсказкой, внутри той же цитаты.
    const asked = new Set(events.flatMap((e) => (e.t === 'ask' ? [e.at] : [])))
    const verdicts = new Map<number, Extract<JournalEvent, { t: 'verify' }>>()
    for (const ev of events) {
      if (ev.t === 'verify' && ev.askAt !== undefined && asked.has(ev.askAt)) verdicts.set(ev.askAt, ev)
    }
    const verdictLines = (ev: Extract<JournalEvent, { t: 'verify' }>): string[] => {
      const label =
        ev.status === 'ok'
          ? '✓ проверено'
          : ev.status === 'issues'
            ? '⚠ уточнение'
            : ev.status === 'error'
              ? 'проверка не удалась'
              : 'проверка без внятного ответа'
      // Кто проверял — только если не Claude: так выгрузка прежних записей не меняется.
      const who = providerLabel(ev.provider)
      const meta = [label, who, who ? ev.model : null, `${(ev.tookMs / 1000).toFixed(1)} с`].filter(Boolean).join(' · ')
      return [
        `> **Проверка** — ${meta}`,
        ...ev.notes.map((note) => `> ${note}`),
        ...(ev.error ? [`> ${ev.error}`] : []),
      ]
    }

    const body: string[] = []
    for (const ev of events) {
      if (ev.t === 'line') {
        body.push(`**${clock(ev.at)} · ${WHO[ev.speaker]}:** ${ev.text}`, '')
      } else if (ev.t === 'verify') {
        // Проверка без своей подсказки в записи — остаётся там, где записана.
        if (ev.askAt === undefined || !asked.has(ev.askAt)) body.push(...verdictLines(ev), '')
      } else if (ev.t === 'ask') {
        const meta = [
          providerLabel(ev.provider),
          ev.model,
          ev.thinking === false ? 'без размышлений' : ev.thinking === true ? 'с размышлениями' : null,
          ev.effort && ev.effort !== 'default' ? `усилие ${ev.effort}` : null,
          `${(ev.tookMs / 1000).toFixed(1)} с`,
        ]
          .filter(Boolean)
          .join(' · ')
        body.push(`> **Подсказка** — ${meta}`)
        if (ev.question) body.push(`> Вопрос: ${ev.question}`)
        body.push('>')
        const text = ev.error ? `Ошибка: ${ev.error}` : ev.answer
        for (const l of text.split('\n')) body.push(`> ${l}`)
        const verdict = verdicts.get(ev.at)
        if (verdict) body.push('>', ...verdictLines(verdict))
        body.push('')
      }
    }

    return head.concat(body).join('\n')
  }
}
