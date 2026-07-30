import type { Capability, CapabilityForest } from './model'
import { ancestryOf, childrenOf } from './model'
import type { CapabilityPointer, Declaration } from './parse'

/**
 * Forest validation.
 *
 * A pure function over the whole forest, in the same style as the policy gate:
 * it either passes or it names what is wrong, and nothing here consults a model.
 *
 * Single ownership is the rule the rest of the system leans on. It has to be
 * checked across the entire forest rather than per manifest, because the failure
 * it catches — two capabilities claiming the same repo — is invisible from
 * inside either one. The spec's own example manifest contains that mistake on
 * purpose; this is what rejects it.
 *
 * Errors and elicitations are returned separately, and that distinction is
 * load-bearing rather than cosmetic. A reference to a `proposed` component is
 * not a broken manifest — it is a question for a person, and reporting it as a
 * failure would push people to confirm components just to make the validator
 * quiet, which is exactly how a governance record becomes fiction.
 */

export interface ValidationError {
  capabilityId: string
  problem: string
}

export interface Elicitation {
  capabilityId: string
  question: string
  /** What the answer would bind. */
  about: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  elicitations: Elicitation[]
}

function componentIndex(forest: CapabilityForest): Map<string, { owner: string; status: string }> {
  const index = new Map<string, { owner: string; status: string }>()
  for (const capability of forest.byId.values()) {
    for (const component of capability.components ?? []) {
      index.set(`${capability.id}::${component.id}`, {
        owner: capability.id,
        status: component.status
      })
    }
  }
  return index
}

