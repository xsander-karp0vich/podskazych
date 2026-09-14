import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JsonRpcConnection } from '../src/main/llm/jsonrpc.ts'
import { TurnQueue } from '../src/main/llm/queue.ts'
import { LlmError, SkippedError } from '../src/main/llm/types.ts'
import {
  CODEX_FEATURES_OFF,
  CodexTurnRouter,
  buildInitializeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  classifyTurnError,
  codexMcpServerNames,
  codexServerArgs,
  codexThreadConfig,
  errorFromText,
  errorInfoOf,
  isAddressableMcpName,
  isContextOverflow,
  isSandboxCasingError,
  parseAccountRead,
  parseLoginStatus,
  parseModelList,
  pickEffort,
  serverRequestReply,
  threadIdOf,
  turnIdOf,
  versionFrom,
  type TurnEnd,
} from '../src/main/llm/providers/codexProtocol.ts'
import { providerById } from '../src/shared/providers.ts'

/*
 * Фикстуры — в форме, какую пишет `codex app-server` 0.154.0: поля и регистр взяты из
 * serde-структур app-server-protocol (v2/*.rs) и тестов сериализации в common.rs.
 * Записей живого CLI здесь нет: на машине разработки Codex не ставили.
 */

/* ---------- сборка запросов ---------- */

test('codex: initialize — clientInfo с обязательными name и version', () => {
  assert.deepEqual(buildInitializeParams('0.1.0'), {
    clientInfo: { name: 'podskazych', title: 'Подсказыч', version: '0.1.0' },
  })
  assert.equal((buildInitializeParams('').clientInfo as { version: string }).version, '0.0.0')
})

test('codex: thread/start — kebab-case песочницы, эфемерная нить, промпт в developerInstructions', () => {
  const p = buildThreadStartParams({ model: 'gpt-5.6-terra', cwd: 'C:\\data\\agents\\codex', developerInstructions: 'Ты — суфлёр' })
  assert.equal(p.approvalPolicy, 'never')
  assert.equal(p.sandbox, 'read-only')
  assert.equal(p.ephemeral, true)
  assert.equal(p.developerInstructions, 'Ты — суфлёр')
  assert.equal(p.model, 'gpt-5.6-terra')
  assert.equal('baseInstructions' in p, false, 'встроенные инструкции Codex не заменяем')
  const cfg = p.config as Record<string, unknown>
  assert.equal(cfg['features.shell_tool'], false)
  assert.equal(cfg['features.unified_exec'], false)
  assert.equal(cfg.web_search, 'disabled')
  assert.equal(cfg.project_doc_max_bytes, 0)

  const noModel = buildThreadStartParams({ cwd: 'C:\\x', developerInstructions: 'x', legacyCasing: true })
  assert.equal('model' in noModel, false, 'пустая модель — модель Codex по умолчанию')
  assert.equal(noModel.sandbox, 'readOnly')
})

test('codex: выключены инструменты, которые могут что-то сделать на компьютере', () => {
  for (const f of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'image_generation', 'browser_use', 'computer_use', 'hooks']) {
    assert.ok(CODEX_FEATURES_OFF.includes(f), f)
    assert.equal(codexThreadConfig()[`features.${f}`], false)
  }
})

test('codex: аргументы запуска — -c до подкоманды, строки простыми словами без кавычек', () => {
  const args = codexServerArgs()
  assert.equal(args.at(-1), 'app-server')
  assert.ok(args.includes('features.shell_tool=false'))
  // Codex берёт значение, которое не разбирается как TOML, строкой: web_search=disabled — это «disabled».
  assert.ok(args.includes('web_search=disabled'), 'веб выключен и на весь процесс, а не только в нити')
  assert.ok(args.includes('history.persistence=none'))
  for (let i = 0; i < args.length - 1; i += 2) {
    assert.equal(args[i], '-c')
    assert.match(args[i + 1]!, /^[\w.-]+=(true|false|\d+|[a-z_-]+)$/, 'кавычки в командной строке не нужны')
  }
})

