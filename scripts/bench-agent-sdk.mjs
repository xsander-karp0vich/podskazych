/**
 * Замер: сколько стоит подсказка через живую сессию Claude Code.
 *
 * Смысл в том, чтобы НЕ поднимать процесс на каждый вопрос — терминал этого
 * не делает, и мы не будем. Держим одну сессию и шлём в неё вопросы подряд.
 * Меряем два числа: до первого текста (его видит пользователь) и до конца.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const SYSTEM = `Ты суфлёр на рабочем созвоне по 1С. Отвечай 3-4 короткими тезисами,
без вступлений и без вопросов в ответ. Пользователь читает это вслух.`

const QUESTIONS = [
  'Собеседник спросил: регистр накопления у вас на остатках или на оборотах?',
  'Собеседник спросил: а почему выбрали план обмена, а не HTTP-сервис?',
  'Собеседник спросил: сколько времени занимает перепроведение за месяц?',
]

// Очередь вопросов: SDK читает из неё, сессия при этом живёт.
let push
const queue = []
const waiting = []
function enqueue(text) {
  const msg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  }
  if (waiting.length) waiting.shift()(msg)
  else queue.push(msg)
}
async function* prompts() {
  while (true) {
    const msg = queue.length ? queue.shift() : await new Promise((r) => waiting.push(r))
    if (msg === null) return
    yield msg
  }
}

const t0 = Date.now()
const session = query({
  prompt: prompts(),
  options: {
    systemPrompt: SYSTEM,
    // Всё лишнее выключено: инструменты, MCP, настройки проекта и CLAUDE.md.
    // Суфлёру нужен только текст, а каждый пункт — это секунды на старте.
    allowedTools: [],
    mcpServers: {},
    settingSources: [],
    permissionMode: 'bypassPermissions',
    maxTurns: 1,
    includePartialMessages: true,
  },
})

let idx = -1
let askedAt = 0
let firstTextAt = 0
let answer = ''
const results = []

enqueue(QUESTIONS[0])
idx = 0
askedAt = Date.now()
console.log(`[${QUESTIONS[0].slice(0, 60)}…]`)

for await (const ev of session) {
  if (ev.type === 'stream_event' && !firstTextAt) {
    const d = ev.event?.delta
    if (d?.type === 'text_delta' && d.text) firstTextAt = Date.now()
  }

  if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text') answer += b.text
    }
  }

  if (ev.type === 'result') {
    const total = Date.now() - askedAt
    results.push({
      n: idx + 1,
      first: firstTextAt ? firstTextAt - askedAt : null,
      total,
      api: ev.duration_api_ms ?? null,
      chars: answer.length,
    })
    console.log(
      `  первый текст: ${firstTextAt ? firstTextAt - askedAt : '—'} мс | целиком: ${total} мс | символов: ${answer.length}`,
    )
    console.log(`  ${answer.slice(0, 160).replace(/\n/g, ' ')}…\n`)

    idx++
    if (idx >= QUESTIONS.length) break
    answer = ''
    firstTextAt = 0
    askedAt = Date.now()
    console.log(`[${QUESTIONS[idx].slice(0, 60)}…]`)
    enqueue(QUESTIONS[idx])
  }
}

console.log('=== итог ===')
console.log(`старт сессии + первый вопрос: ${results[0]?.total} мс`)
const warm = results.slice(1)
if (warm.length) {
  const avgFirst = Math.round(warm.reduce((s, r) => s + (r.first ?? 0), 0) / warm.length)
  const avgTotal = Math.round(warm.reduce((s, r) => s + r.total, 0) / warm.length)
  console.log(`последующие вопросы: первый текст ~${avgFirst} мс, целиком ~${avgTotal} мс`)
}
console.log(`всего за прогон: ${Date.now() - t0} мс`)
process.exit(0)
