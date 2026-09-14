import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  availabilityOf,
  chipOf,
  isReady,
  isUnchecked,
  needsSetup,
  noteOf,
  notReadyText,
  promptReachesModel,
  resumeModel,
  resumeVerifyModel,
  verifyDepthNote,
  verifyEffortsOf,
  viaOf,
} from '../src/renderer/providerStatus.ts'
import { providerById, type ProviderId } from '../src/shared/providers.ts'
import type { Availability, ProviderStatus } from '../src/preload/index.ts'

const st = (id: ProviderId, available: Availability, extra: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  available,
  models: providerById(id).models,
  ...extra,
})

test('чип: итог проверки словами из макета, «проверяю…» важнее итога', () => {
  assert.equal(chipOf(st('codex', { state: 'ok' }), false, 'cli').text, 'подключён')
  assert.equal(chipOf(st('codex', { state: 'not-logged-in' }), false, 'cli').text, 'нужен вход')
  assert.equal(chipOf(st('cursor', { state: 'not-installed' }), false, 'cli').text, 'не установлен')
  assert.equal(chipOf(st('cursor', { state: 'not-installed' }), true, 'cli').text, 'проверяю…')
  assert.equal(chipOf(st('cursor', { state: 'unknown' }), false, 'cli').text, 'не проверен')
  const err = chipOf(st('gemini', { state: 'error', message: 'agy упал' }), false, 'cli')
  assert.deepEqual([err.text, err.tone, err.title], ['ошибка', 'danger', 'agy упал'])
})

test('чип: версия и аккаунт уходят в подсказку, пустые — не дают пустой подсказки', () => {
  assert.equal(chipOf(st('claude', { state: 'ok', version: '2.9.1', account: 'max' }), false, 'cli').title, '2.9.1 · max')
  assert.equal(chipOf(st('claude', { state: 'ok' }), false, 'cli').title, undefined)
})

test('Claude по ключу: готовность — по ключу, а не по установленному Claude Code', () => {
  const claude = st('claude', { state: 'ok' }, { claudeApi: { state: 'not-logged-in' } })
  assert.equal(isReady(claude, 'cli'), true)
  assert.equal(isReady(claude, 'api'), false)
  assert.equal(chipOf(claude, false, 'api').text, 'нет ключа')
  assert.equal(viaOf('claude', 'api'), 'API по ключу')
  assert.equal(viaOf('claude', 'cli'), 'через Claude Code')
  assert.match(noteOf('claude', 'api'), /ANTHROPIC_API_KEY/)
  assert.match(notReadyText(claude, 'api') ?? '', /ANTHROPIC_API_KEY/)
  // Источник 'api' касается только Claude: у остальных смотрим их собственную проверку.
  assert.deepEqual(availabilityOf(st('codex', { state: 'ok' }), 'api'), { state: 'ok' })
})

test('«не готов»: фраза называет программу; готовый и неизвестный — молчат', () => {
  assert.equal(notReadyText(st('codex', { state: 'not-logged-in' }), 'cli'), 'Нужен вход в Codex CLI — нажмите «Войти» в выборе модели')
  assert.match(notReadyText(st('cursor', { state: 'not-installed' }), 'cli') ?? '', /^Cursor Agent не установлен/)
  assert.equal(notReadyText(st('gemini', { state: 'ok' }), 'cli'), null)
  assert.equal(notReadyText(st('cursor', { state: 'unknown' }), 'cli'), null)
})

test('«не проверяли» — только unknown без пояснения', () => {
  assert.equal(isUnchecked({ state: 'unknown' }), true)
  assert.equal(isUnchecked({ state: 'unknown', message: 'не ответил за 5 с' }), false)
  assert.equal(isUnchecked({ state: 'not-installed' }), false)
})

