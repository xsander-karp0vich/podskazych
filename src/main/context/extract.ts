import { ZipError, inflateZipEntrySync, zipEntries, type ZipProblem } from '../zip.ts'
import {
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_MAX_FILE_CHARS,
  contextKindOf,
  cutChars,
  type ContextKind,
} from '../../shared/contextFiles.ts'

/**
 * Текст из прикреплённых файлов: PDF, Word (.docx), TXT и MD.
 *
 * Word разбираем сами — .docx это ZIP с XML внутри, и ради одного файла document.xml
 * тянуть библиотеку незачем. PDF — через unpdf (pdf.js), но импорт ленивый: полтора
 * мегабайта pdf.js грузятся при первом PDF, а не при каждом запуске приложения.
 *
 * Модуль без electron: чистые функции проверяются тестами под голым Node (tests/context-files.test.ts).
 */

/** Ошибка чтения файла. message — готовая причина для строки списка, по-русски. */
export class ContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextError'
  }
}

export interface Extracted {
  kind: ContextKind
  /** нормализованный текст, не длиннее CONTEXT_MAX_FILE_CHARS */
  text: string
  truncated: boolean
}

/* ---------- нормализация ---------- */

/**
 * Переводы строк — к \n, нулевые символы — вон (их оставляют кривые экспорты, и CLI
 * обрывает на них сообщение), пустые строки подряд — не больше двух, края — без пробелов.
 * Строка из одних пробелов считается пустой: у PDF такие остаются между абзацами.
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/^[ \t\u00a0]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/* ---------- TXT и MD ---------- */

/**
 * Windows-1251, верхняя половина. Своя таблица, а не TextDecoder('windows-1251'): кодировки
 * кроме UTF-8 и UTF-16LE в TextDecoder есть только при полном ICU, и на нём не хочется
 * держать чтение старых русских заметок. 0x98 в кодировке не занят.
 */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\ufffd™љ›њќћџ\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕї'

function decodeCp1251(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    out += b < 0x80 ? String.fromCharCode(b) : b < 0xc0 ? CP1251_HIGH[b - 0x80] : String.fromCharCode(0x410 + b - 0xc0)
  }
  return out
}

/** UTF-16BE — переставить байты и прочитать как LE: LE умеет любой TextDecoder, BE — только с ICU. */
function decodeUtf16be(bytes: Uint8Array): string {
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2))
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!
    swapped[i + 1] = bytes[i]!
  }
  return new TextDecoder('utf-16le').decode(swapped)
}

/**
 * Текстовый файл. Метка порядка байтов решает сразу. Без неё — UTF-8, если файл им читается
 * без единой ошибки; иначе это почти наверняка Windows-1251: так Блокнот годами сохранял
 * русский текст, и в UTF-8 такой файл превращается в ромбики.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16be(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return decodeCp1251(bytes)
  }
}

/* ---------- DOCX: ZIP ---------- */

/** Записей в настоящем .docx — десятки. Тысячи — это уже не документ, а ловушка для разборщика. */
export const ZIP_MAX_ENTRIES = 5000
/**
 * Распакованная запись. document.xml резюме — сотни килобайт, толстой книги — единицы мегабайт.
 * Лимит держит zip-бомбу: сотня килобайт, распаковывающаяся в гигабайты, уронила бы main по памяти.
 */
export const ZIP_MAX_ENTRY_BYTES = 50 * 1024 * 1024

const BROKEN_DOCX = 'Файл повреждён или это не документ Word (.docx)'
const ZIP_BOMB = 'Файл распаковывается в слишком большой объём — похоже на повреждённый или подложный .docx'

const ZIP_TEXT: Record<ZipProblem, string> = {
  broken: BROKEN_DOCX,
  bomb: ZIP_BOMB,
  encrypted: 'Документ защищён паролем — снимите защиту в Word и добавьте файл снова',
}