test('codex: веб-поиск — live только по запросу (второй агент), инструменты компьютера всё равно выключены', () => {
  assert.equal(codexThreadConfig().web_search, 'disabled', 'подсказкам веб не нужен')
  assert.equal(codexThreadConfig({ web: false }).web_search, 'disabled')
  const web = codexThreadConfig({ web: true })
  assert.equal(web.web_search, 'live', 'WebSearchMode: disabled | cached | indexed | live; по умолчанию cached')
  for (const f of CODEX_FEATURES_OFF) assert.equal(web[`features.${f}`], false, `${f} выключен и у второго агента`)
  assert.ok(codexServerArgs({ web: true }).includes('web_search=live'))
  const thread = buildThreadStartParams({ cwd: 'C:\\x', developerInstructions: 'x', launch: { web: true } })
  assert.equal((thread.config as Record<string, unknown>).web_search, 'live')
  assert.equal(thread.approvalPolicy, 'never')
  assert.equal(thread.sandbox, 'read-only')
})

test('codex: MCP-серверы пользователя выключаются поимённо — и процессу, и нити', () => {
  const launch = { mcpServers: ['github', 'file-system', 'my.server'] }
  const cfg = codexThreadConfig(launch)
  assert.equal(cfg['mcp_servers.github.enabled'], false)
  assert.equal(cfg['mcp_servers.file-system.enabled'], false)
  assert.equal('mcp_servers.my.server.enabled' in cfg, false, 'имя с точкой адресовать нельзя: Codex делит путь по точкам')
  const args = codexServerArgs(launch)
  assert.ok(args.includes('mcp_servers.github.enabled=false'))
  assert.ok(!args.some((a) => a.includes('my.server')))
  assert.equal(Object.keys(codexThreadConfig()).some((k) => k.startsWith('mcp_servers')), false, 'нет серверов — нет ключей')
  assert.equal(isAddressableMcpName('сервер_1'), true)
  assert.equal(isAddressableMcpName('a b'), false)
  assert.equal(isAddressableMcpName('a=b'), false)
})

test('codex: имена MCP-серверов из config.toml — только с command или url', () => {
  const toml = [
    'model = "gpt-5.6-terra"',
    '# [mcp_servers.commented]',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-github", "--flag=x"]',
    '',
    '[mcp_servers.github.env]',
    'GITHUB_TOKEN = "x"',
    '',
    '[mcp_servers."docs-http"]',
    "url = 'https://example.com/mcp' # комментарий",
    '',
    '[mcp_servers.half]',
    'enabled = false',
    '',
    '[mcp_servers]',
    'inline = { command = "node", args = ["server.js"] }',
    'remote = {url="https://example.com"}',
    'broken = { args = ["x"] }',
    'dotted.command = "uvx"',
    '',
    '[profiles.work]',
    'model = "gpt-5.5"',
    'description = """',
    '[mcp_servers.fake]',
    'command = "в многострочной строке"',
    '"""',
    '[[skills]]',
    'command = "не сервер"',
  ].join('\r\n')
  assert.deepEqual(codexMcpServerNames(toml).sort(), ['docs-http', 'dotted', 'github', 'inline', 'remote'])
  assert.deepEqual(codexMcpServerNames('mcp_servers.top.command = "x"\n'), ['top'], 'ключ через точку до первой таблицы')
  assert.deepEqual(codexMcpServerNames(''), [])
  assert.deepEqual(codexMcpServerNames('[mcp_servers.half]\nenabled = true\n'), [], 'без command и url выключатель создал бы запись, которую Codex отвергнет')
})

