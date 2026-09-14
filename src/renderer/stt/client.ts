import type { Speaker } from '@shared/types'

export interface SttMessage {
  type: 'partial' | 'final' | 'level'
  channel: Speaker
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

/**
 * Один WebSocket на говорящего. Канал 'me' шлёт микрофонный PCM и получает
 * результаты; канал 'them' только слушает — системный звук сайдкар
 * захватывает сам через WASAPI.
 */
export class SttClient {
  private sockets = new Map<Speaker, WebSocket>()
  private queues = new Map<Speaker, ArrayBuffer[]>()
  /**
   * Последний словарь. Помним его, чтобы отправить, как только откроется
   * соединение: окно может собрать словарь раньше, чем сайдкар примет подключение.
   */
  private terms: string[] | null = null

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly onMessage: (m: SttMessage) => void,
    private readonly onError: (e: string) => void,
    private readonly onHotwords?: (info: HotwordsInfo) => void,
  ) {}

  async connect(speakers: Speaker[] = ['me', 'them']): Promise<void> {
    await Promise.all(speakers.map((s) => this.open(s)))
  }

  private open(speaker: Speaker): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/?ch=${speaker}&token=${this.token}`)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        this.sockets.set(speaker, ws)
        const q = this.queues.get(speaker)
        if (q) {
          for (const buf of q) ws.send(buf)
          q.length = 0
        }
        if (speaker === 'them' && this.terms) this.flushTerms()
        resolve()
      }
      ws.onmessage = (e) => {
        let data: unknown
        try {
          data = JSON.parse(e.data as string)
        } catch {
          return // мусорный кадр игнорируем
        }
        // Подтверждение словаря — не реплика. Отдай его в обработчик
        // расшифровки, и тот упадёт на пустом тексте.
        if ((data as { type?: string }).type === 'hotwords') {
          this.onHotwords?.(data as HotwordsInfo)
          return
        }
        this.onMessage(data as SttMessage)
      }
      ws.onerror = () => {
        this.onError(`Не удалось подключиться к распознаванию (${speaker})`)
        reject(new Error(`ws ${speaker}`))
      }
      ws.onclose = (ev) => {
        this.sockets.delete(speaker)
        if (ev.code === 4001) this.onError('Распознавание отклонило подключение')
      }
    })
  }

  send(speaker: Speaker, pcm: ArrayBuffer): void {
    const ws = this.sockets.get(speaker)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
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
    const ws = this.sockets.get('them') ?? this.sockets.get('me')
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.terms) return
    ws.send(JSON.stringify({ type: 'hotwords', terms: this.terms }))
  }

  close(): void {
    for (const [, ws] of this.sockets) ws.close()
    this.sockets.clear()
    this.queues.clear()
    this.terms = null
  }
}
