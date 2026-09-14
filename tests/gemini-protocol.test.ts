import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGY_SETTINGS_HINT,
  AgyTurn,
  StartGate,
  agyArgs,
  agyEffort,
  agyPermissionProblem,
  agyStderrErrors,
  agyUserLine,
  classifyAgyError,
  composeAgyMessage,
  isSandboxRejection,
  looksLikeLoginPrompt,
  parseJsonc,
  missingTail,
  parseAgyLine,
  parseAgyModels,
  quickModel,
  type AgyOutcome,
} from '../src/main/llm/providers/geminiProtocol.ts'

/** Приёмник событий хода: записывает, что разбор отдал бы очереди. */
function sink() {
  const log: string[] = []
  let text = ''
  return {
    log,
    text: () => text,
    s: {
      delta: (t: string) => {
        text += t
        log.push(`delta:${t}`)
      },
      blockBreak: () => {
        if (text) text += '\n\n'
        log.push('break')
      },
      thinking: () => log.push('thinking'),
      tool: (name: string) => log.push(`tool:${name}`),
    },
  }
}

function run(lines: string[]) {
  const turn = new AgyTurn()
  const out = sink()
  let outcome: AgyOutcome | null = null
  for (const line of lines) {
    const ev = parseAgyLine(line)
    if (!ev) continue
    outcome = turn.handle(ev, out.s) ?? outcome
  }
  return { ...out, outcome, turn }
}

const CID = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a'

test('agy: пример потока из документации — init, шаги, result', () => {
  const lines = [
    `{"event":"init","conversation_id":"${CID}","init":{"cwd":"/home/user/project","tools":["ask_permission","run_command"],"permission_mode":"request-review"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"Git rebase rewrites history.\\n","duration_seconds":6.28}}`,
    `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.53}}`,
    `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","response":"Git rebase rewrites history.\\n","duration_seconds":6.88,"num_turns":1}}`,
  ]
  const init = parseAgyLine(lines[0]!)
  assert.deepEqual(init, { type: 'init', conversationId: CID, model: undefined })
  const r = run(lines)
  assert.deepEqual(r.outcome, { ok: true, response: 'Git rebase rewrites history.\n' })
  assert.equal(r.text(), 'Git rebase rewrites history.\n')
  assert.ok(!r.log.includes('thinking'), 'служебные DONE-шаги — не размышления')
})

test('agy: ACTIVE-куски и DONE-хвост складываются, как обещает документация', () => {
  const r = run([
    '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello"}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n"}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"Hello\\n"}}',
  ])
  assert.deepEqual(r.log, ['delta:Hello', 'delta:\n'])
  assert.deepEqual(r.outcome, { ok: true, response: 'Hello\n' })
})

test('agy: DONE с полным текстом шага не дублирует уже написанное', () => {
  const full = 'Первый тезис — прямой ответ. Второй тезис.'
  const r = run([
    '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Первый тезис — прямой ответ."}}',
    `{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":${JSON.stringify(full)}}}`,
    `{"event":"result","result":{"status":"SUCCESS","response":${JSON.stringify(full)}}}`,
  ])
  assert.equal(r.text(), full)
})

test('agy: новый шаг ответа отделяется абзацем, инструмент сообщается один раз', () => {
  const r = run([
    '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Посмотрю."}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"search_web"}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"search_web"}}',
    '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"Ответ."}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"Ответ."}}',
  ])
  assert.deepEqual(r.log, ['delta:Посмотрю.', 'tool:search_web', 'break', 'delta:Ответ.'])
  assert.equal(r.text(), 'Посмотрю.\n\nОтвет.')
})

test('agy: шаг ответа без текста — модель думает', () => {
  const r = run(['{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response"}}'])
  assert.deepEqual(r.log, ['thinking'])
  assert.equal(r.outcome, null)
})

