import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import {
  evaluate,
  parseJUnit,
  parseSarif,
  updatePosterior,
  type AcceptanceClaim,
  type ClaimVerdict,
  type Signal
} from './claims'
import { allNodes, validate, type AgentNode, type ToolNode, type Workflow, type WorkflowNode } from './ir'
import {
  forbiddenWritePaths,
  invalidationFrontier,
  matchGlob,
  type Constraint
} from './constraints'

/**
 * The workflow runtime.
 *
 * A small state machine over the IR. It owns three things the steps cannot be
 * trusted to own themselves:
 *
 *   Evidence. Commands are run by this process, so an exit code is something
 *   the client observed rather than something a step reported.
 *
 *   Checkpoints. Written after every node, so a run that is killed resumes from
 *   its frontier instead of from the beginning. Anything expensive and already
 *   done stays done.
 *
 *   Budgets. Enforced here, because a step that has exhausted its budget is
 *   exactly the step least able to notice.
 *
 * No electron import: the runtime has to be drivable headlessly, or none of the
 * above can be tested without a window on screen.
 */

export interface Checkpoint {
  nodeId: string
  at: number
  outputs: Record<string, string>
  artifactHashes: Record<string, string>
  evidenceIds: string[]
  iteration?: number
}

export interface EvidenceRecord {
  id: string
  nodeId: string
  /** Set when a constraint invalidated the work this evidence describes. */
  staleUnder?: string
  claimClass?: string
  tier?: string
  verdict?: ClaimVerdict
  signal?: Signal
  at: number
}

export interface Approval {
  gateId: string
  artifact: string
  /** The hash approved. An approval that named the artifact would not survive it changing. */
  artifactSha256: string
  approver: string
  at: number
}

export type RunStatus =
  | 'completed'
  | 'awaiting-approval'
  | 'rejected'
  | 'budget-exhausted'
  | 'failed'

export interface RunState {
  workflowId: string
  status: RunStatus
  outputs: Record<string, string>
  artifactHashes: Record<string, string>
  checkpoints: Checkpoint[]
  evidence: EvidenceRecord[]
  approvals: Approval[]
  signals: Signal[]
  /** Posteriors as they stood at the end of the run, by claim class. */
  posteriors: Record<string, { alpha: number; beta: number }>
  /** Constraints injected while the run was in flight. */
  constraints: Constraint[]
  /** Completed work a constraint invalidated. Kept, not deleted — see below. */
  stale: string[]
  /** Set when the run stopped short. */
  stoppedAt?: string
  reason?: string
}

/**
 * How a step reaches an agent.
 *
 * Injected rather than imported so the runtime does not depend on a session
 * implementation, an Electron window, or a live model. The production
 * implementation opens one ACP session per agent node and disposes it at step
 * end; a test can substitute a scripted agent and still exercise every other
 * part of this file.
 */
export interface AgentRunner {
  run(
    node: AgentNode,
    ctx: {
      cwd: string
      inputs: Record<string, string>
      timeoutSec: number
      constraints: Constraint[]
      forbiddenWrites: string[]
    }
  ): Promise<{ output: string; artifactPath?: string }>
}

/** Asks a human. Resolves with the approver, or null to reject. */
export interface GateResolver {
  ask(gate: {
    nodeId: string
    artifact: string
    artifactSha256: string
    requiredRole: string
  }): Promise<{ approver: string } | null>
}

export interface CheckpointStore {
  load(runId: string): Promise<RunState | null>
  save(runId: string, state: RunState): Promise<void>
}

/** In-memory store. Real persistence injects its own. */
export function memoryCheckpointStore(): CheckpointStore {
  const runs = new Map<string, RunState>()
  return {
    async load(runId) {
      const found = runs.get(runId)
      return found ? (JSON.parse(JSON.stringify(found)) as RunState) : null
    },
    async save(runId, state) {
      runs.set(runId, JSON.parse(JSON.stringify(state)) as RunState)
    }
  }
}

export interface RunOptions {
  runId: string
  cwd: string
  agents: AgentRunner
  gates: GateResolver
  store?: CheckpointStore
  /** Stop before this node id. Used to prove a killed run resumes. */
  stopBefore?: string
  onEvent?: (event: { type: string; nodeId?: string; detail?: unknown }) => void
}

