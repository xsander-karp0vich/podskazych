import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, migrateSettings, viaClaudeCode } from '../src/shared/settings.ts'

test('миграция: пусто и мусор — настройки по умолчанию', () => {
  for (const raw of [undefined, null, 42, 'строка', [], [1, 2]]) {
    const s = migrateSettings(raw)
    assert.equal(s.llmProvider, 'claude')
    assert.equal(s.claudeSource, 'cli')
    assert.equal(s.llmModel, 'claude-opus-5')
    assert.deepEqual(s.llmModelByProvider, { claude: 'claude-opus-5' })
    assert.equal(s.fontSize, DEFAULT_SETTINGS.fontSize)
  }
})

test('миграция: старый Claude Code с псевдонимом модели', () => {
  const s = migrateSettings({ llmProvider: 'claude-code', llmModel: 'sonnet', verifyModel: 'haiku', fontSize: 20 })
  assert.equal(s.llmProvider, 'claude')
  assert.equal(s.claudeSource, 'cli')
  assert.equal(s.llmModel, 'claude-sonnet-5')
  assert.equal(s.verifyModel, 'claude-haiku-4-5')
  assert.deepEqual(s.llmModelByProvider, { claude: 'claude-sonnet-5' })
  assert.equal(s.fontSize, 20, 'прочие настройки не трогаем')
  assert.equal(viaClaudeCode(s), true)
})

test('миграция: старый источник «API по ключу»', () => {
  const s = migrateSettings({ llmProvider: 'api', llmModel: 'claude-opus-4-8' })
  assert.equal(s.llmProvider, 'claude')
  assert.equal(s.claudeSource, 'api')
  assert.equal(s.llmModel, 'claude-opus-4-8')
  assert.equal(viaClaudeCode(s), false)
})

test('миграция: незнакомая модель Claude — модель по умолчанию', () => {
  const s = migrateSettings({ llmProvider: 'claude-code', llmModel: 'claude-opus-9', verifyModel: 'toString' })
  assert.equal(s.llmModel, 'claude-opus-5')
  assert.equal(s.verifyModel, 'claude-opus-5')
})

test('миграция: новые настройки не меняются', () => {
  const raw = {
    llmProvider: 'codex',
    claudeSource: 'api',
    llmModel: 'gpt-5.6-sol',
    llmModelByProvider: { claude: 'claude-sonnet-5', codex: 'gpt-5.6-luna', ollama: 'qwen3:32b' },
  }
  const s = migrateSettings(raw)
  assert.equal(s.llmProvider, 'codex')
  assert.equal(s.claudeSource, 'api')
  // Текущая модель важнее запомненной: её выбрали последней.
  assert.equal(s.llmModel, 'gpt-5.6-sol')
  assert.deepEqual(s.llmModelByProvider, { claude: 'claude-sonnet-5', codex: 'gpt-5.6-sol', ollama: 'qwen3:32b' })
  assert.equal(viaClaudeCode(s), false)
})

test('миграция: модель Claude у другого провайдера — след старых настроек', () => {
  const s = migrateSettings({ llmProvider: 'codex', llmModel: 'claude-haiku-4-5' })
  assert.equal(s.llmModel, 'gpt-5.6-terra')
  assert.equal(s.llmModelByProvider.codex, 'gpt-5.6-terra')
  assert.equal(s.llmModelByProvider.claude, 'claude-haiku-4-5', 'вернётся при переключении на Claude')
})

test('миграция: модели нет — берём запомненную у провайдера, иначе по умолчанию', () => {
  assert.equal(migrateSettings({ llmProvider: 'cursor', llmModelByProvider: { cursor: 'composer-2.5' } }).llmModel, 'composer-2.5')
  assert.equal(migrateSettings({ llmProvider: 'cursor' }).llmModel, 'auto')
  // У Ollama запасного списка нет: модель придёт из живого списка.
  assert.equal(migrateSettings({ llmProvider: 'ollama' }).llmModel, '')
})

test('миграция: незнакомый провайдер — Claude, битые записи по провайдерам отбрасываются', () => {
  const s = migrateSettings({
    llmProvider: 'yandex',
    llmModel: 'yandexgpt',
    llmModelByProvider: { codex: 5, cursor: '  ', gemini: 'gemini-3.8-flash-low', yandex: 'x', claude: 'opus' },
  })
  assert.equal(s.llmProvider, 'claude')
  assert.equal(s.llmModel, 'claude-opus-5')
  assert.deepEqual(s.llmModelByProvider, { gemini: 'gemini-3.8-flash-low', claude: 'claude-opus-5' })
})

test('миграция: сохранённый Copilot (провайдер убран) — Claude, без хвостов', () => {
  const s = migrateSettings({
    llmProvider: 'copilot',
    llmModel: 'gpt-5.5',
    llmModelByProvider: { copilot: 'x', codex: 'gpt-5.6-sol' },
    verifyProvider: 'copilot',
    verifyModel: 'x',
    verifyModelByProvider: { copilot: 'x' },
  })
  assert.equal(s.llmProvider, 'claude')
  assert.equal(s.llmModel, 'claude-opus-5')
  assert.deepEqual(s.llmModelByProvider, { claude: 'claude-opus-5', codex: 'gpt-5.6-sol' })
  // Незнакомый провайдер второго агента при сохранённой модели — эпоха «второй агент только Claude».
  assert.equal(s.verifyProvider, 'claude')
  assert.equal(s.verifyModel, 'claude-opus-5')
  assert.deepEqual(s.verifyModelByProvider, { claude: 'claude-opus-5' })
})

