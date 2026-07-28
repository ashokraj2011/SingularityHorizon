import type { SessionMode } from '../../shared/ipc'

/**
 * The workflow intermediate representation.
 *
 * Built before the compiler that targets it, so the first workflow is
 * hand-written and becomes the compiler's acceptance test rather than whatever
 * the compiler happens to emit.
 *
 * Two properties do the real work here, and both are structural rather than
 * advisory:
 *
 *   `effects` is mandatory on every node. It is what makes a mid-run constraint
 *   ("do not touch the database schema") answerable as a graph query instead of
 *   a guess — without it, invalidation degenerates to re-running everything,
 *   which is the same as having no answer.
 *
 *   `maturity` records how bound a node is. The compiler advances a node from
 *   FRAGMENT to SPEC_BOUND as it closes holes, and nothing runs until every
 *   node is SPEC_BOUND. That check is a validator, never a model: a gate that
 *   reads prose is a gate that can be argued with.
 */

/** What a step touches. Coarse by design — precision here is unenforceable. */
export interface ResourceSelector {
  kind: 'repo' | 'db.schema' | 'db.data' | 'config' | 'external'
  /** Glob, for `repo` and `config`. Absent means the whole kind. */
  path?: string
}

export interface StepEffects {
  reads: ResourceSelector[]
  writes: ResourceSelector[]
  /** Named outputs this step produces, referenced by later steps. */
  emits: string[]
}

export interface Budget {
  maxTokens?: number
  maxCostUsd?: number
  /** Required: a step with no time bound can hang a run forever. */
  timeoutSec: number
}

export interface ContextSelector {
  kind: 'document' | 'repo' | 'artifact' | 'thread'
  ref: string
}

export type Maturity = 'FRAGMENT' | 'REQUIREMENT' | 'SPEC_BOUND'

export interface BaseNode {
  id: string
  effects: StepEffects
  budget: Budget
  /** What this step is given. Not everything — that is the point. */
  contextSlice: ContextSelector[]
  maturity: Maturity
}

export interface AgentNode extends BaseNode {
  type: 'agent'
  role: string
  /** Any registered ACP agent. Cheap model to analyse, strong one to build. */
  agentId: string
  toolProfile: 'full' | 'no-mcp' | 'lean' | 'minimal'
  workspace: 'readonly' | 'isolatedWorktree'
  /** The M1 capability lattice, pinned per step. */
  mode: SessionMode
  /** The instruction this step gives its agent. */
  prompt: string
  inputs: string[]
  output: string
  /**
   * Where the runtime persists this step's output.
   *
   * The runtime writes it, not the agent — which is what lets an analyst run in
   * `explore` mode and still produce a design document. Making the agent write
   * its own artifact would force every step that emits one up to `edit`, and
   * the capability a step needs would be decided by bookkeeping rather than by
   * what the step actually does.
   */
  artifactPath?: string
}

export interface ToolNode extends BaseNode {
  type: 'tool'
  /** Run by the client, so its exit code is evidence rather than testimony. */
  command: string
  /** Named signal this produces, referenced by acceptance claims. */
  output: string
  /** Optional report to parse from the working directory afterwards. */
  report?: { kind: 'junit' | 'sarif'; path: string }
}

export interface HumanGateNode extends BaseNode {
  type: 'humanGate'
  /** Named output of a prior step. */
  artifact: string
  /**
   * Approval binds the content hash, never the name. A gate that approved
   * "the design" would still read as approved after the design changed.
   */
  artifactSha256: 'BIND_AT_RUNTIME'
  requiredRole: string
}

export interface ConditionNode extends BaseNode {
  type: 'condition'
  /** Evaluated against named outputs already in scope. */
  when: { output: string; op: 'eq' | 'ne' | 'exists'; value?: string }
  then: string
  else?: string
}

export interface LoopNode extends BaseNode {
  type: 'loop'
  maxIterations: number
  /** Calibrated claims, not booleans. See claims.ts. */
  until: AcceptanceClaimRef[]
  body: WorkflowNode[]
}

/** Claims are declared once and referenced, so a run can score them per class. */
export interface AcceptanceClaimRef {
  claimId: string
}

export type WorkflowNode =
  | AgentNode
  | ToolNode
  | HumanGateNode
  | ConditionNode
  | LoopNode

