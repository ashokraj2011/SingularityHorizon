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
  ContextDocument,
  MainEvent,
  PendingPermission,
  PromptRequest,
  SessionMode,
  SessionSnapshot,
  ThreadBlock
} from '../../shared/ipc'
import { parseContext, parseUsage } from '../../shared/contextInfo'
import { indexFor } from '../ast/astIndex'
import { rewriteBlocks, upsertSession } from '../store/sessionStore'
import { buildAttachments } from '../attachments'
import { renderContextDocuments } from '../contextDocuments'
import { RpcPeer } from './jsonrpc'
import { TerminalManager } from './terminals'
import { readTextFile, writeTextFile } from './workspaceFs'
import {
  allowAllGrants,
  classify,
  decide,
  defaultPolicy,
  grantFor,
  type ClassifiedCall,
  type SessionPolicy
} from './policy'

/** Coalesce streaming token bursts into one renderer update per frame-ish. */
const FLUSH_INTERVAL_MS = 40

/**
 * Hard ceiling on blocks held in memory.
 *
 * The full transcript is on disk, so this is a safety valve rather than a
 * normal-path behaviour: a session would have to run for many hours to reach
 * it. Without a ceiling the array and its DOM nodes grow without bound, which
 * is precisely the failure persistence makes more likely by encouraging long
 * sessions.
 */
const MAX_BLOCKS_IN_MEMORY = 2000

interface PermissionWaiter {
  resolve: (optionId: string | null) => void
}

export declare interface AgentSession {
  on(event: 'event', listener: (e: MainEvent) => void): this
}

export class AgentSession extends EventEmitter {
  readonly id: string
  readonly cwd: string
  readonly agent: AgentDefinition

  private child?: ChildProcessWithoutNullStreams
  private peer?: RpcPeer
  private terminals = new TerminalManager()
  private permissionWaiters = new Map<string, PermissionWaiter>()

  /**
   * Client-enforced mode policy. Never sent to the agent and never
   * settable by it — an agent that could raise its own mode would be back to
   * enforcing its own manners.
   */
  private policy: SessionPolicy = defaultPolicy()

  /**
   * Calls the agent asked permission for itself, keyed by what was approved.
   * Consumed by the interceptor so a properly-behaved agent is not carded twice
   * for one action.
   */
  private pendingApprovals: ClassifiedCall[] = []

  /**
   * True when this session runs a governed workflow step rather than serving a
   * person. Agent-initiated permission requests are then answered from the
   * standing grant instead of parked on a card nobody is present to click —
   * which otherwise deadlocks the run at the first well-behaved agent.
   */
  private unattended = false
  private flushTimer?: NodeJS.Timeout
  private dirty = false
  private disposed = false
  private stderrTail = ''
  /** Serializes prompt turns against silent command runs. */
  private queue: Promise<unknown> = Promise.resolve()
  /** True once older blocks have been dropped from memory. */
  private trimmed = false
  private persistDirty = false
  private turns = 0
  private lastModel?: string
  private lastModelMultiplier?: string
  private canLoadSession = false
  /** Suppresses the agent's replay while resuming; we already have the record. */
  private replaying = false
  /** When set, streamed output is captured here instead of the transcript. */
  private capture: { text: string } | null = null
  private contextPending = true
  private readonly contextDocuments: ContextDocument[]

  private snapshot: SessionSnapshot

  constructor(
    agent: AgentDefinition,
    cwd: string,
    contextDocuments: ContextDocument[] = [],
    options: { id?: string } = {}
  ) {
    super()
    // A restored session keeps its stored id so its transcript, index entry and
    // audit record stay one continuous thing rather than forking on reopen.
    this.id = options.id ?? randomUUID()
    this.agent = agent
    this.cwd = cwd
    this.contextDocuments = contextDocuments.filter((document) => document.text.trim())
    this.snapshot = {
      id: this.id,
      title: basename(cwd) || cwd,
      cwd,
      agentId: agent.id,
      toolProfile: agent.toolProfile,
      status: 'starting',
      createdAt: Date.now(),
      blocks: [],
      models: [],
      configOptions: [],
      commands: [],
      contextDocuments: this.contextDocuments.map(({ providerId, title, kind, reason }) => ({
        providerId,
        title,
        kind: kind ?? 'evidence',
        reason
      }))
    }
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot
  }

