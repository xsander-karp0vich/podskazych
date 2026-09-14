/**
 * Проба живой сессии CLI без SDK.
 *
 * Смысл: держать один процесс и слать в него вопросы потоком. Первое сообщение
 * уходит СРАЗУ после запуска — именно его отсутствие раньше подвешивало CLI
 * («no stdin data received in 3s»).
 *
 * Меряем два числа на каждый вопрос: до первого текста и до конца.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { join } from 'node:path'

const SYSTEM =
  'Ты суфлёр на рабочем созвоне по 1С. Отвечай 2-3 короткими тезисами, ' +
  'без вступлений и без встречных вопросов.'

const QUESTIONS = [
  'Чем регистр остатков отличается от оборотного?',
  'Почему план обмена, а не HTTP-сервис?',
  'Сколько занимает перепроведение за месяц?',
]

app.whenReady().then(async () => {
  const proc = spawn(
    'claude',
    [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      // MCP-серверы стоили 4.5 с на старте — суфлёру они не нужны
      '--strict-mcp-config',
      '--mcp-config', JSON.stringify(join(app.getAppPath(), 'no-mcp.json')),
    ],
    { shell: true, windowsHide: true, cwd: app.getPath('userData') },
  )

  proc.stderr.on('data', (b) => process.stderr.write('[cli] ' + b.toString()))
  proc.on('error', (e) => { console.log('ОШИБКА ЗАПУСКА:', e.message); app.quit() })
  proc.on('close', (c) => { console.log('CLI закрылся, код', c); app.quit() })

  let idx = 0
  let askedAt = 0
  let firstAt = 0
  let acc = ''

  const send = (text) => {
    askedAt = Date.now()
    firstAt = 0
    acc = ''
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    }
    proc.stdin.write(JSON.stringify(msg) + '\n')
    console.log(`\n[${idx + 1}/${QUESTIONS.length}] ${text}`)
  }

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let ev
    try { ev = JSON.parse(line) } catch { return }

    if (ev.type === 'stream_event') {
      const d = ev.event?.delta
      if (d?.type === 'text_delta' && d.text) {
        if (!firstAt) {
          firstAt = Date.now()
          console.log(`   первый текст: ${firstAt - askedAt} мс`)
        }
        acc += d.text
      }
      return
    }

    if (ev.type === 'result') {
      console.log(`   целиком: ${Date.now() - askedAt} мс, символов: ${acc.length}`)
      console.log('   ' + acc.trim().slice(0, 120).replace(/\n/g, ' ') + '…')
      idx++
      if (idx < QUESTIONS.length) send(QUESTIONS[idx])
      else { proc.stdin.end(); setTimeout(() => app.quit(), 800) }
    }
  })

  // КЛЮЧЕВОЕ: первое сообщение уходит немедленно, CLI не остаётся без ввода
  send(SYSTEM + '\n\n' + QUESTIONS[0])

  setTimeout(() => { console.log('ТАЙМАУТ 150 с'); try { proc.kill() } catch {} ; app.quit() }, 150_000)
})
