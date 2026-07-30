import { load } from 'js-yaml'

import type { Capability, CapabilityForest, KnowledgeRef } from './model'
import { forestOf, SIDECAR_LEDGER_REF } from './model'

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

/**
 * A member repo's back-reference to its owning capability.
 *
 * Member repos carry `.singularity/capability.yaml` so a checkout can say which
 * capability it belongs to without an index. It is deliberately a back-reference
 * and not a copy of the ledger location: restating where the ledger lives would
 * create a second source of truth that goes stale on the first rename.
 */
export interface CapabilityPointer {
  capability: string
  repoId: string
  source?: string
}

export interface ParseResult {
  capabilities: Capability[]
  /** Pointer files, which are NOT capabilities — see parsePointer. */
  pointers: CapabilityPointer[]
  issues: ParseIssue[]
}

type Raw = Record<string, unknown>

const KINDS = new Set(['business', 'delivery'])
const WRITE_POLICIES = new Set(['open', 'gated'])
const COMPONENT_KINDS = new Set(['api', 'database', 'queue', 'storage', 'service', 'job'])
const COMPONENT_STATUSES = new Set(['proposed', 'confirmed', 'stale', 'contradicted'])
const REPO_ROLES = new Set(['lead', 'member'])
const KNOWLEDGE_KINDS = new Set(['design', 'runbook', 'adr', 'api-portal', 'wiki', 'other'])
const LEDGER_KINDS = new Set(['sidecar', 'repo'])

/** Keys that only ever appear on a real manifest, never on a pointer. */
const MANIFEST_ONLY_KEYS = [
  'kind',
  'parent',
  'repos',
  'ledger',
  'policy',
  'consumes',
  'components',
  'children',
  'knowledge',
  'contacts',
  'tracker'
]

/** A date we can actually compare. `verifiedAt: last tuesday` is worse than none. */
const DATE_ISH = /^\d{4}-\d{2}-\d{2}([T ].*)?$/

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
function parsePointer(
  raw: Raw,
  at: string,
  pointers: CapabilityPointer[],
  issues: ParseIssue[],
  source?: string
): void {
  if (raw.pointer !== 'capability') {
    issues.push({
      source,
      at: `${at}.pointer`,
      problem: `must be "capability", got ${JSON.stringify(raw.pointer)}`
    })
    return
  }

  const capability = typeof raw.capability === 'string' ? raw.capability.trim() : ''
  const repoId = typeof raw.repoId === 'string' ? raw.repoId.trim() : ''
  if (!capability || !repoId) {
    issues.push({
      source,
      at,
      problem: 'a pointer needs both `capability` and `repoId`'
    })
    return
  }

  // A file trying to be both must not resolve silently as either.
  const alsoManifest = MANIFEST_ONLY_KEYS.filter((key) => raw[key] !== undefined)
  if (alsoManifest.length) {
    issues.push({
      source,
      at,
      problem:
        `is a pointer but also carries manifest keys (${alsoManifest.join(', ')}) — ` +
        'a file is one or the other'
    })
    return
  }

  pointers.push({ capability, repoId, ...(source ? { source } : {}) })
}

