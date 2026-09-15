import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { isPinned, type PackAsset } from '../../shared/gpuPack.ts'
import { ZipError, inflateZipEntry, zipEntries } from '../zip.ts'

/**
 * Скачивание и установка пакета ускорения на видеокарте: помощник (zip) и модель ggml из релиза.
 *
 * 890 МБ по домашнему каналу — минуты, и обрыв посреди них обычен: Wi-Fi, сон ноутбука, выход из
 * приложения. Поэтому загрузка докачивается с места обрыва (HTTP Range), а установленным пакет
 * считается только целиком: всё скачано, размеры и sha256 совпали, архив распакован в соседний
 * временный каталог и уже потом переименован в каталог версии. Полуустановленного пакета, который
 * сайдкар попытался бы запустить, не бывает.
 *
 * Раскладка под root (%LOCALAPPDATA%\Podskazych\gpu):
 *   downloads\<ассет>.part        — скачиваемое, растёт до полного размера
 *   downloads\<ассет>.part.json   — чья это загрузка (sha256) и метка версии файла на сервере для If-Range
 *   v1.staging-<случайное>\       — собирается установка
 *   v1\ + pack.json               — установленный пакет; pack.json пишется последним
 *
 * Модуль без electron: сеть — переданный fetch (по умолчанию глобальный, с прокси приложения),
 * поэтому тест гоняет его на локальном HTTP-сервере.
 */

export class PackError extends Error {
  /** скачанное сохранено — «Докачать» продолжит с того же места */
  readonly resumable: boolean
  constructor(message: string, resumable: boolean) {
    super(message)
    this.name = 'PackError'
    this.resumable = resumable
  }
}

/** Загрузку отменили: это не сбой, и в строке настроек ошибкой не показывается. */
export class PackCancelled extends Error {
  constructor() {
    super('Загрузка отменена')
    this.name = 'PackCancelled'
  }
}

export interface PackProgress {
  phase: 'downloading' | 'verifying' | 'installing'
  doneBytes: number
  totalBytes: number
  speedBps: number | null
}

export interface InstallOptions {
  /** …\Podskazych\gpu */
  root: string
  /** каталог версии: v1 */
  version: string
  assets: readonly PackAsset[]
  /** адрес каталога ассетов релиза, с косой чертой в конце */
  baseUrl: string
  /** файлы, без которых пакет не пакет: помощник и модель */
  required: readonly string[]
  signal?: AbortSignal
  fetch?: typeof fetch
  onProgress?: (p: PackProgress) => void
  /** сколько ждать очередных байтов, прежде чем счесть соединение зависшим */
  stallMs?: number
  /** свободное место на диске с root; null — узнать не вышло, не мешаем */
  freeBytes?: (dir: string) => Promise<number | null>
}

export interface InstalledPack {
  dir: string
  installedAt: string
}

const MANIFEST = 'pack.json'
/** В архиве помощника — exe, лицензии и README. Сотни записей — это уже не наш архив. */
const ZIP_MAX_ENTRIES = 64
/** Помощник весит ~58 МБ; четверть гигабайта на запись — с запасом, но не распаковка в бесконечность. */
const ZIP_MAX_ENTRY_BYTES = 256 * 1024 * 1024
const SUMS_FILE = 'SHA256SUMS.txt'

const downloadsDir = (root: string) => join(root, 'downloads')
const partOf = (root: string, name: string) => join(downloadsDir(root), `${name}.part`)
const metaOf = (part: string) => `${part}.json`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code

