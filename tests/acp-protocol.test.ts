import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AcpTurn,
  acpToolName,
  answerAgentRequest,
  applyConfigOptions,
  buildPrompt,
  classifyText,
  exitError,
  initializeParams,
  isAuthRequired,
  matchModel,
  modelsFromSelector,
  newSessionWithAuth,
  parseCursorStatus,
  parseInitialize,
  parseNewSession,
  permissionResponse,
  pickAuthMethod,
  pickLatestVersionDir,
  pickReadOnlyMode,
  readUpdate,
  selectRequest,
  stopOutcome,
  toLlmError,
  webToolOf,
  type AcpTurnEvent,
  type NewSessionIo,
} from '../src/main/llm/providers/acpProtocol.ts'
import { JsonRpcConnection, RpcRemoteError } from '../src/main/llm/jsonrpc.ts'
import { LlmError } from '../src/main/llm/types.ts'

/*
 * Фикстуры — в форме схемы ACP v1 (schema/v1/schema.json) и того, что отвечает
 * Cursor Agent: заглушка агента из cursor-agent-go (test/mockagent/acp.go) и матрица
 * реестра ACP (коды ошибок, типы способов входа). Личных данных в них нет.
 */

const CURSOR_INIT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
  authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
}

/** Агент, чей вход делается только в терминале (тип terminal по схеме ACP): клиент ACP сам его не выполнит. */
const TERMINAL_AUTH_INIT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {} } },
  agentInfo: { name: 'some-agent', title: 'Some Agent', version: '1.0.83' },
  authMethods: [{ id: 'terminal-login', name: 'Log in', type: 'terminal', args: ['login'] }],
}

/** Cursor: старые поля modes/models, как в заглушке cursor-agent-go. */
const CURSOR_SESSION = {
  sessionId: '00000000-0000-4000-8000-0000000000ac',
  modes: {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' },
    ],
  },
  models: {
    currentModelId: 'composer-2.5',
    availableModels: [
      { modelId: 'auto', name: 'Auto' },
      { modelId: 'composer-2.5', name: 'Composer 2.5' },
      { modelId: 'gpt-5.5', name: 'GPT-5.5' },
    ],
  },
}

