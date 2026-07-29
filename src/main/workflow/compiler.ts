import type { Maturity, ResourceSelector, ValidationIssue, Workflow } from './ir'
import { validate } from './ir'
import {
  holesOf,
  maturityMap,
  seal,
  type Hole,
  type PartialLoopNode,
  type PartialNode,
  type PartialWorkflow
} from './partial'
import { DEFAULT_PLAYBOOK, GATE_BUDGET, type Playbook } from './playbook'

/**
 * The compiler: elicitation with a typed target.
 *
 * It does not translate a conversation into a workflow. It works out what the
 * conversation failed to settle and closes each of those holes by exactly one
 * of three routes:
 *
 *   playbook — an org convention, recorded with the playbook version that
 *              supplied it, so the choice stays explicable after the playbook
 *              has moved on
 *   fabric   — a lookup against what is already known about the repository
 *   question — a human. Last, and counted, because this is the only route that
 *              costs someone's attention. A compiler that asks about the tool
 *              profile has spent the user's patience before reaching the
 *              question that actually needed them.
 *
 * The gate at the end is the M3 validator — deterministic, and never a model.
 */

export interface Question {
  hole: Hole
  /** Phrased for a person, not for a schema. */
  ask: string
  /** Offered where the answer is drawn from a known set. */
  options?: string[]
}

export interface BindingRecord {
  nodeId: string
  field: string
  route: 'playbook' | 'fabric' | 'question'
  value: unknown
  /** Playbook version, fabric query, or the question that was answered. */
  source: string
}

export interface CompileResult {
  /** Present only when nothing is left open. */
  workflow: Workflow | null
  draft: PartialWorkflow
  questions: Question[]
  bindings: BindingRecord[]
  holes: Hole[]
  maturity: Record<string, Maturity>
  runnable: boolean
  issues: ValidationIssue[]
}

/**
 * What is already known about the repository.
 *
 * Injected: the compiler has no business knowing how a world model is built,
 * and a lookup that misses must be able to say so rather than inventing paths.
 */
export interface Fabric {
  /** Paths a role with this intent is expected to touch, or null if unknown. */
  effectsFor(node: { id: string; role?: string; intent?: string }):
    | { reads?: ResourceSelector[]; writes?: ResourceSelector[] }
    | null
}

export const EMPTY_FABRIC: Fabric = { effectsFor: () => null }

export interface CompileOptions {
  playbook?: Playbook
  fabric?: Fabric
  /** Answers keyed `${nodeId}.${field}`, from a previous round of questions. */
  answers?: Record<string, unknown>
}

const key = (h: Pick<Hole, 'nodeId' | 'field'>): string => `${h.nodeId}.${h.field}`

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
}

function findNode(draft: PartialWorkflow, nodeId: string): PartialNode | undefined {
  const search = (nodes: PartialNode[]): PartialNode | undefined => {
    for (const node of nodes) {
      if (node.id === nodeId) return node
      if (node.type === 'loop') {
        const found = search((node as PartialLoopNode).body ?? [])
        if (found) return found
      }
    }
    return undefined
  }
  return search(draft.nodes)
}

/** Phrasing for the holes a person has to answer. */
function phrase(hole: Hole, node?: PartialNode): Question {
  const label = node && 'role' in node && node.role ? `the ${node.role} step` : `"${hole.nodeId}"`

  switch (hole.field) {
    case 'until':
      return {
        hole,
        ask: `What has to be true for ${label} to stop retrying? Name the checks — each becomes a claim evaluated from a real exit code, not from what the agent reports.`
      }
    case 'maxIterations':
      return { hole, ask: `How many attempts should ${label} make before handing back to a person?` }
    case 'requiredRole':
      return { hole, ask: `Who is allowed to approve ${hole.nodeId}?` }
    case 'predicate':
      return { hole, ask: `How is "${hole.nodeId.replace('claim:', '')}" checked, mechanically?` }
    case 'effects.writes':
      return hole.state === 'PARTIAL'
        ? {
            hole,
            ask: `Does ${label} write only ${describe(hole.inferred)}? A mid-run constraint is answered from this, so a wrong answer here is a wrong answer later.`,
            options: ['yes', 'no']
          }
        : { hole, ask: `What does ${label} write?` }
    case 'objective':
      return { hole, ask: 'In one line, what is this workflow for?' }
    default:
      return { hole, ask: `${hole.field} for ${label}: ${hole.why}` }
  }
}

function describe(value: unknown): string {
  if (!Array.isArray(value)) return String(value)
  return value
    .map((v) => (v as ResourceSelector).path ?? (v as ResourceSelector).kind)
    .join(', ')
}