test('codex: turn/start — снимки localImage перед текстом, глубина по выбору', () => {
  assert.deepEqual(
    buildTurnStartParams({ threadId: 'thr_1', text: 'Что на экране?', imagePaths: ['C:\\t\\shot-1.jpg', 'C:\\t\\shot-2.jpg'], effort: 'medium' }),
    {
      threadId: 'thr_1',
      input: [
        { type: 'localImage', path: 'C:\\t\\shot-1.jpg' },
        { type: 'localImage', path: 'C:\\t\\shot-2.jpg' },
        { type: 'text', text: 'Что на экране?' },
      ],
      effort: 'medium',
    },
  )
  assert.deepEqual(buildTurnStartParams({ threadId: 'thr_1', text: 'Вопрос' }), {
    threadId: 'thr_1',
    input: [{ type: 'text', text: 'Вопрос' }],
  })
})

test('codex: id нити и хода из ответов thread/start и turn/start', () => {
  const threadStart = JSON.parse(
    '{"thread":{"id":"67e55044-10b1-426f-9247-bb680e5fe0c8","ephemeral":true,"status":{"type":"idle"},"turns":[]},"model":"gpt-5.6-terra","modelProvider":"openai","serviceTier":null,"cwd":"C:\\\\data","approvalPolicy":"never","approvalsReviewer":"user","sandbox":{"type":"readOnly"},"reasoningEffort":null}',
  )
  assert.equal(threadIdOf(threadStart), '67e55044-10b1-426f-9247-bb680e5fe0c8')
  assert.equal(turnIdOf({ turn: { id: 'turn_7', items: [], status: 'inProgress', error: null } }), 'turn_7')
  assert.equal(threadIdOf(null), undefined)
  assert.equal(turnIdOf({ turn: null }), undefined)
})

test('codex: песочница не узнана сервером — повтор со старым написанием', () => {
  assert.equal(isSandboxCasingError('Invalid request: unknown variant `read-only`, expected one of `readOnly`, `workspaceWrite`, `dangerFullAccess`'), true)
  assert.equal(isSandboxCasingError('Not initialized'), false)
})

/* ---------- глубина ---------- */

test('codex: глубина — «сразу» low, «думает» выбранная или medium, с поправкой на модель', () => {
  assert.equal(pickEffort(false, 'high'), 'low')
  assert.equal(pickEffort(true, undefined), 'medium')
  assert.equal(pickEffort(true, 'default'), 'medium')
  assert.equal(pickEffort(true, 'xhigh'), 'xhigh')
  // Модель без настройки глубины — не шлём вовсе
  assert.equal(pickEffort(true, 'high', null), undefined)
  assert.equal(pickEffort(true, 'high', []), undefined)
  // Неподдержанная — к ближайшей, при равенстве к меньшей
  assert.equal(pickEffort(true, 'max', ['low', 'medium', 'high', 'xhigh']), 'xhigh')
  assert.equal(pickEffort(true, 'medium', ['low', 'high']), 'low')
  assert.equal(pickEffort(false, undefined, ['medium', 'high']), 'medium')
})

/* ---------- модели ---------- */

const MODEL_LIST = {
  data: [
    {
      id: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol',
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: 'GPT-5.6-Sol',
      description: 'Frontier model for complex coding and reasoning.',
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses' },
        { reasoningEffort: 'medium', description: 'Balanced' },
        { reasoningEffort: 'high', description: 'Deeper reasoning' },
        { reasoningEffort: 'xhigh', description: 'Extra deep' },
        { reasoningEffort: 'max', description: 'Maximum reasoning' },
        { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
      ],
      defaultReasoningEffort: 'low',
      inputModalities: ['text', 'image'],
      supportsPersonality: true,
      multiAgentVersion: 'v2',
      additionalSpeedTiers: ['fast', 'ultrafast'],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
    },
    {
      id: 'gpt-7-nova',
      model: 'gpt-7-nova',
      displayName: 'GPT-7 Nova',
      description: 'Next generation model. Available to eligible accounts only, rolling out gradually over the coming weeks.',
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'none', description: '' }],
      defaultReasoningEffort: 'none',
      inputModalities: ['text'],
      isDefault: false,
    },
    {
      id: 'codex-auto-review',
      model: 'codex-auto-review',
      displayName: 'Auto review',
      description: 'Internal approval-review model',
      hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
      defaultReasoningEffort: 'medium',
      isDefault: false,
    },
  ],
  nextCursor: 'page-2',
}

