import { load } from 'js-yaml'

import type { Capability, CapabilityForest } from './model'
import { forestOf } from './model'

/**
 * Manifest parsing.
 *
 * One `capability.yaml` per materialized node, with children inlined until they
 * materialize themselves. Parsing therefore has two jobs: read the YAML, and
 * flatten the inline nesting into the flat, parent-linked forest everything
 * downstream works on.
 *
 * The flattening is where the spec's authority rule gets enforced. An inline
 * child's parent is the node it is nested under — not whatever its path-like id
 * suggests — so a child written as `payments.retry-engine` under `platform`
 * belongs to `platform`. Deriving ancestry from the id instead would make the
 * `parent` field decorative and re-parenting a lie.
 *
 * Pure and IO-free: callers read the file. That keeps the whole correctness
 * surface of this increment testable without a filesystem, which is most of why
 * the spec puts it first.
 */

export interface ParseIssue {
  /** Which manifest, when the caller knows. */
  source?: string
  /** Dotted-ish location within the document, best effort. */
  at: string
  problem: string
}

export interface ParseResult {
  capabilities: Capability[]
  issues: ParseIssue[]
}

type Raw = Record<string, unknown>

const KINDS = new Set(['business', 'delivery'])
const WRITE_POLICIES = new Set(['open', 'gated'])
const COMPONENT_KINDS = new Set(['api', 'database', 'queue', 'storage', 'service', 'job'])
const COMPONENT_STATUSES = new Set(['proposed', 'confirmed', 'stale', 'contradicted'])

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Parse one manifest document into a flat capability list.
 *
 * `parentId` is the node this document's root hangs from — absent for a root
 * manifest. Inline children recurse with their container as parent.
 */