async function sizeOf(path: string): Promise<number> {
  return stat(path).then(
    (s) => s.size,
    () => 0,
  )
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

interface PartMeta {
  sha256: string
  /** сильный ETag или Last-Modified — If-Range вернёт 200 вместо 206, если файл на сервере сменился */
  validator: string | null
}

async function readMeta(part: string): Promise<PartMeta | null> {
  try {
    const m = JSON.parse(await readFile(metaOf(part), 'utf8')) as Partial<PartMeta>
    return typeof m.sha256 === 'string' ? { sha256: m.sha256, validator: typeof m.validator === 'string' ? m.validator : null } : null
  } catch {
    return null
  }
}

async function dropPart(part: string): Promise<void> {
  await rm(part, { force: true })
  await rm(metaOf(part), { force: true })
}

/**
 * Переименование с повторами. Свежезаписанный exe на Windows секунду-другую держит антивирус,
 * и rename каталога падает EPERM — через мгновение проходит.
 */
async function renameRetry(from: string, to: string, tries: number): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = errCode(e)
      if (i + 1 >= tries || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await sleep(150 * (i + 1))
    }
  }
}

/** Остаток прерванной загрузки: байты .part, которые докачаются под нынешние контрольные суммы. */
export async function partialBytes(root: string, assets: readonly PackAsset[]): Promise<number> {
  let n = 0
  for (const a of assets) {
    const part = partOf(root, a.name)
    const meta = await readMeta(part)
    if (meta?.sha256 === a.sha256) n += Math.min(await sizeOf(part), a.bytes || Infinity)
  }
  return n
}