/**
 * Одна запись ZIP по имени; null — записи с таким именем нет. Сам разбор каталога — общий
 * с пакетом ускорения (../zip.ts), здесь только лимиты .docx и причины по-русски для списка файлов.
 */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  try {
    for (const entry of zipEntries(zip, ZIP_MAX_ENTRIES)) {
      if (entry.name !== name) continue
      // Размер из каталога может врать: лимит на выход держит бомбу и тогда.
      return inflateZipEntrySync(zip, entry, ZIP_MAX_ENTRY_BYTES)
    }
    return null
  } catch (e) {
    if (e instanceof ZipError) throw new ContextError(ZIP_TEXT[e.problem])
    throw e
  }
}

/* ---------- DOCX: XML ---------- */

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Сущности XML: пять именованных и числовые. Незнакомую или битую оставляем как есть — текст важнее. */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e] ?? m
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    const ok = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
    return ok ? String.fromCodePoint(cp) : m
  })
}

interface XmlToken {
  cdata?: string
  close?: string
  tag?: string
  selfClose?: string
  text?: string
}

const TAG_NAME = /<(\/?)([^\s/<>]+)/y

/**
 * Лексер XML на indexOf, а не на одном глобальном регулярном выражении. Регулярка с ленивыми
 * группами на битой разметке откатывается к концу строки на каждом «<» без пары: .docx
 * в 241 байт держал main 20 секунд, и время росло в 8 раз на каждое удвоение. Здесь каждый шаг
 * сдвигает позицию за найденный конец, поэтому работа линейна при любом входе.
 * Разметка без закрывающего «>», «-->», «]]>» или «?>» дальше не читается: остаток всё равно битый.
 */
function* xmlTokens(xml: string): Generator<XmlToken> {
  const n = xml.length
  let i = 0
  while (i < n) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      yield { text: xml.slice(i) }
      return
    }
    if (lt > i) yield { text: xml.slice(i, lt) }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end === -1) return
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end === -1) return
      yield { cdata: xml.slice(lt + 9, end) }
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end === -1) return
      i = end + 2
      continue
    }
    const gt = xml.indexOf('>', lt + 1)
    if (gt === -1) return
    // Прочие <!…> (DOCTYPE) и «<» без имени тега пропускаем целиком до «>»: шаг вперёд
    // на один символ снова сканировал бы до того же «>» — квадратично на «<<<<…>».
    if (xml[lt + 1] !== '!') {
      TAG_NAME.lastIndex = lt
      const m = TAG_NAME.exec(xml)
      if (m && lt + m[0].length <= gt) {
        yield { close: m[1], tag: m[2], selfClose: xml[gt - 1] === '/' && gt - 1 > lt + 1 ? '/' : '' }
      }
    }
    i = gt + 1
  }
}

/**
 * Текст из word/document.xml. Берём только <w:t> — удалённый в режиме правок текст (<w:delText>)
 * и коды полей (<w:instrText>) в документ не входят. Абзац — перевод строки, <w:tab/> — табуляция,
 * <w:br/> и <w:cr/> — перевод строки. Таблица — строка на строку, ячейки через табуляцию:
 * так модель видит «навык — уровень» парой, а не столбиком вперемешку.
 *
 * Разбор идёт в main синхронно, поэтому время обязано расти линейно. Текст копится кусками,
 * а хвост ячейки и строки таблицы правится в последних кусках: одна растущая строка, которую
 * переписывает каждая ячейка, превращала бы в минуты документ из сотни тысяч пустых ячеек,
 * а весь такой .docx весит единицы килобайт. И дальше лимита одного файла не читаем.
 */