export function validateForest(
  forest: CapabilityForest,
  declarations?: Declaration[]
): ValidationResult {
  const errors: ValidationError[] = []
  const elicitations: Elicitation[] = []
  const push = (capabilityId: string, problem: string): void => {
    errors.push({ capabilityId, problem })
  }

  /* ------------------------------------------------------ single ownership */

  // Across the whole forest, not per node. Reported against both claimants
  // because the fix requires knowing who the other one is.
  const repoOwners = new Map<string, string[]>()
  for (const capability of forest.byId.values()) {
    for (const repo of capability.repos ?? []) {
      repoOwners.set(repo.repoId, [...(repoOwners.get(repo.repoId) ?? []), capability.id])
    }
  }
  for (const [repoId, owners] of repoOwners) {
    if (owners.length < 2) continue
    for (const owner of owners) {
      push(
        owner,
        `repo "${repoId}" is also owned by ${owners.filter((o) => o !== owner).join(', ')} — ` +
          'a repo has exactly one owning capability; give it one owner and a consumer edge ' +
          'from the others'
      )
    }
  }

  /* --------------------------------------------------------------- the tree */

  for (const capability of forest.byId.values()) {
    if (capability.parent !== undefined) {
      if (!capability.parent) {
        push(capability.id, 'has an empty parent — omit the field entirely for a root')
      } else if (!forest.byId.has(capability.parent)) {
        push(capability.id, `parent "${capability.parent}" does not exist in the forest`)
      }
    }

    // Ownership is a tree. Usage may cycle; this may not.
    if (ancestryOf(forest, capability.id) === null && forest.byId.has(capability.parent ?? '')) {
      push(capability.id, 'is part of a parent cycle — ownership must be a tree')
    }

    if (capability.kind === 'business' && (capability.repos?.length ?? 0) > 0) {
      push(
        capability.id,
        'is a business capability and owns repos — business nodes are governance and rollup only; ' +
          'move the repos to a delivery child'
      )
    }

    for (const [field, value] of Object.entries(capability.policy?.budgets ?? {})) {
      if (typeof value === 'number' && value < 0) {
        push(capability.id, `budget ${field} is negative (${value})`)
      }
    }

    for (const gate of capability.policy?.requiredGates ?? []) {
      if (!gate.on.trim() || !gate.role.trim()) {
        push(capability.id, 'a required gate has an empty `on` or `role`')
      }
    }

    const repoIds = new Set<string>()
    for (const repo of capability.repos ?? []) {
      if (repoIds.has(repo.repoId)) {
        push(capability.id, `repo "${repo.repoId}" is listed twice`)
      }
      repoIds.add(repo.repoId)
    }

    const componentIds = new Set<string>()
    for (const component of capability.components ?? []) {
      if (componentIds.has(component.id)) {
        push(capability.id, `component "${component.id}" is declared twice`)
      }
      componentIds.add(component.id)
    }

    // Dedupe on the pair: one person legitimately holds two roles.
    const contactKeys = new Set<string>()
    for (const contact of capability.contacts ?? []) {
      const key = `${contact.actorId}|${contact.role}`
      if (contactKeys.has(key)) {
        push(capability.id, `${contact.actorId} is listed twice as ${contact.role}`)
      }
      contactKeys.add(key)
    }

    /* --------------------------------------------- the lead repo (R14) */

    // Scoped to delivery nodes that actually own repos. A delivery node with no
    // repos is legal and common — plenty are governed entirely by an ancestor —
    // and an unscoped rule would fail most real forests.
    if (capability.kind === 'delivery' && (capability.repos?.length ?? 0) > 0) {
      const leads = capability.repos!.filter((r) => r.role === 'lead')
      if (leads.length === 0) {
        push(
          capability.id,
          'owns repos but names no lead — the ledger is an orphan branch inside the lead repo, ' +
            `so exactly one is needed. Candidates: ${capability.repos!.map((r) => r.repoId).join(', ')}`
        )
      } else if (leads.length > 1) {
        push(
          capability.id,
          `names ${leads.length} leads (${leads.map((r) => r.repoId).join(', ')}) — ` +
            'the ledger has one home, so exactly one repo can be the lead'
        )
      }
    }

    /* ------------------------------------------- ledger placement (R15/R16/E3) */

    if (capability.ledger?.kind === 'sidecar') {
      if (capability.kind === 'business') {
        // Checked before R15 so one wrong line yields one error: a business node
        // owns no repos, so "does not own that repo" is true but useless here.
        push(
          capability.id,
          'is a business capability with a sidecar ledger — it owns no repo to put the branch in. ' +
            'Use a standalone ledger repo (kind: repo).'
        )
      } else {
        const sidecarRepo = capability.ledger.repo
        const owned = capability.repos?.find((r) => r.repoId === sidecarRepo)
        if (!owned) {
          push(
            capability.id,
            `its sidecar ledger lives in "${sidecarRepo}", which this capability does not own — ` +
              'writing there would cross the boundary single ownership exists to forbid'
          )
        } else {
          const leads = (capability.repos ?? []).filter((r) => r.role === 'lead')
          // Only meaningful when the lead is unambiguous; R14 has already fired
          // otherwise, and "must be the lead (there is no lead)" is a worse message.
          if (leads.length === 1 && leads[0].repoId !== sidecarRepo) {
            push(
              capability.id,
              `its sidecar ledger lives in "${sidecarRepo}" but the lead is "${leads[0].repoId}" — ` +
                'either point the ledger at the lead, or move role: lead to that repo'
            )
          }
        }
      }
    }

    if (capability.kind === 'delivery' && capability.ledger?.kind === 'repo') {
      // An elicitation, not an error. This contradicts a convention rather than
      // a rule: the receipts exist, they are reachable, the governance record
      // works. Failing it would demand relocating git history to satisfy a
      // validator.
      elicitations.push({
        capabilityId: capability.id,
        about: 'ledger placement',
        question:
          'This delivery capability keeps a standalone ledger repo rather than a sidecar branch ' +
          'in its lead. Is that a pre-convention ledger to migrate, or a deliberate exception?'
      })
    }
  }

  /* ------------------------------------------------------ the consumer graph */

  const components = componentIndex(forest)

  for (const capability of forest.byId.values()) {
    for (const edge of capability.consumes ?? []) {
      if (!forest.byId.has(edge.provider)) {
        push(capability.id, `consumes from "${edge.provider}", which is not a capability`)
        continue
      }
      if (edge.provider === capability.id) {
        push(capability.id, 'consumes from itself — a consumer edge crosses an ownership boundary')
        continue
      }

      const named = edge.component ?? edge.contract?.component
      if (!named) continue

      const key = `${edge.provider}::${named}`
      const found = components.get(key)
      if (!found) {
        push(
          capability.id,
          `consumes component "${named}" from "${edge.provider}", which does not declare it`
        )
        continue
      }
      // Governance may only reference confirmed anatomy. An unconfirmed one is a
      // question, not a failure.
      if (found.status !== 'confirmed') {
        elicitations.push({
          capabilityId: capability.id,
          about: `${edge.provider}::${named}`,
          question:
            `"${named}" in ${edge.provider} is ${found.status}, and a consumer edge may only ` +
            'reference a confirmed component. Confirm it, or point the edge somewhere else.'
        })
      }
    }

    /* ------------------------- constraints and effects reference components */

    for (const constraint of capability.policy?.constraints ?? []) {
      const selector = constraint.selector as { kind: string; component?: string }
      if (!selector.component) continue
      const found = components.get(`${capability.id}::${selector.component}`)
      if (!found) {
        push(
          capability.id,
          `a constraint selects component "${selector.component}", which this capability does not declare`
        )
      } else if (found.status !== 'confirmed') {
        elicitations.push({
          capabilityId: capability.id,
          about: `${capability.id}::${selector.component}`,
          question:
            `A constraint selects "${selector.component}", which is ${found.status}. ` +
            'Constraints may only reference confirmed components — confirm it first.'
        })
      }
    }
  }

  /* --------------------------------------- gate satisfiability (R18) */

  // `Contact.role` and `GateRule.role` share one namespace: a gate is
  // satisfiable at a node when some contact on the root→node path holds its
  // role. An unsatisfiable gate elicits rather than fails, for the same reason
  // components do — an incomplete manifest should not fail a forest, and failing
  // it would push people to add placeholder contacts to quiet the validator.
  //
  // Worth knowing what this binding implies: editing `contacts` changes who may
  // approve. That is mitigated, not removed, by the manifest PR itself being
  // gated by CODEOWNERS on the parent ledger.
  for (const capability of forest.byId.values()) {
    const ancestry = ancestryOf(forest, capability.id)
    if (!ancestry) continue

    const rolesOnPath = new Set<string>()
    for (const id of ancestry) {
      for (const contact of forest.byId.get(id)?.contacts ?? []) rolesOnPath.add(contact.role)
    }

    // Only the gates this node actually declares — an inherited gate is reported
    // against the ancestor that declared it, once, rather than at every
    // descendant.
    for (const gate of capability.policy?.requiredGates ?? []) {
      if (!gate.role.trim() || rolesOnPath.has(gate.role)) continue
      elicitations.push({
        capabilityId: capability.id,
        about: `gate ${gate.on}/${gate.role}`,
        question:
          `The gate on "${gate.on}" needs role "${gate.role}", but no contact on ` +
          `${ancestry.join(' / ')} holds it — the gate cannot be satisfied. ` +
          'Add a contact with that role, or change the gate.'
      })
    }
  }

  /* ------------------------------------------- reachability (R19) */

  // A materialized node whose parent's manifest carries no stanza for it has a
  // ledger that nothing can find. Materialization is several writes across refs
  // and is never atomic, so this is the state a crash between the ledger write
  // and the stanza write leaves behind — and until now it validated clean.
  //
  // Reachability cannot be read off the forest. The merge is flat by design and
  // erases who declared what, so this needs the pre-dedup declarations; without
  // them the rule simply does not run rather than guessing.
  //
  // The guard below is the important part. A node is only judged when the
  // parent's OWN manifest was among the documents read, because otherwise the
  // absence of a stanza means "not scanned", not "not written" — and a rule that
  // fires on a partial scan would make `valid` depend on how much of the org
  // somebody happened to walk. That is the same reason reconcilePointers is not
  // in here.
  if (declarations) {
    // One helper, used for both the set and the lookup. Building a composite key
    // twice is how the two sides quietly stop matching.
    const stanzaKey = (parentId: string, childId: string): string => `${parentId}\u0000${childId}`

    const inlineUnder = new Set(
      declarations
        .filter((d) => d.inlineParent)
        .map((d) => stanzaKey(d.inlineParent as string, d.id))
    )
    const readAsOwnDocument = new Set(
      declarations.filter((d) => !d.inlineParent).map((d) => d.id)
    )

    for (const capability of forest.byId.values()) {
      const parentId = capability.parent
      if (!capability.ledger || !parentId) continue

      const parent = forest.byId.get(parentId)
      if (!parent) continue // already reported as a broken parent link

      // A parent with no ledger of its own lives inside some ancestor's
      // document, which we therefore read; a parent with a ledger was only read
      // if it turned up as a top-level entry somewhere.
      const parentManifestWasRead = !parent.ledger || readAsOwnDocument.has(parentId)
      if (!parentManifestWasRead) continue

      if (!inlineUnder.has(stanzaKey(parentId, capability.id))) {
        push(
          capability.id,
          `has its own ledger but no stanza in ${parentId}'s manifest — nothing that reads ` +
            `${parentId} can find it, so the node is unreachable. This is what a materialization ` +
            'that wrote the ledger and failed the parent stanza leaves behind; re-run the parent ' +
            'stanza step to repair it.'
        )
      }
    }
  }

  return { valid: errors.length === 0, errors, elicitations }
}

