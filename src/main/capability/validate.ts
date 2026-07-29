import type { Capability, CapabilityForest } from './model'
import { ancestryOf, childrenOf } from './model'

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

export function validateForest(forest: CapabilityForest): ValidationResult {
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

  return { valid: errors.length === 0, errors, elicitations }
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
        childrenOf(forest, c.id).length === 0
    )
    .map((c) => c.id)
}