  /**
   * Seeds a restored transcript before the agent connects, so reopening a
   * session shows its history immediately rather than after a handshake.
   */
  restoreBlocks(blocks: ThreadBlock[], turns: number): void {
    this.snapshot = { ...this.snapshot, blocks }
    this.turns = turns
  }

  /** True when the in-memory window no longer holds the whole transcript. */
  get isTrimmed(): boolean {
    return this.trimmed
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(resumeAcpSessionId?: string): Promise<void> {
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

    this.canLoadSession = init.agentCapabilities?.loadSession === true
    this.patch({
      agentName: init.agentInfo?.title ?? init.agentInfo?.name ?? this.agent.name,
      agentVersion: init.agentInfo?.version
    })

    // Resume the agent's own session when it supports it, so the model keeps
    // its conversation rather than merely the transcript being redrawn.
    // Its replay is suppressed: we restored the record from disk already, and
    // taking both would duplicate every block.
    let session: NewSessionResponse | null = null
    if (resumeAcpSessionId && this.canLoadSession) {
      try {
        this.replaying = true
        session = await this.peer.request<NewSessionResponse>('session/load', {
          sessionId: resumeAcpSessionId,
          cwd: this.cwd,
          mcpServers: []
        })
        // session/load may resolve without echoing the id back.
        session = { ...(session ?? {}), sessionId: session?.sessionId ?? resumeAcpSessionId }
      } catch {
        session = null
      } finally {
        this.replaying = false
      }
    }

    if (!session) {
      session = await this.peer.request<NewSessionResponse>('session/new', {
        cwd: this.cwd,
        mcpServers: []
      })
    }

    this.patch({
      acpSessionId: session.sessionId,
      status: 'idle',
      models: session.models?.availableModels ?? [],
      modes: session.modes,
      configOptions: session.configOptions ?? []
    })
  }

  dispose(): void {
    // Write the final state before tearing down, so a session closed mid-flight
    // is not missing its last turn on disk.
    this.persist()
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
   * Serializes everything that issues a `session/prompt`. A silent `/context`
   * refresh and a real user turn share one agent and one notification stream —
   * if they overlap, the refresh's output lands in the user's transcript and the
   * turn's output lands in the capture buffer. The queue makes that impossible.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * `displayText` lets a caller show something shorter than what is sent — a
   * skill invocation expands to a whole SKILL.md, and pasting that into the
   * transcript would bury the conversation. The block records the substitution
   * so it stays visible rather than hidden.
   */
  prompt(request: PromptRequest): Promise<void> {
    return this.enqueue(async () => {
      const acpSessionId = this.snapshot.acpSessionId
      if (!this.peer || !acpSessionId) throw new Error('Session is not ready')

      const built = request.attachments?.length
        ? await buildAttachments(request.attachments, this.cwd)
        : { blocks: [], summaries: [] }

      // Attachments lead so the model has the context before the instruction.
      const initialContext = this.contextPending ? renderContextDocuments(this.contextDocuments) : null
      const content: ContentBlock[] = [
        ...built.blocks,
        ...(initialContext ? [{ type: 'text' as const, text: initialContext }] : []),
        { type: 'text', text: request.text }
      ]

      this.pushBlock({
        kind: 'user',
        text: request.displayText ?? request.text,
        skill: request.skill,
        attachments: built.summaries.length ? built.summaries : undefined
      })
      this.patch({ status: 'busy' })

      try {
        const res = await this.peer.request<PromptResponse>('session/prompt', {
          sessionId: acpSessionId,
          prompt: content
        })
        if (initialContext) this.contextPending = false
        this.finalizeStreamingBlocks()
        this.turns++
        // Count the turn before flushing, not after: flushNow is what writes
        // the index entry, so incrementing afterwards left `turns` permanently
        // one behind — and stuck at zero for a session that ended here.
        this.persistDirty = true
        this.flushNow()
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
        this.flushNow()
        this.patch({ status: this.snapshot.status === 'exited' ? 'exited' : 'idle' })
      }
    })
  }

  /**
   * Runs a slash command and returns its text without touching the transcript.
   *
   * Needed because Copilot exposes token accounting only through `/context` and
   * `/usage` — it never sends ACP's `usage_update`. Those are local commands
   * that cost no AI units, so polling them after each turn is cheap.
   */
  runCommandSilent(command: string): Promise<string> {
    return this.enqueue(async () => {
      const acpSessionId = this.snapshot.acpSessionId
      if (!this.peer || !acpSessionId) throw new Error('Session is not ready')

      // Deliver anything still pending before muting the stream, so a prior
      // turn's tail can't be swallowed by the capture guard.
      this.flushNow()
      this.capture = { text: '' }
      try {
        await this.peer.request<PromptResponse>('session/prompt', {
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text: command }]
        })
        return this.capture.text
      } finally {
        this.capture = null
      }
    })
  }

