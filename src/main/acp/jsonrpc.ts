import type { Readable, Writable } from 'node:stream'

/**
 * Minimal bidirectional JSON-RPC 2.0 peer over newline-delimited JSON.
 *
 * IMPORTANT: incoming frames are dispatched on the presence of `method` BEFORE
 * looking at `id`. Agent->client requests carry their own independently
 * numbered ids, so an incoming `{id: 2, method: "session/request_permission"}`
 * will collide with our own outbound request #2 if you switch on `id` first.
 * (Confirmed against Copilot CLI 1.0.75 — it starts its request ids at 1.)
 */

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

type AnyMessage = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

export type RequestHandler = (method: string, params: any) => Promise<unknown>
export type NotificationHandler = (method: string, params: any) => void

export class RpcPeer {
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >()
  private buffer = ''
  private closed = false

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onRequest: RequestHandler,
    private readonly onNotification: NotificationHandler,
    private readonly onProtocolError: (err: Error) => void = () => {}
  ) {
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.ingest(chunk))
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: AnyMessage
      try {
        msg = JSON.parse(line)
      } catch {
        // Agents occasionally emit non-JSON banner lines on stdout. Skip them
        // rather than tearing down an otherwise healthy connection.
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: AnyMessage): void {
    // Method first — see the class comment on id-space collisions.
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) {
        try {
          this.onNotification(msg.method, msg.params)
        } catch (err) {
          this.onProtocolError(err as Error)
        }
        return
      }
      const id = msg.id
      void this.onRequest(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? {} }),
        (err: any) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: {
              code: typeof err?.code === 'number' ? err.code : -32603,
              message: String(err?.message ?? err)
            }
          })
      )
      return
    }

    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(msg.id as number)
      if (!entry) return
      this.pending.delete(msg.id as number)
      if (msg.error) {
        const e = new Error(msg.error.message) as Error & { code?: number; data?: unknown }
        e.code = msg.error.code
        e.data = msg.error.data
        entry.reject(e)
      } else {
        entry.resolve(msg.result)
      }
    }
  }

  private send(msg: AnyMessage): void {
    if (this.closed) return
    try {
      this.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      this.onProtocolError(err as Error)
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RPC connection is closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Fail every in-flight request; called when the child process goes away. */
  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    for (const [, entry] of this.pending) entry.reject(new Error(reason))
    this.pending.clear()
  }
}
