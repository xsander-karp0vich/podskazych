/**
 * Собранные словари по всем темам — ровно то, что окно отправит распознавателю.
 * Нужен опыту на звуке: он должен проверять настоящую сборку, а не мой список.
 *
 * Запуск: node scripts/probe-compose.ts <снимок.jsonl> <выход.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildGlossary, composeTerms } from '../src/shared/glossary.ts'

const [snap, out] = process.argv.slice(2)
if (!snap || !out) throw new Error('нужны пути: снимок и выходной json')

const rows = readFileSync(snap, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Record<string, unknown>)

const g = buildGlossary(rows)
const result = {
  base: composeTerms(g, null, [], []),
  topics: Object.fromEntries(Object.keys(g.topics).map((t) => [t, composeTerms(g, t, [], [])])),
}
writeFileSync(out, JSON.stringify(result, null, 1), 'utf8')
console.log(`ok: постоянная ${result.base.length}, тем ${Object.keys(result.topics).length}`)