let evidenceSeq = 0

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Run a command and capture what it did.
 *
 * The result is marked `client-terminal` because this process spawned it. That
 * label is what lets a claim be evaluated from it at all — see claims.ts.
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    // A hard timeout, not a polite one: a step that has run over its budget is
    // the step least likely to stop on request.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutSec * 1000)

    child.stdout.on('data', (d) => {
      // Bounded: a runaway command must not be able to exhaust memory here.
      if (stdout.length < 64_000) stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 64_000) stderr += String(d)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr, timedOut })
    })
  })
}

export class WorkflowRuntime {
  private state!: RunState
  private opts!: RunOptions
  private workflow!: Workflow

  async run(workflow: Workflow, opts: RunOptions): Promise<RunState> {
    const check = validate(workflow)
    if (!check.runnable) {
      throw new Error(
        'Workflow is not runnable:\n' +
          check.issues.map((i) => `  ${i.nodeId}: ${i.problem}`).join('\n')
      )
    }

    this.workflow = workflow
    this.opts = opts
    const store = opts.store ?? memoryCheckpointStore()

    const resumed = await store.load(opts.runId)
    this.state = resumed ?? {
      workflowId: workflow.id,
      status: 'completed',
      outputs: {},
      artifactHashes: {},
      checkpoints: [],
      evidence: [],
      approvals: [],
      signals: [],
      posteriors: {},
      constraints: [],
      stale: []
    }
    // Older persisted runs predate constraints; treat them as unconstrained
    // rather than crashing on a missing field.
    this.state.constraints = this.state.constraints ?? []
    this.state.stale = this.state.stale ?? []
    // A resumed run starts optimistic again; the previous stop is history.
    this.state.status = 'completed'
    this.state.stoppedAt = undefined
    this.state.reason = undefined

    try {
      await this.runNodes(workflow.nodes, store)
    } catch (error) {
      if (!(error instanceof StopRun)) throw error
      this.state.status = error.status
      this.state.stoppedAt = error.nodeId
      this.state.reason = error.reason
    }

    await store.save(opts.runId, this.state)
    return this.state
  }

  private done(nodeId: string, iteration?: number): boolean {
    // Loop bodies legitimately run the same node more than once, so a completed
    // node is only skipped when the iteration matches too.
    return this.state.checkpoints.some(
      (c) => c.nodeId === nodeId && c.iteration === iteration
    )
  }

  private async checkpoint(
    store: CheckpointStore,
    nodeId: string,
    iteration?: number,
    evidenceIds: string[] = []
  ): Promise<void> {
    this.state.checkpoints.push({
      nodeId,
      at: Date.now(),
      outputs: { ...this.state.outputs },
      artifactHashes: { ...this.state.artifactHashes },
      evidenceIds,
      iteration
    })
    await store.save(this.opts.runId, this.state)
    this.opts.onEvent?.({ type: 'checkpoint', nodeId })
  }

  private async runNodes(
    nodes: WorkflowNode[],
    store: CheckpointStore,
    iteration?: number
  ): Promise<void> {
    for (const node of nodes) {
      if (this.opts.stopBefore === node.id && !this.done(node.id, iteration)) {
        throw new StopRun('failed', node.id, 'stopped before node (test harness)')
      }
      if (this.done(node.id, iteration)) {
        this.opts.onEvent?.({ type: 'skipped', nodeId: node.id })
        continue
      }
      await this.runNode(node, store, iteration)
    }
  }

