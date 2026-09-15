import { afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BacklogWatch,
  RECONNECTING,
  SttClient,
  healthLag,
  type SttHealth,
  type SttMessage,
} from '../src/renderer/stt/client.ts'
import type { Speaker } from '../src/shared/types.ts'

/**
 * WebSocket-заглушка: сама ничего не делает, тест открывает, роняет и присылает
 * кадры руками. Как в браузере, readyState и обработчики — единственный интерфейс.
 */
class FakeWs {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static all: FakeWs[] = []

  readonly url: string
  readyState = FakeWs.CONNECTING
  binaryType = 'blob'
  bufferedAmount = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWs.all.push(this)
  }

  get channel(): Speaker {
    return new URL(this.url).searchParams.get('ch') as Speaker
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === FakeWs.CLOSED) return
    this.readyState = FakeWs.CLOSED
    this.onclose?.({ code: 1005 })
  }

  /** сервер принял подключение */
  accept(): void {
    this.readyState = FakeWs.OPEN
    this.onopen?.()
  }

  /** сервер закрыл сокет с кодом */
  drop(code: number): void {
    this.readyState = FakeWs.CLOSED
    this.onclose?.({ code })
  }

  /** подключиться не удалось: браузер шлёт error, потом close 1006 */
  fail(): void {
    this.readyState = FakeWs.CLOSED
    this.onerror?.()
    this.onclose?.({ code: 1006 })
  }

  emit(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

const sockets = (ch: Speaker) => FakeWs.all.filter((w) => w.channel === ch)
const last = (ch: Speaker) => {
  const s = sockets(ch)
  return s[s.length - 1]!
}

const realWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeWs.all = []
  globalThis.WebSocket = FakeWs as unknown as typeof WebSocket
  mock.timers.enable({ apis: ['setTimeout'] })
})
afterEach(() => {
  mock.timers.reset()
  globalThis.WebSocket = realWebSocket
})

/** Клиент с записью всего, что он сообщил окну. */
async function connected() {
  const log = {
    messages: [] as SttMessage[],
    errors: [] as string[],
    health: [] as Array<[Speaker, SttHealth]>,
    resets: [] as Speaker[],
    restored: 0,
    hotwords: 0,
  }
  const client = new SttClient(
    1234,
    'tok',
    (m) => log.messages.push(m),
    (e) => log.errors.push(e),
    () => log.hotwords++,
    {
      onHealth: (ch, h) => log.health.push([ch, h]),
      onChannelReset: (ch) => log.resets.push(ch),
      onRestored: () => log.restored++,
    },
  )
  const ready = client.connect(['me', 'them'])
  last('me').accept()
  last('them').accept()
  await ready
  return { client, log }
}

test('stt-клиент: обрыв канала — переподключение с паузами 0,5 → 1 → 2 → 5 с, без предела попыток', async () => {
  const { log } = await connected()
  last('me').drop(1011)
  assert.deepEqual(log.resets, ['me'], 'черновик оборванного канала сбрасывается сразу')
  assert.equal(sockets('me').length, 1, 'сразу не переподключаемся')

  mock.timers.tick(499)
  assert.equal(sockets('me').length, 1)
  mock.timers.tick(1)
  assert.equal(sockets('me').length, 2, 'первая попытка через 0,5 с')

  last('me').fail()
  mock.timers.tick(999)
  assert.equal(sockets('me').length, 2)
  mock.timers.tick(1)
  assert.equal(sockets('me').length, 3, 'после неудачи — через 1 с')

  last('me').fail()
  mock.timers.tick(1999)
  assert.equal(sockets('me').length, 3)
  mock.timers.tick(1)
  assert.equal(sockets('me').length, 4, 'после второй — через 2 с')
  assert.deepEqual(log.errors, [], 'две неудачи — ещё не повод пугать')

  last('me').fail()
  assert.deepEqual(log.errors, [RECONNECTING], 'после трёх неудач подряд — сообщение')
  mock.timers.tick(4999)
  assert.equal(sockets('me').length, 4)
  mock.timers.tick(1)
  assert.equal(sockets('me').length, 5, 'дальше — раз в 5 с')

  last('me').fail()
  mock.timers.tick(5000)
  assert.equal(sockets('me').length, 6, 'попытки не кончаются')
  assert.deepEqual(log.errors, [RECONNECTING], 'сообщение один раз, а не на каждую попытку')

  last('me').accept()
  assert.equal(log.restored, 1, 'восстановление сообщается')
  assert.equal(sockets('them').length, 1, 'живой канал не трогаем')
  assert.equal(log.resets.length, 1, 'неудачные попытки черновик не сбрасывают — сбрасывать уже нечего')

  // После успеха счётчик неудач обнулён: следующий обрыв снова начинается с 0,5 с.
  last('me').drop(1006)
  mock.timers.tick(500)
  assert.equal(sockets('me').length, 7)
})

test('stt-клиент: 4002 — подключение заменено нашим же новым, переподключаться не нужно', async () => {
  const { log } = await connected()
  last('me').drop(4002)
  mock.timers.tick(30_000)
  assert.equal(sockets('me').length, 1)
  assert.deepEqual(log.errors, [])
})

test('stt-клиент: 1000 и 4001 не переподключают; на 4001 — ошибка', async () => {
  const { log } = await connected()
  last('them').drop(1000)
  last('me').drop(4001)
  mock.timers.tick(30_000)
  assert.equal(sockets('them').length, 1)
  assert.equal(sockets('me').length, 1)
  assert.deepEqual(log.errors, ['Распознавание отклонило подключение'])
})

