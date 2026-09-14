/**
 * Проверка одного факта: переживёт ли CLI простой на пустом stdin.
 *
 * Прогрев поднимает процесс заранее, а первый вопрос может прийти через
 * минуту. Раньше именно пустой stdin подвешивал CLI («no stdin data received
 * in 3s»), поэтому надо убедиться, что после паузы он всё ещё отвечает.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { join } from 'node:path'

const IDLE_MS = 15_000
const QUESTION = 'Чем регистр остатков отличается от оборотного?'

app.whenReady().then(() => {
  const t0 = Date.now()
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
    { shell: true, windowsHide: true, cwd: app.getPath('userData') },
  )

  let alive = true
  proc.stderr.on('data', (b) => console.log(`[cli ${((Date.now() - t0) / 1000).toFixed(1)}c] ` + b.toString().trim()))
  proc.on('error', (e) => { console.log('ОШИБКА ЗАПУСКА:', e.message); app.quit() })
  proc.on('close', (c) => {
    alive = false
    console.log(`CLI закрылся на ${((Date.now() - t0) / 1000).toFixed(1)} с, код ${c}`)
    app.quit()
  })

  let askedAt = 0
  let firstAt = 0

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let ev
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type === 'system') console.log(`[system ${((Date.now() - t0) / 1000).toFixed(1)}c] subtype=${ev.subtype}`)
    if (ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta' && !firstAt) {
      firstAt = Date.now()
      console.log(`ПЕРВЫЙ ТЕКСТ через ${firstAt - askedAt} мс после вопроса`)
    }
    if (ev.type === 'result') {
      console.log(`ЦЕЛИКОМ ${Date.now() - askedAt} мс`)
      proc.stdin.end()
      setTimeout(() => app.quit(), 500)
    }
  })

  console.log(`простаиваем ${IDLE_MS / 1000} с без единого байта в stdin…`)
  setTimeout(() => {
    if (!alive) { console.log('ВЕРДИКТ: процесс не дожил до вопроса'); return }
    console.log(`ЖИВ после простоя, шлём вопрос`)
    askedAt = Date.now()
    proc.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: QUESTION }] },
      parent_tool_use_id: null,
      session_id: '',
    }) + '\n')
  }, IDLE_MS)

  setTimeout(() => { console.log('ТАЙМАУТ'); try { proc.kill() } catch {} ; app.quit() }, 90_000)
})
