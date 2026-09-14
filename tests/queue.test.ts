import { afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { TurnQueue } from '../src/main/llm/queue.ts'
import { CancelledError, LlmError, SkippedError, isCancelled } from '../src/main/llm/types.ts'

/** Транспорт-заглушка: записывает, что очередь с ним делала. */
function fake(opts: { sendThrows?: (q: string) => boolean } = {}) {
  const log: string[] = []
  const transport = {
    ensure: () => log.push('ensure'),
    send: (q: string) => {
      log.push(`send:${q}`)
      if (opts.sendThrows?.(q)) throw new Error(`не отправилось: ${q}`)
    },
    kill: () => log.push('kill'),
  }
  const q = new TurnQueue<string>({ provider: 'codex', label: 'Codex CLI', transport })
  return { q, log, sent: () => log.filter((l) => l.startsWith('send:')).map((l) => l.slice(5)) }
}

/** Дать отработать промисам после синхронных событий. */
const flush = () => new Promise<void>((r) => setImmediate(r))

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => mock.timers.reset())

test('очередь: по одному вопросу, следующий — после ответа', async () => {
  const { q, sent } = fake()
  const deltas: string[] = []
  const a = q.ask('a', { onDelta: (t) => deltas.push(`a:${t}`) })
  const b = q.ask('b', { onDelta: (t) => deltas.push(`b:${t}`) })
  assert.deepEqual(sent(), ['a'])
  assert.equal(q.busy, true)
  q.delta('При')
  q.delta('вет')
  q.finish()
  assert.equal(await a, 'Привет')
  assert.deepEqual(sent(), ['a', 'b'])
  q.finish('целиком')
  assert.equal(await b, 'целиком', 'без дельт — запасной текст')
  assert.deepEqual(deltas, ['a:При', 'a:вет'])
  assert.equal(q.busy, false)
})

test('очередь: новый текстовый блок отделяется пустой строкой', async () => {
  const { q } = fake()
  const a = q.ask('a', { onDelta: () => {} })
  q.blockBreak() // до текста — ничего
  q.delta('Проверю через поиск.')
  q.blockBreak()
  q.delta('ВЕРНО')
  q.finish()
  assert.equal(await a, 'Проверю через поиск.\n\nВЕРНО')
})

test('очередь: устаревший вопрос не уходит в модель', async () => {
  const { q, sent } = fake()
  const a = q.ask('a', { onDelta: () => {} })
  const stale = q.ask('old', { onDelta: () => {}, isStale: () => true })
  const c = q.ask('c', { onDelta: () => {} })
  q.finish('A')
  await assert.rejects(stale, SkippedError)
  assert.deepEqual(sent(), ['a', 'c'])
  q.finish('C')
  assert.equal(await a, 'A')
  assert.equal(await c, 'C')
})

test('очередь: onStart — когда вопрос ушёл в модель', async () => {
  const { q } = fake()
  const started: string[] = []
  const a = q.ask('a', { onDelta: () => {}, onStart: () => started.push('a') })
  const b = q.ask('b', { onDelta: () => {}, onStart: () => started.push('b') })
  assert.deepEqual(started, ['a'])
  q.finish('A')
  assert.deepEqual(started, ['a', 'b'])
  q.finish('B')
  await Promise.all([a, b])
})

test('тишина: зависший вопрос отклоняется, процесс гасится, очередь идёт дальше', async () => {
  const { q, log, sent } = fake()
  const a = q.ask('a', { onDelta: () => {} }, { silenceSec: 10 })
  const b = q.ask('b', { onDelta: () => {} })
  mock.timers.tick(9_000)
  q.activity() // признак жизни перезаводит таймер
  mock.timers.tick(9_000)
  assert.equal(log.includes('kill'), false)
  mock.timers.tick(1_000)
  const err = await a.catch((e: unknown) => e)
  assert.ok(err instanceof LlmError)
  assert.equal(err.kind, 'timeout')
  assert.match(err.message, /Codex CLI молчит дольше 10 с/)
  assert.ok(log.includes('kill'))
  assert.deepEqual(sent(), ['a', 'b'])
  q.finish('B')
  assert.equal(await b, 'B')
})