  /** Refreshes the context meter. Failures are non-fatal and leave it as-is. */
  async refreshContext(): Promise<void> {
    try {
      const contextText = await this.runCommandSilent('/context')
      const context = parseContext(contextText)
      if (context) this.patch({ context })
    } catch {
      /* meter simply doesn't update */
    }
    try {
      const usageText = await this.runCommandSilent('/usage')
      const usage = parseUsage(usageText)
      if (usage) {
        this.patch({ usage })
        // Record which model produced it. Cost attribution is meaningless
        // without knowing the multiplier those requests were billed at.
        const modelOption = this.snapshot.configOptions.find((o) => o.id === 'model')
        const current = modelOption?.currentValue
        const choice = modelOption?.options?.find((c) => c.value === current)
        const multiplier = choice?._meta?.copilotUsage
        this.lastModel = current
        this.lastModelMultiplier = typeof multiplier === 'string' ? multiplier : undefined
        this.persistDirty = true
        this.persist()
      }
    } catch {
      /* ignore */
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
      // ACP names this field configId. `optionId` was accepted by our local
      // TypeScript shape but rejected by the agent's runtime schema (-32602).
      configId: optionId,
      value
    })
    // Allow-All tells the agent to stop asking. Without mirroring it into the
    // gate, the client would simply start asking in the agent's place — which
    // is the opposite of what the user just requested. Still capped by the mode
    // lattice, and still per-session.
    if (optionId === 'allow_all') {
      this.policy = {
        ...this.policy,
        grants: value === 'on' ? allowAllGrants(this.policy.mode) : []
      }
    }

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
    // Gate before dispatch. Every path below this line is already permitted.
    const call = classify(method, params)
    if (call) await this.enforce(call)

