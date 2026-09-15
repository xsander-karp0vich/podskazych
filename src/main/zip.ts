import { crc32, inflateRaw, inflateRawSync } from 'node:zlib'

/**
 * Разбор ZIP без библиотек: центральный каталог, сжатые данные записи, распаковка.
 *
 * Общий для двух мест: .docx в файлах для контекста (context/extract.ts) и пакета ускорения на
 * видеокарте (gpu/download.ts). Сообщения об ошибках у них разные — у .docx «файл повреждён или это
 * не Word», у пакета «архив повреждён», — поэтому здесь только вид поломки, а текст дают вызывающие.
 *
 * Модуль без electron: проверяется тестами под голым Node.
 */

export type ZipProblem = 'broken' | 'bomb' | 'encrypted'

export class ZipError extends Error {
  readonly problem: ZipProblem
  constructor(problem: ZipProblem) {
    super(`zip: ${problem}`)
    this.name = 'ZipError'
    this.problem = problem
  }
}

export interface ZipEntry {
  name: string
  flags: number
  /** 0 — без сжатия, 8 — deflate */
  method: number
  compressedSize: number
  /** распакованный размер, как его заявил каталог: может врать, поэтому выход всё равно ограничен */
  size: number
  crc32: number
  localOffset: number
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/**
 * Записи по центральному каталогу, а не по локальным заголовкам: размеры в локальном заголовке
 * бывают нулями (дескриптор данных после записи), в каталоге — всегда верные.
 *
 * Генератор, а не массив: .docx ищет одну запись и дальше каталог не читает — битая запись после
 * нужной не должна отказывать документу, который раньше открывался.
 */
export function* zipEntries(zip: Buffer, maxEntries: number): Generator<ZipEntry> {
  if (zip.length < 22) throw new ZipError('broken')
  // Конец каталога — последние 22 байта плюс комментарий архива до 65 535 байт.
  let eocd = -1
  for (let i = zip.length - 22, min = Math.max(0, zip.length - 22 - 0xffff); i >= min; i--) {
    if (zip.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('broken')
  const total = zip.readUInt16LE(eocd + 10)
  const cdOffset = zip.readUInt32LE(eocd + 16)
  // ZIP64 не разбираем: ни Word, ни сборка пакета его не пишут — архивы меньше 4 ГБ.
  if (total === 0xffff || cdOffset === 0xffffffff) throw new ZipError('broken')
  if (total > maxEntries) throw new ZipError('bomb')

  let p = cdOffset
  for (let i = 0; i < total; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('broken')
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const entry: ZipEntry = {
      name: zip.toString('utf8', p + 46, Math.min(zip.length, p + 46 + nameLen)),
      flags: zip.readUInt16LE(p + 8),
      method: zip.readUInt16LE(p + 10),
      crc32: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      localOffset: zip.readUInt32LE(p + 42),
    }
    p += 46 + nameLen + extraLen + commentLen
    yield entry
  }
}

/** Сжатые байты записи — сразу за её локальным заголовком. Проверки те же, что были у чтения .docx. */
function entryBody(zip: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.flags & 1) throw new ZipError('encrypted')
  if (entry.size > maxBytes) throw new ZipError('bomb')
  const local = entry.localOffset
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== SIG_LOCAL) throw new ZipError('broken')
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
  if (start + entry.compressedSize > zip.length) throw new ZipError('broken')
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError('broken')
  return zip.subarray(start, start + entry.compressedSize)
}

function inflateProblem(e: unknown): ZipError {
  const code = (e as { code?: unknown }).code
  return new ZipError(e instanceof RangeError || code === 'ERR_BUFFER_TOO_LARGE' ? 'bomb' : 'broken')
}

/**
 * Распаковать запись синхронно — для маленьких частей .docx. Выход ограничен maxBytes:
 * размер из каталога может врать, а сотня килобайт, распаковывающаяся в гигабайты, уронила бы main.
 */
export function inflateZipEntrySync(zip: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const data = entryBody(zip, entry, maxBytes)
  if (entry.method === 0) return Buffer.from(data)
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes })
  } catch (e) {
    throw inflateProblem(e)
  }
}

/**
 * То же в пуле потоков zlib — для десятков мегабайт (исполняемый файл пакета): синхронная распаковка
 * держала бы main, и панель замирала бы на время установки. Здесь же сверяется CRC: у .docx его
 * не проверяли никогда, а для программы, которую потом запустим, битый байт недопустим.
 */
export async function inflateZipEntry(zip: Buffer, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
  const data = entryBody(zip, entry, maxBytes)
  const out =
    entry.method === 0
      ? Buffer.from(data)
      : await new Promise<Buffer>((resolve, reject) => {
          inflateRaw(data, { maxOutputLength: maxBytes }, (err, res) => (err ? reject(inflateProblem(err)) : resolve(res)))
        })
  if (out.length !== entry.size || crc32(out) >>> 0 !== entry.crc32 >>> 0) throw new ZipError('broken')
  return out
}
