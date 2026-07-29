import type {
  AcceptanceClaimRef,
  Budget,
  ContextSelector,
  Maturity,
  ResourceSelector,
  StepEffects,
  WorkflowNode
} from './ir'
import type { AcceptanceClaim } from './claims'
import type { SessionMode } from '../../shared/ipc'

/**
 * A workflow that is not yet runnable.
 *
 * Deliberately a separate type from `Workflow` rather than the same type with
 * optional fields. The runtime takes a `Workflow`; a half-bound draft is
 * therefore unrepresentable at the point of execution, and cannot reach it
 * through an oversight in a validator someone forgot to call. Two shapes to
 * maintain is the price, and it is worth paying for exactly one guarantee.
 *
 * Holes are **derived from the target schema, never self-reported.** An
 * extraction pass that failed to notice a field would leave it out of its own
 * hole list with equal confidence, so asking the model what it missed inherits
 * the miss. Everything the IR requires is enumerated here, and whatever the
 * draft has not filled in is a hole by construction.
 */

export interface PartialAgentNode {
  id: string
  type: 'agent'
  role?: string
  agentId?: string
  toolProfile?: 'full' | 'no-mcp' | 'lean' | 'minimal'
  workspace?: 'readonly' | 'isolatedWorktree'
  mode?: SessionMode
  prompt?: string
  inputs?: string[]
  output?: string
  artifactPath?: string
  effects?: PartialEffects
  budget?: Partial<Budget>
  contextSlice?: ContextSelector[]
}

export interface PartialToolNode {
  id: string
  type: 'tool'
  command?: string
  output?: string
  report?: { kind: 'junit' | 'sarif'; path: string }
  effects?: PartialEffects
  budget?: Partial<Budget>
  contextSlice?: ContextSelector[]
}

export interface PartialHumanGateNode {
  id: string
  type: 'humanGate'
  artifact?: string
  requiredRole?: string
  effects?: PartialEffects
  budget?: Partial<Budget>
  contextSlice?: ContextSelector[]
}

export interface PartialLoopNode {
  id: string
  type: 'loop'
  maxIterations?: number
  until?: AcceptanceClaimRef[]
  body?: PartialNode[]
  effects?: PartialEffects
  budget?: Partial<Budget>
  contextSlice?: ContextSelector[]
}

export interface PartialConditionNode {
  id: string
  type: 'condition'
  when?: { output: string; op: 'eq' | 'ne' | 'exists'; value?: string }
  then?: string
  else?: string
  effects?: PartialEffects
  budget?: Partial<Budget>
  contextSlice?: ContextSelector[]
}

export type PartialNode =
  | PartialAgentNode
  | PartialToolNode
  | PartialHumanGateNode
  | PartialLoopNode
  | PartialConditionNode

/**
 * Effects a draft may have guessed at.
 *
 * `inferred` marks a value the extraction pass proposed from the conversation
 * without anything confirming it. It is not the same as absent and must not be
 * treated as bound — an unconfirmed guess about what a step writes is precisely
 * the input M5's invalidation frontier would silently get wrong.
 */
export interface PartialEffects {
  reads?: ResourceSelector[]
  writes?: ResourceSelector[]
  emits?: string[]
  inferred?: Array<'reads' | 'writes' | 'emits'>
}

export interface PartialWorkflow {
  id: string
  objective?: string
  nodes: PartialNode[]
  claims?: Record<string, Partial<AcceptanceClaim>>
}

/* -------------------------------------------------------------------- holes */

export type HoleState = 'MISSING' | 'PARTIAL'

export interface Hole {
  nodeId: string
  /** Dotted path into the node, e.g. `budget.timeoutSec` or `loop.until`. */
  field: string
  state: HoleState
  why: string
  /** Present for PARTIAL: proposed, but nothing has confirmed it. */
  inferred?: unknown
}

function hole(nodeId: string, field: string, why: string): Hole {
  return { nodeId, field, state: 'MISSING', why }
}

function partialHole(nodeId: string, field: string, why: string, inferred: unknown): Hole {
  return { nodeId, field, state: 'PARTIAL', why, inferred }
}

function effectHoles(node: PartialNode): Hole[] {
  const out: Hole[] = []
  const e = node.effects
  const inferred = new Set(e?.inferred ?? [])

  for (const field of ['reads', 'writes'] as const) {
    const value = e?.[field]
    if (!value) {
      out.push(
        hole(
          node.id,
          `effects.${field}`,
          `every node must declare what it ${field === 'reads' ? 'reads' : 'writes'} — ` +
            'a constraint injected mid-run is answered from these'
        )
      )
    } else if (inferred.has(field)) {
      out.push(
        partialHole(
          node.id,
          `effects.${field}`,
          'inferred from the conversation, unconfirmed',
          value
        )
      )
    }
  }
  if (!e?.emits) {
    out.push(hole(node.id, 'effects.emits', 'later steps reference outputs by name'))
  }
  return out
}

/**
 * Every unbound field in a draft.
 *
 * Structural and total: it walks the shape the IR requires rather than asking
 * the draft what it thinks is missing.
 */