test('agy: дельт не было — ответ берётся из result, потерянный хвост дописывается', () => {
  const none = run(['{"event":"result","result":{"status":"SUCCESS","response":"Готов."}}'])
  assert.deepEqual(none.log, ['delta:Готов.'])
  const tail = run([
    '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Нач"}}',
    '{"event":"result","result":{"status":"SUCCESS","response":"Начало и конец"}}',
  ])
  assert.equal(tail.text(), 'Начало и конец')
  assert.equal(missingTail('Другое', 'Начало'), '', 'чужой текст не дописываем')
})

test('agy: ERROR в result — вид ошибки по тексту', () => {
  const quota = run(['{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED: weekly quota reached"}}'])
  assert.deepEqual(quota.outcome, { ok: false, kind: 'rate-limit', detail: 'RESOURCE_EXHAUSTED: weekly quota reached' })
  const model = run(['{"event":"result","result":{"status":"ERROR","error":"gemini-9 is not recognized as a known model"}}'])
  assert.equal(model.outcome?.ok === false && model.outcome.kind, 'model-unavailable')
  const bare = run(['{"event":"result","result":{"status":"INVALID"}}'])
  assert.equal(bare.outcome?.ok, false)
})

test('agy: сетевая ошибка после законченного ответа — не сбой, после оборванного — сбой', () => {
  const net = 'There was a network issue connecting to the server, please try again.'
  const complete = run([
    '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Complete answer."}}',
    `{"event":"result","result":{"status":"ERROR","response":"Complete answer.","error":"${net}"}}`,
  ])
  assert.deepEqual(complete.outcome, { ok: true, response: 'Complete answer.' })
  const partial = run([
    '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Earlier answer."}}',
    '{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"Partial"}}',
    `{"event":"result","result":{"status":"ERROR","response":"Partial","error":"${net}"}}`,
  ])
  assert.equal(partial.outcome?.ok, false)
})

test('agy: строки не JSON — таймаут печати и приглашение ко входу узнаются, прочее — шум', () => {
  assert.deepEqual(run(['Error: timed out waiting for response']).outcome, {
    ok: false,
    kind: 'timeout',
    detail: 'Error: timed out waiting for response',
  })
  const login = run(['Please sign in: https://accounts.google.com/o/oauth2/auth?x=1'])
  assert.equal(login.outcome?.ok === false && login.outcome.kind, 'not-logged-in')
  assert.equal(run(['I0528 13:36:23 printmode.go:130] sending message']).outcome, null)
  assert.equal(looksLikeLoginPrompt('Login succeeded'), false, 'без ссылки — не приглашение')
  assert.equal(parseAgyLine('   '), null)
  assert.deepEqual(parseAgyLine('{"event":"future_event"}'), { type: 'other' })
})

test('agy: сообщение в stdin — одна строка, системный промпт только в первом, «/» не уходит командой', () => {
  const line = agyUserLine(composeAgyMessage('Вопрос: что такое регистр?', 'СИСТЕМА'))
  assert.ok(line.endsWith('\n'))
  assert.equal(line.indexOf('\n'), line.length - 1, 'перевод строки внутри текста экранирован')
  assert.deepEqual(JSON.parse(line), { event: 'user', message: { content: 'СИСТЕМА\n\nВопрос: что такое регистр?' } })
  assert.equal(composeAgyMessage('обычный'), 'обычный')
  assert.ok(!composeAgyMessage('/usage').startsWith('/'), 'незнакомая слеш-команда погасила бы сессию')
})

