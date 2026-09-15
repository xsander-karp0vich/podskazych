import type { Speaker } from '@shared/types'

export interface SttMessage {
  type: 'partial' | 'final' | 'level'
  channel: Speaker
  /** у final может быть пустым: реплика закрыта, строки нет, черновик убрать */
  text: string
  startMs?: number
  /** только для type='level': текущий уровень канала в dBFS */
  db?: number
}

/** Ответ сайдкара на словарь: сколько терминов реально влезло в бюджет. */
export interface HotwordsInfo {
  kept: number
  total: number
  tokens: number
}

/** Отчёт сайдкара о здоровье распознавания: раз в 5 с по каждому открытому сокету. */
export interface SttHealth {
  type: 'health'
  device: string
  /** доля времени, которую модель работала за последние 20 с, 0..1 */
  load: number
  /** секунды звука, ждущие финала: очередь плюс выполняемый прогон — для диагностики */
  backlogS: number
  /**
   * Сколько уже ждёт самая старая недосказанная строка, от конца её звучания.
   * Это и есть задержка, которую видит пользователь: backlogS меряет звук, и одна
   * длинная реплика, которая просто считается, показывала бы «задержку 57 с».
   * Нет у сайдкаров старше этого поля.
   */
  delayS?: number
  queuedFinals: number
}

/** Отставание из отчёта: время ожидания, если сайдкар его сообщает, иначе объём очереди. */
export function healthLag(h: SttHealth): number {
  return typeof h.delayS === 'number' ? h.delayS : h.backlogS
}

export interface SttClientEvents {
  onHealth?: (speaker: Speaker, health: SttHealth) => void
  /**
   * Канал оборвался: черновик на экране уже не закроется финалом — сайдкар
   * начнёт реплику заново на новом подключении.
   */
  onChannelReset?: (speaker: Speaker) => void
  /** Все каналы, о переподключении которых сказали, снова на связи. */
  onRestored?: () => void
}

export const RECONNECTING = 'Распознавание переподключается…'

/**
 * Паузы между попытками переподключения. Без предела попыток: пока идёт сессия
 * и жив сайдкар, голос должен вернуться сам, а не ждать «Стоп/Старт».
 */
const RETRY_MS = [500, 1000, 2000, 5000]
/** После стольких неудач подряд окно говорит, что распознавание переподключается. */
const FAILS_BEFORE_NOTICE = 3

/** Своё закрытие: 1000 — штатное, 4001 — чужой токен, 4002 — это подключение заменили новым. */
const CLOSE_NORMAL = 1000
const CLOSE_REJECTED = 4001
const CLOSE_REPLACED = 4002

/** Отставание, после которого предупреждаем (два отчёта подряд), и ниже которого снимаем. */
export const BACKLOG_WARN_S = 8
export const BACKLOG_OK_S = 3

/**
 * Предупреждение «не успевает» с гистерезисом. Один отчёт выше порога — ещё не
 * отставание: длинная реплика на мгновение даёт такую очередь и сама рассасывается.
 * Серии считаются по каналу: оба сокета присылают отчёт почти одновременно, и
 * два «подряд» из разных каналов были бы одним и тем же мгновением.
 */
export class BacklogWatch {
  private streak = new Map<Speaker, number>()
  private lagging = false

  /** Учесть отчёт. Вернёт отставание в секундах, пока предупреждение горит, иначе null. */
  note(speaker: Speaker, backlogS: number): number | null {
    if (backlogS > BACKLOG_WARN_S) {
      const n = (this.streak.get(speaker) ?? 0) + 1
      this.streak.set(speaker, n)
      if (n >= 2) this.lagging = true
    } else {
      this.streak.set(speaker, 0)
      if (backlogS < BACKLOG_OK_S) this.lagging = false
    }
    return this.lagging ? backlogS : null
  }
}

/**
 * Один WebSocket на говорящего. Канал 'me' шлёт микрофонный PCM и получает
 * результаты; канал 'them' только слушает — системный звук сайдкар
 * захватывает сам через WASAPI.
 */
export class SttClient {
  /** последний сокет канала — открытый или ещё подключающийся */
  private sockets = new Map<Speaker, WebSocket>()
  private queues = new Map<Speaker, ArrayBuffer[]>()
  /** каналы, которые хоть раз открылись: только их и переподключаем */
  private established = new Set<Speaker>()
  private timers = new Map<Speaker, ReturnType<typeof setTimeout>>()
  /** неудачные попытки переподключения подряд */
  private fails = new Map<Speaker, number>()
  /** каналы, о чьём переподключении уже сказали */
  private warned = new Set<Speaker>()
  /** close() вызван: сессия кончилась, ни одно закрытие больше не обрыв */
  private closed = false
  /**
   * Последний словарь. Помним его, чтобы отправить, как только откроется
   * соединение: окно может собрать словарь раньше, чем сайдкар примет подключение.
   */
  private terms: string[] | null = null

  // Поля объявлены явно, без параметров-свойств: тест грузит модуль голым Node,
  // а он умеет только стираемый синтаксис TypeScript.
  private readonly port: number
  private readonly token: string
  private readonly onMessage: (m: SttMessage) => void
  private readonly onError: (e: string) => void
  private readonly onHotwords?: (info: HotwordsInfo) => void
  private readonly events: SttClientEvents

  constructor(
    port: number,
    token: string,
    onMessage: (m: SttMessage) => void,
    onError: (e: string) => void,
    onHotwords?: (info: HotwordsInfo) => void,
    events: SttClientEvents = {},
  ) {
    this.port = port
    this.token = token
    this.onMessage = onMessage
    this.onError = onError
    this.onHotwords = onHotwords
    this.events = events
  }