/* ------------------------------------------------------- pointer reconciliation */

export type PointerFindingKind =
  | 'unknown-capability'
  | 'unknown-repo'
  | 'points-at-lead'
  | 'repo-claimed-elsewhere'

export interface PointerFinding {
  kind: PointerFindingKind
  pointer: CapabilityPointer
  detail: string
}

/**
 * Compare member-repo pointers against the forest.
 *
 * Deliberately outside `validateForest`. That function's contract is "this
 * forest is internally consistent", and a dangling pointer may mean a stale
 * pointer *or* a partial scan — scanning one member repo produces an empty
 * forest and a dangling pointer by construction. Folding this in would make
 * `valid` depend on how much of the org somebody happened to walk.
 *
 * So findings come back as data with a kind, and the caller — which knows what
 * was scanned — decides severity.
 */
export function reconcilePointers(
  forest: CapabilityForest,
  pointers: CapabilityPointer[]
): PointerFinding[] {
  const findings: PointerFinding[] = []

  // Single ownership seen from the repo side. This catches the case the
  // manifest-side rule structurally cannot: the second claimant's manifest was
  // never scanned, so the forest has no idea there is a conflict.
  const byRepo = new Map<string, CapabilityPointer[]>()
  for (const pointer of pointers) {
    byRepo.set(pointer.repoId, [...(byRepo.get(pointer.repoId) ?? []), pointer])
  }
  for (const [repoId, claims] of byRepo) {
    const capabilities = [...new Set(claims.map((c) => c.capability))]
    if (capabilities.length < 2) continue
    for (const pointer of claims) {
      findings.push({
        kind: 'repo-claimed-elsewhere',
        pointer,
        detail: `repo "${repoId}" is pointed at ${capabilities.join(' and ')} — one of them is stale`
      })
    }
  }

  for (const pointer of pointers) {
    const owner = forest.byId.get(pointer.capability)
    if (!owner) {
      findings.push({
        kind: 'unknown-capability',
        pointer,
        detail: `points at "${pointer.capability}", which is not in the scanned forest — the scan may be partial`
      })
      continue
    }

    const repo = owner.repos?.find((r) => r.repoId === pointer.repoId)
    if (!repo) {
      findings.push({
        kind: 'unknown-repo',
        pointer,
        detail: `"${pointer.capability}" declares no repo "${pointer.repoId}" — the pointer is stale`
      })
      continue
    }

    if (repo.role === 'lead') {
      findings.push({
        kind: 'points-at-lead',
        pointer,
        detail:
          `"${pointer.repoId}" is the lead repo, which carries the real manifest in its sidecar ` +
          'ledger rather than a pointer'
      })
    }
  }

  return findings
}