export interface Workflow {
  id: string
  objective: string
  nodes: WorkflowNode[]
  /** Referenced by loops. Declared here so posteriors accumulate per class. */
  claims: Record<string, import('./claims').AcceptanceClaim>
}

/* ------------------------------------------------------- executability gate */

export interface ValidationIssue {
  nodeId: string
  problem: string
}

export interface ValidationResult {
  runnable: boolean
  issues: ValidationIssue[]
}

function walk(nodes: WorkflowNode[], visit: (n: WorkflowNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if (node.type === 'loop') walk(node.body, visit)
  }
}

/** Every node in the workflow, loop bodies included. */
export function allNodes(workflow: Workflow): WorkflowNode[] {
  const out: WorkflowNode[] = []
  walk(workflow.nodes, (n) => out.push(n))
  return out
}

/**
 * Whether this workflow may run.
 *
 * Deterministic and total — it either passes or it names what is missing.
 * Nothing here consults a model, and nothing here reads prose. A workflow is
 * runnable iff it is schema-valid, every node is SPEC_BOUND, every budget is
 * set, every human gate has a role, and every node declares its effects.
 */
export function validate(workflow: Workflow): ValidationResult {
  const issues: ValidationIssue[] = []
  const nodes = allNodes(workflow)
  const seen = new Set<string>()
  const emitted = new Set<string>()

  if (!nodes.length) issues.push({ nodeId: workflow.id, problem: 'workflow has no nodes' })

  for (const node of nodes) {
    if (seen.has(node.id)) issues.push({ nodeId: node.id, problem: 'duplicate node id' })
    seen.add(node.id)

    if (node.maturity !== 'SPEC_BOUND') {
      issues.push({
        nodeId: node.id,
        problem: `is ${node.maturity}; every node must be SPEC_BOUND before a run`
      })
    }

    if (!node.effects) {
      issues.push({ nodeId: node.id, problem: 'declares no effects' })
    } else {
      if (!Array.isArray(node.effects.reads) || !Array.isArray(node.effects.writes)) {
        issues.push({ nodeId: node.id, problem: 'effects.reads and effects.writes are required' })
      }
      for (const name of node.effects.emits ?? []) emitted.add(name)
    }

    if (!node.budget || typeof node.budget.timeoutSec !== 'number' || node.budget.timeoutSec <= 0) {
      issues.push({ nodeId: node.id, problem: 'needs a positive budget.timeoutSec' })
    }

    if (node.type === 'humanGate') {
      if (!node.requiredRole) {
        issues.push({ nodeId: node.id, problem: 'human gate has no required role' })
      }
      if (node.artifactSha256 !== 'BIND_AT_RUNTIME') {
        issues.push({
          nodeId: node.id,
          problem: 'artifactSha256 must be BIND_AT_RUNTIME — a hash cannot be authored ahead of the artifact'
        })
      }
    }

    if (node.type === 'loop') {
      if (!(node.maxIterations > 0)) {
        issues.push({ nodeId: node.id, problem: 'loop needs a positive maxIterations' })
      }
      if (!node.until?.length) {
        issues.push({ nodeId: node.id, problem: 'loop has no acceptance claims to exit on' })
      }
      for (const ref of node.until ?? []) {
        if (!workflow.claims[ref.claimId]) {
          issues.push({ nodeId: node.id, problem: `references undeclared claim "${ref.claimId}"` })
        }
      }
      if (!node.body?.length) issues.push({ nodeId: node.id, problem: 'loop body is empty' })
    }
  }

  // An input nobody produces is a hole the compiler failed to close, and it
  // fails at the point of use rather than at submission — which is the worst
  // time to discover it.
  for (const node of nodes) {
    if (node.type !== 'agent') continue
    for (const input of node.inputs ?? []) {
      if (!emitted.has(input)) {
        issues.push({ nodeId: node.id, problem: `input "${input}" is never emitted by any step` })
      }
    }
  }

  for (const node of nodes) {
    if (node.type !== 'humanGate') continue
    if (!emitted.has(node.artifact)) {
      issues.push({ nodeId: node.id, problem: `gates on "${node.artifact}", which no step emits` })
    }
  }

  return { runnable: issues.length === 0, issues }
}