/** Выбросить прерванную загрузку — по «Отмене»: место на диске человеку нужнее, чем докачка. */
export async function discardPartial(root: string): Promise<void> {
  await rm(downloadsDir(root), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** Хвосты оборванных установок и удалений: процесс мог умереть между шагами. */
export async function sweepLeftovers(root: string, version: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[])
  for (const n of names) {
    if (n.startsWith(`${version}.staging-`) || n.startsWith(`${version}.removing-`)) {
      await rm(join(root, n), { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * Установленный пакет или null. Проверяем дёшево — манифест и размеры файлов, без sha256: хеш
 * 874 МБ на каждом старте сессии стоил бы секунду. Целостность проверена при установке, а подменённый
 * или обрезанный файл выдаст себя стартовой проверкой сайдкара.
 */
export async function readInstalled(root: string, version: string, required: readonly string[]): Promise<InstalledPack | null> {
  const dir = join(root, version)
  try {
    const m = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as {
      version?: unknown
      installedAt?: unknown
      files?: Array<{ name?: unknown; bytes?: unknown }>
    }
    if (m.version !== version || !Array.isArray(m.files)) return null
    for (const f of m.files) {
      if (typeof f.name !== 'string' || typeof f.bytes !== 'number') return null
      if ((await sizeOf(join(dir, f.name))) !== f.bytes) return null
    }
    for (const name of required) if (!m.files.some((f) => f.name === name)) return null
    return { dir, installedAt: typeof m.installedAt === 'string' ? m.installedAt : '' }
  } catch {
    return null
  }
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  // Кусками по мегабайту: хеш 874 МБ не держит main, между кусками проходят события окна.
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    if (signal?.aborted) throw new PackCancelled()
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/* ---------- загрузка ---------- */

class Meter {
  private samples: Array<[number, number]> = []
  private lastEmit = 0
  done = 0
  total: number
  private readonly emit: ((p: PackProgress) => void) | undefined

  constructor(total: number, emit: ((p: PackProgress) => void) | undefined) {
    this.total = total
    this.emit = emit
  }

  /** Байты, пришедшие из сети. */
  add(bytes: number, force = false): void {
    this.done += bytes
    const now = Date.now()
    this.samples.push([now, this.done])
    // Скорость — за последние три секунды: мгновенная скачет, средняя с начала не видит, что сеть просела.
    while (this.samples.length > 2 && now - this.samples[0]![0] > 3000) this.samples.shift()
    if (!force && now - this.lastEmit < 250) return
    this.report(now)
  }

  /**
   * Байты не из сети: скачанное в прошлый раз (докачка) или откат файла, начатого заново. В прогресс они идут
   * сразу, а в скорость — нет: прошлые замеры сдвигаются вместе со счётчиком. Иначе 300 МБ с диска после
   * «Докачать» три секунды выглядели бы как 236 МБ/с при настоящих 40.
   */
  shift(bytes: number): void {
    this.done += bytes
    for (const s of this.samples) s[1] += bytes
    this.report(Date.now())
  }

  report(now = Date.now()): void {
    this.lastEmit = now
    this.emit?.({ phase: 'downloading', doneBytes: this.done, totalBytes: this.total, speedBps: this.speed(now) })
  }

  private speed(now: number): number | null {
    const first = this.samples[0]
    if (!first || now - first[0] < 700) return null
    // Откат файла, начатого заново, shift сдвигает вместе с замерами; страховка — отрицательной скорости не показываем.
    const bps = ((this.done - first[1]) * 1000) / (now - first[0])
    return bps > 0 ? bps : null
  }
}

interface FetchCtx {
  fetch: typeof fetch
  signal?: AbortSignal
  stallMs: number
  meter: Meter
}

const CONTENT_RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i

const RESUME_DROPPED = 'Загрузка оборвалась — нажмите «Докачать», она продолжится с того же места'
const RESUME_STALLED = 'Сеть перестала отвечать — нажмите «Докачать», загрузка продолжится с того же места'

/** Кому адресована жалоба: релиз и его хранилище файлов — «GitHub», зеркало или локальный сервер — по имени. */
function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname
    return /(^|\.)(github\.com|githubusercontent\.com)$/i.test(host) ? 'GitHub' : host
  } catch {
    return 'сервером'
  }
}

/** Сильный валидатор для If-Range: слабый ETag (W/…) стандарт в If-Range не принимает. */
function validatorOf(res: Response): string | null {
  const etag = res.headers.get('etag')
  if (etag && !etag.startsWith('W/')) return etag
  return res.headers.get('last-modified')
}

async function downloadAsset(asset: PackAsset, url: string, part: string, ctx: FetchCtx): Promise<void> {
  const meta = await readMeta(part)
  if (meta?.sha256 !== asset.sha256) await dropPart(part)
  let have = await sizeOf(part)
  if (have > asset.bytes) {
    await dropPart(part)
    have = 0
  }
  ctx.meter.shift(have)
  if (have === asset.bytes) return

  // Две попытки: вторая — с нуля, если сервер отказался продолжать (файл сменился или диапазон не тот).
  for (let attempt = 0; attempt < 2; attempt++) {
    const stall = new AbortController()
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, stall.signal]) : stall.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => stall.abort(), ctx.stallMs)
    }
    /** байты, пришедшие в этой попытке: были — соединение состоялось и оборвалось, а не «не связаться» */
    let got = 0
    const failure = (e: unknown): Error => {
      if (ctx.signal?.aborted) return new PackCancelled()
      if (stall.signal.aborted) return new PackError(RESUME_STALLED, true)
      if (e instanceof PackError || e instanceof PackCancelled) return e
      const msg = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e)
      // Код ошибки у самого исключения бывает только у диска: сетевые fetch кладёт в cause. Полный диск
      // или .part, занятый антивирусом, — не повод проверять сеть.
      const code = errCode(e)
      if (code === 'ENOSPC') return new PackError('Не хватает места на диске — освободите место и нажмите «Докачать»', true)
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
        return new PackError('Файл загрузки занят другой программой, часто антивирусом, — нажмите «Докачать» чуть позже', true)
      }
      // Сырую причину undici («other side closed») — в лог: в строке настроек английский текст ничего не объясняет.
      console.warn(`[gpu] ${asset.name}: ${msg}`)
      if (got > 0) return new PackError(RESUME_DROPPED, true)
      // До первого байта: сырая причина уже в логе, в строку — понятный русский текст и что делать.
      return new PackError(`Не удалось связаться с ${hostOf(url)} — проверьте интернет или прокси и нажмите «Повторить»`, true)
    }

    const headers: Record<string, string> = {}
    const validator = have > 0 ? ((await readMeta(part))?.validator ?? null) : null
    if (have > 0) {
      headers.range = `bytes=${have}-`
      if (validator) headers['if-range'] = validator
    }

    arm()
    let res: Response
    try {
      res = await ctx.fetch(url, { headers, signal, redirect: 'follow' })
    } catch (e) {
      clearTimeout(timer)
      throw failure(e)
    }

    try {
      if (res.status === 416) {
        // Диапазон за концом файла, хотя .part короче ожидаемого: файл на сервере другой — заново.
        await res.body?.cancel().catch(() => {})
        await dropPart(part)
        ctx.meter.shift(-have)
        have = 0
        continue
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {})
        throw new PackError(`В релизе нет файла ${asset.name} (404) — пакет ещё не опубликован или переехал`, false)
      }
      if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => {})
        // По адресу ответа, а не релиза: 503 от прокси или зеркала — не вина GitHub.
        throw new PackError(`${hostOf(res.url || url)} ответил ${res.status} на загрузку ${asset.name} — попробуйте позже`, true)
      }

      let start = 0
      let total = Number(res.headers.get('content-length') ?? NaN)
      if (res.status === 206) {
        const m = CONTENT_RANGE.exec(res.headers.get('content-range') ?? '')
        if (!m || Number(m[1]) !== have) {
          // Сервер прислал не тот кусок: склеивать нельзя — начинаем файл заново.
          await res.body?.cancel().catch(() => {})
          await dropPart(part)
          ctx.meter.shift(-have)
          have = 0
          continue
        }
        start = have
        total = m[3] === '*' ? NaN : Number(m[3])
      } else if (have > 0) {
        // 200 на Range: сервер не умеет докачку или файл сменился (If-Range) — пишем с нуля.
        ctx.meter.shift(-have)
        have = 0
      }
      if (Number.isFinite(total) && total !== asset.bytes) {
        await res.body?.cancel().catch(() => {})
        await dropPart(part)
        throw new PackError(`Размер ${asset.name} на сервере не совпал с ожидаемым — файл в релизе заменён. Обновите приложение`, false)
      }

      await mkdir(dirname(part), { recursive: true })
      await writeFile(metaOf(part), JSON.stringify({ sha256: asset.sha256, validator: validatorOf(res) } satisfies PartMeta))
      const fh = await open(part, start > 0 ? 'a' : 'w')
      try {
        const reader = res.body?.getReader()
        if (!reader) throw new PackError('Пустой ответ сервера', true)
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          arm()
          if (have + value.byteLength > asset.bytes) {
            await reader.cancel().catch(() => {})
            await fh.close()
            await dropPart(part)
            throw new PackError(`${asset.name} больше ожидаемого — файл в релизе заменён. Обновите приложение`, false)
          }
          await fh.write(value)
          have += value.byteLength
          got += value.byteLength
          ctx.meter.add(value.byteLength)
        }
      } finally {
        await fh.close().catch(() => {})
      }
    } catch (e) {
      throw failure(e)
    } finally {
      clearTimeout(timer)
    }

    if (have !== asset.bytes) throw new PackError(RESUME_DROPPED, true)
    return
  }
  throw new PackError(`Сервер не отдаёт ${asset.name} целиком — попробуйте позже`, true)
}