export function holesOf(draft: PartialWorkflow): Hole[] {
  const out: Hole[] = []

  const visit = (node: PartialNode): void => {
    out.push(...effectHoles(node))

    if (node.budget?.timeoutSec === undefined) {
      out.push(hole(node.id, 'budget.timeoutSec', 'a step with no time bound can hang a run'))
    }
    if (!node.contextSlice) {
      out.push(hole(node.id, 'contextSlice', 'what this step is given — not everything'))
    }

    switch (node.type) {
      case 'agent':
        if (!node.role) out.push(hole(node.id, 'role', 'which role this step plays'))
        if (!node.agentId) out.push(hole(node.id, 'agentId', 'which agent runs it'))
        if (!node.toolProfile) {
          out.push(hole(node.id, 'toolProfile', 'how much tool surface this step pays for'))
        }
        if (!node.mode) {
          out.push(hole(node.id, 'mode', 'the capability ceiling for this step'))
        }
        if (!node.workspace) out.push(hole(node.id, 'workspace', 'readonly, or its own worktree'))
        if (!node.prompt) out.push(hole(node.id, 'prompt', 'what this step instructs its agent to do'))
        if (!node.output) out.push(hole(node.id, 'output', 'the name later steps refer to it by'))
        if (!node.inputs) out.push(hole(node.id, 'inputs', 'which earlier outputs it needs'))
        break

      case 'tool':
        if (!node.command) out.push(hole(node.id, 'command', 'the command to run'))
        if (!node.output) out.push(hole(node.id, 'output', 'the signal name claims refer to'))
        break

      case 'humanGate':
        if (!node.artifact) out.push(hole(node.id, 'artifact', 'what is being approved'))
        if (!node.requiredRole) {
          out.push(hole(node.id, 'requiredRole', 'who is allowed to approve it'))
        }
        break

      case 'loop':
        if (node.maxIterations === undefined) {
          out.push(hole(node.id, 'maxIterations', 'how many attempts before giving up'))
        }
        if (!node.until?.length) {
          out.push(hole(node.id, 'until', 'which acceptance claims end this loop'))
        }
        if (!node.body?.length) out.push(hole(node.id, 'body', 'what the loop repeats'))
        for (const child of node.body ?? []) visit(child)
        break

      case 'condition':
        if (!node.when) out.push(hole(node.id, 'when', 'the condition to evaluate'))
        if (!node.then) out.push(hole(node.id, 'then', 'what happens when it holds'))
        break
    }
  }

  for (const node of draft.nodes) visit(node)

  // Claims referenced by a loop but never declared, and declared claims that
  // are themselves incomplete.
  const referenced = new Set<string>()
  const collect = (nodes: PartialNode[]): void => {
    for (const n of nodes) {
      if (n.type !== 'loop') continue
      for (const ref of n.until ?? []) referenced.add(ref.claimId)
      collect(n.body ?? [])
    }
  }
  collect(draft.nodes)

  for (const claimId of referenced) {
    const claim = draft.claims?.[claimId] ?? {}
    if (!claim.predicate) {
      out.push(hole(`claim:${claimId}`, 'predicate', 'what machine-checkable fact ends the loop'))
    }
    if (!claim.evidenceTier) {
      out.push(hole(`claim:${claimId}`, 'evidenceTier', 'how strong the evidence has to be'))
    }
    if (claim.acceptThreshold === undefined) {
      out.push(hole(`claim:${claimId}`, 'acceptThreshold', 'how reliable the class must be to be trusted'))
    }
  }

  if (!draft.objective) {
    out.push(hole(draft.id, 'objective', 'what this workflow is for'))
  }

  return out
}

/**
 * How bound a node is.
 *
 * SPEC_BOUND means nothing is left open. REQUIREMENT means the step's identity
 * is settled — what it is and what it produces — and only configuration is
 * outstanding. FRAGMENT means the shape itself is still in question.
 */
const IDENTITY_FIELDS = ['role', 'prompt', 'output', 'command', 'artifact', 'body', 'when', 'until']

export function maturityOf(nodeId: string, holes: Hole[]): Maturity {
  const mine = holes.filter((h) => h.nodeId === nodeId)
  if (mine.length === 0) return 'SPEC_BOUND'
  if (mine.some((h) => IDENTITY_FIELDS.includes(h.field))) return 'FRAGMENT'
  return 'REQUIREMENT'
}

export function maturityMap(draft: PartialWorkflow, holes: Hole[]): Record<string, Maturity> {
  const out: Record<string, Maturity> = {}
  const visit = (node: PartialNode): void => {
    out[node.id] = maturityOf(node.id, holes)
    if (node.type === 'loop') for (const child of node.body ?? []) visit(child)
  }
  for (const node of draft.nodes) visit(node)
  return out
}

/**
 * Promote a fully-bound draft to a runnable Workflow.
 *
 * Returns null while anything is open. The cast is confined here, behind the
 * hole check, so there is exactly one place in the codebase where a partial
 * becomes a real workflow and it is the place that just proved it can.
 */
export function seal(draft: PartialWorkflow): import('./ir').Workflow | null {
  const holes = holesOf(draft)
  if (holes.length) return null

  const bind = (node: PartialNode): WorkflowNode => {
    const sealed = {
      ...node,
      maturity: 'SPEC_BOUND' as const,
      effects: {
        reads: node.effects?.reads ?? [],
        writes: node.effects?.writes ?? [],
        emits: node.effects?.emits ?? []
      }
    } as unknown as WorkflowNode
    if (node.type === 'loop') {
      ;(sealed as import('./ir').LoopNode).body = (node.body ?? []).map(bind)
    }
    if (sealed.type === 'humanGate') sealed.artifactSha256 = 'BIND_AT_RUNTIME'
    return sealed
  }

  return {
    id: draft.id,
    objective: draft.objective!,
    nodes: draft.nodes.map(bind),
    claims: (draft.claims ?? {}) as Record<string, AcceptanceClaim>
  }
}