test('codex: model/list — русские подписи из каталога, глубины и снимки от сервиса, скрытые не показываем', () => {
  const known = providerById('codex').models
  const { models, nextCursor } = parseModelList(MODEL_LIST, known)
  assert.equal(nextCursor, 'page-2')
  assert.deepEqual(
    models.map((m) => m.id),
    ['gpt-5.6-sol', 'gpt-7-nova'],
  )
  const sol = models[0]!
  assert.equal(sol.name, 'GPT-5.6 Sol')
  assert.equal(sol.short, 'Sol')
  assert.equal(sol.hint, 'сильная')
  assert.deepEqual(sol.efforts, ['low', 'medium', 'high', 'xhigh', 'max'], 'ultra — подагенты, окну не нужна')
  assert.equal(sol.images, true)

  const nova = models[1]!
  assert.equal(nova.name, 'GPT-7 Nova')
  assert.equal(nova.hint, 'Next generation model')
  assert.equal(nova.efforts, null, 'только none — глубина не настраивается')
  assert.equal(nova.images, false)

  // Нет inputModalities — по умолчанию Codex это text+image; нет глубин — из каталога
  const legacy = parseModelList({ data: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }], nextCursor: null }, known)
  assert.equal(legacy.nextCursor, null)
  assert.equal(legacy.models[0]!.images, true)
  assert.deepEqual(legacy.models[0]!.efforts, ['low', 'medium', 'high', 'xhigh'])

  assert.deepEqual(parseModelList(undefined), { models: [], nextCursor: null })
})

/* ---------- вход ---------- */

test('codex: account/read — тариф без почты, ключ API, нет входа', () => {
  assert.deepEqual(parseAccountRead({ account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }, requiresOpenaiAuth: true }), {
    state: 'ok',
    account: 'ChatGPT Plus',
  })
  assert.deepEqual(parseAccountRead({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }), { state: 'ok', account: 'ключ API' })
  assert.deepEqual(parseAccountRead({ account: null, requiresOpenaiAuth: true }), { state: 'not-logged-in' })
  assert.deepEqual(parseAccountRead({ account: null, requiresOpenaiAuth: false }), { state: 'ok' })
  assert.equal(parseAccountRead('мусор').state, 'unknown')
})

test('codex: login status — код выхода и текст в stderr', () => {
  assert.deepEqual(parseLoginStatus(0, '', 'Logged in using ChatGPT\n'), { state: 'ok', account: 'ChatGPT' })
  assert.deepEqual(parseLoginStatus(0, '', 'Logged in using an API key - sk-proj-***ABCD\n'), { state: 'ok', account: 'ключ API' })
  assert.deepEqual(parseLoginStatus(1, '', 'Not logged in\n'), { state: 'not-logged-in' })
  assert.equal(parseLoginStatus(2, '', "error: unrecognized subcommand 'login'\n").state, 'unknown')
})

test('codex: версия из userAgent и из --version', () => {
  assert.equal(versionFrom('podskazych/0.154.0 (Windows 10.0.26200; x86_64) vscode/0.1.0'), '0.154.0')
  assert.equal(versionFrom('codex-cli 0.155.0-alpha.4'), '0.155.0-alpha.4')
  assert.equal(versionFrom(undefined), undefined)
})

/* ---------- ошибки ---------- */

test('codex: codexErrorInfo — строкой, объектом с кодом HTTP, в любом регистре', () => {
  assert.deepEqual(errorInfoOf('usageLimitExceeded'), { name: 'usagelimitexceeded' })
  assert.deepEqual(errorInfoOf({ httpConnectionFailed: { httpStatusCode: 502 } }), { name: 'httpconnectionfailed', status: 502 })
  assert.deepEqual(errorInfoOf({ httpStatusCode: 429 }), { status: 429 })
  assert.deepEqual(errorInfoOf(null), {})
})