test('stt-клиент: health уходит отдельным колбэком, а не репликой', async () => {
  const { log } = await connected()
  const h = { type: 'health', device: 'cpu', load: 0.4, backlogS: 1.5, queuedFinals: 0 }
  last('them').emit(h)
  last('me').emit(h)
  last('them').emit({ type: 'hotwords', kept: 3, total: 5, tokens: 20 })
  assert.deepEqual(log.messages, [], 'в расшифровку ничего не попало')
  assert.deepEqual(
    log.health.map(([ch, x]) => [ch, x.backlogS]),
    [
      ['them', 1.5],
      ['me', 1.5],
    ],
  )
  assert.equal(log.hotwords, 1)
})

test('stt-клиент: пустой final доходит до окна — по нему убирается черновик', async () => {
  const { log } = await connected()
  last('me').emit({ type: 'partial', channel: 'me', text: 'Вот нач', startMs: 0 })
  last('me').emit({ type: 'final', channel: 'me', text: '', startMs: 0 })
  assert.deepEqual(
    log.messages.map((m) => [m.type, m.text]),
    [
      ['partial', 'Вот нач'],
      ['final', ''],
    ],
  )
})

test('stt-клиент: кадры до первого открытия досылаются, а после обрыва — выбрасываются', async () => {
  const client = new SttClient(1234, 'tok', () => {}, () => {})
  const ready = client.connect(['me'])
  const pcm = (n: number) => new Uint8Array([n]).buffer
  client.send('me', pcm(1))
  client.send('me', pcm(2))
  last('me').accept()
  await ready
  assert.equal(last('me').sent.length, 2, 'начало речи до открытия сокета не теряется')

  last('me').drop(1011)
  client.send('me', pcm(3))
  client.send('me', pcm(4))
  mock.timers.tick(500)
  last('me').accept()
  assert.deepEqual(last('me').sent, [], 'старый звук после обрыва не досылается')

  client.send('me', pcm(5))
  assert.equal(last('me').sent.length, 1, 'новый звук идёт в новый сокет')
})

test('stt-клиент: словарь после переподключения — только по каналу собеседника', async () => {
  const { client } = await connected()
  client.sendHotwords(['1С', 'СКД'])
  assert.equal(last('them').sent.length, 1)

  last('me').drop(1011)
  mock.timers.tick(500)
  last('me').accept()
  assert.deepEqual(last('me').sent, [], 'по микрофону словарь не повторяем')

  last('them').drop(1011)
  mock.timers.tick(500)
  last('them').accept()
  assert.equal(last('them').sent.length, 1, 'новый сокет собеседника получает словарь заново')
})

test('stt-клиент: close() отменяет запланированное переподключение', async () => {
  const { client, log } = await connected()
  last('me').drop(1011)
  last('them').drop(1011)
  client.close()
  mock.timers.tick(60_000)
  assert.equal(sockets('me').length, 1)
  assert.equal(sockets('them').length, 1)
  assert.deepEqual(log.errors, [])
})

test('stt-клиент: close() во время попытки — её закрытие не планирует новую', async () => {
  const { client } = await connected()
  last('me').drop(1011)
  mock.timers.tick(500)
  assert.equal(sockets('me').length, 2)
  client.close()
  mock.timers.tick(60_000)
  assert.equal(sockets('me').length, 2)
  assert.equal(last('me').readyState, FakeWs.CLOSED, 'подключающийся сокет закрыт')
})

test('stt-клиент: ошибка после открытия — не «не удалось подключиться»', async () => {
  const { log } = await connected()
  last('me').fail()
  assert.deepEqual(log.errors, [])
  assert.deepEqual(log.resets, ['me'])
})

test('stt-клиент: не открылся при старте — ошибка и отказ connect, без фоновых попыток', async () => {
  const errors: string[] = []
  const client = new SttClient(1234, 'tok', () => {}, (e) => errors.push(e))
  const ready = client.connect(['me'])
  last('me').fail()
  await assert.rejects(ready)
  assert.deepEqual(errors, ['Не удалось подключиться к распознаванию (me)'])
  mock.timers.tick(60_000)
  assert.equal(sockets('me').length, 1)
})

test('stt-клиент: поздний кадр старого сокета не попадает в расшифровку', async () => {
  const { log } = await connected()
  const old = last('me')
  old.drop(1011)
  mock.timers.tick(500)
  last('me').accept()
  old.emit({ type: 'final', channel: 'me', text: 'хвост', startMs: 0 })
  old.drop(4002)
  assert.deepEqual(log.messages, [])
  mock.timers.tick(30_000)
  assert.equal(sockets('me').length, 2)
})

test('отставание: задержка берётся из delayS, а у старого сайдкара — из объёма очереди', () => {
  const base = { type: 'health', device: 'cuda', load: 0.9, queuedFinals: 1 } as const
  assert.equal(healthLag({ ...base, backlogS: 57.3, delayS: 1.2 }), 1.2, 'длинная реплика считается — это не задержка')
  assert.equal(healthLag({ ...base, backlogS: 0, delayS: 0 }), 0)
  assert.equal(healthLag({ ...base, backlogS: 9.5 }), 9.5)
})

test('отставание: предупреждение после двух отчётов подряд выше 8 с, снимается ниже 3 с', () => {
  const w = new BacklogWatch()
  assert.equal(w.note('me', 9), null, 'один отчёт — ещё не отставание')
  assert.equal(w.note('them', 9), null, 'отчёт другого канала в тот же момент — не «подряд»')
  assert.equal(w.note('me', 12), 12)
  assert.equal(w.note('them', 5), 5, 'между порогами предупреждение держится')
  assert.equal(w.note('me', 2.9), null, 'ниже 3 с — снято')
  assert.equal(w.note('me', 9), null, 'серия началась заново')
  assert.equal(w.note('me', 4), null, 'серию прервал отчёт ниже 8 с')
  assert.equal(w.note('me', 9), null)
})