/** Стабильный путь схемы: configOptions, сгруппированный список моделей. */
const CONFIG_SESSION = {
  sessionId: 'sess-1',
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'https://agentclientprotocol.com/protocol/session-modes#agent',
      options: [
        { value: 'https://agentclientprotocol.com/protocol/session-modes#agent', name: 'Agent' },
        { value: 'https://agentclientprotocol.com/protocol/session-modes#plan', name: 'Plan' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-sonnet-4.6',
      options: [
        { group: 'anthropic', name: 'Anthropic', options: [{ value: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' }] },
        { group: 'openai', name: 'OpenAI', options: [{ value: 'gpt-5.5[effort=high]', name: 'GPT-5.5 High', description: 'глубже' }] },
      ],
    },
    { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
  ],
  // Старые поля рядом с новыми: стабильные configOptions важнее.
  models: { currentModelId: 'x', availableModels: [{ modelId: 'x', name: 'X' }] },
}

test('acp: initialize — без файловой системы и терминала, версия 1', () => {
  const p = initializeParams('0.1.0') as Record<string, any>
  assert.equal(p.protocolVersion, 1)
  assert.deepEqual(p.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false })
  assert.equal(p.clientInfo.version, '0.1.0')
})

test('acp: ответ initialize — картинки, способы входа, версия агента', () => {
  const cursor = parseInitialize(CURSOR_INIT)
  assert.equal(cursor.image, true)
  assert.deepEqual(cursor.authMethods, [{ id: 'cursor_login', name: 'Cursor Login', type: 'agent' }], 'без type — вход делает сам агент')
  const terminal = parseInitialize(TERMINAL_AUTH_INIT)
  assert.equal(terminal.agentVersion, '1.0.83')
  assert.equal(terminal.authMethods[0]!.type, 'terminal')
  const bare = parseInitialize({ protocolVersion: 1 })
  assert.equal(bare.image, false, 'нет promptCapabilities — картинки не поддерживаются')
  assert.equal(parseInitialize(null).protocolVersion, -1)
})

test('acp: authenticate без пользователя — только разрешённый способ типа agent', () => {
  assert.equal(pickAuthMethod(parseInitialize(CURSOR_INIT).authMethods, ['cursor_login'])?.id, 'cursor_login')
  assert.equal(pickAuthMethod(parseInitialize(CURSOR_INIT).authMethods, []), null, 'не разрешён — не зовём: может открыть браузер')
  assert.equal(pickAuthMethod(parseInitialize(TERMINAL_AUTH_INIT).authMethods, ['terminal-login']), null, 'terminal-вход из приложения не выполнить')
})

test('acp: session/new Cursor — старые поля, режим ask', () => {
  const s = parseNewSession(CURSOR_SESSION)
  assert.equal(s.sessionId, CURSOR_SESSION.sessionId)
  assert.equal(s.model?.via, 'legacy')
  assert.equal(s.model?.current, 'composer-2.5')
  assert.equal(pickReadOnlyMode(s.mode), 'ask')
  assert.deepEqual(selectRequest(s.sessionId, s.mode!, 'ask', 'mode'), { method: 'session/set_mode', params: { sessionId: s.sessionId, modeId: 'ask' } })
  assert.deepEqual(selectRequest(s.sessionId, s.model!, 'gpt-5.5', 'model'), { method: 'session/set_model', params: { sessionId: s.sessionId, modelId: 'gpt-5.5' } })
  assert.throws(() => parseNewSession({}), /sessionId/)
})

test('acp: session/new по стабильной схеме — configOptions важнее старых полей, группы разворачиваются', () => {
  const s = parseNewSession(CONFIG_SESSION)
  assert.equal(s.model?.via, 'config')
  assert.deepEqual(s.model?.options.map((o) => o.id), ['claude-sonnet-4.6', 'gpt-5.5[effort=high]'])
  assert.deepEqual(selectRequest('sess-1', s.model!, 'claude-sonnet-4.6', 'model'), {
    method: 'session/set_config_option',
    params: { sessionId: 'sess-1', configId: 'model', value: 'claude-sonnet-4.6' },
  })
  // У такого агента нет ask — plan не берём: он строит план вместо ответа.
  assert.equal(pickReadOnlyMode(s.mode), null)
  assert.equal(pickReadOnlyMode(null), null)

  applyConfigOptions(s, [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-5.5[effort=high]', options: CONFIG_SESSION.configOptions[1]!.options }])
  assert.equal(s.model?.current, 'gpt-5.5[effort=high]')
  assert.equal(s.mode?.via, 'config', 'обновление только модели не стирает известный переключатель режима')
})

test('acp: режим ask узнаётся и в виде URI', () => {
  const sel = { via: 'config' as const, configId: 'mode', current: '', options: [{ id: 'https://x/session-modes#agent', name: 'Agent' }, { id: 'https://x/session-modes#ask', name: 'Спросить' }] }
  assert.equal(pickReadOnlyMode(sel), 'https://x/session-modes#ask')
  assert.equal(pickReadOnlyMode({ ...sel, options: [{ id: 'read-only', name: 'Read Only' }, { id: 'auto', name: 'Auto' }] }), 'read-only')
})

test('acp: модель из выбора — точный id, регистр, имя, параметризованный вариант', () => {
  const legacy = parseNewSession(CURSOR_SESSION).model!
  assert.equal(matchModel(legacy, 'gpt-5.5'), 'gpt-5.5')
  assert.equal(matchModel(legacy, 'GPT-5.5'), 'gpt-5.5')
  assert.equal(matchModel(legacy, 'Auto'), 'auto')
  assert.equal(matchModel(legacy, 'gpt-6-astra'), null, 'нет у агента — null, а не молча другая модель')
  const config = parseNewSession(CONFIG_SESSION).model!
  assert.equal(matchModel(config, 'gpt-5.5'), 'gpt-5.5[effort=high]')
  assert.equal(matchModel(config, ''), null)
})

test('acp: живой список моделей — подписи каталога сохраняются, глубина у сервиса', () => {
  const catalog = [{ id: 'auto', name: 'Auto', hint: 'сам выберет модель', efforts: null }]
  const list = modelsFromSelector(parseNewSession(CURSOR_SESSION).model!, catalog)
  assert.deepEqual(list[0], { id: 'auto', name: 'Auto', hint: 'сам выберет модель', efforts: null })
  assert.deepEqual(list[1], { id: 'composer-2.5', name: 'Composer 2.5', hint: '', efforts: null })
  const config = modelsFromSelector(parseNewSession(CONFIG_SESSION).model!, [])
  assert.equal(config[1]!.hint, 'глубже', 'описание агента — подсказка')
})

test('acp: вопрос — системный промпт первым блоком, потом снимки, потом вопрос', () => {
  assert.deepEqual(buildPrompt({ text: 'Вопрос', system: 'Ты — суфлёр' }), [
    { type: 'text', text: 'Ты — суфлёр' },
    { type: 'text', text: 'Вопрос' },
  ])
  assert.deepEqual(buildPrompt({ text: 'Что на экране?', images: [{ mediaType: 'image/jpeg', data: 'QUJD' }] }), [
    { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
    { type: 'text', text: 'Что на экране?' },
  ])
})

test('acp: session/update — дельты, размышления, инструменты, чужая сессия', () => {
  const sid = 's1'
  const upd = (update: Record<string, unknown>) => readUpdate({ sessionId: sid, update }, sid)!
  assert.equal(readUpdate({ sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk' } }, sid), null, 'чужая сессия — мимо')
  assert.equal(readUpdate({ sessionId: sid }, sid), null)

  const turn = new AcpTurn()
  const events: AcpTurnEvent[] = []
  const feed = (u: Record<string, unknown>) => events.push(...turn.push(upd(u)))
  feed({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'думаю' } })
  feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Проверю' } })
  feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' в поиске.' } })
  feed({ sessionUpdate: 'tool_call', toolCallId: 'web_search_0', title: 'Web search: 1С регистр накопления', kind: 'search', status: 'pending' })
  feed({ sessionUpdate: 'tool_call_update', toolCallId: 'web_search_0', status: 'completed' })
  feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ВЕРНО' } })
  feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } })
  feed({ sessionUpdate: 'usage_update', used: 10, size: 100 })
  assert.deepEqual(events, [
    { type: 'thinking' },
    { type: 'delta', text: 'Проверю' },
    { type: 'delta', text: ' в поиске.' },
    { type: 'tool', name: 'web_search' },
    { type: 'break' },
    { type: 'delta', text: 'ВЕРНО' },
  ])
})

test('acp: имя инструмента — веб единообразно, локальный поиск не выдаётся за поиск в интернете', () => {
  // main показывает «ищу в интернете» по словам web/search/fetch в имени.
  const web = /web|search|fetch/i
  assert.equal(acpToolName({ toolCallId: 'web_search_0', title: 'Web search: node lts', kind: 'search' }), 'web_search')
  assert.equal(acpToolName({ toolCallId: 't2', title: 'Fetch https://example.com', kind: 'fetch' }), 'web_fetch')
  assert.equal(acpToolName({ toolCallId: 't3', title: 'WebFetch', kind: 'other' }), 'web_fetch')
  const grep = acpToolName({ toolCallId: 't4', title: 'Search files for "Регистр"', kind: 'search' })
  assert.doesNotMatch(grep, web, 'поиск по файлам — не веб')
  assert.equal(acpToolName({ toolCallId: 't5', title: 'Read index.ts', kind: 'read' }), 'Read index.ts')
  assert.doesNotMatch(acpToolName({ toolCallId: 't6', title: 'Run web server', kind: 'execute' }), web, 'команда с «web» в названии — не веб-поиск')
  assert.equal(acpToolName({}), 'tool')
})

test('acp: веб-инструмент ли это — по названию, id и виду; локальные виды — никогда', () => {
  assert.equal(webToolOf({ toolCallId: 'web_search_0', title: 'Web search: x', kind: 'search' }), 'web_search')
  assert.equal(webToolOf({ toolCallId: 'x', kind: 'fetch' }), 'web_fetch')
  assert.equal(webToolOf({ toolCallId: 'x', title: 'Web fetch docs.example.com' }), 'web_fetch')
  assert.equal(webToolOf({ toolCallId: 'x', title: 'Grep', kind: 'search' }), null)
  assert.equal(webToolOf({ toolCallId: 'web_search_1', title: 'Web search', kind: 'execute' }), null, 'выполнение команды не становится веб-поиском из-за названия')
  assert.equal(webToolOf({ toolCallId: 'x', title: 'Web search', kind: 'edit' }), null)
  assert.equal(webToolOf(null), null)
})

test('acp: новое сообщение (другой messageId) — с нового абзаца', () => {
  const turn = new AcpTurn()
  const a = turn.push({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Раз' } })
  const b = turn.push({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' два' } })
  const c = turn.push({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Три' } })
  assert.deepEqual([...a, ...b, ...c], [
    { type: 'delta', text: 'Раз' },
    { type: 'delta', text: ' два' },
    { type: 'break' },
    { type: 'delta', text: 'Три' },
  ])
})

test('acp: request_permission — всегда отказ, никогда не allow', () => {
  const options = [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ]
  assert.deepEqual(permissionResponse({ sessionId: 's', toolCall: { toolCallId: 't' }, options }), { outcome: { outcome: 'selected', optionId: 'reject-once' } })
  assert.deepEqual(permissionResponse({ options: options.slice(0, 3) }), { outcome: { outcome: 'selected', optionId: 'reject-always' } })
  assert.deepEqual(permissionResponse({ options: options.slice(0, 2) }), { outcome: { outcome: 'cancelled' } }, 'только разрешающие варианты — отмена')
  assert.deepEqual(permissionResponse({}), { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(answerAgentRequest('cursor/ask_question', { questions: [] }), { outcome: { outcome: 'cancelled' } })
  assert.throws(() => answerAgentRequest('fs/write_text_file', { path: 'C:/x', content: 'y' }), (e: unknown) => e instanceof RpcRemoteError && e.code === -32601)
  assert.throws(() => answerAgentRequest('terminal/create', {}), RpcRemoteError)
})

test('acp: request_permission второго агента с вебом — allow_once только веб-инструментам', () => {
  // Варианты — как у Cursor: optionId allow-once / allow-always / reject-once.
  const options = [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ]
  const search = { sessionId: 's', toolCall: { toolCallId: 'web_search_0', title: 'Web search: latest Node.js LTS', kind: 'search' }, options }
  const fetch = { sessionId: 's', toolCall: { toolCallId: 'f1', title: 'Fetch https://example.com', kind: 'fetch' }, options }
  const shell = { sessionId: 's', toolCall: { toolCallId: 'sh1', title: 'curl https://example.com', kind: 'execute' }, options }
  const edit = { sessionId: 's', toolCall: { toolCallId: 'e1', title: 'Web search notes.md', kind: 'edit' }, options }
  const grep = { sessionId: 's', toolCall: { toolCallId: 'g1', title: 'Search in files', kind: 'search' }, options }
  const allow = { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  const reject = { outcome: { outcome: 'selected', optionId: 'reject-once' } }

  assert.deepEqual(answerAgentRequest('session/request_permission', search, { allowWeb: true }), allow)
  assert.deepEqual(answerAgentRequest('session/request_permission', fetch, { allowWeb: true }), allow)
  assert.deepEqual(answerAgentRequest('session/request_permission', shell, { allowWeb: true }), reject, 'команды — нет, даже если они ходят в сеть')
  assert.deepEqual(answerAgentRequest('session/request_permission', edit, { allowWeb: true }), reject)
  assert.deepEqual(answerAgentRequest('session/request_permission', grep, { allowWeb: true }), reject, 'поиск по файлам — не веб')
  assert.deepEqual(answerAgentRequest('session/request_permission', search), reject, 'подсказкам и второму агенту без веба — отказ')
  assert.deepEqual(answerAgentRequest('session/request_permission', search, { allowWeb: false }), reject)
  // Только «разрешить всегда» — не выбираем: агент запомнил бы это в настройках пользователя.
  const alwaysOnly = { ...search, options: [options[1]!, options[2]!] }
  assert.deepEqual(permissionResponse(alwaysOnly, { allowWeb: true }), reject)
  assert.deepEqual(permissionResponse({ ...search, options: [{ optionId: 'allow_once', name: 'Allow' }] }, { allowWeb: true }), { outcome: { outcome: 'selected', optionId: 'allow_once' } }, 'без kind — по optionId')
})

/** Связь с агентом, который на session/new отвечает «нужен вход», а на authenticate — как задано. */
function authAgent(onAuth: (id: number, send: (msg: object) => void) => void, afterAuth: 'ok' | 'auth' = 'ok') {
  let authed = false
  const rpc: JsonRpcConnection = new JsonRpcConnection({
    withVersion: true,
    write: (line) => {
      const msg = JSON.parse(line) as { id: number; method: string }
      const send = (m: object) => queueMicrotask(() => rpc.handleLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...m })))
      if (msg.method === 'authenticate') {
        onAuth(msg.id, (m) => {
          authed = true
          send(m)
        })
      } else if (msg.method === 'session/new') {
        if (authed && afterAuth === 'ok') send({ result: { sessionId: 'sess-ok' } })
        else send({ error: { code: -32000, message: 'Authentication required' } })
      }
    },
  })
  const io = (over: Partial<NewSessionIo> = {}): NewSessionIo => ({
    provider: 'cursor',
    request: (method, params, timeoutMs) => rpc.request(method, params, { timeoutMs }),
    exited: () => null,
    authMethod: { id: 'cursor_login', name: 'Cursor Login', type: 'agent' },
    sessionTimeoutMs: 30_000,
    authTimeoutMs: 10_000,
    ...over,
  })
  return { rpc, io }
}

test('acp: authenticate не ответил за 10 с — «нужен вход», а не «не отвечает»', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    // cursor_login без выполненного входа и с NO_OPEN_BROWSER молча висит.
    const { io } = authAgent(() => {})
    const pending = newSessionWithAuth(io(), { cwd: 'C:\\x', mcpServers: [] })
    // Дать ответу session/new (-32000) дойти и уйти запросу authenticate.
    await new Promise((r) => setImmediate(r))
    mock.timers.tick(9_999)
    await new Promise((r) => setImmediate(r))
    let settled = false
    pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    await new Promise((r) => setImmediate(r))
    assert.equal(settled, false, 'до таймаута authenticate ещё ждём')
    mock.timers.tick(1)
    await assert.rejects(pending, (e: unknown) => e instanceof LlmError && e.kind === 'not-logged-in' && /ждёт входа/.test(e.message))
  } finally {
    mock.timers.reset()
  }
})

test('acp: вход без пользователя — удача, запрет, умерший процесс, понятные ошибки authenticate', async () => {
  const params = { cwd: 'C:\\x', mcpServers: [] }
  const ok = authAgent((_, send) => send({ result: {} }))
  assert.deepEqual(await newSessionWithAuth(ok.io(), params), { sessionId: 'sess-ok' })

  const noMethod = authAgent(() => assert.fail('authenticate без разрешённого способа звать нельзя'))
  await assert.rejects(newSessionWithAuth(noMethod.io({ authMethod: null }), params), (e: unknown) => e instanceof LlmError && e.kind === 'not-logged-in')

  const rate = authAgent((_, send) => send({ error: { code: -32603, message: 'rate limit exceeded' } }))
  await assert.rejects(newSessionWithAuth(rate.io(), params), (e: unknown) => e instanceof LlmError && e.kind === 'rate-limit', 'лимит — не «нужен вход»')

  const died = new LlmError('crashed', 'cursor', 'Cursor Agent неожиданно завершился.')
  const dead = authAgent((_, send) => send({ error: { code: -32603, message: 'stdin closed' } }))
  await assert.rejects(newSessionWithAuth(dead.io({ exited: () => died }), params), (e: unknown) => e === died, 'умер процесс — его ошибка')

  const stillAuth = authAgent((_, send) => send({ result: {} }), 'auth')
  await assert.rejects(newSessionWithAuth(stillAuth.io(), params), (e: unknown) => e instanceof LlmError && e.kind === 'not-logged-in')
})

test('acp: stopReason — обрезанный ответ отдаём, пустой и отказ без текста — ошибка', () => {
  assert.deepEqual(stopOutcome('cursor', 'end_turn', true), { ok: true })
  assert.deepEqual(stopOutcome('cursor', 'max_tokens', true), { ok: true })
  assert.equal(stopOutcome('cursor', 'end_turn', false).ok, false, 'неверная модель у Cursor даёт пустой ответ')
  const refusal = stopOutcome('cursor', 'refusal', false)
  assert.ok(!refusal.ok && /Cursor отказался/.test(refusal.message))
  const cancelled = stopOutcome('cursor', 'cancelled', false)
  assert.ok(!cancelled.ok && cancelled.kind === 'cancelled')
  assert.equal(stopOutcome('cursor', 'max_turn_requests', false).ok, false)
})

test('acp: ошибки агента — вход, лимит, модель, картинки, сеть, таймаут', () => {
  const auth = new RpcRemoteError(-32000, 'Authentication required')
  assert.equal(isAuthRequired(auth), true)
  assert.equal(isAuthRequired(new RpcRemoteError(-32602, 'Invalid params')), false)
  assert.equal(toLlmError('cursor', auth).kind, 'not-logged-in')
  assert.match(toLlmError('cursor', auth).message, /Cursor Agent ждёт входа/)

  const rate = toLlmError('cursor', new RpcRemoteError(-32603, "You've hit your rate limit. Try again later."))
  assert.equal(rate.kind, 'rate-limit')
  assert.match(rate.message, /Лимит Cursor исчерпан/)
  assert.equal(classifyText('AI Model Not Found'), 'model-unavailable')
  assert.equal(classifyText('Model gpt-9 is not available on your plan'), 'model-unavailable')
  assert.equal(classifyText('This model does not support image input'), 'images-unsupported')
  assert.equal(classifyText('request failed: getaddrinfo ENOTFOUND api2.cursor.sh'), 'network')
  assert.equal(classifyText('session/new: нет ответа за 30 с'), 'timeout')

  const unknown = toLlmError('cursor', new Error('Something odd'))
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.message, 'Cursor Agent: Something odd')
  const same = new LlmError('images-unsupported', 'cursor')
  assert.equal(toLlmError('cursor', same), same, 'готовая LlmError не переупаковывается')
})

test('acp: процесс завершился — вход, нет программы или падение с последней строкой stderr', () => {
  assert.equal(exitError('cursor', 1, 'Error: Not authenticated. Run agent login').kind, 'not-logged-in')
  assert.equal(exitError('cursor', 1, "'agent' is not recognized as an internal or external command").kind, 'not-installed')
  const crash = exitError('cursor', 3, 'loading config\nFatal: boom')
  assert.equal(crash.kind, 'crashed')
  assert.match(crash.message, /Cursor Agent неожиданно завершился\. Fatal: boom/)
})

test('acp: статус входа Cursor — JSON, старый текстовый вывод, непонятное', () => {
  assert.equal(parseCursorStatus('{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,"hasRefreshToken":true}'), 'ok')
  assert.equal(parseCursorStatus('{"isAuthenticated":false,"hasAccessToken":false}'), 'not-logged-in')
  assert.equal(parseCursorStatus('\u001b[2K{"status":"unauthenticated"}\n'), 'not-logged-in')
  assert.equal(parseCursorStatus('Not logged in. Run agent login.'), 'not-logged-in')
  assert.equal(parseCursorStatus('Logged in as someone'), 'ok')
  assert.equal(parseCursorStatus(''), null)
})

test('acp: последняя версия Cursor Agent — по дате, с новым форматом имени со временем', () => {
  const t = 1_000
  assert.equal(
    pickLatestVersionDir([
      { name: '2026.06.11-241fc09', mtimeMs: t },
      { name: '2026.06.15-03-48-54-da23e37', mtimeMs: t },
      { name: '2026.09.10-fd3934a', mtimeMs: t },
      { name: 'tmp', mtimeMs: t * 9 },
    ]),
    '2026.09.10-fd3934a',
  )
  assert.equal(
    pickLatestVersionDir([
      { name: '2026.09.10-03-00-00-aaaaaaa', mtimeMs: t },
      { name: '2026.09.10-fd3934a', mtimeMs: t * 2 },
    ]),
    '2026.09.10-fd3934a',
    'одна дата — новее та, что изменена позже',
  )
  assert.equal(pickLatestVersionDir([{ name: 'backup', mtimeMs: t }]), null)
})
