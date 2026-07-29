import type { Constraint } from '../workflow/constraints'
import { forbiddenWritePaths, matchGlob } from '../workflow/constraints'
import type { SessionMode } from '../../shared/ipc'
import type { SessionPolicy } from '../acp/policy'
import type { Budgets, CapabilityForest, GateRule, PolicyFragment } from './model'
import { ancestryOf, pathOf } from './model'

/**
 * Policy resolution — a fold, not a search.
 *
 * Effective policy at a node is the fold over the root→node path:
 *
 *   gates       union
 *   constraints union
 *   budgets     elementwise MIN
 *   allowlists  intersection
 *
 * Each operation is chosen so that a child can only tighten. There is no
 * override syntax anywhere in the schema, and that absence *is* the
 * enforcement — nothing here has to check for an escape, because none is
 * representable. A child declaring a larger budget does not get one; MIN simply
 * ignores it.
 *
 * This is the vertical twin of the M1 mode lattice. The lattice bounds what a
 * session may reach; this bounds what a subtree may permit. Both are pure
 * functions of structure, both are deterministic, and both refuse to be argued
 * with by anything downstream.
 *
 * Resolution happens host-side. The kernel receives an already-resolved
 * SessionPolicy plus a flat capabilityId for stamping, and never sees the tree.
 */

export interface ResolvedPolicy {
  capabilityId: string
  /** Denormalized at resolve time, so a later re-parenting cannot rewrite it. */
  capabilityPath: string
  requiredGates: GateRule[]
  constraints: Constraint[]
  budgets: Budgets
  /**
   * Absent means no allow-list anywhere on the path — unrestricted, which is
   * different from an empty list, which permits nothing.
   */
  terminalAllowList?: string[]
  /** Root→node, for explaining where a rule came from. */
  ancestry: string[]
}

