import { allNodes, validate, type ValidationResult, type Workflow, type WorkflowNode } from './ir'

/**
 * The plan, as a view of the IR.
 *
 * A rendered plan someone can edit is the obvious thing to build and the
 * obvious thing to get wrong: the moment the plan holds anything the IR does
 * not, there are two sources of truth and the interesting question becomes
 * which one the runtime obeyed. So the plan is derived on every read, edits are
 * expressed against IR paths, and applying one produces a new workflow that is
 * revalidated before anything accepts it.
 *
 * Nothing here is allowed to store state. If this file ever grows a cache, the
 * property above is gone.
 */

export interface PlanField {
  /** IR path an edit writes to, e.g. `mode` or `budget.timeoutSec`. */
  path: string
  label: string
  value: unknown
  editable: boolean
  /** Where the value came from, when it was not authored by hand. */
  options?: string[]
}

export interface PlanStep {
  nodeId: string
  kind: WorkflowNode['type']
  title: string
  /** Loop bodies nest, so the plan reads like the workflow runs. */
  depth: number
  fields: PlanField[]
}

export interface PlanView {
  workflowId: string
  objective: string
  steps: PlanStep[]
}

const MODES = ['discuss', 'explore', 'plan', 'edit', 'verify', 'deliver']
const PROFILES = ['full', 'no-mcp', 'lean', 'minimal']

function titleOf(node: WorkflowNode): string {
  switch (node.type) {
    case 'agent':
      return `${node.role} — ${node.agentId}`
    case 'tool':
      return node.command
    case 'humanGate':
      return `Approve "${node.artifact}" (${node.requiredRole})`
    case 'loop':
      return `Repeat until ${node.until.map((u) => u.claimId).join(' and ')}`
    case 'condition':
      return `If ${node.when.output} ${node.when.op} ${node.when.value ?? ''}`
  }
}

function fieldsOf(node: WorkflowNode): PlanField[] {
  const common: PlanField[] = [
    {
      path: 'budget.timeoutSec',
      label: 'Timeout (s)',
      value: node.budget.timeoutSec,
      editable: true
    },
    {
      path: 'effects.writes',
      label: 'Writes',
      value: node.effects.writes,
      editable: true
    },
    // Maturity is computed from what is bound, so offering it as an editable
    // field would let someone mark an unfinished step ready by typing.
    { path: 'maturity', label: 'Maturity', value: node.maturity, editable: false }
  ]

  switch (node.type) {
    case 'agent':
      return [
        { path: 'agentId', label: 'Agent', value: node.agentId, editable: true },
        { path: 'mode', label: 'Capability', value: node.mode, editable: true, options: MODES },
        {
          path: 'toolProfile',
          label: 'Tool profile',
          value: node.toolProfile,
          editable: true,
          options: PROFILES
        },
        { path: 'prompt', label: 'Instruction', value: node.prompt, editable: true },
        ...common
      ]
    case 'tool':
      return [
        { path: 'command', label: 'Command', value: node.command, editable: true },
        { path: 'output', label: 'Signal', value: node.output, editable: true },
        ...common
      ]
    case 'humanGate':
      return [
        { path: 'requiredRole', label: 'Approver role', value: node.requiredRole, editable: true },
        { path: 'artifact', label: 'Artifact', value: node.artifact, editable: false },
        ...common
      ]
    case 'loop':
      return [
        { path: 'maxIterations', label: 'Max attempts', value: node.maxIterations, editable: true },
        {
          path: 'until',
          label: 'Exit claims',
          value: node.until.map((u) => u.claimId),
          editable: false
        },
        ...common
      ]
    case 'condition':
      return [{ path: 'then', label: 'Then', value: node.then, editable: true }, ...common]
  }
}

/** Derived on every read. Never stored. */
export function toPlan(workflow: Workflow): PlanView {
  const steps: PlanStep[] = []
  const walk = (nodes: WorkflowNode[], depth: number): void => {
    for (const node of nodes) {
      steps.push({
        nodeId: node.id,
        kind: node.type,
        title: titleOf(node),
        depth,
        fields: fieldsOf(node)
      })
      if (node.type === 'loop') walk(node.body, depth + 1)
    }
  }
  walk(workflow.nodes, 0)
  return { workflowId: workflow.id, objective: workflow.objective, steps }
}

export interface PlanEdit {
  nodeId: string
  path: string
  value: unknown
}

export interface EditResult {
  workflow: Workflow
  validation: ValidationResult
  /** Set when the edit was refused rather than applied. */
  refused?: string
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts.at(-1)!] = value
}

/**
 * Apply a plan edit to the IR and revalidate.
 *
 * Refuses edits to fields the plan marked read-only. The plan is a view, so a
 * field it renders as fixed has to be fixed here too — otherwise "editable" is
 * a styling decision that a hand-written request can ignore.
 */
export function applyPlanEdit(workflow: Workflow, edit: PlanEdit): EditResult {
  const next = JSON.parse(JSON.stringify(workflow)) as Workflow
  const node = allNodes(next).find((n) => n.id === edit.nodeId)

  if (!node) {
    return { workflow, validation: validate(workflow), refused: `no such step: ${edit.nodeId}` }
  }

  const field = fieldsOf(node).find((f) => f.path === edit.path)
  if (!field) {
    return {
      workflow,
      validation: validate(workflow),
      refused: `"${edit.path}" is not a field of this step`
    }
  }
  if (!field.editable) {
    return {
      workflow,
      validation: validate(workflow),
      refused: `"${field.label}" is derived, not authored — it cannot be edited directly`
    }
  }
  if (field.options && !field.options.includes(String(edit.value))) {
    return {
      workflow,
      validation: validate(workflow),
      refused: `"${edit.value}" is not one of: ${field.options.join(', ')}`
    }
  }

  setPath(node as unknown as Record<string, unknown>, edit.path, edit.value)
  return { workflow: next, validation: validate(next) }
}
