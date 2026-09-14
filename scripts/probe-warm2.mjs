/**
 * Прогрев настоящим сообщением + попытка убрать extended thinking.
 *
 * Прошлая проба показала: пока в stdin не пришёл первый байт, CLI не делает
 * вообще ничего (system/init появился только вместе с вопросом). Значит
 * «прогрев» пустым запуском бесполезен — надо слать реальное сообщение.
 *
 * Второе: голый вопрос без системного промпта ушёл в размышления на 16 с.
 * Пробуем MAX_THINKING_TOKENS=0.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { join } from 'node:path'

const SYSTEM =
  'Ты суфлёр на рабочем созвоне по 1С. Отвечай 3-5 короткими тезисами, ' +
  'без вступлений и без встречных вопросов. Не размышляй вслух.'

const PRIME = 'Ответь одним словом: готов.'
const QUESTIONS = [
  'Чем регистр остатков отличается от оборотного?',
  'Почему план обмена, а не HTTP-сервис?',
  'Сколько занимает перепроведение за месяц?',
]

const noThink = process.env.NO_THINK === '1'

function session(label, env) {
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
      ],
      { shell: true, windowsHide: true, cwd: app.getPath('userData'), env: { ...process.env, ...env } },
    )

    let idx = -1
    let askedAt = 0
    let firstAt = 0
    let acc = ''
    let think = 0

    const send = (text, tag) => {
      askedAt = Date.now(); firstAt = 0; acc = ''; think = 0
      proc.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n')
      console.log(`\n  ${tag}`)
    }

    proc.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.log('  [cli]', s.slice(0, 200)) })
    proc.on('error', (e) => { console.log('  ОШИБКА:', e.message); done() })
    proc.on('close', () => done())

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev
      try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'system' && ev.subtype === 'thinking_tokens') think++
      if (ev.type === 'stream_event') {
        const d = ev.event?.delta
        if (d?.type === 'text_delta' && d.text) {
          if (!firstAt) { firstAt = Date.now(); console.log(`    первый текст: ${firstAt - askedAt} мс`) }
          acc += d.text
        }
        return
      }
      if (ev.type === 'result') {
        console.log(`    целиком: ${Date.now() - askedAt} мс, размышлений: ${think}, символов: ${acc.length}`)
        idx++
        if (idx < QUESTIONS.length) send(QUESTIONS[idx], `[${idx + 1}/${QUESTIONS.length}] ${QUESTIONS[idx]}`)
        else { proc.stdin.end(); setTimeout(() => done(), 400) }
      }
    })

    console.log(`\n=== ${label} ===`)
    send(SYSTEM + '\n\n' + PRIME, 'прогрев: системный промпт + односложный вопрос')
  })
}

app.whenReady().then(async () => {
  await session('без MAX_THINKING_TOKENS', {})
  await session('MAX_THINKING_TOKENS=0', { MAX_THINKING_TOKENS: '0' })
  app.quit()
})