function parseNode(
  raw: unknown,
  at: string,
  parentId: string | undefined,
  out: Capability[],
  pointers: CapabilityPointer[],
  issues: ParseIssue[],
  source?: string
): void {
  if (!isRecord(raw)) {
    issues.push({ source, at, problem: 'expected a mapping' })
    return
  }

  // Classified by content, never by path. A caller may name a single file
  // directly, so there is not always a path context to read; and a file's
  // meaning should not change when somebody moves it. The positive marker also
  // keeps a *broken* manifest — one that forgot `kind` — from being silently
  // reclassified as a pointer and losing its error message.
  if (raw.pointer !== undefined) {
    parsePointer(raw, at, pointers, issues, source)
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
  const anyRoleDeclared = repos.some((r) => isRecord(r) && r.role !== undefined)
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
      const role = typeof entry.role === 'string' ? entry.role : 'member'
      if (!REPO_ROLES.has(role)) {
        issues.push({
          source,
          at: `${where}.role`,
          problem: `must be "lead" or "member", got ${JSON.stringify(entry.role)}`
        })
        return
      }
      capability.repos!.push({
        // Defaults to member, never lead: the lead decides where the ledger
        // lives, and guessing wrong puts a governance record in a repo nobody
        // chose.
        role: role as 'lead' | 'member',
        repoId,
        url: typeof entry.url === 'string' ? entry.url : '',
        // A repo with no stated base is on `main` far more often than it is on
        // nothing, and an empty string would fail later somewhere less obvious.
        defaultBase: typeof entry.defaultBase === 'string' ? entry.defaultBase : 'main',
        writePolicy: writePolicy as 'open' | 'gated'
      })
    })
  }

  // One repo and no roles stated anywhere: that repo is the lead, because there
  // is no other candidate. Keyed on the RAW length, not the pushed length — a
  // node declaring two repos where one is malformed would otherwise promote the
  // survivor to lead, placing the ledger in a repo nobody picked.
  if (repos.length === 1 && !anyRoleDeclared && capability.repos?.length === 1) {
    capability.repos[0].role = 'lead'
  }

  if (isRecord(raw.ledger)) {
    const ledgerKind = typeof raw.ledger.kind === 'string' ? raw.ledger.kind : undefined
    const url = typeof raw.ledger.url === 'string' ? raw.ledger.url.trim() : ''
    const repo = typeof raw.ledger.repo === 'string' ? raw.ledger.repo.trim() : ''

    if (ledgerKind !== undefined && !LEDGER_KINDS.has(ledgerKind)) {
      issues.push({
        source,
        at: `${at}.ledger.kind`,
        problem: `must be "sidecar" or "repo", got ${JSON.stringify(raw.ledger.kind)}`
      })
    } else if (ledgerKind === 'sidecar') {
      if (!repo) {
        issues.push({ source, at: `${at}.ledger.repo`, problem: 'a sidecar ledger needs a repo' })
      } else {
        const ref = typeof raw.ledger.ref === 'string' ? raw.ledger.ref : SIDECAR_LEDGER_REF
        if (ref !== SIDECAR_LEDGER_REF) {
          // A typo here yields a ledger no other tool can find.
          issues.push({
            source,
            at: `${at}.ledger.ref`,
            problem: `must be ${SIDECAR_LEDGER_REF} — every tool reads that ref`
          })
        } else {
          capability.ledger = { kind: 'sidecar', repo, ref: SIDECAR_LEDGER_REF }
        }
      }
    } else if (url) {
      // An untagged ledger is structurally a repo ledger missing its tag,
      // carrying the same meaning — a migration, not a guess. defaultBase is
      // kept rather than dropped so existing manifests lose nothing.
      capability.ledger = {
        kind: 'repo',
        url,
        ...(typeof raw.ledger.defaultBase === 'string'
          ? { defaultBase: raw.ledger.defaultBase }
          : {})
      }
    } else {
      // Previously this yielded `{url: ''}`, marking the node materialized while
      // pointing at nothing — and suppressing pendingMaterialization with it.
      issues.push({
        source,
        at: `${at}.ledger`,
        problem: 'needs kind: sidecar with a repo, or kind: repo with a url'
      })
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

  /* ------------------------------------- knowledge, contacts, tracker */

  // Attached at one fixed point in the single code path through parseNode. The
  // drift comparison in parseManifests is JSON.stringify-based and therefore
  // key-order sensitive, so splitting these between the initial literal and a
  // later branch would make two identical manifests compare unequal.

  const knowledge = asArray(raw.knowledge)
  if (knowledge.length) {
    capability.knowledge = []
    knowledge.forEach((entry, index) => {
      const where = `${at}.knowledge[${index}]`
      if (!isRecord(entry)) {
        issues.push({ source, at: where, problem: 'expected a mapping' })
        return
      }
      const title = typeof entry.title === 'string' ? entry.title.trim() : ''
      const url = typeof entry.url === 'string' ? entry.url.trim() : ''
      if (!title || !url) {
        // A knowledge ref without a url references nothing.
        issues.push({ source, at: where, problem: 'needs both `title` and `url`' })
        return
      }
      const knowledgeKind = typeof entry.kind === 'string' ? entry.kind : 'other'
      if (!KNOWLEDGE_KINDS.has(knowledgeKind)) {
        // Absent defaults, present-but-wrong refuses. Because `other` exists,
        // coercing `runbok` to it would silently rot the taxonomy that tags and
        // filtering are built on.
        issues.push({
          source,
          at: `${where}.kind`,
          problem: `must be one of ${[...KNOWLEDGE_KINDS].join(', ')}`
        })
        return
      }
      // YAML resolves an unquoted `2026-07-01` to a Date, not a string, and
      // nobody quotes dates in YAML — so a string-only check silently dropped
      // every knowledge ref that dated itself the natural way. Normalised to
      // YYYY-MM-DD either way, so downstream comparison has one shape.
      let verifiedAt: string | undefined
      if (entry.verifiedAt !== undefined) {
        if (entry.verifiedAt instanceof Date && !Number.isNaN(entry.verifiedAt.valueOf())) {
          verifiedAt = entry.verifiedAt.toISOString().slice(0, 10)
        } else if (typeof entry.verifiedAt === 'string' && DATE_ISH.test(entry.verifiedAt)) {
          verifiedAt = entry.verifiedAt
        } else {
          issues.push({
            source,
            at: `${where}.verifiedAt`,
            problem:
              'must be a date (YYYY-MM-DD) — a timestamp nobody can compare is worse than none'
          })
          return
        }
      }
      const ref: KnowledgeRef = {
        kind: knowledgeKind as KnowledgeRef['kind'],
        title,
        url,
        ...(Array.isArray(entry.tags)
          ? { tags: entry.tags.filter((t): t is string => typeof t === 'string') }
          : {}),
        ...(verifiedAt ? { verifiedAt } : {})
      }
      capability.knowledge!.push(ref)
    })
  }

  const contacts = asArray(raw.contacts)
  if (contacts.length) {
    capability.contacts = []
    contacts.forEach((entry, index) => {
      const where = `${at}.contacts[${index}]`
      if (
        !isRecord(entry) ||
        typeof entry.actorId !== 'string' ||
        !entry.actorId.trim() ||
        typeof entry.role !== 'string' ||
        !entry.role.trim()
      ) {
        issues.push({ source, at: where, problem: 'a contact needs both `actorId` and `role`' })
        return
      }
      capability.contacts!.push({ actorId: entry.actorId.trim(), role: entry.role.trim() })
    })
  }

  if (isRecord(raw.tracker)) {
    const system = typeof raw.tracker.system === 'string' ? raw.tracker.system : ''
    const projectKey = typeof raw.tracker.projectKey === 'string' ? raw.tracker.projectKey.trim() : ''
    if (system !== 'jira') {
      // Refusing an unknown system is how the next one gets added deliberately
      // rather than accepted here and unhandled downstream.
      issues.push({
        source,
        at: `${at}.tracker.system`,
        problem: `only "jira" is supported, got ${JSON.stringify(raw.tracker.system)}`
      })
    } else if (!projectKey) {
      issues.push({ source, at: `${at}.tracker.projectKey`, problem: 'is required' })
    } else {
      capability.tracker = { system: 'jira', projectKey }
    }
  }

  out.push(capability)

  /* ------------------------------------------- inline, unmaterialized children */

  asArray(raw.children).forEach((child, index) => {
    parseNode(child, `${at}.children[${index}]`, id, out, pointers, issues, source)
  })
}

/** Parse one manifest document. */
export function parseManifest(text: string, source?: string): ParseResult {
  const capabilities: Capability[] = []
  const pointers: CapabilityPointer[] = []
  const issues: ParseIssue[] = []

  let doc: unknown
  try {
    doc = load(text)
  } catch (error) {
    return {
      capabilities,
      pointers,
      issues: [{ source, at: '', problem: `not valid YAML: ${(error as Error).message}` }]
    }
  }

  if (doc === undefined || doc === null) {
    return { capabilities, pointers, issues: [{ source, at: '', problem: 'the manifest is empty' }] }
  }

  // A manifest may be a single node or a list of roots; both appear in practice
  // and neither is ambiguous.
  asArray(doc).forEach((node, index) => {
    parseNode(
      node,
      Array.isArray(doc) ? `[${index}]` : '',
      undefined,
      capabilities,
      pointers,
      issues,
      source
    )
  })

  return { capabilities, pointers, issues }
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
): {
  forest: CapabilityForest
  capabilities: Capability[]
  pointers: CapabilityPointer[]
  issues: ParseIssue[]
} {
  const capabilities: Capability[] = []
  const pointers: CapabilityPointer[] = []
  const issues: ParseIssue[] = []

  for (const document of documents) {
    const result = parseManifest(document.text, document.source)
    capabilities.push(...result.capabilities)
    pointers.push(...result.pointers)
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

    // Two copies that each declare a ledger and disagree about it is a far more
    // serious divergence than two differing urls, and the drift check below
    // cannot see it: it strips `ledger` on purpose, because the inline copy in a
    // parent legitimately has none.
    if (
      winner.ledger &&
      loser.ledger &&
      JSON.stringify(winner.ledger) !== JSON.stringify(loser.ledger)
    ) {
      issues.push({
        at: capability.id,
        problem: 'is claimed by two manifests that disagree about where its ledger lives'
      })
    }

    // Drift is disagreement on a shared field, not absence of one.
    //
    // Materializing demotes the parent's inline copy to a stub — id, kind, parent
    // and the ledger pointer, nothing else — so that the parent still says where
    // the child's ledger lives. A stub is a strict subset, and comparing whole
    // documents would report every correctly materialized node as drifted.
    //
    // Absence is safe to ignore precisely because the copy carrying a ledger
    // wins: a field the loser omits discards nothing. A field the loser *states
    // differently* is the real hazard, because that value is silently dropped.
    const disagreeing = (Object.keys(winner) as Array<keyof Capability>)
      .filter((key) => key !== 'ledger' && key in loser)
      .filter((key) => JSON.stringify(winner[key]) !== JSON.stringify(loser[key]))

    if (disagreeing.length) {
      issues.push({
        at: capability.id,
        problem:
          'appears in more than one manifest and they disagree about ' +
          `${disagreeing.join(', ')} — the inline copy in the parent has drifted from the ` +
          'materialized one, and the materialized value is the one in effect'
      })
    }
    merged.set(capability.id, winner)
  }

  const deduped = [...merged.values()]
  return { forest: forestOf(deduped), capabilities: deduped, pointers, issues }
}