/* ---------- установка ---------- */

/** Имя записи архива → путь внутри staging. Пути с «..», диском или от корня — отказ: архив не должен писать мимо каталога пакета. */
function entryTarget(staging: string, name: string): string | null {
  const clean = name.replace(/\\/g, '/')
  if (clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.includes('\0')) return null
  const segs = clean.split('/').filter((s, i, all) => s !== '' || i === all.length - 1)
  if (segs.some((s) => s === '..' || s === '.' || s.includes(':'))) return null
  const target = resolve(staging, ...segs)
  return target === resolve(staging) || target.startsWith(resolve(staging) + sep) ? target : null
}

const BROKEN_ZIP = 'Архив помощника повреждён — скачайте пакет заново'

async function unzipTo(zipPath: string, staging: string, signal?: AbortSignal): Promise<void> {
  const zip = await readFile(zipPath)
  try {
    for (const entry of zipEntries(zip, ZIP_MAX_ENTRIES)) {
      if (signal?.aborted) throw new PackCancelled()
      const target = entryTarget(staging, entry.name)
      if (!target) throw new PackError(BROKEN_ZIP, false)
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      const data = await inflateZipEntry(zip, entry, ZIP_MAX_ENTRY_BYTES)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
    }
  } catch (e) {
    if (e instanceof ZipError) throw new PackError(BROKEN_ZIP, false)
    throw e
  }

  // Архив несёт свои суммы файлов: сверяем распакованное — exe потом запускается.
  const sums = await readFile(join(staging, SUMS_FILE), 'utf8').catch(() => null)
  if (sums === null) return
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (!m) continue
    const target = entryTarget(staging, m[2]!)
    if (!target || (await sha256File(target, signal).catch(() => '')) !== m[1]!.toLowerCase()) {
      throw new PackError(BROKEN_ZIP, false)
    }
  }
}

