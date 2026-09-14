/**
 * Сетка «модель × размышления» на живой сессии.
 *
 * Меряем ровно то, что видит человек на созвоне: сколько ждать до первого
 * слова и сколько до конца ответа. Прогрев считается отдельно — он платится
 * до созвона и в ожидание не входит.
 *
 * Запуски строго по одному: параллельные сессии делят одну машину и один и
 * тот же CLI, и цифры перестают что-либо значить.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { join } from 'node:path'

const SYSTEM = `Ты — суфлёр на рабочем созвоне по 1С.
Дай пользователю то, что он скажет вслух своими словами.
3-5 коротких тезисов, без вступлений и встречных вопросов.
Не выдумывай цифры и названия.`

const NO_THINK_RULE = '\nНе рассуждай в ответе, сразу тезисы.'
const PRIME = 'Ответь одним словом: готов.'

const QUESTIONS = [
  'Чем регистр остатков отличается от оборотного?',
  'Почему для обмена между базами взяли план обмена, а не HTTP-сервис?',
  'Мы перепроводим документы за месяц ночью, это нормально или сигнал проблемы?',
]

const GRID = []
for (const model of ['opus', 'sonnet', 'haiku']) {
  for (const thinking of [true, false]) GRID.push({ model, thinking })
}

/** Один прогон: своя сессия, прогрев, затем вопросы по очереди. */
function run({ model, thinking }) {
  return new Promise((done) => {
    const proc = spawn(
      'claude',
      [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--strict-mcp-config',
        '--mcp-config', JSON.stringify(join(app.getAppPath(), 'no-mcp.json')),
        '--model', model,
      ],
      {
        shell: true,
        windowsHide: true,
        cwd: app.getPath('userData'),
        env: thinking ? process.env : { ...process.env, MAX_THINKING_TOKENS: '0' },
      },
    )

    const rows = []
    let idx = -1
    let askedAt = 0
    let firstAt = 0
    let thoughtAt = 0
    let acc = ''
    let failed = null

    const send = (text) => {
      askedAt = Date.now()
      firstAt = 0
      thoughtAt = 0
      acc = ''
      proc.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: '',
        }) + '\n',
      )
    }

    proc.stderr.on('data', (b) => {
      const s = b.toString().trim()
      if (s && !failed) failed = s.slice(0, 200)
    })
    proc.on('error', (e) => done({ model, thinking, error: e.message, rows }))
    proc.on('close', () => done({ model, thinking, error: rows.length ? null : failed, rows }))

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }

      if (ev.type === 'stream_event') {
        const d = ev.event?.delta
        if (d?.type === 'thinking_delta' && !thoughtAt) thoughtAt = Date.now()
        if (d?.type === 'text_delta' && d.text) {
          if (!firstAt) firstAt = Date.now()
          acc += d.text
        }
        return
      }

      if (ev.type === 'result') {
        rows.push({
          label: idx < 0 ? 'прогрев' : `вопрос ${idx + 1}`,
          first: firstAt ? firstAt - askedAt : null,
          total: Date.now() - askedAt,
          thoughtAfter: thoughtAt ? thoughtAt - askedAt : null,
          chars: acc.length,
        })
        idx++
        if (idx < QUESTIONS.length) send(QUESTIONS[idx])
        else {
          proc.stdin.end()
          setTimeout(() => done({ model, thinking, error: null, rows }), 400)
        }
      }
    })

    send(SYSTEM + (thinking ? '' : NO_THINK_RULE) + '\n\n' + PRIME)
  })
}

app.whenReady().then(async () => {
  const all = []
  for (const cell of GRID) {
    const label = `${cell.model}, размышления ${cell.thinking ? 'вкл' : 'выкл'}`
    console.log(`\n=== ${label} ===`)
    const res = await run(cell)
    if (res.error) console.log('  ОШИБКА:', res.error)
    for (const r of res.rows) {
      const think = r.thoughtAfter !== null ? `, думать начал через ${r.thoughtAfter} мс` : ''
      console.log(
        `  ${r.label}: первое слово ${r.first ?? '—'} мс, целиком ${r.total} мс, ${r.chars} симв.${think}`,
      )
    }
    all.push({ ...cell, ...res })
  }

  console.log('\n=== СВОДКА (без прогрева) ===')
  for (const r of all) {
    const q = r.rows.filter((x) => x.label !== 'прогрев')
    if (!q.length) {
      console.log(`  ${r.model} / ${r.thinking ? 'думает' : 'сразу'}: нет данных`)
      continue
    }
    const avg = (f) => Math.round(q.reduce((s, x) => s + (f(x) ?? 0), 0) / q.length)
    console.log(
      `  ${r.model.padEnd(7)} ${(r.thinking ? 'думает' : 'сразу').padEnd(7)} ` +
        `первое слово ${String(avg((x) => x.first)).padStart(6)} мс, ` +
        `целиком ${String(avg((x) => x.total)).padStart(6)} мс`,
    )
  }
  app.quit()
})