/**
 * Close every hole that can be closed without a person, then report the rest.
 *
 * Pure: it copies the draft rather than mutating the caller's, so a round of
 * answers can be replayed against the original draft and produce the same
 * result. That matters because a compile is re-run every time a question is
 * answered.
 */
export function compile(input: PartialWorkflow, options: CompileOptions = {}): CompileResult {
  const playbook = options.playbook ?? DEFAULT_PLAYBOOK
  const fabric = options.fabric ?? EMPTY_FABRIC
  const answers = options.answers ?? {}
  const draft = JSON.parse(JSON.stringify(input)) as PartialWorkflow
  const bindings: BindingRecord[] = []

  // 1. Answers first: a human decision outranks any default.
  for (const [path, value] of Object.entries(answers)) {
    const dot = path.indexOf('.')
    const nodeId = path.slice(0, dot)
    const field = path.slice(dot + 1)

    if (nodeId.startsWith('claim:')) {
      const claimId = nodeId.slice('claim:'.length)
      draft.claims = draft.claims ?? {}
      draft.claims[claimId] = draft.claims[claimId] ?? {}
      if (field === 'claim') Object.assign(draft.claims[claimId], value)
      else setPath(draft.claims[claimId] as Record<string, unknown>, field, value)
    } else if (nodeId === draft.id) {
      setPath(draft as unknown as Record<string, unknown>, field, value)
    } else {
      const node = findNode(draft, nodeId)
      if (node) setPath(node as unknown as Record<string, unknown>, field, value)
    }
    // Confirming an inferred value has to clear the inference, or the hole
    // stays PARTIAL forever and the compiler asks the same question every
    // round — the one failure mode that makes an elicitation loop never
    // converge.
    if (field.startsWith('effects.')) {
      const node = findNode(draft, nodeId)
      const which = field.slice('effects.'.length) as 'reads' | 'writes' | 'emits'
      if (node?.effects?.inferred) {
        node.effects.inferred = node.effects.inferred.filter((f) => f !== which)
      }
    }

    bindings.push({ nodeId, field, route: 'question', value, source: 'answered by user' })
  }

  // A loop that names a claim nobody declared does not need a person to be told
  // the claim is missing — it needs to be asked how that check is made. Stub it
  // from convention so the only hole left is the one worth a question.
  const referenced = new Set<string>()
  const collectClaims = (nodes: PartialNode[]): void => {
    for (const n of nodes) {
      if (n.type !== 'loop') continue
      for (const ref of n.until ?? []) referenced.add(ref.claimId)
      collectClaims(n.body ?? [])
    }
  }
  collectClaims(draft.nodes)
  for (const claimId of referenced) {
    draft.claims = draft.claims ?? {}
    if (!draft.claims[claimId]) draft.claims[claimId] = {}
  }

  // 2. The playbook: org convention, applied by role.
  const applyPlaybook = (node: PartialNode): void => {
    if (node.type === 'agent' && node.role) {
      const defaults = playbook.roles[node.role]
      if (defaults) {
        for (const field of ['agentId', 'toolProfile', 'mode', 'workspace'] as const) {
          if (node[field] === undefined) {
            ;(node as unknown as Record<string, unknown>)[field] = defaults[field]
            bindings.push({
              nodeId: node.id,
              field,
              route: 'playbook',
              value: defaults[field],
              source: `${playbook.version} roles.${node.role}`
            })
          }
        }
        if (node.budget?.timeoutSec === undefined) {
          node.budget = { ...defaults.budget, ...node.budget }
          bindings.push({
            nodeId: node.id,
            field: 'budget',
            route: 'playbook',
            value: node.budget,
            source: `${playbook.version} roles.${node.role}`
          })
        }
      }
    }

    if (node.type === 'humanGate' && (!node.effects?.reads || !node.effects?.writes)) {
      node.effects = { ...node.effects, reads: [], writes: [] }
      bindings.push({
        nodeId: node.id,
        field: 'effects',
        route: 'playbook',
        value: node.effects,
        source: 'a human gate touches nothing by construction'
      })
    }

    if (node.budget?.timeoutSec === undefined) {
      // A gate waits on a person, so it gets the long clock rather than the
      // step default — a gate that times out in ten minutes is a gate that
      // fails whenever someone is in a meeting.
      const budget =
        node.type === 'humanGate'
          ? GATE_BUDGET
          : node.type === 'loop'
            ? playbook.loopBudget
            : playbook.defaultBudget
      node.budget = { ...budget, ...node.budget }
      bindings.push({
        nodeId: node.id,
        field: 'budget',
        route: 'playbook',
        value: node.budget,
        source: `${playbook.version} ${
          node.type === 'humanGate' ? 'gate budget' : node.type === 'loop' ? 'loopBudget' : 'defaultBudget'
        }`
      })
    }

    if (!node.contextSlice) {
      node.contextSlice = []
      bindings.push({
        nodeId: node.id,
        field: 'contextSlice',
        route: 'playbook',
        value: [],
        source: `${playbook.version} empty slice`
      })
    }

    if (node.type === 'loop') for (const child of node.body ?? []) applyPlaybook(child)
  }
  for (const node of draft.nodes) applyPlaybook(node)

  // Claim conventions.
  for (const [claimId, claim] of Object.entries(draft.claims ?? {})) {
    if (!claim.claimClass) claim.claimClass = claimId
    if (!claim.evidenceTier) {
      claim.evidenceTier = playbook.claimDefaults.evidenceTier
      bindings.push({
        nodeId: `claim:${claimId}`,
        field: 'evidenceTier',
        route: 'playbook',
        value: claim.evidenceTier,
        source: `${playbook.version} claimDefaults`
      })
    }
    if (claim.acceptThreshold === undefined) {
      claim.acceptThreshold = playbook.claimDefaults.acceptThreshold
      bindings.push({
        nodeId: `claim:${claimId}`,
        field: 'acceptThreshold',
        route: 'playbook',
        value: claim.acceptThreshold,
        source: `${playbook.version} claimDefaults`
      })
    }
  }

  // 3. The fabric: what is already known about this repository.
  const applyFabric = (node: PartialNode): void => {
    const needsReads = !node.effects?.reads
    const needsWrites = !node.effects?.writes
    if (needsReads || needsWrites) {
      const known = fabric.effectsFor({
        id: node.id,
        role: node.type === 'agent' ? node.role : undefined,
        intent: node.type
      })
      if (known) {
        node.effects = { ...node.effects }
        if (needsReads && known.reads) {
          node.effects.reads = known.reads
          bindings.push({
            nodeId: node.id,
            field: 'effects.reads',
            route: 'fabric',
            value: known.reads,
            source: 'repository model'
          })
        }
        if (needsWrites && known.writes) {
          node.effects.writes = known.writes
          bindings.push({
            nodeId: node.id,
            field: 'effects.writes',
            route: 'fabric',
            value: known.writes,
            source: 'repository model'
          })
        }
      }
    }
    // An emit list can be read off the node itself: a step's output *is* what
    // it emits, so asking about it would be asking a question we can answer.
    if (!node.effects?.emits) {
      const emits =
        'output' in node && node.output
          ? [node.output]
          : node.type === 'loop'
            ? ((node.body ?? []).flatMap((c) => ('output' in c && c.output ? [c.output] : [])))
            : []
      node.effects = { ...node.effects, emits }
      bindings.push({
        nodeId: node.id,
        field: 'effects.emits',
        route: 'fabric',
        value: emits,
        source: "the step's own declared output"
      })
    }
    if (node.type === 'loop') for (const child of node.body ?? []) applyFabric(child)
  }
  for (const node of draft.nodes) applyFabric(node)

  // 4. Whatever is left needs a person.
  const remaining = holesOf(draft)
  const answered = new Set(Object.keys(answers))
  const questions = remaining
    .filter((h) => !answered.has(key(h)))
    .map((h) => phrase(h, findNode(draft, h.nodeId)))

  const workflow = seal(draft)
  const check = workflow ? validate(workflow) : { runnable: false, issues: [] }

  return {
    workflow,
    draft,
    questions,
    bindings,
    holes: remaining,
    maturity: maturityMap(draft, remaining),
    runnable: check.runnable,
    issues: check.issues
  }
}

/**
 * A draft plus one round of answers.
 *
 * Answers accumulate rather than replace, so a second round of questions does
 * not undo the first — the compile is re-run from the original draft each time,
 * and the accumulated answers are what make it converge.
 */
export function answer(
  result: CompileResult,
  original: PartialWorkflow,
  newAnswers: Record<string, unknown>,
  options: CompileOptions = {}
): CompileResult {
  const priorAnswers = Object.fromEntries(
    result.bindings
      .filter((b) => b.route === 'question')
      .map((b) => [`${b.nodeId}.${b.field}`, b.value])
  )
  return compile(original, { ...options, answers: { ...priorAnswers, ...newAnswers } })
}