test('codex: виды ошибок хода → LlmError', () => {
  const limit = classifyTurnError({
    message: "You've hit your usage limit. Upgrade to Pro or try again at 5:32 PM.",
    codexErrorInfo: 'usageLimitExceeded',
    additionalDetails: null,
  })
  assert.equal(limit.kind, 'rate-limit')
  assert.equal(limit.provider, 'codex')
  assert.match(limit.message, /^Лимит ChatGPT исчерпан\. You've hit your usage limit/)

  assert.equal(classifyTurnError({ message: 'Rate limit reached', codexErrorInfo: 'RateLimitExceeded' }).kind, 'rate-limit')
  assert.equal(classifyTurnError({ message: 'Your access token could not be refreshed', codexErrorInfo: 'unauthorized' }).kind, 'not-logged-in')
  assert.equal(classifyTurnError({ message: 'unexpected status 429', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 429 } } }).kind, 'rate-limit')
  assert.equal(classifyTurnError({ message: 'unexpected status 401', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }).kind, 'not-logged-in')
  assert.equal(classifyTurnError({ message: 'stream disconnected before completion', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }).kind, 'network')

  const overflow = classifyTurnError({ message: 'Codex ran out of room in the model context window.', codexErrorInfo: 'contextWindowExceeded' })
  assert.equal(overflow.kind, 'unknown')
  assert.equal(isContextOverflow(overflow), true)
  assert.equal(isContextOverflow(limit), false)

  const model = classifyTurnError({
    message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
    codexErrorInfo: 'badRequest',
  })
  assert.equal(model.kind, 'model-unavailable')
  assert.equal(classifyTurnError({ message: 'This model does not support image input.', codexErrorInfo: 'badRequest' }).kind, 'images-unsupported')

  const other = classifyTurnError({ message: 'Something odd', codexErrorInfo: 'other' })
  assert.equal(other.kind, 'unknown')
  assert.equal(other.message, 'Codex CLI вернул ошибку: Something odd')
  assert.equal(classifyTurnError(undefined).message, 'Codex CLI вернул ошибку')
})

test('codex: ошибка без вида — по тексту (ответ RPC, старая версия)', () => {
  assert.equal(errorFromText('model "gpt-9" not found').kind, 'model-unavailable')
  assert.equal(errorFromText('Not logged in').kind, 'not-logged-in')
  assert.equal(errorFromText('error sending request for url (https://chatgpt.com/backend-api/codex/responses)').kind, 'network')
})

test('codex: встречные запросы — отказ в одобрении, остальное ошибкой', () => {
  assert.deepEqual(serverRequestReply('item/commandExecution/requestApproval'), { decision: 'decline' })
  assert.deepEqual(serverRequestReply('item/fileChange/requestApproval'), { decision: 'decline' })
  assert.equal(serverRequestReply('mcpServer/elicitation/request'), undefined)
})

/* ---------- ход целиком: JSONL → JSON-RPC → роутер → очередь ---------- */

function harness() {
  let token = 0
  const sent: string[] = []
  const ends: TurnEnd[] = []
  let router: CodexTurnRouter
  const queue = new TurnQueue<string>({
    provider: 'codex',
    label: 'Codex CLI',
    transport: {
      ensure: () => {},
      // Как codex.ts: открыть ход до turn/start, id хода придёт ответом или событием.
      send: (text) => {
        token = router.begin()
        router.threadId = 'thr_1'
        sent.push(text)
      },
      kill: () => router.abandon(),
    },
  })
  router = new CodexTurnRouter(queue, (e) => ends.push(e))
  const rpc = new JsonRpcConnection({ withVersion: false, write: () => {}, onNotification: (m, p) => router.handle(m, p) })
  const feed = (...lines: string[]) => {
    for (const l of lines) assert.equal(rpc.handleLine(l), true, l)
  }
  return { queue, router, feed, sent, ends, token: () => token }
}

