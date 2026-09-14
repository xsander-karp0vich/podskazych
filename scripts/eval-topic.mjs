/**
 * Точность определения темы разговора — на базе, где ответ известен.
 *
 * У каждого вопроса есть «Поисковые формулировки» — так вопрос звучит у живого
 * человека — и известная «Тема». Берём формулировку как реплику, прогоняем
 * через настоящий поиск в запущенном приложении и смотрим, угадана ли тема.
 * Порог покрытия подбираем здесь, а не на глаз.
 *
 * Это верхняя оценка: формулировки из базы чище расшифровки живой речи.
 *
 * Запуск: приложение с --remote-debugging-port=<порт>, затем
 *   node scripts/eval-topic.mjs <порт> <снимок.jsonl> <отчёт.txt>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [port, snap, reportPath] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rows = readFileSync(snap, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

// Каждая третья строка: ~330 запросов, все темы представлены пропорционально.
const cases = rows
  .filter((_, i) => i % 3 === 0)
  .map((r) => ({
    topic: r['Тема'],
    query: String(r['Поисковые формулировки'] ?? '').split(';')[0].trim(),
  }))
  .filter((c) => c.topic && c.query.length >= 12)

// Окно появляется не сразу: ждём, пока отладочный порт отдаст страницу.
let page = null
for (let i = 0; i < 60 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    page = list.find((t) => t.type === 'page') ?? null
  } catch {
    /* порт ещё не поднялся */
  }
  if (!page) await sleep(1000)
}
if (!page) {
  console.log('страница приложения не появилась за 60 с')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

let seq = 0
const evaluate = (expression) =>
  new Promise((resolve) => {
    const id = ++seq
    const onMsg = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      ws.removeEventListener('message', onMsg)
      resolve(m.result?.result?.value)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })

// Снимок базы грузится в фоне после старта окна. Без этого ожидания замер
// отработал бы на пустом индексе и выдал бы бессмысленные нули.
let ready = false
for (let i = 0; i < 120 && !ready; i++) {
  const n = await evaluate(
    "window.copilot ? window.copilot.searchKb('регистр сведений', 1).then((r) => r.hits.length).catch(() => 0) : 0",
  )
  if (n > 0) ready = true
  else await sleep(1000)
}
if (!ready) {
  console.log('индекс базы не загрузился за 120 с')
  ws.close()
  process.exit(1)
}

const results = await evaluate(`(async () => {
  const qs = ${JSON.stringify(cases.map((c) => c.query))}
  const out = []
  for (const q of qs) {
    const r = await window.copilot.searchKb(q, 5)
    out.push(r.hits.map((h) => [h.topic, h.score, h.coverage]))
  }
  return out
})()`)
ws.close()

const vote = (hits, minCov) => {
  const w = new Map()
  for (const [topic, score, cov] of hits) {
    if (!topic || cov < minCov) continue
    w.set(topic, (w.get(topic) ?? 0) + score)
  }
  return [...w].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—')
const lines = [`запросов: ${cases.length} (формулировки из базы — верхняя оценка)`, '']
lines.push('порог покрытия | ответил | угадал из ответивших | угадал из всех')
for (const minCov of [0, 0.2, 0.3, 0.4, 0.5, 0.6]) {
  let answered = 0
  let right = 0
  cases.forEach((c, i) => {
    const t = vote(results[i] ?? [], minCov)
    if (t === null) return
    answered++
    if (t === c.topic) right++
  })
  lines.push(
    `${String(minCov).padEnd(14)} | ${pct(answered, cases.length).padEnd(7)} | ${pct(right, answered).padEnd(20)} | ${pct(right, cases.length)}`,
  )
}

// Где путается — при пороге, который стоит в приложении.
const confusion = new Map()
cases.forEach((c, i) => {
  const t = vote(results[i] ?? [], 0.3)
  if (t && t !== c.topic) {
    const k = `${c.topic} → ${t}`
    confusion.set(k, (confusion.get(k) ?? 0) + 1)
  }
})
lines.push('', 'частые путаницы при пороге 0.3:')
for (const [k, n] of [...confusion].sort((a, b) => b[1] - a[1]).slice(0, 12)) lines.push(`  ${n}  ${k}`)

writeFileSync(reportPath, lines.join('\n'), 'utf8')
console.log('готово')