function parseNode(
  raw: unknown,
  at: string,
  parentId: string | undefined,
  out: Capability[],
  issues: ParseIssue[],
  source?: string
): void {
  if (!isRecord(raw)) {
    issues.push({ source, at, problem: 'expected a mapping' })
    return
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) {
    issues.push({ source, at, problem: 'missing id' })
    return
  }

  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  if (!KINDS.has(kind)) {
    issues.push({
      source,
      at: `${at}.kind`,
      problem: `kind must be "business" or "delivery", got ${JSON.stringify(raw.kind)}`
    })
    return
  }

  // An explicit parent in the document is honoured; nesting supplies it
  // otherwise. A document that states a different parent than the one it is
  // nested under is contradicting itself, and guessing which was meant is worse
  // than saying so.
  const declaredParent = typeof raw.parent === 'string' ? raw.parent.trim() : undefined
  if (declaredParent && parentId && declaredParent !== parentId) {
    issues.push({
      source,
      at: `${at}.parent`,
      problem:
        `declares parent "${declaredParent}" but is nested under "${parentId}" — ` +
        'remove one of them rather than leaving the ownership ambiguous'
    })
    return
  }

  const capability: Capability = {
    id,
    kind: kind as Capability['kind'],
    ...(raw.name !== undefined ? { name: String(raw.name) } : {}),
    ...(declaredParent ?? parentId ? { parent: declaredParent ?? parentId } : {})
  }

  /* ------------------------------------------------------------- repos */

  const repos = asArray(raw.repos)
  if (repos.length) {
    capability.repos = []
    repos.forEach((entry, index) => {
      const where = `${at}.repos[${index}]`
      if (!isRecord(entry)) {
        issues.push({ source, at: where, problem: 'expected a mapping' })
        return
      }
      const repoId = typeof entry.repoId === 'string' ? entry.repoId.trim() : ''
      if (!repoId) {
        issues.push({ source, at: where, problem: 'missing repoId' })
        return
      }
      const writePolicy = typeof entry.writePolicy === 'string' ? entry.writePolicy : 'open'
      if (!WRITE_POLICIES.has(writePolicy)) {
        issues.push({
          source,
          at: `${where}.writePolicy`,
          problem: `must be "open" or "gated", got ${JSON.stringify(entry.writePolicy)}`
        })
        return
      }
      capability.repos!.push({
        repoId,
        url: typeof entry.url === 'string' ? entry.url : '',
        // A repo with no stated base is on `main` far more often than it is on
        // nothing, and an empty string would fail later somewhere less obvious.
        defaultBase: typeof entry.defaultBase === 'string' ? entry.defaultBase : 'main',
        writePolicy: writePolicy as 'open' | 'gated'
      })
    })
  }

  if (isRecord(raw.ledger)) {
    capability.ledger = {
      url: typeof raw.ledger.url === 'string' ? raw.ledger.url : '',
      ...(typeof raw.ledger.defaultBase === 'string'
        ? { defaultBase: raw.ledger.defaultBase }
        : {})
    }
  }

  /* ----------------------------------------------------------- consumes */

  const consumes = asArray(raw.consumes)
  if (consumes.length) {
    capability.consumes = []
    consumes.forEach((entry, index) => {
      const where = `${at}.consumes[${index}]`
      if (!isRecord(entry)) {
        issues.push({ source, at: where, problem: 'expected a mapping' })
        return
      }
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      if (!provider) {
        issues.push({ source, at: where, problem: 'missing provider' })
        return
      }
      const contract =
        typeof entry.contract === 'string'
          ? { path: entry.contract }
          : isRecord(entry.contract) && typeof entry.contract.path === 'string'
            ? {
                path: entry.contract.path,
                ...(typeof entry.contract.component === 'string'
                  ? { component: entry.contract.component }
                  : {})
              }
            : undefined
      capability.consumes!.push({
        provider,
        ...(contract ? { contract } : {}),
        ...(typeof entry.component === 'string' ? { component: entry.component } : {})
      })
    })
  }

  /* ------------------------------------------------------------- policy */

  if (isRecord(raw.policy)) {
    const policy: Capability['policy'] = {}
    const gates = asArray(raw.policy.requiredGates)
    if (gates.length) {
      policy.requiredGates = []
      gates.forEach((entry, index) => {
        const where = `${at}.policy.requiredGates[${index}]`
        if (!isRecord(entry) || typeof entry.on !== 'string' || typeof entry.role !== 'string') {
          issues.push({ source, at: where, problem: 'a gate needs both `on` and `role`' })
          return
        }
        policy.requiredGates!.push({
          on: entry.on,
          role: entry.role,
          ...(typeof entry.scope === 'string' ? { scope: entry.scope } : {})
        })
      })
    }

    if (isRecord(raw.policy.budgets)) {
      const budgets: NonNullable<Capability['policy']>['budgets'] = {}
      for (const field of ['maxCostUsdPerThread', 'maxTokensPerStep'] as const) {
        const value = raw.policy.budgets[field]
        if (value === undefined) continue
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({
            source,
            at: `${at}.policy.budgets.${field}`,
            problem: `must be a number, got ${JSON.stringify(value)}`
          })
          continue
        }
        budgets[field] = value
      }
      if (Object.keys(budgets).length) policy.budgets = budgets
    }

    const allowList = asArray(raw.policy.terminalAllowList).filter(
      (v): v is string => typeof v === 'string'
    )
    if (allowList.length) policy.terminalAllowList = allowList

    // Constraints share the M5 typed form rather than a second shape. A
    // capability-shaped constraint and an injected one have to be the same thing
    // or the frontier query stops seeing half of them.
    const constraints = asArray(raw.policy.constraints)
    if (constraints.length) {
      policy.constraints = []
      constraints.forEach((entry, index) => {
        const where = `${at}.policy.constraints[${index}]`
        if (
          !isRecord(entry) ||
          (entry.forbids !== 'writes' && entry.forbids !== 'reads') ||
          !isRecord(entry.selector) ||
          typeof entry.selector.kind !== 'string'
        ) {
          issues.push({
            source,
            at: where,
            problem: 'a constraint needs `forbids` of writes|reads and a selector with a kind'
          })
          return
        }
        policy.constraints!.push({
          id: typeof entry.id === 'string' ? entry.id : `${id}-constraint-${index}`,
          forbids: entry.forbids,
          selector: {
            kind: entry.selector.kind as never,
            ...(typeof entry.selector.path === 'string' ? { path: entry.selector.path } : {})
          },
          text: typeof entry.text === 'string' ? entry.text : `declared by ${id}`,
          at: typeof entry.at === 'number' ? entry.at : 0
        })
      })
    }

    if (Object.keys(policy).length) capability.policy = policy
  }

  /* --------------------------------------------------------- components */

  const components = asArray(raw.components)
  if (components.length) {
    capability.components = []
    components.forEach((entry, index) => {
      const where = `${at}.components[${index}]`
      if (!isRecord(entry) || typeof entry.id !== 'string') {
        issues.push({ source, at: where, problem: 'a component needs an id' })
        return
      }
      const componentKind = typeof entry.kind === 'string' ? entry.kind : ''
      if (!COMPONENT_KINDS.has(componentKind)) {
        issues.push({
          source,
          at: `${where}.kind`,
          problem: `must be one of ${[...COMPONENT_KINDS].join(', ')}`
        })
        return
      }
      const status = typeof entry.status === 'string' ? entry.status : 'proposed'
      if (!COMPONENT_STATUSES.has(status)) {
        issues.push({
          source,
          at: `${where}.status`,
          problem: `must be one of ${[...COMPONENT_STATUSES].join(', ')}`
        })
        return
      }
      const provenance = isRecord(entry.provenance) ? entry.provenance : undefined
      capability.components!.push({
        id: entry.id,
        kind: componentKind as never,
        ...(typeof entry.tech === 'string' ? { tech: entry.tech } : {}),
        // Unstated status is `proposed`: a claim nobody has confirmed is a
        // proposal, and defaulting to confirmed would let the manifest assert
        // its own evidence.
        status: status as never,
        ...(provenance
          ? {
              provenance: {
                ...(isRecord(provenance.declared) && typeof provenance.declared.by === 'string'
                  ? {
                      declared: {
                        by: provenance.declared.by,
                        ...(typeof provenance.declared.at === 'number'
                          ? { at: provenance.declared.at }
                          : {})
                      }
                    }
                  : {}),
                observed: asArray(provenance.observed)
                  .filter(isRecord)
                  .filter((o) => typeof o.extractor === 'string' && typeof o.repo === 'string')
                  .map((o) => ({
                    extractor: String(o.extractor),
                    repo: String(o.repo),
                    ...(typeof o.path === 'string' ? { path: o.path } : {}),
                    ...(typeof o.sha === 'string' ? { sha: o.sha } : {}),
                    ...(typeof o.at === 'number' ? { at: o.at } : {})
                  }))
              }
            }
          : {})
      })
    })
  }

  out.push(capability)

  /* ------------------------------------------- inline, unmaterialized children */

  asArray(raw.children).forEach((child, index) => {
    parseNode(child, `${at}.children[${index}]`, id, out, issues, source)
  })
}

