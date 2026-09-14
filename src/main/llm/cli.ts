import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import type { ImageInput, ProviderId } from './types'

/**
 * Запуск терминальных CLI провайдеров: найти, запустить, погасить, прочитать вывод.
 *
 * Windows диктует почти всё здесь:
 * - npm ставит CLI скриптами .cmd/.ps1. Node отказывается запускать .cmd без оболочки
 *   (EINVAL после CVE-2024-27980), а через оболочку командная строка ограничена
 *   8191 символом и кавычками cmd.exe. Поэтому .exe запускаем напрямую, без shell,
 *   а длинный текст (промпт, расшифровку) — только через stdin, никогда аргументом.
 * - Процесс через оболочку — это cmd.exe, и kill() гасит только его: сам CLI
 *   остаётся жить. Гасим всё дерево через taskkill /T.
 * - Приложение, запущенное из меню «Пуск», видит PATH на момент входа в Windows.
 *   CLI, поставленный минуту назад, в нём ещё нет — дочитываем PATH из реестра.
 * - Ошибки самого cmd.exe («не является внутренней или внешней командой») приходят
 *   в OEM-кодировке консоли (cp866), а не в UTF-8.
 */

export interface ResolvedCommand {
  /** полный путь к найденному файлу */
  path: string
  /** нужен ли запуск через cmd.exe (.cmd/.bat) */
  shell: boolean
  kind: 'exe' | 'cmd' | 'ps1' | 'bin'
}

const IS_WIN = process.platform === 'win32'
/** .exe первым: он запускается без оболочки. .ps1 — последним: только через powershell. */
const WIN_EXTS: Array<[string, ResolvedCommand['kind']]> = [
  ['.exe', 'exe'],
  ['.cmd', 'cmd'],
  ['.bat', 'cmd'],
  ['.ps1', 'ps1'],
]

/* ---------- PATH ---------- */

let freshPathCache: { at: number; dirs: string[] } | null = null

function expandEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (process.env[key] ?? whole) : whole
  })
}

function regPath(key: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', key, '/v', 'Path'],
      { windowsHide: true, timeout: 3000, encoding: 'buffer' },
      (err, stdout) => {
        if (err) return resolve([])
        const line = decodeConsole(stdout as Buffer)
          .split(/\r?\n/)
          .find((l) => /^\s*Path\s+REG_/i.test(l))
        const value = line?.replace(/^\s*Path\s+REG_\w+\s+/i, '') ?? ''
        resolve(splitPath(expandEnv(value)))
      },
    )
  })
}

function splitPath(value: string | undefined): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

function envPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
}

/**
 * Папки PATH: текущего процесса и свежие из реестра (пользователь и система).
 * Кэш на 30 с: проверка шести провайдеров подряд не должна шесть раз читать реестр.
 */
export async function pathDirs(): Promise<string[]> {
  const own = splitPath(process.env[envPathKey(process.env)])
  if (!IS_WIN) return own
  if (!freshPathCache || Date.now() - freshPathCache.at > 30_000) {
    const [user, system] = await Promise.all([
      regPath('HKCU\\Environment'),
      regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
    ])
    freshPathCache = { at: Date.now(), dirs: [...system, ...user] }
  }
  return unique([...own, ...freshPathCache.dirs])
}

