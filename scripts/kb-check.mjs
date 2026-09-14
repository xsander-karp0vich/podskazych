/**
 * Проверка встроенной базы вопросов и её паспорта.
 *
 *   node scripts/kb-check.mjs          — проверить kb/questions.jsonl и что паспорт ему соответствует
 *   node scripts/kb-check.mjs --write  — после правок базы: проверить и переписать kb/manifest.json
 *
 * База — главная копия: её правят здесь, в репозитории, и она уезжает в установщик.
 * Паспорт нужен окну настроек («982 записи · версия от 13 сентября») и чтобы сборка
 * не уехала с базой, которую правили, но не проверили.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DATA = join(ROOT, 'kb', 'questions.jsonl')
const MANIFEST = join(ROOT, 'kb', 'manifest.json')

/**
 * Ровно эти поля. Словарь распознавания берёт термины из ВСЕХ строковых полей записи
 * (src/shared/glossary.ts), поэтому лишнее поле — например, ссылки на источники — молча
 * поменяло бы словарь и определение темы, настроенные на этом наборе.
 */
const FIELDS = [
  'UID',
  'title',
  'Тема',
  'Уровень',
  'Приоритет',
  'Источников',
  'Кратко',
  'Ответ вслух',
  'Опорные пункты',
  'Код',
  'Копнут дальше',
  'Если не знаешь',
  'Поисковые формулировки',
]
/** Ключи тем — те, что знает src/shared/glossary.ts (TOPIC_LABELS). */
const TOPICS = new Set(
  'soft perf subd queries registers tasks arch exchange configs extensions meta domain forms admin skd other devops testing clientserver rls http bsp'.split(
    ' ',
  ),
)

const raw = readFileSync(DATA)
const errors = []
const uids = new Set()
let answered = 0
const lines = raw.toString('utf8').split('\n')
if (lines.at(-1) === '') lines.pop()

lines.forEach((line, i) => {
  const at = `строка ${i + 1}`
  let row
  try {
    row = JSON.parse(line)
  } catch {
    errors.push(`${at}: не JSON`)
    return
  }
  const keys = Object.keys(row)
  const missing = FIELDS.filter((f) => !(f in row))
  const extra = keys.filter((k) => !FIELDS.includes(k))
  if (missing.length) errors.push(`${at}: нет полей ${missing.join(', ')}`)
  if (extra.length) errors.push(`${at}: лишние поля ${extra.join(', ')}`)
  // UID пишется в журнал созвонов: сменить или переиспользовать его — значит испортить старые записи.
  if (!/^U\d{4}$/.test(row.UID)) errors.push(`${at}: UID «${row.UID}» не по образцу U0000`)
  else if (uids.has(row.UID)) errors.push(`${at}: UID ${row.UID} повторяется`)
  uids.add(row.UID)
  if (typeof row.title !== 'string' || !row.title.trim()) errors.push(`${at}: пустой вопрос`)
  if (!TOPICS.has(row['Тема'])) errors.push(`${at}: неизвестная тема «${row['Тема']}»`)
  if (typeof row['Источников'] !== 'number') errors.push(`${at}: «Источников» должно быть числом`)
  for (const f of FIELDS) {
    if (f !== 'Источников' && typeof row[f] !== 'string') errors.push(`${at}: «${f}» должно быть строкой`)
  }
  if (row['Кратко']) answered++
})

if (errors.length) {
  console.error(`kb: ${errors.length} ошибок\n${errors.slice(0, 30).join('\n')}`)
  process.exit(1)
}

const sha256 = createHash('sha256').update(raw).digest('hex')
let manifest = null
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch {
  /* паспорта ещё нет */
}

const summary = `${lines.length} записей, с ответом ${answered}, ${(raw.length / 1e6).toFixed(1)} МБ`

if (process.argv.includes('--write')) {
  const changed = manifest?.sha256 !== sha256
  const next = {
    name: 'Вопросы с собеседования 1С',
    // Версия — дата последней правки содержимого: переписываем, только если база изменилась.
    version: changed ? new Date().toISOString().slice(0, 10) : manifest.version,
    rows: lines.length,
    answered,
    bytes: raw.length,
    sha256,
  }
  writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`kb: ${summary} · паспорт ${changed ? `обновлён, версия ${next.version}` : 'без изменений'}`)
} else if (!manifest || manifest.sha256 !== sha256 || manifest.rows !== lines.length) {
  console.error(`kb: ${summary} · паспорт не совпадает с базой — запустите node scripts/kb-check.mjs --write`)
  process.exit(1)
} else {
  console.log(`kb: ${summary} · версия ${manifest.version} · ок`)
}