  async connect(speakers: Speaker[] = ['me', 'them']): Promise<void> {
    await Promise.all(speakers.map((s) => this.open(s)))
  }

  private open(speaker: Speaker): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/?ch=${speaker}&token=${this.token}`)
      ws.binaryType = 'arraybuffer'
      this.sockets.set(speaker, ws)
      const again = this.established.has(speaker)
      let opened = false

      ws.onopen = () => {
        if (this.closed || this.sockets.get(speaker) !== ws) return
        opened = true
        this.established.add(speaker)
        this.fails.delete(speaker)
        const q = this.queues.get(speaker)
        this.queues.delete(speaker)
        // Накопленное до первого открытия — начало речи, его досылаем. После обрыва
        // сайдкар начинает реплику заново, и старый звук только склеился бы с новым.
        if (q && !again) for (const buf of q) ws.send(buf)
        if (speaker === 'them' && this.terms) this.flushTerms()
        if (again && this.warned.delete(speaker) && this.warned.size === 0) this.events.onRestored?.()
        resolve()
      }
      ws.onmessage = (e) => {
        // Поздний кадр старого подключения не должен мешать новому.
        if (this.sockets.get(speaker) !== ws) return
        let data: unknown
        try {
          data = JSON.parse(e.data as string)
        } catch {
          return // мусорный кадр игнорируем
        }
        const type = (data as { type?: string }).type
        // Подтверждение словаря — не реплика. Отдай его в обработчик
        // расшифровки, и тот упадёт на пустом тексте.
        if (type === 'hotwords') {
          this.onHotwords?.(data as HotwordsInfo)
          return
        }
        // Отчёт о здоровье тоже не реплика.
        if (type === 'health') {
          this.events.onHealth?.(speaker, data as SttHealth)
          return
        }
        this.onMessage(data as SttMessage)
      }
      ws.onerror = () => {
        // После открытия ошибка — это обрыв, о нём скажет onclose. Неудачную
        // попытку переподключения тоже считает onclose: «не удалось подключиться»
        // посреди созвона только пугало бы.
        if (opened || again || this.closed) return
        this.onError(`Не удалось подключиться к распознаванию (${speaker})`)
        reject(new Error(`ws ${speaker}`))
      }
      ws.onclose = (ev) => {
        if (!opened) reject(new Error(`ws ${speaker}`))
        if (this.closed || this.sockets.get(speaker) !== ws) return
        this.sockets.delete(speaker)
        if (opened) {
          this.queues.delete(speaker)
          this.events.onChannelReset?.(speaker)
        }
        if (ev.code === CLOSE_REJECTED) {
          this.onError('Распознавание отклонило подключение')
          return
        }
        // Не открылся при старте — об этом уже сказал onerror, а «Старт» разберётся сам.
        if (!this.established.has(speaker)) return
        // 4002: сайдкар принял наше же новое подключение, переподключаться незачем.
        if (ev.code === CLOSE_NORMAL || ev.code === CLOSE_REPLACED) return
        this.retry(speaker, !opened)
      }
    })
  }

  private retry(speaker: Speaker, failed: boolean): void {
    let n = this.fails.get(speaker) ?? 0
    if (failed) {
      n += 1
      this.fails.set(speaker, n)
      if (n === FAILS_BEFORE_NOTICE) {
        const first = this.warned.size === 0
        this.warned.add(speaker)
        if (first) this.onError(RECONNECTING)
      }
    }
    const delay = RETRY_MS[Math.min(n, RETRY_MS.length - 1)] ?? 5000
    clearTimeout(this.timers.get(speaker))
    this.timers.set(
      speaker,
      setTimeout(() => {
        this.timers.delete(speaker)
        if (!this.closed) this.open(speaker).catch(() => {})
      }, delay),
    )
  }

  send(speaker: Speaker, pcm: ArrayBuffer): void {
    const ws = this.sockets.get(speaker)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Канал уже работал и сейчас переподключается: этот звук сайдкар всё равно
      // не склеит с новой репликой, копить его незачем.
      if (this.closed || this.established.has(speaker)) return
      const q = this.queues.get(speaker) ?? []
      if (q.length < 40) q.push(pcm) // ~2 секунды, дальше просроченное аудио бесполезно
      this.queues.set(speaker, q)
      return
    }
    // Бэкпрешер: копить отставание бессмысленно, оно уже не догонит.
    if (ws.bufferedAmount > 200_000) return
    ws.send(pcm)
  }

  /**
   * Словарь распознавания по приоритету. Сайдкар уложит его в бюджет и
   * ответит, сколько влезло. Шлём по одному каналу: распознаватель у обоих
   * общий, а два подтверждения подряд только путали бы счётчик.
   */
  sendHotwords(terms: string[]): void {
    this.terms = terms
    this.flushTerms()
  }

  private flushTerms(): void {
    const open = (s: Speaker) => {
      const ws = this.sockets.get(s)
      return ws && ws.readyState === WebSocket.OPEN ? ws : undefined
    }
    const ws = open('them') ?? open('me')
    if (!ws || !this.terms) return
    ws.send(JSON.stringify({ type: 'hotwords', terms: this.terms }))
  }

  close(): void {
    this.closed = true
    for (const [, t] of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const [, ws] of this.sockets) ws.close()
    this.sockets.clear()
    this.queues.clear()
    this.fails.clear()
    this.warned.clear()
    this.terms = null
  }
}