export function docxXmlToText(xml: string): string {
  const out: string[] = []
  /**
   * Знаков текста, не считая пробелов. Нормализация убирает только пробельное, поэтому как только
   * их больше лимита, первые CONTEXT_MAX_FILE_CHARS знаков итога уже не изменятся — остальное обрежется.
   */
  let solid = 0
  const put = (s: string) => {
    if (s) out.push(s)
  }
  /** Снять с конца пробелы (all) или одну табуляцию — глядя в последние куски, а не во весь текст. */
  const dropTail = (ch: string, all: boolean) => {
    while (out.length) {
      const last = out[out.length - 1]!
      let n = last.length
      while (n > 0 && last[n - 1] === ch) {
        n--
        if (!all) break
      }
      if (n === last.length) return
      if (n > 0) {
        out[out.length - 1] = last.slice(0, n)
        return
      }
      out.pop()
      if (!all) return
    }
  }
  let inText = false
  /** глубина ячеек таблицы: абзац внутри ячейки — пробел, иначе строка таблицы рассыпалась бы */
  let cells = 0
  /** <w:tabs> в свойствах абзаца — позиции табуляции, а не сами табуляции */
  let tabStops = 0
  /** <mc:Fallback> — запасная копия надписи для старого Word: её текст уже был в <mc:Choice> */
  let fallback = 0

  for (const { cdata, close, tag, selfClose, text } of xmlTokens(xml)) {
    if (tag === undefined) {
      if (fallback || !inText) continue
      const s = text !== undefined ? decodeXmlEntities(text) : (cdata ?? '')
      put(s)
      solid += s.replace(/[\s ]+/g, '').length
      if (solid > CONTEXT_MAX_FILE_CHARS) break
      continue
    }
    const closing = close === '/'
    const empty = selfClose === '/'
    if (tag === 'mc:Fallback') {
      if (!empty) fallback += closing ? -1 : 1
      continue
    }
    if (fallback) continue
    switch (tag) {
      case 'w:t':
        inText = !closing && !empty
        break
      case 'w:tabs':
        if (!empty) tabStops += closing ? -1 : 1
        break
      case 'w:tab':
        if (!closing && !tabStops) put('\t')
        break
      case 'w:br':
      case 'w:cr':
        if (!closing) put('\n')
        break
      case 'w:noBreakHyphen':
        if (!closing) put('-')
        break
      case 'w:p':
        if (closing || empty) put(cells > 0 ? ' ' : '\n')
        break
      case 'w:tc':
        if (empty) put('\t')
        else if (!closing) cells++
        else {
          cells = Math.max(0, cells - 1)
          dropTail(' ', true)
          put('\t')
        }
        break
      case 'w:tr':
        if (closing) {
          dropTail('\t', false)
          put('\n')
        }
        break
    }
  }
  return out.join('')
}

const DEFAULT_MAIN_PART = 'word/document.xml'

/** Значение атрибута в теге XML: в двойных или одинарных кавычках, с сущностями. */
function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? '') : undefined
}

/**
 * Имя главной части документа по _rels/.rels — туда указывает связь officeDocument. Почти всегда
 * это word/document.xml, но стандарт имени не требует: выгрузки из Word в браузере и SharePoint
 * пишут и word/document2.xml, и такой файл Word открывает. Нет связи — берём обычное имя.
 */
export function docxMainPart(rels: string | null): string {
  if (!rels) return DEFAULT_MAIN_PART
  for (const m of rels.matchAll(/<(?:[\w.-]+:)?Relationship\s([^>]*?)\/?>/g)) {
    const attrs = m[1]!
    // Тип бывает и переходного словаря (…/2006/relationships/officeDocument), и строгого (purl.oclc.org).
    if (!attrValue(attrs, 'Type')?.endsWith('/officeDocument')) continue
    if (attrValue(attrs, 'TargetMode') === 'External') continue
    let target = attrValue(attrs, 'Target')?.trim()
    if (!target) continue
    try {
      target = decodeURIComponent(target)
    } catch {
      /* кривая %-последовательность — имя как есть */
    }
    // Цель — от корня пакета: «/word/document2.xml» и «./word/document2.xml» — одна и та же запись ZIP.
    target = target.replace(/^(?:\.?\/)+/, '')
    if (target) return target
  }
  return DEFAULT_MAIN_PART
}