/**
 * Whether a node has anything that requires its own ledger.
 *
 * Materialization is lazy: a node stays a stanza in its parent until it owns an
 * approval, a receipt head, a workflow, or a budget allocation. Repos alone do
 * not qualify — plenty of delivery nodes own a repo and are governed entirely by
 * an ancestor, and giving each of them a ledger is how this becomes one repo per
 * box on an EA map.
 */
export function needsMaterialization(capability: Capability): boolean {
  return Boolean(
    capability.policy?.budgets &&
      Object.values(capability.policy.budgets).some((v) => typeof v === 'number')
  ) || Boolean(capability.policy?.requiredGates?.length)
}

/** Nodes carrying their own governance but still inlined in a parent. */
export function pendingMaterialization(forest: CapabilityForest): string[] {
  return [...forest.byId.values()]
    .filter((c) => !c.ledger && needsMaterialization(c))
    .map((c) => c.id)
}

/**
 * Nodes that declare nothing and own nothing.
 *
 * Not an error — an imported EA map is mostly these on day one, and refusing
 * them would make onboarding a modeling workshop, which §10 exists to prevent.
 * Worth surfacing so a tree that never grows past the import is visible as such.
 */
export function emptyNodes(forest: CapabilityForest): string[] {
  return [...forest.byId.values()]
    .filter(
      (c) =>
        !c.repos?.length &&
        !c.policy &&
        !c.consumes?.length &&
        !c.components?.length &&
        // A node with curated links and named owners HAS grown past the import,
        // and reporting it as empty is a false signal.
        !c.knowledge?.length &&
        !c.contacts?.length &&
        !c.tracker &&
        childrenOf(forest, c.id).length === 0
    )
    .map((c) => c.id)
}
