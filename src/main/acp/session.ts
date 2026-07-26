import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { EventEmitter } from 'node:events'

import {
  ACP_PROTOCOL_VERSION,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionResponse,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall
} from '../../shared/acp'
import type {
  AgentDefinition,
  InvokedSkill,
  MainEvent,
  PendingPermission,
  SessionSnapshot,
  ThreadBlock
} from '../../shared/ipc'
import { RpcPeer } from './jsonrpc'
import { TerminalManager } from './terminals'
import { readTextFile, writeTextFile } from './workspaceFs'

/** Coalesce streaming token bursts into one renderer update per frame-ish. */
const FLUSH_INTERVAL_MS = 40

interface PermissionWaiter {
  resolve: (optionId: string | null) => void
}

export declare interface AgentSession {
  on(event: 'event', listener: (e: MainEvent) => void): this
}

export class AgentSession extends EventEmitter {
  readonly id = randomUUID()
  readonly cwd: string
  readonly agent: AgentDefinition

  private child?: ChildProcessWithoutNullStreams
  private peer?: RpcPeer
  private terminals = new TerminalManager()
  private permissionWaiters = new Map<string, PermissionWaiter>()
  private flushTimer?: NodeJS.Timeout
  private dirty = false
  private disposed = false
  private stderrTail = ''

  private snapshot: SessionSnapshot

  constructor(agent: AgentDefinition, cwd: string) {
    super()
    this.agent = agent
    this.cwd = cwd
    this.snapshot = {
      id: this.id,
      title: basename(cwd) || cwd,
      cwd,
      agentId: agent.id,
      status: 'starting',
      createdAt: Date.now(),
      blocks: [],
      models: [],
      configOptions: [],
      commands: []
    }
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    const child = spawn(this.agent.command, this.agent.args, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.agent.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Keep a bounded tail so a crash can be explained without leaking memory.
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })

    child.on('error', (err) => {
      this.fail(`Failed to launch "${this.agent.command}": ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this.disposed) return
      this.peer?.close('Agent process exited')
      const detail = this.stderrTail.trim()
      this.patch({
        status: 'exited',
        lastError:
          code === 0 && !signal
            ? undefined
            : `Agent exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`
      })
    })

    this.peer = new RpcPeer(
      child.stdin,
      child.stdout,
      (method, params) => this.handleAgentRequest(method, params),
      (method, params) => this.handleAgentNotification(method, params),
      (err) => this.pushBlock({ kind: 'notice', level: 'error', text: err.message })
    )

    const init = await this.peer.request<InitializeResponse>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true
      },
      clientInfo: { name: 'Event Horizon', version: '0.1.0' }
    })

    this.patch({
      agentName: init.agentInfo?.title ?? init.agentInfo?.name ?? this.agent.name,
      agentVersion: init.agentInfo?.version
    })

    const session = await this.peer.request<NewSessionResponse>('session/new', {
      cwd: this.cwd,
      mcpServers: []
    })

    this.patch({
      acpSessionId: session.sessionId,
      status: 'idle',
      models: session.models?.availableModels ?? [],
      modes: session.modes,
      configOptions: session.configOptions ?? []
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.flushTimer) clearInterval(this.flushTimer)
    for (const [, w] of this.permissionWaiters) w.resolve(null)
    this.permissionWaiters.clear()
    this.terminals.disposeAll()
    this.peer?.close('Session closed')
    this.child?.kill('SIGTERM')
    // Escalate if the agent ignores SIGTERM.
    const child = this.child
    if (child) setTimeout(() => child.killed || child.kill('SIGKILL'), 3000).unref()
  }

  /* ---------------------------------------------------------------- verbs */

  /**
   * `display` lets a caller show something shorter than what is sent — a skill
   * invocation expands to a whole SKILL.md, and pasting that into the
   * transcript would bury the conversation. The block records the expansion
   * size so the substitution stays visible rather than hidden.
   */
  async prompt(
    content: ContentBlock[],
    display?: { text: string; skill?: InvokedSkill }
  ): Promise<void> {
    const acpSessionId = this.snapshot.acpSessionId
    if (!this.peer || !acpSessionId) throw new Error('Session is not ready')

    const text =
      display?.text ??
      content
        .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    this.pushBlock({ kind: 'user', text, skill: display?.skill })
    this.patch({ status: 'busy' })

    try {
      const res = await this.peer.request<PromptResponse>('session/prompt', {
        sessionId: acpSessionId,
        prompt: content
      })
      this.finalizeStreamingBlocks()
      this.patch({ status: 'idle' })
      this.emitEvent({
        type: 'session:turnEnded',
        sessionId: this.id,
        stopReason: res?.stopReason ?? 'end_turn'
      })
    } catch (err) {
      this.finalizeStreamingBlocks()
      this.pushBlock({
        kind: 'notice',
        level: 'error',
        text: `Prompt failed: ${(err as Error).message}`
      })
      this.patch({ status: this.snapshot.status === 'exited' ? 'exited' : 'idle' })
    }
  }

  cancel(): void {
    const acpSessionId = this.snapshot.acpSessionId
    if (!this.peer || !acpSessionId) return
    // Any permission prompt still on screen would block the turn from ending.
    for (const [, w] of this.permissionWaiters) w.resolve(null)
    this.permissionWaiters.clear()
    this.peer.notify('session/cancel', { sessionId: acpSessionId })
  }

  async setConfigOption(optionId: string, value: string): Promise<void> {
    const acpSessionId = this.snapshot.acpSessionId
    if (!this.peer || !acpSessionId) return
    await this.peer.request('session/set_config_option', {
      sessionId: acpSessionId,
      optionId,
      value
    })
    // Optimistic: the agent also broadcasts config_option_update, but updating
    // locally keeps the picker from snapping back while that round-trips.
    this.patch({
      configOptions: this.snapshot.configOptions.map((o) =>
        o.id === optionId ? { ...o, currentValue: value } : o
      )
    })
  }

  resolvePermission(requestId: string, optionId: string | null): void {
    const waiter = this.permissionWaiters.get(requestId)
    if (!waiter) return
    this.permissionWaiters.delete(requestId)
    waiter.resolve(optionId)

    this.updateBlocks((blocks) =>
      blocks.map((b) =>
        b.kind === 'permission' && b.request.requestId === requestId
          ? {
              ...b,
              request: {
                ...b.request,
                resolvedOptionId: optionId ?? undefined,
                cancelled: optionId === null
              }
            }
          : b
      )
    )
  }

  /* ------------------------------------------------- agent -> client calls */

  private async handleAgentRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file':
        return readTextFile([this.cwd], params)

      case 'fs/write_text_file': {
        await writeTextFile([this.cwd], params)
        return {}
      }

      case 'session/request_permission':
        return this.requestPermission(params as RequestPermissionRequest)

      case 'terminal/create':
        return this.terminals.create(params, this.cwd)

      case 'terminal/output':
        return this.terminals.output(params.terminalId)

      case 'terminal/wait_for_exit': {
        const exitStatus = await this.terminals.waitForExit(params.terminalId)
        return { exitStatus }
      }

      case 'terminal/kill':
        this.terminals.kill(params.terminalId)
        return {}

      case 'terminal/release':
        this.terminals.release(params.terminalId)
        return {}

      default: {
        // We still answer -32601 so the agent can fall back, but the ask is
        // surfaced rather than swallowed. An agent asking something we can't
        // service (elicitation/create is the live example — it is in the spec
        // but not in Copilot 1.0.75 or the published TS lib) would otherwise
        // vanish silently, and the user would just see the turn stall.
        this.pushBlock({
          kind: 'notice',
          level: 'error',
          text:
            `The agent called "${method}", which this client does not implement yet, ` +
            `so it was declined. Anything it was asking for here did not reach you.`
        })
        const err = new Error(`Method not found: ${method}`) as Error & { code?: number }
        err.code = -32601
        throw err
      }
    }
  }

  private requestPermission(
    req: RequestPermissionRequest
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const requestId = randomUUID()
    const options: PermissionOption[] = req.options ?? []

    const pending: PendingPermission = {
      requestId,
      sessionId: this.id,
      toolCall: req.toolCall,
      options
    }
    this.pushBlock({ kind: 'permission', request: pending })

    return new Promise((resolve) => {
      this.permissionWaiters.set(requestId, {
        resolve: (optionId) =>
          resolve(
            optionId
              ? { outcome: { outcome: 'selected', optionId } }
              : { outcome: { outcome: 'cancelled' } }
          )
      })
    })
  }

  private handleAgentNotification(method: string, params: any): void {
    if (method !== 'session/update') return
    const note = params as SessionNotification
    this.applyUpdate(note.update)
  }

  /* ------------------------------------------------------- update folding */

  private applyUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.appendStream('assistant', textOf((update as any).content))
        break

      case 'agent_thought_chunk':
        this.appendStream('thought', textOf((update as any).content))
        break

      case 'user_message_chunk':
        // Emitted when replaying a loaded session.
        this.pushBlock({ kind: 'user', text: textOf((update as any).content) })
        break

      case 'tool_call':
      case 'tool_call_update': {
        const { sessionUpdate: _ignored, ...call } = update as any
        this.upsertToolCall(call as ToolCall)
        break
      }

      case 'plan':
        this.upsertPlan((update as any).entries ?? [])
        break

      case 'available_commands_update':
        this.patch({ commands: (update as any).availableCommands ?? [] })
        break

      case 'config_option_update':
        this.patch({ configOptions: (update as any).configOptions ?? [] })
        break

      case 'current_mode_update': {
        const modes = this.snapshot.modes
        if (modes) {
          this.patch({ modes: { ...modes, currentModeId: (update as any).currentModeId } })
        }
        break
      }

      case 'usage_update':
        this.patch({ usage: (update as any).usage ?? (update as any) })
        break

      default:
        // Unknown update kinds are ignored on purpose: ACP is in preview and
        // agents are free to add variants we don't render yet.
        break
    }
  }

  /**
   * Streaming text is folded into the trailing block of the same kind. A tool
   * call landing between chunks closes the run, so the transcript keeps the
   * real interleaving of prose and actions.
   */
  private appendStream(kind: 'assistant' | 'thought', text: string): void {
    if (!text) return
    this.updateBlocks((blocks) => {
      const last = blocks[blocks.length - 1]
      if (last && last.kind === kind && last.streaming) {
        const merged = { ...last, text: last.text + text }
        return [...blocks.slice(0, -1), merged]
      }
      return [
        ...blocks,
        { id: randomUUID(), kind, text, at: Date.now(), streaming: true } as ThreadBlock
      ]
    })
  }

  private finalizeStreamingBlocks(): void {
    this.updateBlocks((blocks) =>
      blocks.map((b) =>
        (b.kind === 'assistant' || b.kind === 'thought') && b.streaming
          ? { ...b, streaming: false }
          : b
      )
    )
  }

  private upsertToolCall(call: ToolCall): void {
    if (!call.toolCallId) return
    this.finalizeStreamingBlocks()
    this.updateBlocks((blocks) => {
      const idx = blocks.findIndex(
        (b) => b.kind === 'tool' && b.call.toolCallId === call.toolCallId
      )
      if (idx === -1) {
        return [
          ...blocks,
          { id: randomUUID(), kind: 'tool', call, at: Date.now() } as ThreadBlock
        ]
      }
      const existing = blocks[idx] as Extract<ThreadBlock, { kind: 'tool' }>
      // Partial update: only overwrite fields the agent actually sent.
      const merged: ToolCall = { ...existing.call }
      for (const [k, v] of Object.entries(call)) {
        if (v !== undefined) (merged as any)[k] = v
      }
      const next = [...blocks]
      next[idx] = { ...existing, call: merged }
      return next
    })
  }

  private upsertPlan(entries: any[]): void {
    this.updateBlocks((blocks) => {
      const idx = blocks.findIndex((b) => b.kind === 'plan')
      if (idx === -1) {
        return [
          ...blocks,
          { id: randomUUID(), kind: 'plan', entries, at: Date.now() } as ThreadBlock
        ]
      }
      const next = [...blocks]
      next[idx] = { ...(next[idx] as any), entries }
      return next
    })
  }

  /* -------------------------------------------------------------- plumbing */

  private pushBlock(partial: Omit<ThreadBlock, 'id' | 'at'> & Partial<ThreadBlock>): void {
    const block = { id: randomUUID(), at: Date.now(), ...partial } as ThreadBlock
    this.updateBlocks((blocks) => [...blocks, block])
  }

  private updateBlocks(fn: (blocks: ThreadBlock[]) => ThreadBlock[]): void {
    this.snapshot = { ...this.snapshot, blocks: fn(this.snapshot.blocks) }
    this.scheduleFlush()
  }

  private patch(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emitEvent({ type: 'session:patch', sessionId: this.id, patch })
  }

  private fail(message: string): void {
    this.patch({ status: 'error', lastError: message })
  }

  /**
   * Block updates are batched: during streaming the agent emits a notification
   * per token, and forwarding each one across IPC would swamp the renderer.
   */
  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setInterval(() => {
      if (!this.dirty) {
        clearInterval(this.flushTimer)
        this.flushTimer = undefined
        return
      }
      this.dirty = false
      this.emitEvent({
        type: 'session:blocks',
        sessionId: this.id,
        blocks: this.snapshot.blocks
      })
    }, FLUSH_INTERVAL_MS)
  }

  private emitEvent(event: MainEvent): void {
    if (this.disposed) return
    this.emit('event', event)
  }
}

function textOf(content: ContentBlock | undefined): string {
  if (!content) return ''
  if (content.type === 'text') return content.text
  if (content.type === 'resource' && 'text' in content.resource) return content.resource.text
  return ''
}