  private async runNode(
    node: WorkflowNode,
    store: CheckpointStore,
    iteration?: number
  ): Promise<void> {
    this.opts.onEvent?.({ type: 'node', nodeId: node.id, detail: node.type })
    const evidenceIds: string[] = []

    switch (node.type) {
      case 'agent': {
        const inputs: Record<string, string> = {}
        for (const name of node.inputs ?? []) inputs[name] = this.state.outputs[name] ?? ''
        const result = await this.opts.agents.run(node, {
          cwd: this.opts.cwd,
          inputs,
          timeoutSec: node.budget.timeoutSec,
          // Both halves: the step is told, and the step is stopped. Telling it
          // alone would make the constraint a suggestion addressed to the
          // component with the least reason to honour it.
          constraints: this.state.constraints,
          forbiddenWrites: forbiddenWritePaths(this.state.constraints)
        })
        this.state.outputs[node.output] = result.output
        const artifact = node.artifactPath ?? result.artifactPath
        if (node.artifactPath) {
          const full = isAbsolute(node.artifactPath)
            ? node.artifactPath
            : join(this.opts.cwd, node.artifactPath)
          await writeFile(full, result.output, 'utf8')
        }
        if (artifact) await this.hashArtifact(node.output, artifact)
        break
      }

      case 'tool': {
        const signal = await this.runToolNode(node)
        this.state.signals = [...this.state.signals.filter((s) => s.name !== signal.name), signal]
        this.state.outputs[node.output] = String(signal.fields.exitCode ?? '')
        const record: EvidenceRecord = {
          id: `ev-${++evidenceSeq}`,
          nodeId: node.id,
          signal,
          at: Date.now()
        }
        this.state.evidence.push(record)
        evidenceIds.push(record.id)
        break
      }

      case 'humanGate': {
        const hash = this.state.artifactHashes[node.artifact]
        if (!hash) {
          throw new StopRun('failed', node.id, `no artifact hash for "${node.artifact}"`)
        }
        const answer = await this.opts.gates.ask({
          nodeId: node.id,
          artifact: node.artifact,
          artifactSha256: hash,
          requiredRole: node.requiredRole
        })
        if (!answer) throw new StopRun('rejected', node.id, 'approval declined')
        this.state.approvals.push({
          gateId: node.id,
          artifact: node.artifact,
          artifactSha256: hash,
          approver: answer.approver,
          at: Date.now()
        })
        break
      }

      case 'condition': {
        const value = this.state.outputs[node.when.output]
        const holds =
          node.when.op === 'exists'
            ? value !== undefined
            : node.when.op === 'eq'
              ? value === node.when.value
              : value !== node.when.value
        this.state.outputs[node.id] = holds ? node.then : (node.else ?? '')
        break
      }

      case 'loop': {
        await this.runLoop(node, store)
        break
      }
    }

    await this.checkpoint(store, node.id, iteration, evidenceIds)
  }

  private async runToolNode(node: ToolNode): Promise<Signal> {
    const result = await runCommand(node.command, this.opts.cwd, node.budget.timeoutSec)
    const fields: Signal['fields'] = {
      exitCode: result.exitCode,
      timedOut: result.timedOut
    }

    // A parsed report is stronger evidence than an exit code, and independent
    // of it: a runner can exit 0 with failures recorded, or exit 1 for reasons
    // that have nothing to do with the tests.
    if (node.report) {
      const path = isAbsolute(node.report.path)
        ? node.report.path
        : join(this.opts.cwd, node.report.path)
      const raw = await readFile(path, 'utf8').catch(() => null)
      if (raw !== null) {
        Object.assign(fields, node.report.kind === 'junit' ? parseJUnit(raw) : parseSarif(raw))
      }
    }

    return {
      name: node.output,
      source: 'client-terminal',
      fields,
      // Bounded, and enough to see why something failed without storing a log.
      rawRef: (result.stdout + result.stderr).slice(-2000)
    }
  }

  private async runLoop(node: import('./ir').LoopNode, store: CheckpointStore): Promise<void> {
    const claims = node.until.map((ref) => this.workflow.claims[ref.claimId])

    for (let i = 1; i <= node.maxIterations; i++) {
      await this.runNodes(node.body, store, i)

      const verdicts = claims.map((claim) => this.scoreClaim(claim, node.id))
      this.opts.onEvent?.({ type: 'loop-iteration', nodeId: node.id, detail: { i, verdicts } })

      if (verdicts.every((v) => v.accepted)) {
        this.state.outputs[`${node.id}.iterations`] = String(i)
        return
      }
    }

    // Out of iterations with claims still unmet. Surfaced rather than swallowed:
    // a loop that quietly gives up looks identical to one that succeeded.
    throw new StopRun(
      'budget-exhausted',
      node.id,
      `ran ${node.maxIterations} iterations without meeting every acceptance claim`
    )
  }

  private scoreClaim(claim: AcceptanceClaim, nodeId: string): ClaimVerdict {
    const current = this.state.posteriors[claim.claimClass] ?? claim.posterior
    const verdict = evaluate({ ...claim, posterior: current }, this.state.signals)

    // The posterior measures whether *accepting* this claim class turned out to
    // be right — not how often the underlying check failed. A failing test on
    // the first pass of a repair loop is the expected path; counting it against
    // the class drove the posterior below its own threshold after one
    // iteration, at which point the loop could never exit and every run ended
    // as budget-exhausted. Only an acceptance is evidence here.
    //
    // That makes the posterior monotone in v1, which is honest: knowing an
    // acceptance was *wrong* needs a contradiction arriving later — a revert, a
    // failure downstream of a green gate — and v1 has nothing that reports one.
    // The cut list says posteriors update silently in v1; this is what silently
    // has to mean until there is a signal to learn from.
    if (verdict.accepted) {
      this.state.posteriors[claim.claimClass] = updatePosterior(current, true)
    } else if (current) {
      this.state.posteriors[claim.claimClass] = current
    }
    this.state.evidence.push({
      id: `ev-${++evidenceSeq}`,
      nodeId,
      claimClass: claim.claimClass,
      tier: claim.evidenceTier,
      verdict,
      at: Date.now()
    })
    return verdict
  }