test('второй агент: старая модель Claude без провайдера — это Claude, даже если отвечает другой', () => {
  const s = migrateSettings({ llmProvider: 'codex', llmModel: 'gpt-5.6-sol', verifyModel: 'claude-sonnet-5', verifyEffort: 'medium', verifyWeb: true })
  assert.equal(s.verifyProvider, 'claude')
  assert.equal(s.verifyModel, 'claude-sonnet-5')
  assert.deepEqual(s.verifyModelByProvider, { claude: 'claude-sonnet-5' })
  assert.equal(s.verifyEffort, 'medium')
  assert.equal(s.verifyWeb, true)
})

test('второй агент: новому пользователю — тот же провайдер, что отвечает', () => {
  assert.equal(migrateSettings(undefined).verifyProvider, 'claude')
  assert.equal(migrateSettings(undefined).verifyModel, 'claude-opus-5')
  const codex = migrateSettings({ llmProvider: 'codex' })
  assert.equal(codex.verifyProvider, 'codex')
  assert.equal(codex.verifyModel, 'gpt-5.6-terra')
  // У Ollama своей модели по умолчанию нет: берём ту, которой уже отвечают.
  const local = migrateSettings({ llmProvider: 'ollama', llmModel: 'qwen3:32b' })
  assert.equal(local.verifyProvider, 'ollama')
  assert.equal(local.verifyModel, 'qwen3:32b')
})

test('второй агент: пока провайдера не выбрали сами, он следует за тем, кто отвечает', () => {
  // Окно сохраняет настройки целиком: verifyProvider 'claude' из умолчаний — ещё не выбор.
  const saved = { ...DEFAULT_SETTINGS, llmProvider: 'codex', llmModel: 'gpt-5.6-sol' }
  const s = migrateSettings(saved)
  assert.equal(s.verifyProviderChosen, false)
  assert.equal(s.verifyProvider, 'codex')
  // модель Claude из умолчаний у Codex не годится — берётся та, которой уже отвечают
  assert.equal(s.verifyModel, 'gpt-5.6-sol')
  // Выбрали сами — остаётся, даже если отвечает другой.
  const chosen = migrateSettings({ ...saved, verifyProvider: 'claude', verifyProviderChosen: true })
  assert.equal(chosen.verifyProvider, 'claude')
  assert.equal(chosen.verifyProviderChosen, true)
  // Настройки до провайдеров: проверял Claude — это и есть выбор.
  const legacy = migrateSettings({ llmProvider: 'claude-code', verifyModel: 'sonnet' })
  assert.equal(legacy.verifyProviderChosen, true)
  assert.equal(legacy.verifyProvider, 'claude')
  // Повторная миграция не превращает умолчание в выбор.
  assert.equal(migrateSettings(migrateSettings(saved)).verifyProviderChosen, false)
})

test('второй агент: свой провайдер и модель, память по провайдерам, битые значения', () => {
  const s = migrateSettings({
    llmProvider: 'claude-code',
    verifyProvider: 'gemini',
    verifyModel: 'gemini-3.8-flash-low',
    verifyModelByProvider: { codex: 'gpt-5.6-luna', claude: 'sonnet', yandex: 'x', cursor: 7 },
    verifyEffort: 'max',
    verifyWeb: 'да',
  })
  assert.equal(s.llmProvider, 'claude')
  assert.equal(s.verifyProvider, 'gemini')
  assert.equal(s.verifyModel, 'gemini-3.8-flash-low')
  assert.deepEqual(s.verifyModelByProvider, { codex: 'gpt-5.6-luna', claude: 'claude-sonnet-5', gemini: 'gemini-3.8-flash-low' })
  assert.equal(s.verifyEffort, 'high', 'max у второго агента не бывает')
  assert.equal(s.verifyWeb, false)
  // Модель Claude у другого провайдера — след старых настроек: провайдеру уходит его модель.
  const leftover = migrateSettings({ verifyProvider: 'codex', verifyModel: 'claude-haiku-4-5' })
  assert.equal(leftover.verifyModel, 'gpt-5.6-terra')
  assert.equal(leftover.verifyModelByProvider.claude, 'claude-haiku-4-5')
})

test('миграция: повторная миграция ничего не меняет', () => {
  for (const raw of [
    { llmProvider: 'claude-code', llmModel: 'haiku' },
    { llmProvider: 'api' },
    { llmProvider: 'codex', llmModel: 'claude-opus-5' },
    { llmProvider: 'gemini', llmModel: 'gemini-3.8-flash-medium', claudeSource: 'api' },
    { llmProvider: 'codex', verifyModel: 'opus' },
    { llmProvider: 'ollama', llmModel: 'qwen3:32b' },
    { verifyProvider: 'cursor', verifyModel: 'claude-opus-5', verifyModelByProvider: { cursor: 'composer-2.5' } },
  ]) {
    const once = migrateSettings(raw)
    assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(once))), once)
  }
})

test('миграция: «Спрятать из трея» — выключено у старых настроек и у битых значений', () => {
  // Настройки до появления переключателя: значок остаётся на месте.
  assert.equal(migrateSettings({ llmProvider: 'claude-code', fontSize: 20 }).hideTray, false)
  assert.equal(migrateSettings(undefined).hideTray, false)
  assert.equal(DEFAULT_SETTINGS.hideTray, false)
  // Спрятать значок по мусору — оставить приложение без запасного выхода: только строгое true.
  for (const hideTray of ['true', 1, 'да', null, {}, []]) {
    assert.equal(migrateSettings({ hideTray }).hideTray, false, JSON.stringify(hideTray))
  }
  assert.equal(migrateSettings({ hideTray: true }).hideTray, true)
  assert.equal(migrateSettings({ hideTray: false }).hideTray, false)
  const once = migrateSettings({ hideTray: true, contentProtected: false })
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(once))), once)
  assert.equal(once.contentProtected, false, 'соседнюю настройку не трогаем')
})