/** Word (.docx): ZIP, в нём главная часть — word/document.xml или то, на что указывает _rels/.rels. */
export function extractDocx(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Зашифрованный паролем .docx — вовсе не ZIP, а контейнер OLE, как старый .doc.
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new ContextError('Документ защищён паролем или это старый .doc — снимите пароль или сохраните его в Word как .docx')
  }
  const main = docxMainPart(readZipEntry(buf, '_rels/.rels')?.toString('utf8') ?? null)
  // Связь указала мимо — пробуем обычное имя: лучше прочитать документ, чем отказать из-за одной строки.
  const xml = readZipEntry(buf, main) ?? (main === DEFAULT_MAIN_PART ? null : readZipEntry(buf, DEFAULT_MAIN_PART))
  // Та же связь есть и у таблицы Excel, переименованной в .docx: без корня <w:document> это не Word,
  // и честнее сказать об этом, чем показать «в файле нет текста».
  if (!xml || !/<(?:[\w.-]+:)?document[\s>]/.test(xml.toString('utf8', 0, 4096))) throw new ContextError(BROKEN_DOCX)
  return docxXmlToText(xml.toString('utf8'))
}

/* ---------- PDF ---------- */

function pdfError(e: unknown): ContextError {
  const name = (e as { name?: unknown })?.name
  if (name === 'PasswordException') return new ContextError('PDF защищён паролем — снимите защиту и добавьте файл снова')
  if (name === 'InvalidPDFException') return new ContextError('Файл повреждён или это не PDF')
  const msg = e instanceof Error ? e.message : String(e)
  return new ContextError(`PDF не прочитался: ${msg}`)
}

/**
 * PDF: текстовый слой всех страниц, страницы — через пустую строку. У скана слоя нет,
 * и текст выйдет пустым — это не ошибка: окно покажет «похоже на скан».
 */
export async function extractPdf(bytes: Uint8Array): Promise<string> {
  // Лениво: pdf.js нужен только тем, кто прикрепляет PDF, и только в момент добавления.
  const { extractText, getDocumentProxy } = await import('unpdf')
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // Копия: pdf.js может забрать буфер себе, а он ещё нужен вызывающему.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
  } catch (e) {
    throw pdfError(e)
  }
  try {
    const { text } = await extractText(pdf, { mergePages: false })
    return text.map((page) => page.trim()).join('\n\n')
  } catch (e) {
    throw pdfError(e)
  } finally {
    // Документ держит разобранные шрифты и страницы: без этого они жили бы в main до выхода.
    void pdf.loadingTask.destroy().catch(() => {})
  }
}

/* ---------- всё вместе ---------- */

/**
 * Текст файла по его имени и содержимому. Вид — по расширению: окно фильтрует выбор по нему же,
 * а подпись в списке («PDF», «DOCX») должна совпасть с тем, что человек выбрал.
 */
export async function extractContext(name: string, bytes: Uint8Array): Promise<Extracted> {
  const kind = contextKindOf(name)
  if (kind === 'doc') throw new ContextError('Старый формат .doc не поддерживается — сохраните файл в Word как .docx')
  if (!kind) throw new ContextError('Этот формат не читается — подойдут PDF, DOCX, TXT и MD')
  if (bytes.byteLength > CONTEXT_MAX_FILE_BYTES) throw new ContextError('Файл больше 20 МБ')
  const raw = kind === 'pdf' ? await extractPdf(bytes) : kind === 'docx' ? extractDocx(bytes) : decodeText(bytes)
  const text = normalizeText(raw)
  const truncated = text.length > CONTEXT_MAX_FILE_CHARS
  return { kind, text: truncated ? cutChars(text, CONTEXT_MAX_FILE_CHARS).trimEnd() : text, truncated }
}
