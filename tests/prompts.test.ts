import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NO_THINKING_RULE, SUGGEST_SYSTEM, WARMUP_PROMPT, suggestSystemPrompt } from '../src/main/llm/prompts.ts'

test('промпт суфлёра: формат ответа, который панель умеет показывать', () => {
  assert.match(SUGGEST_SYSTEM, /^Ты — суфлёр на рабочем созвоне/)
  assert.match(SUGGEST_SYSTEM, /3-5 коротких тезисов/)
  // Панель подсвечивает код только в блоках с языком — правило не должно потеряться при правке.
  assert.match(SUGGEST_SYSTEM, /```1c, ```sql/)
  assert.equal(NO_THINKING_RULE, '\n- Не рассуждай в ответе, сразу тезисы.')
  assert.equal(WARMUP_PROMPT, 'Ответь одним словом: готов.')
})

test('промпт сессии: свой важнее встроенного, «не рассуждай» — только к встроенному', () => {
  assert.equal(suggestSystemPrompt(undefined), SUGGEST_SYSTEM)
  assert.equal(suggestSystemPrompt('   '), SUGGEST_SYSTEM, 'пустой свой промпт — встроенный')
  assert.equal(suggestSystemPrompt('', true), SUGGEST_SYSTEM + NO_THINKING_RULE)
  assert.equal(suggestSystemPrompt('  Ты — мой помощник.  ', true), 'Ты — мой помощник.')
})
