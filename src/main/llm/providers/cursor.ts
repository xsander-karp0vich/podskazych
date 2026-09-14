import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCommand, runCli, type ResolvedCommand } from '../cli'
import type { Availability, ProviderAdapter } from '../types'
import { createAcpAdapter, type AcpLaunch, type AcpRuntime } from './acp'
import { parseCursorStatus, pickLatestVersionDir } from './acpProtocol'

/**
 * Cursor через Cursor Agent в режиме ACP (`agent acp`).
 *
 * Программа — `agent` или `cursor-agent`. `cursor` в PATH — лаунчер редактора, не агент:
 * его не ищем вовсе, а `agent` — слишком общее имя, чужую программу с ним не берём.
 *
 * Установка на Windows (скрипт cursor.com/install?win32=true, выпуск 2026.09.10):
 * %LOCALAPPDATA%\cursor-agent\ — лаунчеры cursor-agent.{exe,cmd,ps1} и их копии agent.*,
 * а в versions\<версия>\ — сам агент: node.exe и index.js. .exe в пакете бывает не всегда;
 * без него цепочка .cmd → PowerShell → .ps1 → node.exe. Лаунчер .ps1 в июне 2026 ломался
 * на новом формате имён папок версий («No version directories found»), и каждый его
 * запуск — лишний PowerShell. Поэтому, если .exe нет, запускаем node.exe из последней
 * версии напрямую — так же, как это делает официальный лаунчер для macOS/Linux:
 * `node --use-system-ca index.js`. Не завёлся так — возвращаемся к лаунчеру.
 *
 * Только ответы: режим ask (без него не отвечаем — сторонние замеры показали, что в
 * режиме agent Cursor правит файлы, не спрашивая разрешения), запретительные правила в
 * рабочей папке и NO_OPEN_BROWSER, чтобы проверка входа никогда не открывала браузер.
 */

const IS_WIN = process.platform === 'win32'

const installRoot = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'cursor-agent')

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** Проверенные по `--version` пути программы `agent` без «cursor» в пути. */
const verified = new Map<string, boolean>()

/** Версия Cursor Agent — дата сборки: «2026.09.10-fd3934a». */
const VERSION_RE = /\d{4}\.\d{1,2}\.\d{1,2}(?:-[\w-]+)?/

async function isCursorAgent(cmd: ResolvedCommand): Promise<boolean> {
  if (/cursor/i.test(cmd.path)) return true
  const cached = verified.get(cmd.path)
  if (cached !== undefined) return cached
  const r = await runCli(cmd, ['--version'], { timeoutMs: 4000 })
  const ok = r.code === 0 && new RegExp(`^\\s*${VERSION_RE.source}\\s*$`).test(r.stdout)
  if (!r.timedOut) verified.set(cmd.path, ok)
  return ok
}

/** Лаунчер: сначала папка установки Cursor, потом PATH. */
async function findLauncher(): Promise<ResolvedCommand | null> {
  const root = installRoot()
  // Нативный установщик на других системах и старые сборки кладут лаунчер в ~/.local/bin.
  const extra = [join(homedir(), '.local', 'bin')]
  for (const name of [join(root, 'agent'), join(root, 'cursor-agent'), 'cursor-agent', 'agent']) {
    const hit = await resolveCommand([name], extra)
    if (hit && (await isCursorAgent(hit))) return hit
  }
  return null
}

/** node.exe и index.js последней версии — рядом с лаунчером или в стандартной папке установки. */
async function bundledNode(launcher: ResolvedCommand): Promise<AcpLaunch | null> {
  if (!IS_WIN) return null
  const roots = [dirname(launcher.path), installRoot()].filter((r, i, all) => all.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i)
  for (const root of roots) {
    const versions = join(root, 'versions')
    let dirs: Array<{ name: string; mtimeMs: number }>
    try {
      const entries = await readdir(versions, { withFileTypes: true })
      dirs = await Promise.all(
        entries.filter((e) => e.isDirectory()).map(async (e) => ({ name: e.name, mtimeMs: (await stat(join(versions, e.name)).catch(() => null))?.mtimeMs ?? 0 })),
      )
    } catch {
      continue
    }
    const latest = pickLatestVersionDir(dirs)
    if (!latest) continue
    // В архиве пакета файлы лежат в dist-package (реестр ACP); установщик, по всему судя,
    // раскладывает их прямо в папку версии. Смотрим оба места.
    for (const base of [join(versions, latest), join(versions, latest, 'dist-package')]) {
      const node = join(base, 'node.exe')
      const index = join(base, 'index.js')
      if ((await isFile(node)) && (await isFile(index))) {
        return { cmd: { path: node, shell: false, kind: 'exe' }, prefix: ['--use-system-ca', index] }
      }
    }
  }
  return null
}

