import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JsonRpcConnection, RpcRemoteError } from '../src/main/llm/jsonrpc.ts'

function pair(withVersion: boolean, extra: Partial<ConstructorParameters<typeof JsonRpcConnection>[0]> = {}) {
  const out: Record<string, unknown>[] = []
  const rpc = new JsonRpcConnection({
    withVersion,
    write: (line) => {
      assert.ok(line.endsWith('\n'), 'сообщение — одна строка с переводом строки')
      out.push(JSON.parse(line) as Record<string, unknown>)
    },
    ...extra,
  })
  return { rpc, out }
}

const flush = () => new Promise<void>((r) => setImmediate(r))

test('jsonrpc: запрос и ответ, без поля jsonrpc (Codex app-server)', async () => {
  const { rpc, out } = pair(false)
  const p = rpc.request<{ threadId: string }>('thread/start', { model: 'gpt-5.6-terra' })
  assert.deepEqual(out[0], { id: 1, method: 'thread/start', params: { model: 'gpt-5.6-terra' } })
  assert.equal(rpc.handleLine('{"id":1,"result":{"threadId":"t1"}}'), true)
  assert.deepEqual(await p, { threadId: 't1' })
  assert.equal(rpc.pendingCount, 0)
})

test('jsonrpc: с полем jsonrpc (ACP), уведомление без params', () => {
  const { rpc, out } = pair(true)
  rpc.notify('initialized')
  void rpc.request('initialize', { protocolVersion: 1 })
  assert.deepEqual(out, [
    { jsonrpc: '2.0', method: 'initialized' },
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
  ])
})

test('jsonrpc: ошибка сервера — RpcRemoteError с кодом', async () => {
  const { rpc } = pair(true)
  const p = rpc.request('session/prompt', {})
  rpc.handleLine('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required"}}')
  await assert.rejects(p, (e: unknown) => e instanceof RpcRemoteError && e.code === -32000 && e.message === 'Authentication required')
})

test('jsonrpc: уведомления уходят обработчику, мусор игнорируется', () => {
  const got: Array<[string, unknown]> = []
  const { rpc } = pair(false, { onNotification: (m, p) => got.push([m, p]) })
  assert.equal(rpc.handleLine('Loading config...'), false)
  assert.equal(rpc.handleLine('{битый'), false)
  assert.equal(rpc.handleLine('{"method":"item/agentMessage/delta","params":{"delta":"При"}}'), true)
  assert.deepEqual(got, [['item/agentMessage/delta', { delta: 'При' }]])
})

test('jsonrpc: встречный запрос — ответ результатом, ошибкой или «метод не найден»', async () => {
  const { rpc, out } = pair(true, {
    onRequest: async (method) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      if (method === 'fs/read_text_file') throw new RpcRemoteError(-32002, 'запрещено')
      return undefined
    },
  })
  rpc.handleLine('{"jsonrpc":"2.0","id":"a","method":"session/request_permission","params":{}}')
  rpc.handleLine('{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{}}')
  rpc.handleLine('{"jsonrpc":"2.0","id":8,"method":"x/other"}')
  await flush()
  assert.deepEqual(out, [
    { jsonrpc: '2.0', id: 'a', result: { outcome: { outcome: 'cancelled' } } },
    { jsonrpc: '2.0', id: 7, error: { code: -32002, message: 'запрещено' } },
    { jsonrpc: '2.0', id: 8, result: null },
  ])

  const bare = pair(false)
  bare.rpc.handleLine('{"id":3,"method":"item/commandExecution/requestApproval","params":{}}')
  await flush()
  assert.deepEqual(bare.out, [{ id: 3, error: { code: -32601, message: 'Method not found: item/commandExecution/requestApproval' } }])
})

test('jsonrpc: close отклоняет ждущие, новые запросы сразу падают', async () => {
  const { rpc } = pair(false)
  const p = rpc.request('turn/start', {})
  rpc.close(new Error('Codex CLI завершился'))
  await assert.rejects(p, /завершился/)
  await assert.rejects(rpc.request('turn/interrupt'), /завершился/)
})