function gateKey(gate: GateRule): string {
  return `${gate.on}|${gate.role}|${gate.scope ?? ''}`
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

/**
 * Fold one fragment onto an accumulator.
 *
 * Exported because the fold is the specification: a test that re-implements it
 * proves nothing, and a test that drives it one step at a time can show that
 * each operation is the one the spec names.
 */
export function foldFragment(
  accumulated: {
    requiredGates: GateRule[]
    constraints: Constraint[]
    budgets: Budgets
    terminalAllowList?: string[]
  },
  fragment: PolicyFragment | undefined
): typeof accumulated {
  if (!fragment) return accumulated

  // Union, de-duplicated: the same gate declared at two levels is one gate, not
  // two reviews.
  const gates = [...accumulated.requiredGates]
  const seen = new Set(gates.map(gateKey))
  for (const gate of fragment.requiredGates ?? []) {
    if (seen.has(gateKey(gate))) continue
    seen.add(gateKey(gate))
    gates.push(gate)
  }

  const constraintIds = new Set(accumulated.constraints.map((c) => c.id))
  const constraints = [...accumulated.constraints]
  for (const constraint of fragment.constraints ?? []) {
    if (constraintIds.has(constraint.id)) continue
    constraintIds.add(constraint.id)
    constraints.push(constraint)
  }

  const budgets: Budgets = {
    maxCostUsdPerThread: minDefined(
      accumulated.budgets.maxCostUsdPerThread,
      fragment.budgets?.maxCostUsdPerThread
    ),
    maxTokensPerStep: minDefined(
      accumulated.budgets.maxTokensPerStep,
      fragment.budgets?.maxTokensPerStep
    )
  }

  // Intersection. A child listing a command an ancestor never permitted does not
  // gain it; an ancestor with no list at all is not a constraint to intersect
  // against, which is why absent and empty have to stay distinguishable.
  let allowList = accumulated.terminalAllowList
  if (fragment.terminalAllowList) {
    allowList = allowList
      ? allowList.filter((command) => fragment.terminalAllowList!.includes(command))
      : [...fragment.terminalAllowList]
  }

  return {
    requiredGates: gates,
    constraints,
    budgets,
    ...(allowList ? { terminalAllowList: allowList } : {})
  }
}

/** Effective policy at a node. Pure in (forest, capabilityId). */
export function resolvePolicy(
  forest: CapabilityForest,
  capabilityId: string
): ResolvedPolicy | null {
  const ancestry = ancestryOf(forest, capabilityId)
  if (!ancestry) return null

  let accumulated: Parameters<typeof foldFragment>[0] = {
    requiredGates: [],
    constraints: [],
    budgets: {}
  }

  for (const id of ancestry) {
    accumulated = foldFragment(accumulated, forest.byId.get(id)?.policy)
  }

  const budgets: Budgets = {}
  if (accumulated.budgets.maxCostUsdPerThread !== undefined) {
    budgets.maxCostUsdPerThread = accumulated.budgets.maxCostUsdPerThread
  }
  if (accumulated.budgets.maxTokensPerStep !== undefined) {
    budgets.maxTokensPerStep = accumulated.budgets.maxTokensPerStep
  }

  return {
    capabilityId,
    capabilityPath: pathOf(forest, capabilityId) ?? capabilityId,
    requiredGates: accumulated.requiredGates,
    constraints: accumulated.constraints,
    budgets,
    ...(accumulated.terminalAllowList ? { terminalAllowList: accumulated.terminalAllowList } : {}),
    ancestry
  }
}

/**
 * Whether one resolved policy is at least as tight as another.
 *
 * The monotonicity invariant, as a checkable predicate rather than a comment.
 * Used to assert the property across a whole forest: for every node, its
 * resolution must be no looser than its parent's. If that ever fails, some
 * operation in the fold is wrong — which is a different and much worse bug than
 * a manifest being wrong.
 */
export function isAtLeastAsTight(child: ResolvedPolicy, parent: ResolvedPolicy): boolean {
  const parentGates = new Set(parent.requiredGates.map(gateKey))
  for (const gate of parentGates) {
    if (!child.requiredGates.some((g) => gateKey(g) === gate)) return false
  }

  for (const constraint of parent.constraints) {
    if (!child.constraints.some((c) => c.id === constraint.id)) return false
  }

  for (const field of ['maxCostUsdPerThread', 'maxTokensPerStep'] as const) {
    const parentValue = parent.budgets[field]
    if (parentValue === undefined) continue
    const childValue = child.budgets[field]
    if (childValue === undefined || childValue > parentValue) return false
  }

  if (parent.terminalAllowList) {
    if (!child.terminalAllowList) return false
    for (const command of child.terminalAllowList) {
      if (!parent.terminalAllowList.includes(command)) return false
    }
  }

  return true
}

/** Every node whose resolution is looser than its parent's. Expected: none. */
export function monotonicityViolations(forest: CapabilityForest): string[] {
  const violations: string[] = []
  for (const capability of forest.byId.values()) {
    if (!capability.parent) continue
    const child = resolvePolicy(forest, capability.id)
    const parent = resolvePolicy(forest, capability.parent)
    if (!child || !parent) continue
    if (!isAtLeastAsTight(child, parent)) violations.push(capability.id)
  }
  return violations
}

/**
 * The SessionPolicy the kernel already takes.
 *
 * The whole point of resolving host-side: what crosses into the session layer is
 * a flat capability policy and an id, in a shape the M1 gate already enforces.
 * Nothing below this line knows a tree exists.
 *
 * `writePolicy: 'gated'` on a repo is deliberately *not* folded in here. It is
 * per-repo rather than per-session, and flattening it would either over-restrict
 * a session that spans an open repo and a gated one, or silently under-restrict
 * the gated one. It belongs to the per-repo worktree grant instead.
 */
export function toSessionPolicy(
  resolved: ResolvedPolicy,
  mode: SessionMode
): SessionPolicy {
  const forbidden = forbiddenWritePaths(resolved.constraints)
  return {
    mode,
    grants: [],
    ...(resolved.terminalAllowList ? { commandAllowList: resolved.terminalAllowList } : {}),
    ...(forbidden.length ? { forbiddenWrites: forbidden, matchPath: matchGlob } : {})
  }
}

/**
 * Where a rule came from.
 *
 * A resolved policy with no provenance is unarguable in the wrong way: someone
 * hits a gate they did not add and has nowhere to look. The fold knows the
 * answer, so it may as well be recoverable.
 */
export function explainGate(
  forest: CapabilityForest,
  capabilityId: string,
  gate: GateRule
): string | null {
  const ancestry = ancestryOf(forest, capabilityId)
  if (!ancestry) return null
  for (const id of ancestry) {
    const declared = forest.byId.get(id)?.policy?.requiredGates ?? []
    if (declared.some((g) => gateKey(g) === gateKey(gate))) return id
  }
  return null
}