function unique(dirs: string[]): string[] {
  const seen = new Set<string>()
  return dirs.filter((d) => {
    const k = IS_WIN ? d.toLowerCase() : d
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Окружение для дочернего CLI: PATH дополнен свежим из реестра. Без этого npm-обёртка
 * найдётся, а `node`, который она зовёт внутри, — нет.
 */
export async function cliEnv(extra?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env, ...extra }
  const key = envPathKey(env)
  env[key] = (await pathDirs()).join(delimiter)
  return env
}

/** Папки, куда CLI ставятся мимо PATH или до перезапуска проводника. */
export function knownDirs(): string[] {
  const home = homedir()
  const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  return IS_WIN
    ? [join(roaming, 'npm'), join(local, 'Microsoft', 'WinGet', 'Links'), join(home, '.local', 'bin')]
    : [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Найти программу. names — по приоритету: ['agent', 'cursor-agent']. Имя, которое
 * совпадает с чужой программой, адаптер обязан проверить сам (`--version`): например,
 * `cursor` в PATH — лаунчер редактора Cursor, а не агент.
 * extraDirs смотрим после PATH. null — не нашли.
 */
export async function resolveCommand(names: string[], extraDirs: string[] = []): Promise<ResolvedCommand | null> {
  const dirs = unique([...(await pathDirs()), ...extraDirs, ...knownDirs()])
  for (const name of names) {
    if (isAbsolute(name)) {
      const hit = await probe(name)
      if (hit) return hit
      continue
    }
    for (const dir of dirs) {
      const hit = await probe(join(dir, name))
      if (hit) return hit
    }
  }
  return null
}

async function probe(base: string): Promise<ResolvedCommand | null> {
  if (!IS_WIN) return (await isFile(base)) ? { path: base, shell: false, kind: 'bin' } : null
  const lower = base.toLowerCase()
  const own = WIN_EXTS.find(([ext]) => lower.endsWith(ext))
  if (own) return (await isFile(base)) ? { path: base, shell: own[1] === 'cmd', kind: own[1] } : null
  for (const [ext, kind] of WIN_EXTS) {
    const p = base + ext
    if (await isFile(p)) return { path: p, shell: kind === 'cmd', kind }
  }
  return null
}

/* ---------- запуск ---------- */

/**
 * Аргумент для cmd.exe. Кавычки — по правилам разбора командной строки программ
 * (MSVCRT), которые npm-обёртки передают дальше через %*. Свободный текст так
 * передавать нельзя: cmd раскрывает %ПЕРЕМЕННЫЕ% и внутри кавычек. Только флаги и пути.
 */
function quoteForCmd(arg: string): string {
  if (arg && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

export interface SpawnCliOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Запустить CLI с открытыми stdin/stdout/stderr. Окно консоли не показывается.
 * .ps1 — через powershell с политикой Bypass только для этого процесса: так npm-обёртки
 * и сами запускают свои скрипты, системную политику это не меняет.
 */
export function spawnCli(cmd: ResolvedCommand, args: string[], opts: SpawnCliOptions = {}): ChildProcess {
  const base = { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true }
  if (cmd.kind === 'ps1') {
    return spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', cmd.path, ...args],
      base,
    )
  }
  // Командную строку для cmd.exe собираем сами одной строкой: аргументы при shell:true Node
  // не экранирует, а просто склеивает (и предупреждает об этом, DEP0190).
  if (cmd.shell) return spawn([cmd.path, ...args].map(quoteForCmd).join(' '), { ...base, shell: true })
  return spawn(cmd.path, args, base)
}

/** Погасить процесс со всем деревом: через оболочку kill() гасит только cmd.exe. */
export function treeKill(proc: ChildProcess | null | undefined): void {
  if (!proc) return
  // Процесс уже завершился: Node закрыл его дескриптор, но pid не обнулил. Windows быстро
  // отдаёт освободившийся pid другому процессу, и taskkill /T /F по старому номеру погасил бы
  // чужое дерево. Пока выход не обработан, дескриптор открыт и pid занят — там taskkill безопасен.
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    proc.stdin?.end()
    if (IS_WIN && proc.pid) {
      execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      proc.kill()
    }
  } catch {
    /* уже завершился */
  }
}

/* ---------- вывод ---------- */

const utf8Strict = new TextDecoder('utf-8', { fatal: true })
let oemDecoder: TextDecoder | null | undefined

/**
 * Байты консоли — в текст. CLI на Node и Rust пишут UTF-8, а cmd.exe и системные
 * утилиты — в OEM-кодировке (на русской Windows cp866). Не UTF-8 — значит OEM.
 */
export function decodeConsole(buf: Buffer | Uint8Array): string {
  try {
    return utf8Strict.decode(buf)
  } catch {
    /* не UTF-8 целиком — может быть, хвост начался с середины символа */
  }
  // Хвост буфера мог начаться с середины многобайтового символа: пробуем без этих байтов.
  // Отбрасывать их сразу нельзя — в cp866 так выглядят заглавные «А»–«П».
  let start = 0
  while (start < buf.length && start < 3 && (buf[start]! & 0xc0) === 0x80) start++
  if (start > 0) {
    try {
      return utf8Strict.decode(buf.subarray(start))
    } catch {
      /* и так не UTF-8 — значит, OEM */
    }
  }
  if (oemDecoder === undefined) {
    try {
      oemDecoder = new TextDecoder('ibm866')
    } catch {
      oemDecoder = null
    }
  }
  return oemDecoder ? oemDecoder.decode(buf) : Buffer.from(buf).toString('latin1')
}

/**
 * Хвост потока (stderr) — последние max символов. Нужен для текста ошибки, когда CLI
 * падает: полный stderr копить незачем, он бывает мегабайтами.
 */
export function stderrTail(stream: Readable | null | undefined, max = 3000): () => string {
  let chunks: Buffer[] = []
  let size = 0
  stream?.on('data', (b: Buffer) => {
    chunks.push(b)
    size += b.length
    // Байт на символ бывает до четырёх: держим с запасом и режем по байтам.
    while (size > max * 4 && chunks.length > 1) size -= chunks.shift()!.length
  })
  return () => decodeConsole(Buffer.concat(chunks)).slice(-max)
}

/** Построчное чтение stdout. Строки JSONL разбирает сам адаптер. */
export function readLines(stream: Readable | null | undefined, onLine: (line: string) => void): void {
  if (!stream) return
  readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine)
}

export interface CliResult {
  /** код выхода; null — не запустился или убит по таймауту */
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** ошибка запуска (ENOENT и т.п.) */
  error?: Error
}

/**
 * Короткий запуск для проверок: `--version`, `login status`. Не бросает. По таймауту
 * гасит дерево процессов: зависшая проверка не должна копиться в фоне.
 */
export function runCli(
  cmd: ResolvedCommand,
  args: string[],
  opts: SpawnCliOptions & { timeoutMs?: number; input?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawnCli(cmd, args, opts)
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: e instanceof Error ? e : new Error(String(e)) })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    let settled = false
    const finish = (code: number | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: decodeConsole(Buffer.concat(out)), stderr: decodeConsole(Buffer.concat(err)), timedOut, error })
    }
    const timer = setTimeout(() => {
      timedOut = true
      treeKill(proc)
      finish(null)
    }, opts.timeoutMs ?? 5000)
    proc.stdout?.on('data', (b: Buffer) => out.push(b))
    proc.stderr?.on('data', (b: Buffer) => err.push(b))
    proc.on('error', (e) => finish(null, e))
    proc.on('close', (code) => finish(code))
    if (opts.input !== undefined) proc.stdin?.end(opts.input)
    else proc.stdin?.end()
  })
}

