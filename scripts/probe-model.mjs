/**
 * Сравнение моделей на одной живой сессии: первый текст и полный ответ.
 * Вопрос в том, стоит ли давать переключатель модели ради скорости.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { join } from 'node:path'

const SYSTEM =
  'Ты суфлёр на рабочем созвоне по 1С. Отвечай 3-5 короткими тезисами, ' +
  'без вступлений и без встречных вопросов. Не размышляй вслух, сразу тезисы.'
const PRIME = 'Ответь одним словом: готов.'
const QUESTIONS = [
  'Чем регистр остатков отличается от оборотного?',
  'Почему план обмена, а не HTTP-сервис?',
]

function run(model) {
  return new Promise((done) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify(join(app.getAppPath(), 'no-mcp.json')),
    ]
    if (model) args.push('--model', model)

    const proc = spawn('claude', args, {
      shell: true,
      windowsHide: true,
      cwd: app.getPath('userData'),
      env: { ...process.env, MAX_THINKING_TOKENS: '0' },
    })

    let idx = -1
    let askedAt = 0
    let firstAt = 0
    let acc = ''

    const send = (text) => {
      askedAt = Date.now(); firstAt = 0; acc = ''
      proc.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n')
    }

    proc.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.log('  [cli]', s.slice(0, 160)) })
    proc.on('error', (e) => { console.log('  ОШИБКА:', e.message); done() })
    proc.on('close', () => done())

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev
      try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'stream_event') {
        const d = ev.event?.delta
        if (d?.type === 'text_delta' && d.text) { if (!firstAt) firstAt = Date.now(); acc += d.text }
        return
      }
      if (ev.type === 'result') {
        const total = Date.now() - askedAt
        const label = idx < 0 ? 'прогрев' : `вопрос ${idx + 1}`
        console.log(`  ${label}: первый текст ${firstAt ? firstAt - askedAt : '—'} мс, целиком ${total} мс, ${acc.length} симв.`)
        idx++
        if (idx < QUESTIONS.length) send(QUESTIONS[idx])
        else { proc.stdin.end(); setTimeout(() => done(), 400) }
      }
    })

    console.log(`\n=== модель: ${model ?? 'по умолчанию'} ===`)
    send(SYSTEM + '\n\n' + PRIME)
  })
}

app.whenReady().then(async () => {
  await run(null)
  await run('haiku')
  app.quit()
})