/** Прямой запуск node.exe не завёлся — до перезапуска приложения ходим через лаунчер. */
let directBroken = false

async function launcherOnly(): Promise<AcpLaunch | null> {
  const cmd = await findLauncher()
  return cmd ? { cmd, prefix: [] } : null
}

async function resolve(): Promise<AcpLaunch | null> {
  const launcher = await findLauncher()
  if (!launcher) return null
  if (launcher.kind === 'exe' || directBroken) return { cmd: launcher, prefix: [] }
  return (await bundledNode(launcher)) ?? { cmd: launcher, prefix: [] }
}

const isDirect = (l: AcpLaunch) => l.prefix.length > 0

/**
 * Запрет правок и команд на уровне самого Cursor — файл проекта .cursor/cli.json в
 * нашей рабочей папке (документация Cursor, CLI → Permissions; запрет сильнее разрешения).
 * Работает ли он в режиме ACP, Cursor не пишет — это ещё один слой, а не единственный.
 */
const CLI_CONFIG = `${JSON.stringify({ permissions: { deny: ['Shell(*)', 'Write(**)', 'Mcp(*:*)'] } }, null, 2)}\n`

async function prepareWorkDir(dir: string): Promise<void> {
  const file = join(dir, '.cursor', 'cli.json')
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === CLI_CONFIG) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, CLI_CONFIG, 'utf8')
}

/**
 * Установлен ли и выполнен ли вход: `agent status --format json` (флаг появился в апреле
 * 2026) и `--version` параллельно — оба холодных запуска укладываются в проверку реестра.
 */
async function detect(rt: AcpRuntime): Promise<Availability> {
  let launch = await rt.launch()
  if (!launch) return { state: 'not-installed' }
  const env = await rt.env()
  const check = (l: AcpLaunch, ms: number) => Promise.all([rt.run(l, ['status', '--format', 'json'], env, ms), rt.run(l, ['--version'], env, ms)])
  let [status, ver] = await check(launch, 4000)
  const silent = (r: typeof status) => !r.timedOut && r.code !== 0 && !r.stdout.trim()
  if (isDirect(launch) && silent(status) && silent(ver)) {
    directBroken = true
    const next = await rt.launch()
    if (next) {
      launch = next
      ;[status, ver] = await check(launch, 3500)
    }
  }
  if (status.error && (status.error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'not-installed' }
  const version = VERSION_RE.exec(ver.stdout)?.[0]
  const auth = parseCursorStatus(`${status.stdout}\n${status.stderr}`)
  if (auth === 'ok') return { state: 'ok', version }
  if (auth === 'not-logged-in') return { state: 'not-logged-in' }
  if (status.timedOut) return { state: 'unknown', message: 'Cursor Agent не ответил на проверку входа за 4 с' }
  if (ver.code === 0) return { state: 'unknown', message: 'Cursor Agent установлен, но проверить вход не удалось' }
  const tail = (status.stderr || ver.stderr || status.error?.message || '').trim().split(/\r?\n/).at(-1)?.slice(0, 300)
  return { state: 'error', message: tail || `Cursor Agent завершился с кодом ${status.code}` }
}

export function createCursorAdapter(): ProviderAdapter {
  return createAcpAdapter({
    provider: 'cursor',
    commands: ['agent', 'cursor-agent'],
    args: ['acp'],
    resolve,
    resolveLauncher: launcherOnly,
    onEarlyExit: (launch) => {
      if (!isDirect(launch)) return false
      directBroken = true
      return true
    },
    // Вход у Cursor делается в браузере. Проверка и прогрев не должны его открывать даже случайно.
    env: { NO_OPEN_BROWSER: '1' },
    prepareWorkDir,
    detect,
    // cursor_login при выполненном `agent login` только подтверждает вход; без входа — не
    // открывает браузер (NO_OPEN_BROWSER) и падает по таймауту, это и есть «нужен вход».
    silentAuthMethods: ['cursor_login'],
    requireReadOnlyMode: true,
    loginArgs: ['login'],
  })
}