/** Parse one manifest document. */
export function parseManifest(text: string, source?: string): ParseResult {
  const capabilities: Capability[] = []
  const issues: ParseIssue[] = []

  let doc: unknown
  try {
    doc = load(text)
  } catch (error) {
    return {
      capabilities,
      issues: [{ source, at: '', problem: `not valid YAML: ${(error as Error).message}` }]
    }
  }

  if (doc === undefined || doc === null) {
    return { capabilities, issues: [{ source, at: '', problem: 'the manifest is empty' }] }
  }

  // A manifest may be a single node or a list of roots; both appear in practice
  // and neither is ambiguous.
  asArray(doc).forEach((node, index) => {
    parseNode(node, Array.isArray(doc) ? `[${index}]` : '', undefined, capabilities, issues, source)
  })

  return { capabilities, issues }
}

/**
 * Parse several manifests into one forest.
 *
 * Every materialized node contributes a document, so the forest is only whole
 * once they are read together — which is also the only level at which single
 * ownership can be checked at all.
 */
export function parseManifests(
  documents: Array<{ text: string; source?: string }>
): { forest: CapabilityForest; capabilities: Capability[]; issues: ParseIssue[] } {
  const capabilities: Capability[] = []
  const issues: ParseIssue[] = []

  for (const document of documents) {
    const result = parseManifest(document.text, document.source)
    capabilities.push(...result.capabilities)
    issues.push(...result.issues)
  }

  // A node inlined in its parent and also present as its own materialized
  // manifest is the normal state during materialization, so the standalone
  // document wins — it is the one with the ledger.
  const merged = new Map<string, Capability>()
  for (const capability of capabilities) {
    const existing = merged.get(capability.id)
    if (!existing) {
      merged.set(capability.id, capability)
      continue
    }
    const winner = capability.ledger ? capability : existing.ledger ? existing : capability
    const loser = winner === capability ? existing : capability
    if (JSON.stringify({ ...winner, ledger: null }) !== JSON.stringify({ ...loser, ledger: null })) {
      issues.push({
        at: capability.id,
        problem:
          'appears in more than one manifest with different content — the inline copy in the ' +
          'parent has drifted from the materialized one'
      })
    }
    merged.set(capability.id, winner)
  }

  const deduped = [...merged.values()]
  return { forest: forestOf(deduped), capabilities: deduped, issues }
}