test('agy: аргументы запуска — без -p и без снятия разрешений', () => {
  const args = agyArgs({ model: 'gemini-3.8-flash-high', effort: 'high' })
  assert.ok(!args.includes('-p') && !args.includes('--print'), '-p требует текст промпта аргументом')
  assert.ok(!args.some((a) => /dangerously|skip-permissions|yolo/i.test(a)))
  assert.deepEqual(args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json'])
  assert.deepEqual(args.slice(-4), ['--model', 'gemini-3.8-flash-high', '--effort', 'high'])
  assert.ok(!agyArgs({}).includes('--model'), 'пустая модель — решает сам agy')
  assert.ok(agyArgs({ sandbox: true }).includes('--sandbox'), '--sandbox из справочника флагов headless')
  assert.ok(!agyArgs({ sandbox: false }).includes('--sandbox'))
})

test('agy: запуск с --sandbox не удался — узнаём, чтобы повторить без флага; прочие сбои — нет', () => {
  assert.equal(isSandboxRejection('Error: unknown flag: --sandbox'), true)
  assert.equal(isSandboxRejection('terminal sandbox is not supported on this platform'), true)
  assert.equal(isSandboxRejection('Error: model not found'), false)
  assert.equal(isSandboxRejection('sandbox enabled'), false, 'упоминание песочницы без сбоя — не отказ')
})

test('agy: настройки разрешений — запускаемся только с режимом, где без спроса ничего не выполнится', () => {
  assert.equal(agyPermissionProblem(null), null, 'файла нет — умолчание request-review')
  assert.equal(agyPermissionProblem('  '), null)
  assert.equal(agyPermissionProblem('{"toolPermission":"request-review"}'), null)
  assert.equal(agyPermissionProblem('{"toolPermission":"strict","theme":"dark"}'), null)
  assert.equal(agyPermissionProblem('{"theme":"dark"}'), null, 'режим не задан — умолчание agy')

  const always = agyPermissionProblem('{"toolPermission":"always-proceed"}')
  assert.match(always ?? '', /always-proceed/)
  assert.match(always ?? '', /без спроса/)
  assert.ok(always?.includes(AGY_SETTINGS_HINT), 'текст говорит, где поправить')
  assert.match(agyPermissionProblem('{"toolPermission":"proceed-in-sandbox"}') ?? '', /песочниц/)
  assert.match(agyPermissionProblem('{"toolPermission":"yolo-2027"}') ?? '', /неизвестен/, 'незнакомый режим — не рискуем')
  assert.match(agyPermissionProblem('{"toolPermission":true}') ?? '', /true/)

  const allowCmd = agyPermissionProblem('{"toolPermission":"request-review","permissions":{"allow":["command(git status)","read_file(docs/*)","write_file(*)"]}}')
  assert.match(allowCmd ?? '', /command\(git status\), write_file\(\*\)/)
  assert.ok(!allowCmd?.includes('read_file(docs'), 'точечное чтение не опасно')
  assert.match(agyPermissionProblem('{"permissions":{"allow":["read_url(*)"]}}') ?? '', /read_url/, 'чтение любого адреса — тоже нет')
  assert.equal(agyPermissionProblem('{"permissions":{"allow":["read_url(docs.example.com)"]}}'), null)

  assert.match(agyPermissionProblem('{"toolPermission": ', undefined) ?? '', /не читаются как JSON/)
  assert.match(agyPermissionProblem(null, 'EACCES') ?? '', /Не удалось прочитать/)
  // Файл, поправленный руками в Блокноте: BOM, комментарии, висячая запятая.
  const bom = String.fromCharCode(0xfeff)
  assert.equal(agyPermissionProblem(`${bom}{\n // режим\n "toolPermission": "strict", /* ок */\n}`), null)
  assert.deepEqual(parseJsonc('{"a": "// не комментарий", "b": [1,],}'), { a: '// не комментарий', b: [1] })
})

test('agy: старт процесса — после гашения новый вопрос не присоединяется к брошенному старту', async () => {
  const gate = new StartGate<string>()
  const starts: Array<{ gen: number; resolve: (v: string) => void }> = []
  const start = (gen: number) =>
    new Promise<string>((resolve, reject) => {
      starts.push({
        gen,
        resolve: (v) => (gate.isCurrent(gen) ? resolve(v) : reject(new Error('cancelled'))),
      })
    })

  const a = gate.join(start)
  assert.equal(gate.join(start), a, 'пока старт идёт, все ждут его')
  assert.equal(starts.length, 1)

  gate.cancel()
  assert.equal(gate.starting, false)
  const b = gate.join(start)
  assert.notEqual(b, a, 'вопрос после гашения поднимает свой процесс')
  assert.equal(starts.length, 2)

  starts[0]!.resolve('старый')
  await assert.rejects(a, /cancelled/)
  assert.equal(gate.starting, true, 'поздний конец брошенного старта не стирает новый')
  starts[1]!.resolve('новый')
  assert.equal(await b, 'новый')
  assert.equal(gate.starting, false)
})

test('agy: «сразу» — -low того же семейства, только если такая модель известна', () => {
  const known = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']
  assert.equal(quickModel('gemini-3.8-flash-high', known), 'gemini-3.8-flash-low')
  assert.equal(quickModel('gemini-3.8-flash-medium', known), 'gemini-3.8-flash-low')
  assert.equal(quickModel('gemini-3.1-pro-high', known), 'gemini-3.1-pro-high', 'неизвестный slug не выдумываем')
  assert.equal(quickModel('claude-opus-4-6-thinking', known), 'claude-opus-4-6-thinking')
  assert.equal(agyEffort(false, 'high', 'gemini-3.8-flash-high'), 'low')
  assert.equal(agyEffort(true, 'xhigh', 'x'), 'high')
  assert.equal(agyEffort(true, 'default', 'gemini-3.8-flash-medium'), 'medium', 'по умолчанию — глубина из slug')
  assert.equal(agyEffort(true, undefined, 'claude-opus-4-6-thinking'), undefined)
})

test('agy models: формат «slug<TAB>подпись», старый построчный и мусор', () => {
  const tab = parseAgyModels('gemini-3.6-flash-high\tGemini 3.6 Flash (High)\r\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\textra\ngemini-3.6-flash-high\tдубль\n')
  assert.deepEqual(
    tab.map((m) => [m.id, m.name, m.hint, m.short]),
    [
      ['gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)', 'думает глубже', 'Flash'],
      ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', 'думает', 'Opus'],
    ],
  )
  assert.ok(tab.every((m) => m.efforts === null && m.images === false))
  const legacy = parseAgyModels('Available models:\nGemini 3.5 Flash (Medium)\n\nGPT-OSS 120B (Medium)\n')
  assert.deepEqual(legacy.map((m) => m.id), ['Gemini 3.5 Flash (Medium)', 'GPT-OSS 120B (Medium)'])
  assert.equal(legacy[0]!.short, 'Flash M')
  assert.deepEqual(parseAgyModels('Error: please sign in at https://example.com\n'), [])
  assert.deepEqual(parseAgyModels('   \n\t\n'), [])
  assert.deepEqual(parseAgyModels('[{"slug":"gemini-3.8-flash-low","label":"Gemini 3.8 Flash (Low)"}]').map((m) => m.id), ['gemini-3.8-flash-low'])
})

test('agy: из stderr в разбор ошибок идут не информационные строки glog', () => {
  const tail = 'I0528 13:36:23.318877 73304 oauth.go:88] oauth token refreshed\r\nW0528 13:36:24.1 1 proxy.go:1] no proxy\nE0528 13:36:25.2 1 printmode.go:289] model not found\npanic: boom\n'
  assert.equal(agyStderrErrors(tail), 'E0528 13:36:25.2 1 printmode.go:289] model not found\npanic: boom')
  assert.equal(classifyAgyError(agyStderrErrors('I0528 1 1 a.go:1] oauth ok')), 'unknown', 'oauth в диагностике — не «нужен вход»')
})

test('agy: вид ошибки по тексту', () => {
  assert.equal(classifyAgyError('429 Too Many Requests'), 'rate-limit')
  assert.equal(classifyAgyError('model gemini-x not found for this login'), 'model-unavailable')
  assert.equal(classifyAgyError('You are not logged in'), 'not-logged-in')
  assert.equal(classifyAgyError('dial tcp: connection refused'), 'network')
  assert.equal(classifyAgyError('context deadline exceeded'), 'timeout')
  assert.equal(classifyAgyError('something odd'), 'unknown')
})