const ev = (method: string, params: Record<string, unknown>) => JSON.stringify({ method, params })
const turnObj = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  items: [],
  itemsView: 'notLoaded',
  status,
  error: null,
  startedAt: 1757851200,
  completedAt: status === 'inProgress' ? null : 1757851209,
  durationMs: status === 'inProgress' ? null : 9500,
  ...extra,
})

test('codex: ход — размышления, два сообщения абзацами, завершение', async () => {
  const h = harness()
  const deltas: string[] = []
  let thinking = 0
  const answer = h.queue.ask('Что такое регистр накопления?', { onDelta: (d) => deltas.push(d), onThinking: () => thinking++ })
  assert.deepEqual(h.sent, ['Что такое регистр накопления?'])

  h.feed(
    // Уведомления опережают ответ на turn/start: id хода назначает первое событие.
    ev('turn/started', { threadId: 'thr_1', turn: turnObj('turn_1', 'inProgress') }),
    ev('item/started', { item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] }, threadId: 'thr_1', turnId: 'turn_1', startedAtMs: 1757851200100 }),
    ev('item/reasoning/summaryTextDelta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'rs_1', delta: '**Recalling registers**', summaryIndex: 0 }),
    ev('item/started', { item: { type: 'agentMessage', id: 'msg_1', text: '', phase: null, memoryCitation: null }, threadId: 'thr_1', turnId: 'turn_1', startedAtMs: 1757851201000 }),
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'msg_1', delta: '- Регистр накопления хранит ' }),
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'msg_1', delta: 'остатки и обороты.' }),
    // Событие чужой нити — не наше.
    ev('item/agentMessage/delta', { threadId: 'thr_other', turnId: 'turn_9', itemId: 'msg_9', delta: 'ЧУЖОЕ' }),
    ev('thread/tokenUsage/updated', { threadId: 'thr_1', turnId: 'turn_1', tokenUsage: { total: { inputTokens: 5210 } } }),
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'msg_2', delta: '- Виды: остатки и обороты.' }),
    ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_1', 'completed') }),
  )
  // Ответ на turn/start пришёл позже завершения — ход уже закрыт, ничего не меняет.
  h.router.started(h.token(), 'turn_1')

  assert.equal(await answer, '- Регистр накопления хранит остатки и обороты.\n\n- Виды: остатки и обороты.')
  assert.equal(deltas.join(''), '- Регистр накопления хранит остатки и обороты.\n\n- Виды: остатки и обороты.')
  assert.ok(thinking >= 2)
  assert.deepEqual(h.ends, [{ turnId: 'turn_1' }])
  assert.equal(h.queue.busy, false)
})

test('codex: хвост завершённого хода не попадает в следующий вопрос', async () => {
  const h = harness()
  const first = h.queue.ask('первый', { onDelta: () => {} })
  h.router.started(h.token(), 'turn_1')
  h.feed(
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'msg_1', delta: 'ответ 1' }),
    ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_1', 'completed') }),
  )
  assert.equal(await first, 'ответ 1')

  const second = h.queue.ask('второй', { onDelta: () => {} })
  h.feed(
    // Позднее событие первого хода, пока id второго ещё неизвестен, — не назначает его.
    ev('item/completed', { item: { type: 'agentMessage', id: 'msg_1', text: 'ответ 1' }, threadId: 'thr_1', turnId: 'turn_1', completedAtMs: 1 }),
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'msg_1', delta: 'ЛИШНЕЕ' }),
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_2', itemId: 'msg_5', delta: 'ответ 2' }),
    ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_2', 'completed') }),
  )
  assert.equal(await second, 'ответ 2')
})

