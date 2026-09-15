import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CONTEXT_ID_RE,
  CONTEXT_MAX_FILES,
  contextBlock,
  isContextId,
  type ContextFile,
} from '../../shared/contextFiles.ts'
import { extractContext } from './extract.ts'

/**
 * Где лежит текст прикреплённых файлов: <папка данных>/context/<id>.txt, UTF-8.
 *
 * Сами файлы не копируем — резюме могло лежать где угодно, и хранить его вторую копию
 * незачем: модели нужен только текст. Список и флаги живут в настройках окна, здесь — ничего,
 * кроме текста: одно место правды, и настройки не расходятся с диском.
 *
 * Путь строится только из id, прошедшего CONTEXT_ID_RE: окно присылает id, и никакая строка
 * от окна не превращается в путь для записи или удаления.
 *
 * Без electron: папка приходит снаружи, поэтому хранилище проверяется тестами на временной папке.
 */
export class ContextStore {
  readonly dir: string
  /** текст по id: читается на каждый вопрос, а с диска его хватит взять один раз */
  private readonly cache = new Map<string, string>()

  constructor(dir: string) {
    this.dir = dir
  }

  private pathOf(id: string): string {
    if (!isContextId(id)) throw new Error(`недопустимый id файла контекста: ${String(id).slice(0, 40)}`)
    return join(this.dir, `${id}.txt`)
  }

  /** Извлечь текст и сохранить. Бросает ContextError с причиной — окно покажет её в строке. */
  async add(name: string, bytes: Uint8Array): Promise<ContextFile> {
    // Из диалога приходит путь, из перетаскивания — имя. В список и в промпт — только имя.
    const base = name.split(/[\\/]/).pop()?.trim() || 'файл'
    const ex = await extractContext(base, bytes)
    const id = randomBytes(16).toString('hex')
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.pathOf(id), ex.text, 'utf8')
    this.cache.set(id, ex.text)
    return {
      id,
      name: base,
      kind: ex.kind,
      chars: ex.text.length,
      truncated: ex.truncated,
      enabled: true,
      addedAt: new Date().toISOString(),
    }
  }

  async remove(id: string): Promise<void> {
    if (!isContextId(id)) return
    this.cache.delete(id)
    await rm(this.pathOf(id), { force: true })
  }

  /** Текст файла; null — текста на диске нет (папку почистили руками). */
  async text(id: string): Promise<string | null> {
    if (!isContextId(id)) return null
    const hit = this.cache.get(id)
    if (hit !== undefined) return hit
    try {
      const text = await readFile(this.pathOf(id), 'utf8')
      this.cache.set(id, text)
      return text
    } catch {
      return null
    }
  }

  /** Какие из файлов списка потеряли текст: окно пометит их, а не будет обещать, что они уйдут в запрос. */
  async missing(ids: readonly string[]): Promise<string[]> {
    const out: string[] = []
    for (const id of ids) if ((await this.text(id)) === null) out.push(id)
    return out
  }

  /**
   * Убрать тексты, которых нет в списке: настройки сбросили, а файлы остались. Трогаем только
   * файлы вида <id>.txt — всё остальное в папке не наше.
   */
  async prune(keep: readonly string[]): Promise<number> {
    const alive = new Set(keep.filter(isContextId))
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const n of names) {
      const id = n.endsWith('.txt') ? n.slice(0, -4) : ''
      if (!CONTEXT_ID_RE.test(id) || alive.has(id)) continue
      this.cache.delete(id)
      await rm(join(this.dir, n), { force: true })
      removed++
    }
    return removed
  }

  /**
   * Блок материалов для системного промпта из того, что окно прислало включённым, по порядку.
   * Список из окна не доверенный: чужие id и лишние файлы отбрасываются, потерянный текст пропускается.
   */
  async block(raw: unknown): Promise<string> {
    if (!Array.isArray(raw)) return ''
    const files: Array<{ name: string; text: string }> = []
    for (const r of raw.slice(0, CONTEXT_MAX_FILES)) {
      const f = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
      if (!isContextId(f.id) || typeof f.name !== 'string') continue
      const text = await this.text(f.id)
      if (text) files.push({ name: f.name, text })
    }
    return contextBlock(files)
  }
}
