import { app } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Встроенная база вопросов с собеседования 1С.
 *
 * Лежит в репозитории (kb/questions.jsonl) и уезжает в установщик рядом с приложением:
 * у каждого пользователя она есть сразу, без сторонних сервисов и без сети. Главная копия — файл
 * в репозитории; правки проверяет и заносит в паспорт `node scripts/kb-check.mjs --write`.
 *
 * Модель в базу не ходит: main ищет по файлу сам (kb/search.ts) и подкладывает найденное
 * в запрос текстом, словарь распознавания строится из того же файла.
 */

export interface KbMeta {
  filePath: string
  rows: number
  bytes: number
  /** дата последней правки базы из паспорта, «2026-09-13»; null — паспорта нет */
  version: string | null
}

/** Папка базы: в собранном приложении — resources/kb, при разработке — kb/ в корне проекта. */
export function bundledKbDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'kb') : join(app.getAppPath(), 'kb')
}

/**
 * Найти базу и прочитать её паспорт. Ошибки не бросаются: без базы приложение обязано
 * работать — подсказки идут без неё, словарь остаётся общим.
 */
export async function readBundledKb(): Promise<KbMeta | null> {
  const dir = bundledKbDir()
  const filePath = join(dir, 'questions.jsonl')
  try {
    const { size } = await stat(filePath)
    if (!size) return null
    let rows = -1
    let version: string | null = null
    try {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { rows?: number; version?: string }
      rows = m.rows ?? -1
      version = m.version ?? null
    } catch {
      /* паспорт не обязателен: число записей возьмём из индекса */
    }
    return { filePath, rows, bytes: size, version }
  } catch (e) {
    console.warn('[kb] встроенная база не найдена:', filePath, e instanceof Error ? e.message : e)
    return null
  }
}
