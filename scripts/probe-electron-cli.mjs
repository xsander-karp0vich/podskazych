/**
 * Минимальная проба: может ли Electron получить ответ от CLI Claude Code.
 *
 * Три способа подряд, каждый со своим таймаутом. Задача — найти хотя бы один
 * рабочий, а не понять, почему падают остальные.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const PROMPT = 'Ответь одним предложением: что такое регистр накопления в 1С?'
const LIMIT = 70_000

function attempt(name, cmd, args, opts) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let err = ''
    let done = false

    const finish = (verdict) => {
      if (done) return
      done = true
      const dt = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`\n=== ${name}: ${verdict} за ${dt} с ===`)
      if (out.trim()) console.log('ОТВЕТ:', out.trim().slice(0, 240))
      if (err.trim()) console.log('stderr:', err.trim().slice(0, 240))
      resolve(verdict === 'ОТВЕТИЛ')
    }

    let p
    try {
      p = spawn(cmd, args, opts)
    } catch (e) {
      err = String(e)
      return finish('НЕ ЗАПУСТИЛСЯ')
    }

    p.stdout?.on('data', (b) => { out += b.toString() })
    p.stderr?.on('data', (b) => { err += b.toString() })
    p.on('error', (e) => { err += String(e); finish('ОШИБКА ЗАПУСКА') })
    p.on('close', () => finish(out.trim() ? 'ОТВЕТИЛ' : 'ПУСТО'))

    setTimeout(() => { try { p.kill() } catch {} ; finish('ЗАВИС') }, LIMIT)
  })
}

app.whenReady().then(async () => {
  console.log('проба началась, prompt:', PROMPT)

  // 1) через оболочку — так же, как это делает терминал
  const a = await attempt(
    '1. через cmd.exe (shell)',
    'claude',
    ['-p', '"' + PROMPT + '"', '--output-format', 'text'],
    { shell: true, windowsHide: true },
  )

  // 2) напрямую бинарником из состава SDK
  const cliPath = join(app.getAppPath(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
  const b = a ? false : await attempt(
    '2. напрямую claude.exe',
    cliPath,
    ['-p', PROMPT, '--output-format', 'text'],
    { windowsHide: true },
  )

  // 3) через оболочку, но с пустым stdin (вдруг CLI ждёт ввода)
  const c = a || b ? false : await attempt(
    '3. shell + закрытый stdin',
    'claude',
    ['-p', '"' + PROMPT + '"', '--output-format', 'text'],
    { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  console.log(`\nИТОГ: shell=${a} прямой=${b} без-stdin=${c}`)
  app.quit()
})
