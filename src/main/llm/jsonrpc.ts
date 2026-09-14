/**
 * JSON-RPC 2.0 поверх JSONL (сообщение — одна строка) — общий для транспортов
 * `codex app-server` и ACP (`agent acp`).
 *
 * Модуль чистый: ни процесса, ни потоков. Транспорт сам пишет строку в stdin
 * (write) и сам отдаёт сюда каждую строку stdout (handleLine). Так разбор протокола
 * проверяется тестами без запуска CLI.
 *
 * Отличия протоколов, которые здесь учтены:
 * - Codex app-server не пишет поле "jsonrpc":"2.0" («header omitted on the wire» —
 *   документация app-server), ACP пишет. withVersion: false для Codex, true для ACP.
 *   Входящие принимаем и с полем, и без.
 * - Оба присылают встречные запросы (одобрения, session/request_permission): у них
 *   есть и method, и id, и на них обязательно ответить — иначе агент ждёт вечно.
 *
 * API:
 *   const rpc = new JsonRpcConnection({ write, withVersion, onNotification, onRequest })
 *   rpc.request<T>(method, params?, { timeoutMs? }) → Promise<T>; ошибка сервера — RpcRemoteError
 *   rpc.notify(method, params?)
 *   rpc.handleLine(line) → true, если строка — сообщение JSON-RPC
 *   rpc.close(err)       процесс умер: отклонить все ждущие запросы
 */

export interface RpcErrorObject {
  code: number
  message: string
  data?: unknown
}

/** Ошибка, пришедшая от сервера в ответ на запрос, или та, которой отвечаем на встречный. */
export class RpcRemoteError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcRemoteError'
    this.code = code
    this.data = data
  }
}

export type RpcId = number | string

export interface JsonRpcOptions {
  /** записать сообщение в stdin; перевод строки добавляет сама связь */
  write(line: string): void
  /** писать ли "jsonrpc":"2.0": ACP — да, Codex app-server — нет */
  withVersion: boolean
  onNotification?(method: string, params: unknown): void
  /**
   * Встречный запрос от агента. Вернуть результат (можно промисом). Бросить
   * RpcRemoteError — ответить этой ошибкой. Обработчика нет — «метод не найден».
   */
  onRequest?(method: string, params: unknown, id: RpcId): unknown
}

interface Waiter {
  method: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class JsonRpcConnection {
  private readonly opts: JsonRpcOptions
  private nextId = 1
  private readonly waiting = new Map<RpcId, Waiter>()
  private closed: Error | null = null

  constructor(opts: JsonRpcOptions) {
    this.opts = opts
  }

  get pendingCount(): number {
    return this.waiting.size
  }

  request<T = unknown>(method: string, params?: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = { method, resolve: resolve as (v: unknown) => void, reject }
      if (o.timeoutMs) {
        w.timer = setTimeout(() => {
          this.waiting.delete(id)
          reject(new Error(`${method}: нет ответа за ${Math.round(o.timeoutMs! / 1000)} с`))
        }, o.timeoutMs)
      }
      this.waiting.set(id, w)
      try {
        this.send({ id, method, ...(params === undefined ? {} : { params }) })
      } catch (e) {
        clearTimeout(w.timer)
        this.waiting.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ method, ...(params === undefined ? {} : { params }) })
  }

  /** Строка stdout. Не JSON или не JSON-RPC — false: CLI иногда печатает в stdout и прочее. */
  handleLine(line: string): boolean {
    const text = line.trim()
    if (!text.startsWith('{')) return false
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text) as Record<string, unknown>
    } catch {
      return false
    }
    if (!msg || typeof msg !== 'object') return false
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string'
    const method = typeof msg.method === 'string' ? msg.method : undefined

    if (method && hasId) {
      void this.answer(msg.id as RpcId, method, msg.params)
      return true
    }
    if (method) {
      this.opts.onNotification?.(method, msg.params)
      return true
    }
    if (hasId && ('result' in msg || 'error' in msg)) {
      const w = this.waiting.get(msg.id as RpcId)
      if (!w) return true // ответ на запрос, который уже истёк по таймауту
      this.waiting.delete(msg.id as RpcId)
      clearTimeout(w.timer)
      const err = msg.error as Partial<RpcErrorObject> | undefined
      if (err) w.reject(new RpcRemoteError(Number(err.code ?? -32603), String(err.message ?? `${w.method}: ошибка`), err.data))
      else w.resolve(msg.result)
      return true
    }
    return false
  }

  /** Процесс умер или связь закрыта: ждущие запросы отклоняются этой ошибкой. */
  close(err: Error): void {
    if (this.closed) return
    this.closed = err
    const all = [...this.waiting.values()]
    this.waiting.clear()
    for (const w of all) {
      clearTimeout(w.timer)
      w.reject(err)
    }
  }

  private send(msg: Record<string, unknown>): void {
    const full = this.opts.withVersion ? { jsonrpc: '2.0', ...msg } : msg
    this.opts.write(`${JSON.stringify(full)}\n`)
  }

  private async answer(id: RpcId, method: string, params: unknown): Promise<void> {
    let reply: Record<string, unknown>
    if (!this.opts.onRequest) {
      reply = { id, error: { code: -32601, message: `Method not found: ${method}` } }
    } else {
      try {
        const result = await this.opts.onRequest(method, params, id)
        reply = { id, result: result === undefined ? null : result }
      } catch (e) {
        reply =
          e instanceof RpcRemoteError
            ? { id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } }
            : { id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }
      }
    }
    if (this.closed) return
    try {
      this.send(reply)
    } catch {
      /* процесс уже закрыл stdin — отвечать некому */
    }
  }
}