    switch (method) {
      case 'fs/read_text_file':
        return readTextFile([this.cwd], params)

      case 'fs/write_text_file': {
        await writeTextFile([this.cwd], params)
        // The index validates by mtime anyway, but dropping the entry here
        // closes the window where a write and a search land in the same
        // millisecond and the timestamp comparison sees no change.
        indexFor(this.cwd).invalidate(params.path)
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

  /* --------------------------------------------------------- mode gate */

  /**
   * Pin the mode. Set by the host; never by the agent.
   *
   * `autoGrant` is for governed workflow steps, where a human already approved
   * the workflow definition and there is nobody sitting in front of the run to
   * answer cards. The standing approval is the workflow; the mode is what
   * bounds it, so the grants can never exceed what the mode permits. An
   * interactive session never passes it.
   */
  setMode(
    mode: SessionMode,
    opts?: {
      autoGrant?: boolean
      commandAllowList?: string[]
      forbiddenWrites?: string[]
      matchPath?: (pattern: string, path: string) => boolean
    }
  ): void {
    this.unattended = opts?.autoGrant === true
    this.policy = {
      mode,
      grants: opts?.autoGrant ? allowAllGrants(mode) : [],
      commandAllowList: opts?.commandAllowList,
      forbiddenWrites: opts?.forbiddenWrites,
      matchPath: opts?.matchPath
    }
  }

  currentPolicy(): SessionPolicy {
    return this.policy
  }

  /**
   * Allow, refuse, or ask — before anything is dispatched.
   *
   * Throwing here becomes a JSON-RPC error on the agent's call, which is the
   * same shape it would get from a failed filesystem operation. An agent that
   * never asked permission cannot tell the difference between this and a slow
   * or read-only disk, which is the point: correct behaviour does not depend on
   * the agent cooperating.
   */
  private async enforce(call: ClassifiedCall): Promise<void> {
    // The lattice is consulted first, and an approval cannot reach past it.
    //
    // This used to check for a prior approval before deciding, which quietly
    // made the mode ceiling optional: an agent that asked, and was approved,
    // could then do something its mode forbade. The lattice tests never caught
    // it because they exercised decide() directly and never went through the
    // approval path — the one route real agents actually take.
    const decision = decide(this.policy, call)

    if (decision.kind === 'allow') return

    if (decision.kind === 'ask') {
      // An approval the agent itself collected covers the call that follows it.
      // Match on the command when we can. When we cannot — the agent described
      // the action in its own words and there is no reliable identifier tying
      // the request to the call — fall back to the oldest outstanding approval
      // of the same class. ACP gives no correlation id here, and the
      // alternative is carding every well-behaved agent twice for one action.
      const exact = this.pendingApprovals.findIndex(
        (a) => a.toolClass === call.toolClass && a.command === call.command
      )
      const approved =
        exact !== -1
          ? exact
          : this.pendingApprovals.findIndex((a) => a.toolClass === call.toolClass)
      if (approved !== -1) {
        this.pendingApprovals.splice(approved, 1)
        return
      }
    }

    if (decision.kind === 'deny') {
      this.pushBlock({ kind: 'notice', level: 'error', text: decision.reason })
      const err = new Error(decision.reason) as Error & { code?: number }
      err.code = -32603
      throw err
    }

    // 'ask' — synthesize the card the agent should have asked for.
    const optionId = await this.askUngated(call)
    if (optionId === 'allow_always') {
      this.policy = {
        ...this.policy,
        grants: [...this.policy.grants, grantFor(call, 'always')]
      }
      return
    }
    if (optionId === 'allow_once') return

    const err = new Error(`Denied by the user: ${call.title}`) as Error & { code?: number }
    err.code = -32603
    throw err
  }

  /**
   * A permission card for a call the agent never asked about.
   *
   * Deliberately the same card, the same waiter map, and the same renderer path
   * as an agent-initiated request. A user should not have to know which agents
   * are polite, and the audit export should not have two shapes of approval in
   * it.
   */
  private askUngated(call: ClassifiedCall): Promise<string | null> {
    const requestId = randomUUID()
    const pending: PendingPermission = {
      requestId,
      sessionId: this.id,
      toolCall: {
        toolCallId: `gate-${requestId}`,
        title: call.title,
        kind: call.toolClass === 'terminal' ? 'execute' : 'edit',
        status: 'pending',
        rawInput: call.command ? { command: call.command } : undefined
      } as ToolCall,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
      ],
      // Marks the card as one the client raised because the agent did not.
      gated: true
    }
    this.pushBlock({ kind: 'permission', request: pending })

    return new Promise((resolve) => {
      this.permissionWaiters.set(requestId, { resolve: (optionId) => resolve(optionId) })
    })
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

    // A call the mode forbids is refused rather than carded, in either mode.
    // Offering an approval that cannot take effect teaches people that approval
    // is decorative, and the refusal has to read the same whether or not
    // somebody was there to click.
    const classified: ClassifiedCall = {
      toolClass: req.toolCall?.kind === 'execute' ? 'terminal' : 'fs.write',
      command:
        typeof req.toolCall?.rawInput?.command === 'string'
          ? req.toolCall.rawInput.command
          : undefined,
      title: req.toolCall?.title ?? ''
    }
    const upfront = decide(this.policy, classified)
    if (upfront.kind === 'deny') {
      this.pushBlock({ kind: 'notice', level: 'error', text: upfront.reason })
      const denyOption = options.find((o) => o.kind === 'reject_once')
      return Promise.resolve(
        denyOption
          ? { outcome: { outcome: 'selected' as const, optionId: denyOption.optionId } }
          : { outcome: { outcome: 'cancelled' as const } }
      )
    }

    // Unattended: answer from policy. The approval already happened — a human
    // approved the workflow that pinned this step's mode — so parking the call
    // on a card would stall the run waiting for a person who is not there. The
    // decision still runs through the same lattice, so a step cannot be talked
    // into something its mode forbids, and the answered card stays in the
    // transcript so the receipt records what was allowed and on what basis.
    if (this.unattended) {
      const call = classified
      const decision = upfront
      const allow = options.find((o) => o.kind === 'allow_once') ?? options[0]
      const deny = options.find((o) => o.kind === 'reject_once')
      const chosen = decision.kind === 'allow' ? allow : deny

      this.pushBlock({
        kind: 'permission',
        request: {
          ...pending,
          resolvedOptionId: chosen?.optionId,
          cancelled: !chosen,
          unattended: true
        }
      })
      // Remember it, so the interceptor does not card the follow-up call.
      if (decision.kind === 'allow') this.pendingApprovals.push(call)
      return Promise.resolve(
        chosen
          ? { outcome: { outcome: 'selected' as const, optionId: chosen.optionId } }
          : { outcome: { outcome: 'cancelled' as const } }
      )
    }

    this.pushBlock({ kind: 'permission', request: pending })

    return new Promise((resolve) => {
      this.permissionWaiters.set(requestId, {
        resolve: (optionId) => {
          // Approval and action are two separate calls: the agent asks, then
          // calls terminal/create. Remember what was approved so the gate does
          // not immediately card the thing the user just allowed.
          const option = options.find((o) => o.optionId === optionId)
          if (option && option.kind !== 'reject_once' && option.kind !== 'reject_always') {
            const command =
              typeof req.toolCall?.rawInput?.command === 'string'
                ? req.toolCall.rawInput.command
                : undefined
            this.pendingApprovals.push({
              toolClass: req.toolCall?.kind === 'execute' ? 'terminal' : 'fs.write',
              command,
              title: req.toolCall?.title ?? ''
            })
            if (option.kind === 'allow_always') {
              this.policy = {
                ...this.policy,
                grants: [
                  ...this.policy.grants,
                  grantFor(
                    {
                      toolClass: req.toolCall?.kind === 'execute' ? 'terminal' : 'fs.write',
                      command,
                      title: ''
                    },
                    'always'
                  )
                ]
              }
            }
          }
          resolve(
            optionId
              ? { outcome: { outcome: 'selected', optionId } }
              : { outcome: { outcome: 'cancelled' } }
          )
        }
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
    // While capturing, the transcript must stay untouched — including tool
    // calls and plans, so a command that unexpectedly uses a tool can't leave
    // orphaned cards behind. Config and command advertisements still apply,
    // since those are session state rather than conversation.
    // While replaying a loaded session the agent re-emits its history; ours is
    // already restored, so only session-level state is taken from it.
    if (this.replaying) {
      if (
        update.sessionUpdate !== 'available_commands_update' &&
        update.sessionUpdate !== 'config_option_update'
      ) {
        return
      }
    }

    if (this.capture) {
      if (update.sessionUpdate === 'agent_message_chunk') {
        this.capture.text += textOf((update as any).content)
        return
      }
      if (
        update.sessionUpdate !== 'available_commands_update' &&
        update.sessionUpdate !== 'config_option_update'
      ) {
        return
      }
    }

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
    let blocks = fn(this.snapshot.blocks)
    if (blocks.length > MAX_BLOCKS_IN_MEMORY) {
      // Drop the oldest. They remain on disk and in the audit export; the
      // alternative is unbounded growth in both the array and the DOM.
      blocks = blocks.slice(-MAX_BLOCKS_IN_MEMORY)
      this.trimmed = true
    }
    this.snapshot = { ...this.snapshot, blocks }
    this.persistDirty = true
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
   * Delivers pending block updates immediately, bypassing the batch timer.
   *
   * Called at turn boundaries. Status patches emit synchronously while blocks
   * wait for the next tick, so without this the turn reports `idle` up to one
   * interval before its own final message chunk arrives — anything reading
   * state right after `prompt()` resolves would see a truncated transcript.
   */
  private flushNow(): void {
    if (!this.dirty) return
    this.dirty = false
    this.emitEvent({
      type: 'session:blocks',
      sessionId: this.id,
      blocks: this.snapshot.blocks
    })
    this.persist()
  }

  /**
   * Writes the transcript through to disk.
   *
   * A rewrite rather than an append because blocks mutate in place — a tool
   * call reaching `completed`, a permission being answered — and an append-only
   * log would record the pending state and never the resolution. The write is
   * fire-and-forget: history must never delay a live turn.
   */
  private persist(): void {
    if (!this.persistDirty) return
    this.persistDirty = false
    const { id, snapshot } = this
    void rewriteBlocks(id, snapshot.blocks)
    void upsertSession({
      id,
      title: snapshot.title,
      cwd: snapshot.cwd,
      agentId: snapshot.agentId,
      toolProfile: snapshot.toolProfile,
      acpSessionId: snapshot.acpSessionId,
      createdAt: snapshot.createdAt,
      updatedAt: Date.now(),
      turns: this.turns,
      usage: snapshot.usage,
      model: this.lastModel,
      modelMultiplier: this.lastModelMultiplier,
      lastMessage: [...snapshot.blocks]
        .reverse()
        .find((b) => b.kind === 'user')
        ?.text.split('\n')[0]
        .slice(0, 120)
    })
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
