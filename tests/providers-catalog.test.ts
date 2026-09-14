import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_MODELS,
  DEFAULT_PROVIDER,
  PROVIDERS,
  PROVIDER_IDS,
  findModel,
  isProviderId,
  providerById,
  type Effort,
} from '../src/shared/providers.ts'
import { MODELS, modelEfforts, modelFamily, modelFor, modelName, modelNote, normalizeModel } from '../src/shared/models.ts'

const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

test('каталог: порядок и id совпадают со списком провайдеров', () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    [...PROVIDER_IDS],
  )
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length)
  assert.equal(DEFAULT_PROVIDER, 'claude')
})

test('каталог: цвета и подписи как в спецификации', () => {
  const expected: Record<string, [string, string]> = {
    claude: ['Claude', '#D97757'],
    codex: ['ChatGPT', '#F1F7F7'],
    cursor: ['Cursor', '#C9D2DE'],
    gemini: ['Gemini', '#9AD8FF'],
    ollama: ['Локальная', '#FFC24B'],
  }
  for (const p of PROVIDERS) {
    assert.deepEqual([p.name, p.color], expected[p.id], p.id)
    assert.match(p.soft, /^#[0-9A-F]{6}$/i, `${p.id}: soft`)
    for (const field of ['via', 'agent', 'note'] as const) assert.ok(p[field].trim(), `${p.id}: пустое ${field}`)
    assert.match(p.install.url, /^https:\/\//, `${p.id}: install.url`)
  }
  assert.equal(providerById('ollama').kind, 'http')
  assert.equal(providerById('ollama').login, undefined)
})

test('каталог: GitHub Copilot убран по решению владельца — и незнакомый id ведёт к Claude', () => {
  assert.equal(isProviderId('copilot'), false)
  assert.equal(providerById('copilot').id, 'claude')
  assert.doesNotMatch(JSON.stringify(PROVIDERS), /copilot/i)
})

test('каталог: второй агент — у любого провайдера, веб-поиск — только у тех, кто умеет', () => {
  assert.deepEqual(
    PROVIDERS.filter((p) => p.verifier).map((p) => p.id),
    [...PROVIDER_IDS],
  )
  assert.deepEqual(
    PROVIDERS.filter((p) => p.webSearch).map((p) => p.id),
    ['claude', 'codex', 'cursor'],
  )
  assert.doesNotMatch(JSON.stringify(PROVIDERS), /только (здесь|через Claude)/, 'тексты «второй агент только у Claude» убраны')
})

test('каталог: модели корректны, модель по умолчанию есть в списке', () => {
  for (const p of PROVIDERS) {
    const ids = p.models.map((m) => m.id)
    assert.equal(new Set(ids).size, ids.length, `${p.id}: повторяются id моделей`)
    for (const m of p.models) {
      assert.ok(m.id && m.name && m.hint, `${p.id}/${m.id}: пустые поля`)
      if (m.efforts) for (const e of m.efforts) assert.ok(EFFORTS.includes(e), `${p.id}/${m.id}: глубина ${e}`)
    }
    if (p.models.length) assert.ok(ids.includes(p.defaultModel), `${p.id}: defaultModel не из списка`)
    else {
      assert.equal(p.defaultModel, '', `${p.id}: без моделей нет и модели по умолчанию`)
      assert.ok(p.dynamicModels && p.modelsHint, `${p.id}: пустой список без подсказки`)
    }
  }
})

test('каталог: запасные списки как в спецификации', () => {
  assert.deepEqual(
    providerById('codex').models.map((m) => m.id),
    ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  )
  for (const m of providerById('codex').models) assert.deepEqual(m.efforts, ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(
    providerById('cursor').models.map((m) => m.id),
    ['auto', 'composer-2.5'],
  )
  assert.deepEqual(
    providerById('gemini').models.map((m) => m.id),
    ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'],
  )
  // agy снимков не принимает — окно не должно предлагать их Gemini.
  for (const m of providerById('gemini').models) assert.equal(m.images, false, m.id)
  assert.deepEqual(providerById('ollama').models, [])
})

test('модели: живой список важнее, но пустые поля добираются из каталога', () => {
  // Живой список Codex знает имя и глубину, но не короткое имя и не снимки.
  const live = [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (live)', hint: '', efforts: ['low' as const] }]
  const m = findModel('codex', 'gpt-5.6-sol', live)!
  assert.equal(m.name, 'GPT-5.6 Sol (live)')
  assert.deepEqual(m.efforts, ['low'])
  assert.equal(m.short, 'Sol')
  assert.equal(m.hint, 'сильная')
  assert.equal(m.images, true)
  assert.equal(modelFamily('gpt-5.6-sol', 'codex', live), 'Sol')
  // Gemini из живого списка — всё равно без снимков.
  assert.equal(findModel('gemini', 'gemini-3.8-flash-low', [{ id: 'gemini-3.8-flash-low', name: 'Flash low', hint: '', efforts: null }])?.images, false)
  // Модели нет в каталоге — берём живую как есть, первое слово имени вместо короткого.
  assert.equal(modelFamily('gpt-7-nova', 'codex', [{ id: 'gpt-7-nova', name: 'GPT-7 Nova', hint: '', efforts: null }]), 'GPT-7')
})

test('каталог Claude: те же модели, у Haiku глубины нет', () => {
  const claude = providerById('claude')
  assert.deepEqual(
    claude.models.map((m) => m.id),
    CLAUDE_MODELS.map((m) => m.id),
  )
  assert.equal(MODELS, CLAUDE_MODELS)
  for (const m of claude.models) {
    if (/haiku/.test(m.id)) assert.equal(m.efforts, null)
    else assert.deepEqual(m.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  }
})

test('каталог: незнакомый провайдер — Claude', () => {
  assert.equal(providerById('nope').id, 'claude')
  assert.equal(providerById(undefined).id, 'claude')
  assert.equal(providerById(42).id, 'claude')
  assert.equal(isProviderId('codex'), true)
  assert.equal(isProviderId('claude-code'), false)
  assert.equal(isProviderId('toString'), false)
})

test('каталог: ничего личного', () => {
  const text = JSON.stringify(PROVIDERS)
  // Пути профиля (в JSON обратная косая удвоена) и почтовые адреса — без чьего-либо имени в самом тесте.
  assert.doesNotMatch(text, /[A-Z]:(\\\\|\/)Users|[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
})

test('модели: помощники Claude работают как раньше', () => {
  assert.equal(normalizeModel('opus'), 'claude-opus-5')
  assert.equal(normalizeModel('toString'), 'claude-opus-5')
  assert.equal(normalizeModel(undefined), 'claude-opus-5')
  assert.equal(modelName('claude-sonnet-5'), 'Sonnet 5')
  assert.equal(modelName('haiku'), 'Haiku 4.5')
  assert.equal(modelFamily('claude-opus-4-8'), 'Opus')
  assert.match(modelNote('claude-opus-5'), /Opus 5/)
  assert.equal(modelEfforts('claude-haiku-4-5'), null)
  assert.deepEqual(modelEfforts('claude-opus-5'), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('модели: помощники с провайдером', () => {
  assert.equal(modelName('gpt-5.6-sol', 'codex'), 'GPT-5.6 Sol')
  assert.equal(modelFamily('gpt-5.6-sol', 'codex'), 'Sol')
  assert.equal(modelFamily('composer-2.5', 'cursor'), 'Composer')
  // Модели из живого списка, которой нет в запасном, — честный id.
  assert.equal(modelName('gpt-7-nova', 'codex'), 'gpt-7-nova')
  const live = [{ id: 'qwen3:32b', name: 'Qwen 3 32B', hint: 'сильнее', efforts: null }]
  assert.equal(modelName('qwen3:32b', 'ollama', live), 'Qwen 3 32B')
  assert.equal(findModel('ollama', 'qwen3:32b', live)?.hint, 'сильнее')
  assert.equal(modelFor('claude', 'gpt-5.6-sol'), 'claude-opus-5')
  assert.equal(modelFor('codex', ' gpt-5.6-sol '), 'gpt-5.6-sol')
  assert.equal(modelFor('cursor', ''), 'auto')
  assert.equal(modelFor('ollama', undefined), '')
  assert.equal(modelEfforts('auto', 'cursor'), null)
})