/**
 * Скачать и установить пакет. Повторный вызов после обрыва докачивает, после отмены с discardPartial —
 * начинает заново. Бросает PackCancelled при отмене и PackError с причиной по-русски.
 */
export async function installPack(o: InstallOptions): Promise<InstalledPack> {
  const unpinned = o.assets.find((a) => !isPinned(a))
  if (unpinned) throw new PackError('Пакет для видеокарты ещё не закреплён в этой сборке приложения', false)
  const fetchImpl = o.fetch ?? globalThis.fetch
  const stallMs = o.stallMs ?? 30_000
  await mkdir(downloadsDir(o.root), { recursive: true })
  await sweepLeftovers(o.root, o.version)

  const total = o.assets.reduce((n, a) => n + a.bytes, 0)
  const meter = new Meter(total, o.onProgress)

  // Место — до первого байта: оборваться на 800-м мегабайте из-за полного диска обиднее всего.
  // Нужно докачать остаток, распаковать архив (exe втрое больше архива) и немного запаса.
  const free = await (o.freeBytes ?? freeBytesOf)(o.root)
  if (free !== null) {
    const need = total - (await partialBytes(o.root, o.assets)) + o.assets.filter((a) => a.unzip).reduce((n, a) => n + a.bytes * 4, 0) + 50e6
    if (free < need) {
      throw new PackError(`Не хватает места на диске: нужно ещё ${Math.ceil((need - free) / 1e6)} МБ`, true)
    }
  }

  // Архив первым: он маленький, и пропавший релиз выяснится до 874 МБ модели.
  const ordered = [...o.assets].sort((a, b) => Number(b.unzip) - Number(a.unzip))
  const ctx: FetchCtx = { fetch: fetchImpl, signal: o.signal, stallMs, meter }
  for (const a of ordered) await downloadAsset(a, o.baseUrl + a.name, partOf(o.root, a.name), ctx)
  meter.report()

  let checked = 0
  for (const a of ordered) {
    o.onProgress?.({ phase: 'verifying', doneBytes: checked, totalBytes: total, speedBps: null })
    const part = partOf(o.root, a.name)
    if ((await sha256File(part, o.signal)) !== a.sha256) {
      await dropPart(part)
      throw new PackError(`Контрольная сумма ${a.name} не совпала — файл повредился при загрузке. Скачайте заново`, false)
    }
    checked += a.bytes
  }

  o.onProgress?.({ phase: 'installing', doneBytes: total, totalBytes: total, speedBps: null })
  const dir = join(o.root, o.version)
  const staging = join(o.root, `${o.version}.staging-${randomBytes(4).toString('hex')}`)
  /** модель переносится, а не копируется: при сбое её надо вернуть в downloads, иначе 874 МБ качать заново */
  const moved: Array<[string, string]> = []
  const installedAt = new Date().toISOString()
  try {
    await mkdir(staging, { recursive: true })
    for (const a of ordered) if (a.unzip) await unzipTo(partOf(o.root, a.name), staging, o.signal)
    for (const a of ordered) {
      if (a.unzip) continue
      const to = join(staging, a.name)
      await renameRetry(partOf(o.root, a.name), to, 5)
      moved.push([to, partOf(o.root, a.name)])
    }
    for (const name of o.required) {
      if (!(await exists(join(staging, name)))) throw new PackError(`В пакете нет ${name} — скачайте пакет заново`, false)
    }
    const files = await listFiles(staging)
    await writeFile(
      join(staging, MANIFEST),
      JSON.stringify({ version: o.version, installedAt, assets: o.assets.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })), files }, null, 2),
    )
    // Каталог версии без манифеста — след сбоя прошлой установки: убираем, чтобы переименование прошло.
    if (await exists(dir)) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    await renameRetry(staging, dir, 10)
    moved.length = 0
  } catch (e) {
    for (const [from, to] of moved) await rename(from, to).catch(() => {})
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (e instanceof PackError || e instanceof PackCancelled) throw e
    throw new PackError(`Пакет не установился: ${e instanceof Error ? e.message : String(e)}`, true)
  }
  await discardPartial(o.root).catch(() => {})
  return { dir, installedAt }
}