/* ---------- файлы ---------- */

const SHOTS_PREFIX = 'podskazych-shots-'

/**
 * Снимки во временные файлы — для CLI, которые берут картинку только путём (Codex
 * localImage). cleanup() обязателен после ответа: на снимке может быть что угодно.
 */
export async function writeTempImages(images: ImageInput[]): Promise<{ dir: string; paths: string[]; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), SHOTS_PREFIX))
  const paths: string[] = []
  for (const [i, img] of images.entries()) {
    const ext = /png/i.test(img.mediaType) ? 'png' : /webp/i.test(img.mediaType) ? 'webp' : /gif/i.test(img.mediaType) ? 'gif' : 'jpg'
    const p = join(dir, `shot-${i + 1}.${ext}`)
    await writeFile(p, Buffer.from(img.data, 'base64'))
    paths.push(p)
  }
  return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

/** Убрать снимки, оставшиеся от упавшего приложения: старше часа. */
export async function sweepTempImages(): Promise<void> {
  try {
    const base = tmpdir()
    for (const name of await readdir(base)) {
      if (!name.startsWith(SHOTS_PREFIX)) continue
      const p = join(base, name)
      const s = await stat(p).catch(() => null)
      if (s && Date.now() - s.mtimeMs > 3600_000) await rm(p, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    /* временная папка недоступна — чистить нечего */
  }
}

/**
 * Пустая рабочая папка провайдера в данных приложения. CLI подхватывают из рабочей
 * папки AGENTS.md, .cursor/rules, mcp.json — в пустой папке им нечего подхватить,
 * и файлы пользователя агенту не видны.
 */
export async function providerWorkDir(provider: ProviderId): Promise<string> {
  const dir = join(app.getPath('userData'), 'agents', provider)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Открыть окно терминала с командой — для входа в CLI. Команда только из каталога
 * провайдеров, не из окна: строка уходит в cmd.exe как есть.
 */
export async function openInTerminal(command: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  if (!IS_WIN) throw new Error(`Откройте терминал и выполните: ${command}`)
  // Свежий PATH: CLI, поставленный только что, иначе не нашёлся бы и в новом окне.
  const env = opts.env ?? (await cliEnv())
  return new Promise((resolve, reject) => {
    // start "" — пустой заголовок окна: иначе start принял бы первую строку в кавычках за заголовок.
    // Без /s: первая буква после /c не кавычка, и cmd не трогает кавычки внутри команды.
    const proc = spawn('cmd.exe', ['/d', '/c', `start "" cmd /k ${command}`], {
      cwd: opts.cwd ?? homedir(),
      env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      // detached уже не даёт промежуточному cmd.exe своей консоли. windowsHide тут вреден:
      // флаг скрытия окна может достаться и терминалу, который откроет start.
      windowsHide: false,
    })
    proc.once('error', reject)
    proc.once('spawn', () => {
      proc.unref()
      resolve()
    })
  })
}
