import { allNodes, type Workflow } from './ir'

/**
 * Structural difference between two workflows.
 *
 * Exists so the compiler can be scored rather than eyeballed: the exit
 * criterion is that a compiled workflow diffs near-empty against the
 * hand-written one, and "near-empty" has to mean something checkable.
 *
 * Differences are classified rather than counted, because they are not
 * comparable. Two workflows whose prompts are worded differently are the same
 * workflow. Two whose timeouts differ permit exactly the same actions and will
 * both be right or wrong for reasons no compiler could know. Two whose
 * capability modes differ are different workflows, however similar they read —
 * only that last kind changes what a run is allowed to do, so only that kind
 * has to be zero.
 */

export interface Difference {
  path: string
  expected: unknown
  actual: unknown
  kind: 'capability' | 'budget' | 'prose'
}

/** Fields where wording varies without changing what the workflow does. */
const PROSE_FIELDS = new Set(['prompt', 'objective', 'why'])

function classify(path: string): Difference['kind'] {
  const last = path.split('.').at(-1) ?? ''
  if (PROSE_FIELDS.has(last)) return 'prose'
  if (path.includes('budget')) return 'budget'
  return 'capability'
}

function compare(path: string, expected: unknown, actual: unknown, out: Difference[]): void {
  if (expected === actual) return

  const kind = classify(path)

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({ path: `${path}.length`, expected: expected.length, actual: actual.length, kind })
      return
    }
    expected.forEach((item, i) => compare(`${path}[${i}]`, item, actual[i], out))
    return
  }

  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object'
  ) {
    const keys = new Set([
      ...Object.keys(expected as object),
      ...Object.keys(actual as object)
    ])
    for (const k of keys) {
      compare(
        path ? `${path}.${k}` : k,
        (expected as Record<string, unknown>)[k],
        (actual as Record<string, unknown>)[k],
        out
      )
    }
    return
  }

  out.push({ path, expected, actual, kind })
}

/**
 * Differences between a reference workflow and a candidate.
 *
 * Nodes are matched by id rather than by position, because a compiler that
 * emits the right steps in a different order has produced the right workflow.
 */
export function diffWorkflows(expected: Workflow, actual: Workflow): Difference[] {
  const out: Difference[] = []

  compare('objective', expected.objective, actual.objective, out)

  const byId = (w: Workflow): Map<string, unknown> =>
    new Map(allNodes(w).map((n) => [n.id, n]))

  const left = byId(expected)
  const right = byId(actual)

  for (const [id, node] of left) {
    if (!right.has(id)) {
      out.push({ path: `node:${id}`, expected: node, actual: undefined, kind: 'capability' })
      continue
    }
    // Loop bodies are compared through the id map, so comparing them again
    // here would report every child twice.
    const strip = (n: unknown): unknown => {
      const { body: _body, ...rest } = n as Record<string, unknown>
      return rest
    }
    compare(`node:${id}`, strip(node), strip(right.get(id)), out)
  }

  for (const [id, node] of right) {
    if (!left.has(id)) {
      out.push({ path: `node:${id}`, expected: undefined, actual: node, kind: 'capability' })
    }
  }

  const claimIds = new Set([...Object.keys(expected.claims), ...Object.keys(actual.claims)])
  for (const id of claimIds) {
    compare(`claim:${id}`, expected.claims[id], actual.claims[id], out)
  }

  return out
}

/** The differences that change what a run may do. These have to be zero. */
export function capabilityOnly(differences: Difference[]): Difference[] {
  return differences.filter((d) => d.kind === 'capability')
}

export function summarize(differences: Difference[]): string {
  if (!differences.length) return 'identical'
  return differences
    .slice(0, 12)
    .map((d) => `${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`)
    .join('\n')
}