  private async hashArtifact(name: string, path: string): Promise<void> {
    const full = isAbsolute(path) ? path : join(this.opts.cwd, path)
    const raw = await readFile(full, 'utf8').catch(() => null)
    if (raw === null) return
    this.state.artifactHashes[name] = sha256(raw)
  }
}

class StopRun extends Error {
  constructor(
    readonly status: RunStatus,
    readonly nodeId: string,
    readonly reason: string
  ) {
    super(reason)
  }
}

/**
 * Whether an approval still refers to what was approved.
 *
 * The reason gates bind hashes: an approval that named "the design document"
 * would still read as granted after the document was rewritten. Re-checking is
 * the whole value, so it has to be callable independently of a run.
 */
export function approvalStillValid(approval: Approval, currentContent: string): boolean {
  return approval.artifactSha256 === sha256(currentContent)
}

export { sha256 }

/**
 * Apply a constraint to a run already in flight.
 *
 * Pure, and separate from `run()`, because "inject a constraint" and "resume"
 * are two decisions a person makes at two moments — collapsing them into one
 * call would mean a constraint could only be added by something already driving
 * the loop.
 *
 * What happens to invalidated work is the part worth being careful about.
 * Completed frontier nodes are marked stale rather than deleted: the artifacts
 * they produced stay on disk and their evidence stays in the record, demoted a
 * tier. Deleting it would destroy the only account of what the run did before
 * somebody changed the rules, which is exactly what an audit needs to see.
 * Their checkpoints are dropped so they re-run — that is what "resume from the
 * latest checkpoint at or before the frontier" means in practice.
 */
export function applyConstraint(
  workflow: Workflow,
  state: RunState,
  constraint: Constraint
): { state: RunState; frontier: string[]; stale: string[]; rewoundTo: string | null } {
  const frontier = invalidationFrontier(workflow, constraint)
  const invalidated = new Set(frontier.all)

  const next: RunState = JSON.parse(JSON.stringify(state))
  next.constraints = [...(next.constraints ?? []), constraint]

  const completed = next.checkpoints.filter((c) => invalidated.has(c.nodeId))
  const stale = [...new Set(completed.map((c) => c.nodeId))]

  // The checkpoint immediately before the earliest invalidated node — the point
  // a resume picks up from.
  const earliest = next.checkpoints.findIndex((c) => invalidated.has(c.nodeId))
  const rewoundTo = earliest > 0 ? next.checkpoints[earliest - 1].nodeId : null

  next.checkpoints = next.checkpoints.filter((c) => !invalidated.has(c.nodeId))
  next.stale = [...new Set([...(next.stale ?? []), ...stale])]

  // Evidence survives, demoted: it was true when it was captured, and it was
  // captured under rules that no longer hold.
  next.evidence = next.evidence.map((e) =>
    invalidated.has(e.nodeId) ? { ...e, tier: demote(e.tier), staleUnder: constraint.id } : e
  )

  // Signals produced by invalidated steps must not satisfy a claim on the next
  // pass — they describe work that is being redone.
  const invalidatedOutputs = new Set(
    allNodes(workflow)
      .filter((n) => invalidated.has(n.id))
      .flatMap((n) => n.effects.emits ?? [])
  )
  next.signals = next.signals.filter((s) => !invalidatedOutputs.has(s.name))

  next.status = 'completed'
  next.stoppedAt = undefined
  next.reason = undefined

  return { state: next, frontier: frontier.all, stale, rewoundTo }
}

/** One step down the evidence ladder. PRODUCTION evidence gathered under rules
 *  that have since changed is no longer production evidence. */
function demote(tier: string | undefined): string {
  switch (tier) {
    case 'PRODUCTION':
      return 'STAGING'
    case 'STAGING':
      return 'EXPERIMENT'
    default:
      return 'SYNTHETIC'
  }
}

export { matchGlob }