test('тишина: ждущий в очереди не обрывает идущий вопрос со своим лимитом', async () => {
  const { q, log } = fake()
  const a = q.ask('a', { onDelta: () => {} }, { silenceSec: 90 })
  const b = q.ask('b', { onDelta: () => {} }, { silenceSec: 10 })
  mock.timers.tick(10_000)
  assert.equal(log.includes('kill'), false, 'у идущего свой лимит — ждущий перезаводит таймер')
  q.finish('A')
  assert.equal(await a, 'A')
  q.finish('B')
  assert.equal(await b, 'B')
})

test('тишина: истекла у ждущего, а текущий без лимита — зависшим считается текущий', async () => {
  const { q, sent } = fake()
  const prime = q.ask('prime', { onDelta: () => {} })
  const b = q.ask('b', { onDelta: () => {} }, { silenceSec: 5 })
  mock.timers.tick(5_000)
  const err = await prime.catch((e: unknown) => e)
  assert.ok(err instanceof LlmError)
  assert.match(err.message, /зависла и перезапущена/)
  assert.deepEqual(sent(), ['prime', 'b'])
  q.finish('B')
  assert.equal(await b, 'B')
})

test('stop: отклоняет текущий и ждущие одной ошибкой', async () => {
  const { q, log } = fake()
  const a = q.ask('a', { onDelta: () => {} })
  const b = q.ask('b', { onDelta: () => {} })
  q.stop(new CancelledError())
  const [ea, eb] = await Promise.all([a.catch((e: unknown) => e), b.catch((e: unknown) => e)])
  assert.ok(isCancelled(ea) && isCancelled(eb))
  assert.ok(log.includes('kill'))
  assert.equal(q.busy, false)
})

test('reconfigure: посреди ответа перезапуск ждёт его конца', async () => {
  const { q, log } = fake()
  const a = q.ask('a', { onDelta: () => {} })
  const b = q.ask('b', { onDelta: () => {} })
  q.reconfigure(true)
  assert.equal(q.restartPending, true)
  assert.equal(log.includes('kill'), false)
  q.finish('A')
  await a
  const i = log.indexOf('kill')
  assert.ok(i > 0 && i < log.indexOf('send:b'), 'процесс гасится до отправки следующего')
  q.finish('B')
  await b
})

test('reconfigure: без ответа — перезапуск сразу; вернули как было — отложенный снимается', async () => {
  const { q, log } = fake()
  q.reconfigure(true)
  assert.equal(log.filter((l) => l === 'kill').length, 1)
  const a = q.ask('a', { onDelta: () => {} })
  q.reconfigure(true)
  q.reconfigure(false)
  q.finish('A')
  await a
  assert.equal(log.filter((l) => l === 'kill').length, 1)
})

test('warmup: повторные вызовы не множат прогревы', async () => {
  const { q, sent } = fake()
  let warm = false
  const w1 = q.warmup('prime', () => warm)
  const w2 = q.warmup('prime', () => warm)
  assert.deepEqual(sent(), ['prime'])
  q.finish('готов')
  warm = true
  await Promise.all([w1, w2])
  await q.warmup('prime', () => warm)
  assert.deepEqual(sent(), ['prime'])
})

test('send бросает — падает только этот вопрос', async () => {
  const { q, sent } = fake({ sendThrows: (x) => x === 'bad' })
  const a = q.ask('a', { onDelta: () => {} })
  const bad = q.ask('bad', { onDelta: () => {} })
  const c = q.ask('c', { onDelta: () => {} })
  q.finish('A')
  await assert.rejects(bad, /не отправилось: bad/)
  assert.deepEqual(sent(), ['a', 'bad', 'c'])
  q.finish('C')
  assert.equal(await c, 'C')
  assert.equal(await a, 'A')
})

test('failAll: процесс умер — отклоняются все', async () => {
  const { q } = fake()
  const a = q.ask('a', { onDelta: () => {} })
  const b = q.ask('b', { onDelta: () => {} })
  q.failAll(new LlmError('crashed', 'codex'))
  await assert.rejects(a, (e: unknown) => e instanceof LlmError && e.kind === 'crashed' && /Codex CLI/.test(e.message))
  await assert.rejects(b, LlmError)
  await flush()
  assert.equal(q.busy, false)
})