test('codex: без дельт ответ берётся из item/completed', async () => {
  const h = harness()
  const answer = h.queue.ask('вопрос', { onDelta: () => {} })
  h.router.started(h.token(), 'turn_1')
  h.feed(
    ev('item/completed', { item: { type: 'agentMessage', id: 'msg_1', text: 'Готовый ответ', phase: 'final_answer' }, threadId: 'thr_1', turnId: 'turn_1', completedAtMs: 1 }),
    ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_1', 'completed') }),
  )
  assert.equal(await answer, 'Готовый ответ')
})

test('codex: error с willRetry не рвёт ход, без него — вопрос падает сразу, поздний turn/completed игнорируется', async () => {
  const h = harness()
  const first = h.queue.ask('первый', { onDelta: () => {} })
  const second = h.queue.ask('второй', { onDelta: () => {} })
  h.router.started(h.token(), 'turn_1')
  h.feed(
    ev('error', {
      error: { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null },
      willRetry: true,
      threadId: 'thr_1',
      turnId: 'turn_1',
    }),
  )
  assert.equal(h.queue.busy, true)
  h.feed(
    ev('error', {
      error: { message: "You've hit your usage limit. Try again at 5:32 PM.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
      willRetry: false,
      threadId: 'thr_1',
      turnId: 'turn_1',
    }),
  )
  await assert.rejects(first, (e: unknown) => e instanceof LlmError && e.kind === 'rate-limit')
  assert.equal(h.ends[0]?.error?.kind, 'rate-limit')
  // Очередь сразу отправила второй вопрос; поздний turn/completed первого его не закрывает.
  assert.deepEqual(h.sent, ['первый', 'второй'])
  h.feed(
    ev('turn/completed', {
      threadId: 'thr_1',
      turn: turnObj('turn_1', 'failed', { error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' } }),
    }),
  )
  assert.equal(h.queue.busy, true)
  h.feed(
    ev('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_2', itemId: 'm', delta: 'ok' }),
    ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_2', 'completed') }),
  )
  assert.equal(await second, 'ok')
})

test('codex: turn/completed failed и interrupted — вопрос падает с понятной ошибкой', async () => {
  const h = harness()
  const a = h.queue.ask('а', { onDelta: () => {} })
  h.router.started(h.token(), 'turn_1')
  h.feed(
    ev('turn/completed', {
      threadId: 'thr_1',
      turn: turnObj('turn_1', 'failed', { error: { message: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: 'badRequest', additionalDetails: null } }),
    }),
  )
  await assert.rejects(a, (e: unknown) => e instanceof LlmError && e.kind === 'model-unavailable')

  const b = h.queue.ask('б', { onDelta: () => {} })
  h.router.started(h.token(), 'turn_2')
  h.feed(ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_2', 'interrupted') }))
  await assert.rejects(b, /прервал ответ/)
})

test('codex: kill бросает ход — его события больше не доходят, устаревший вопрос не отправляется', async () => {
  const h = harness()
  const a = h.queue.ask('а', { onDelta: () => {} })
  const b = h.queue.ask('б', { onDelta: () => {}, isStale: () => true })
  h.router.started(h.token(), 'turn_1')
  assert.equal(h.router.activeTurnId, 'turn_1')
  h.queue.stop(new LlmError('cancelled', 'codex'))
  await assert.rejects(a, (e: unknown) => e instanceof LlmError && e.kind === 'cancelled')
  await assert.rejects(b, (e: unknown) => e instanceof LlmError && e.kind === 'cancelled')
  assert.equal(h.router.active, false)
  assert.equal(h.router.handle('item/agentMessage/delta', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'm', delta: 'x' }), false)

  // Устаревший в очереди — SkippedError, в модель не уходит
  const c = h.queue.ask('в', { onDelta: () => {} })
  const d = h.queue.ask('г', { onDelta: () => {}, isStale: () => true })
  h.router.started(h.token(), 'turn_3')
  h.feed(ev('turn/completed', { threadId: 'thr_1', turn: turnObj('turn_3', 'completed') }))
  assert.equal(await c, '')
  await assert.rejects(d, (e: unknown) => e instanceof SkippedError)
  assert.deepEqual(h.sent, ['а', 'в'])
})