async function listFiles(dir: string, prefix = ''): Promise<Array<{ name: string; bytes: number }>> {
  const out: Array<{ name: string; bytes: number }> = []
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...(await listFiles(join(dir, d.name), rel)))
    else if (d.isFile() && rel !== MANIFEST) out.push({ name: rel, bytes: await sizeOf(join(dir, d.name)) })
  }
  return out
}

async function freeBytesOf(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

/** Файл кэша сайдкара с итогами проверки видеокарты (sidecar/vulkan.py, GateCache). */
export const GATE_CACHE_FILE = 'vulkan-gate.json'

/**
 * Забыть итоги стартовой проверки видеокарты и флаги её сбоев (раздел gates) — после установки или удаления
 * пакета следующий старт проверяет заново. Замер процессора и суммы файлов остаются: они о другом и стоят секунд.
 * Возвращает, сколько итогов забыто.
 */
export async function forgetGateVerdicts(cacheDir: string): Promise<number> {
  const file = join(cacheDir, GATE_CACHE_FILE)
  let data: unknown
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    // Нет файла — нечего забывать; битый — сайдкар и сам считает его пустым, но и мешать ему незачем.
    if (errCode(e) === 'ENOENT') return 0
    await rm(file, { force: true })
    return 0
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 0
  const gates = (data as { gates?: unknown }).gates
  const n = gates && typeof gates === 'object' ? Object.keys(gates).length : 0
  if (n === 0) return 0
  delete (data as { gates?: unknown }).gates
  // Как у сайдкара: во временный файл и заменой — полузаписанный кэш выглядел бы пустым.
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
  await renameRetry(tmp, file, 5).catch(async (e) => {
    await rm(tmp, { force: true })
    throw e
  })
  return n
}

/**
 * Удалить пакет. Сначала каталог версии переименовывается — так недоудалённый пакет никогда не выглядит
 * установленным. Не переименовался — файлы заняты: помощник ещё работает в сессии распознавания.
 */
export async function removePack(root: string, version: string): Promise<void> {
  const dir = join(root, version)
  if (await exists(dir)) {
    const away = join(root, `${version}.removing-${randomBytes(4).toString('hex')}`)
    try {
      await renameRetry(dir, away, 4)
    } catch (e) {
      const code = errCode(e)
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        throw new PackError('Пакет занят распознаванием — остановите сессию и удалите снова', true)
      }
      throw e
    }
    await rm(away, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
  await discardPartial(root).catch(() => {})
  await sweepLeftovers(root, version)
}
