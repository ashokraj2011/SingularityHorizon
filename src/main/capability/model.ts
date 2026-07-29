import type { Constraint } from '../workflow/constraints'

/**
 * The Capability object model, frozen at spec v1.
 *
 * A Capability is a node in an ownership tree that governs how software is
 * delivered within its scope. Business nodes are interior — pure governance and
 * rollup. Delivery nodes own repos and do work.
 *
 * Two structural facts carry most of the weight:
 *
 *   Ownership is a tree, usage is a graph. A repo has exactly one owning
 *   capability, always; a shared thing gets one owner and consumer edges from
 *   everyone else. Dual membership is not a validation failure to be relaxed
 *   later — it is the thing single ownership exists to forbid.
 *
 *   `id` is path-like by convention, but `parent` is authoritative. Renames and
 *   re-parenting therefore do not break history, because events store the id
 *   and never the path. Anything that reads a path has to re-derive it.
 */

export type CapabilityKind = 'business' | 'delivery'

export interface RepoRef {
  /** Local name within the capability, e.g. `retry-svc`. */
  repoId: string
  url: string
  defaultBase: string
  /**
   * `gated` means the policy gate refuses fs.write without a workflow-carried
   * grant — the M1 lattice, applied per repo rather than per session.
   */
  writePolicy: 'open' | 'gated'
}

export interface ContractRef {
  path: string
  /** Component this contract describes, when it names one. */
  component?: string
}

export interface ConsumerEdge {
  /** Capability id that OWNS the consumed thing. */
  provider: string
  contract?: ContractRef
  /** Component within the provider, when the edge is that specific. */
  component?: string
}

export interface GateRule {
  /** Workflow phase or mode the gate attaches to, e.g. `deliver`. */
  on: string
  role: string
  scope?: string
}

export interface Budgets {
  maxCostUsdPerThread?: number
  maxTokensPerStep?: number
}

export interface PolicyFragment {
  /** Constraints this node ADDS. There is no syntax for removing one. */
  requiredGates?: GateRule[]
  budgets?: Budgets
  constraints?: Constraint[]
  terminalAllowList?: string[]
}

export type ComponentKind = 'api' | 'database' | 'queue' | 'storage' | 'service' | 'job'

/** Claims kept honest by observation, not a configuration database. */
export type ComponentStatus = 'proposed' | 'confirmed' | 'stale' | 'contradicted'

export interface ComponentObservation {
  extractor: string
  repo: string
  path?: string
  sha?: string
  at?: number
}

export interface Component {
  id: string
  kind: ComponentKind
  tech?: string
  status: ComponentStatus
  provenance?: {
    declared?: { by: string; at?: number }
    observed?: ComponentObservation[]
  }
}

export interface LedgerRef {
  url: string
  defaultBase?: string
}

export interface Capability {
  /** Stable slug, globally unique. Path-like by convention only. */
  id: string
  name?: string
  kind: CapabilityKind
  /** Absent only at roots. */
  parent?: string
  repos?: RepoRef[]
  /** Present iff the node has materialized its own ledger repo. */
  ledger?: LedgerRef
  policy?: PolicyFragment
  consumes?: ConsumerEdge[]
  components?: Component[]
}

/**
 * A whole forest, flattened by id.
 *
 * Flat because every lookup the resolver and validator do is by id, and because
 * a nested representation would make the parent field decorative — the thing
 * the spec says is authoritative.
 */
export interface CapabilityForest {
  byId: Map<string, Capability>
}

export function forestOf(capabilities: Capability[]): CapabilityForest {
  return { byId: new Map(capabilities.map((c) => [c.id, c])) }
}

export function rootsOf(forest: CapabilityForest): Capability[] {
  return [...forest.byId.values()].filter((c) => !c.parent)
}

export function childrenOf(forest: CapabilityForest, id: string): Capability[] {
  return [...forest.byId.values()].filter((c) => c.parent === id)
}

/**
 * Root→node ids, derived from `parent` rather than split out of the id.
 *
 * The id looks like a path and is not one. A node re-parented under a different
 * subtree keeps its id and gets a new ancestry, and every consumer of ancestry
 * has to come through here to see that.
 *
 * Returns null when the chain is broken or cyclic — callers get an explicit
 * "cannot answer" instead of a truncated path that reads like a real one.
 */
export function ancestryOf(forest: CapabilityForest, id: string): string[] | null {
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = id

  while (current) {
    if (seen.has(current)) return null
    seen.add(current)
    const node = forest.byId.get(current)
    if (!node) return null
    chain.unshift(node.id)
    current = node.parent
  }
  return chain
}

/**
 * The denormalized path stored alongside `capabilityId` on evidence.
 *
 * Written at record time precisely because it is derived: once a node is
 * re-parented, this string is the only record of where the evidence was
 * gathered from, and re-deriving it later would silently rewrite history.
 */
export function pathOf(forest: CapabilityForest, id: string, separator = ' / '): string | null {
  const chain = ancestryOf(forest, id)
  return chain ? chain.join(separator) : null
}

export function depthOf(forest: CapabilityForest, id: string): number | null {
  const chain = ancestryOf(forest, id)
  return chain ? chain.length - 1 : null
}

/**
 * Lowest common ancestor, and its depth — the coordination-cost metric.
 *
 * Sibling-scope changes share a deep ancestor and are routine; a change whose
 * capabilities meet only near a root crosses subtrees and is the case that
 * warrants an architect gate. Returned rather than judged: what to do with the
 * number belongs to the delivery-set design, not here.
 */
export function lowestCommonAncestor(
  forest: CapabilityForest,
  ids: string[]
): { id: string | null; depth: number | null } {
  if (!ids.length) return { id: null, depth: null }

  const chains = ids.map((id) => ancestryOf(forest, id))
  if (chains.some((c) => c === null)) return { id: null, depth: null }

  const first = chains[0] as string[]
  let common = -1
  for (let i = 0; i < first.length; i++) {
    if ((chains as string[][]).every((chain) => chain[i] === first[i])) common = i
    else break
  }
  // Capabilities in different roots have no common ancestor at all, which is a
  // stronger statement than "the ancestor is the root".
  return common === -1 ? { id: null, depth: null } : { id: first[common], depth: common }
}
