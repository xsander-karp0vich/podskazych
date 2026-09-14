/**
 * Проверка словаря на настоящей базе, без сборки приложения.
 *
 * Запуск: node scripts/probe-glossary.ts [база.jsonl] [отчёт.txt]
 * Node 24 выполняет TypeScript сам, поэтому проверяется тот же модуль, что
 * работает в приложении, а не его копия. По умолчанию — встроенная база kb/questions.jsonl.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildGlossary, composeTerms, topicLabel } from '../src/shared/glossary.ts'

const snap = process.argv[2] ?? new URL('../kb/questions.jsonl', import.meta.url)
const report = process.argv[3] ?? 'glossary-report.txt'

const rows = readFileSync(snap, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Record<string, unknown>)

const t0 = performance.now()
const g = buildGlossary(rows)
const ms = performance.now() - t0

const out: string[] = []
out.push(`строк ${rows.length}, словарь построен за ${ms.toFixed(0)} мс`)
out.push(`постоянная часть (${g.base.length}): ${g.base.join(', ')}`)

const order = Object.keys(g.topics).sort((a, b) => (g.sizes[b] ?? 0) - (g.sizes[a] ?? 0))
for (const t of order) {
  const terms = g.topics[t] ?? []
  out.push('')
  out.push(`${topicLabel(t)} · ${t} · ${g.sizes[t]} вопр. · ${terms.length} терм.`)
  out.push(`  ${terms.join(', ')}`)
}

out.push('')
out.push('ПРИМЕР: тема exchange, свои имена «Иванов», «Проект Альфа», убрать «XML»')
out.push(composeTerms(g, 'exchange', ['Иванов', 'Проект Альфа'], ['XML']).join(', '))

writeFileSync(report, out.join('\n'), 'utf8')
console.log(`готово за ${ms.toFixed(0)} мс, отчёт: ${report}`)
