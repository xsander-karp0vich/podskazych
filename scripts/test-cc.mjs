import { ClaudeCodeSuggester } from './_cc.mjs'

const s = new ClaudeCodeSuggester()
const t0 = Date.now()
let first = 0
try {
  const text = await s.ask('Что такое регистр накопления в 1С? Один тезис.', (d) => {
    if (!first) { first = Date.now(); console.log(`первый текст: ${first - t0} мс`) }
    process.stdout.write(d)
  })
  console.log(`\n\nцеликом: ${Date.now() - t0} мс, символов: ${text.length}`)
} catch (e) {
  console.error('ОШИБКА:', e?.message || e)
} finally {
  s.stop()
  process.exit(0)
}