test('возврат к провайдеру: прошлый выбор, иначе модель по умолчанию, иначе первая живая', () => {
  const s = { llmProvider: 'codex' as const, llmModel: 'gpt-5.6-sol', llmModelByProvider: { codex: 'gpt-5.6-sol' } }
  assert.equal(resumeModel(s, 'codex', []), 'gpt-5.6-sol')
  assert.equal(resumeModel(s, 'claude', []), 'claude-opus-5')
  assert.equal(resumeModel(s, 'cursor', []), 'auto')
  // У Ollama своей модели по умолчанию нет — берём первую скачанную.
  const live = [{ id: 'qwen3:32b', name: 'qwen3:32b', hint: '', efforts: null }]
  assert.equal(resumeModel(s, 'ollama', live), 'qwen3:32b')
  assert.equal(resumeModel(s, 'ollama', []), '')
  // Запомненная модель Claude — псевдонимом из старых настроек — приводится к точному id.
  assert.equal(resumeModel({ ...s, llmModelByProvider: { claude: 'sonnet' } }, 'claude', []), 'claude-sonnet-5')
})

test('второй агент: прошлый выбор проверяющим, иначе модель, которой провайдер отвечает, иначе по умолчанию', () => {
  const s = {
    verifyProvider: 'claude' as const,
    verifyModel: 'claude-sonnet-5',
    verifyModelByProvider: { claude: 'claude-sonnet-5', codex: 'gpt-5.6-luna' },
    llmModelByProvider: { codex: 'gpt-5.6-sol', ollama: 'qwen3:32b', claude: 'claude-fable-5-1' },
  }
  assert.equal(resumeVerifyModel(s, 'codex', []), 'gpt-5.6-luna')
  assert.equal(resumeVerifyModel(s, 'claude', []), 'claude-sonnet-5')
  // Ollama проверяющим ещё не выбирали — та же скачанная модель, что отвечает, а не первая из списка.
  const live = [{ id: 'llama4:8b', name: 'llama4:8b', hint: '', efforts: null }]
  assert.equal(resumeVerifyModel(s, 'ollama', live), 'qwen3:32b')
  assert.equal(resumeVerifyModel({ ...s, llmModelByProvider: {} }, 'ollama', live), 'llama4:8b')
  assert.equal(resumeVerifyModel(s, 'cursor', []), 'auto')
  // Модель Claude, которой он отвечает, проверяющему не навязываем: его выбор — отдельный.
  assert.equal(resumeVerifyModel({ ...s, verifyModelByProvider: {}, verifyProvider: 'codex' }, 'claude', []), 'claude-opus-5')
})

test('глубина проверки — только уровни, которые модель умеет', () => {
  assert.deepEqual(verifyEffortsOf(['low', 'medium', 'high', 'xhigh', 'max']), ['low', 'medium', 'high'])
  assert.deepEqual(verifyEffortsOf(['medium', 'high', 'xhigh']), ['medium', 'high'])
  assert.deepEqual(verifyEffortsOf(null), [])
  assert.deepEqual(verifyEffortsOf([]), [])
})

test('нет глубины у проверяющего — подпись говорит почему', () => {
  assert.match(verifyDepthNote('cursor', 'Auto'), /Cursor выбирает сам/)
  assert.match(verifyDepthNote('gemini', 'Gemini 3.8 Flash'), /сама модель/)
  assert.equal(verifyDepthNote('ollama', 'qwen3:32b'), 'Для qwen3:32b глубина не настраивается.')
})

test('настройка нужна только по итогу проверки: не установлен, без входа, сломан', () => {
  assert.equal(needsSetup(st('codex', { state: 'not-logged-in' }), false, 'cli'), true)
  assert.equal(needsSetup(st('ollama', { state: 'error', message: 'не отвечает' }), false, 'cli'), true)
  assert.equal(needsSetup(st('codex', { state: 'not-logged-in' }), true, 'cli'), false)
  assert.equal(needsSetup(st('cursor', { state: 'unknown', message: 'не ответил за 5 с' }), false, 'cli'), false)
  assert.equal(needsSetup(st('gemini', { state: 'ok' }), false, 'cli'), false)
})

test('команды из своего промпта — всем, кроме Claude по ключу: у API промпт зашитый', () => {
  assert.equal(promptReachesModel({ llmProvider: 'claude', claudeSource: 'api' }), false)
  assert.equal(promptReachesModel({ llmProvider: 'claude', claudeSource: 'cli' }), true)
  // Источник 'api' касается только Claude.
  assert.equal(promptReachesModel({ llmProvider: 'codex', claudeSource: 'api' }), true)
})
