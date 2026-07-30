import type { CapabilityForest } from './model'
import { childrenOf, depthOf, pathOf, rootsOf } from './model'
import type { CapabilityPointer, ParseIssue } from './parse'
import {
  emptyNodes,
  pendingMaterialization,
  reconcilePointers,
  validateForest,
  type Elicitation,
  type PointerFinding,
  type ValidationError
} from './validate'
import { explainGate, resolvePolicy } from './resolve'
import type { CapabilityViewNode, CapabilityView } from '../../shared/ipc'

/**
 * The Navigator's read model.
 *
 * §7.0 requires every pane to be a pure function of (projection state, route),
 * and §5 requires policy resolution to happen host-side. Both are satisfied by
 * computing the whole view here and shipping something flat: the renderer gets
 * rows to draw, the resolution has already happened, and no part of the UI has
 * to know a tree or a fold exists.
 *
 * That is also why provenance is resolved here rather than passed as a forest
 * for the renderer to re-derive. §7.1 says policy rows always carry provenance,
 * and §7.5 makes it a rule — a row that cannot say where it came from leaves
 * somebody looking at a gate they did not add with nowhere to go.
 *
 * Nothing in here writes. Creation, materialization and repo changes are `sgh`
 * commands (§8), and a second thing that writes ledgers is how two sources of
 * truth start.
 */
export function buildCapabilityView(
  root: string,
  forest: CapabilityForest,
  pointers: CapabilityPointer[],
  issues: ParseIssue[],
  sources: string[],
  pointerSources: string[]
): CapabilityView {
  const validation = validateForest(forest)
  const findings = reconcilePointers(forest, pointers)
  const pending = new Set(pendingMaterialization(forest))
  const empty = new Set(emptyNodes(forest))

  const errorsById = new Map<string, ValidationError[]>()
  for (const error of validation.errors) {
    errorsById.set(error.capabilityId, [...(errorsById.get(error.capabilityId) ?? []), error])
  }
  const elicitationsById = new Map<string, Elicitation[]>()
  for (const item of validation.elicitations) {
    elicitationsById.set(item.capabilityId, [
      ...(elicitationsById.get(item.capabilityId) ?? []),
      item
    ])
  }
  const findingsByCapability = new Map<string, PointerFinding[]>()
  for (const finding of findings) {
    findingsByCapability.set(finding.pointer.capability, [
      ...(findingsByCapability.get(finding.pointer.capability) ?? []),
      finding
    ])
  }

  const nodes: CapabilityViewNode[] = []

  // Depth-first from the roots, so the flat array already reads in tree order
  // and the renderer only has to indent by `depth`.
  const visit = (id: string): void => {
    const capability = forest.byId.get(id)
    if (!capability) return

    const resolved = resolvePolicy(forest, id)
    const lead = capability.repos?.find((r) => r.role === 'lead')

    const warnings: string[] = []
    if (pending.has(id)) {
      warnings.push('owns governance but is still a stanza in its parent — not yet materialized')
    }
    if (empty.has(id)) warnings.push('declares nothing yet')

    nodes.push({
      id,
      name: capability.name,
      kind: capability.kind,
      parent: capability.parent,
      depth: depthOf(forest, id) ?? 0,
      path: pathOf(forest, id) ?? id,
      ledger: capability.ledger
        ? capability.ledger.kind === 'sidecar'
          ? { kind: 'sidecar', label: `${capability.ledger.repo} · singularity/ledger` }
          : { kind: 'repo', label: capability.ledger.url }
        : undefined,
      leadRepoId: lead?.repoId,
      repos: (capability.repos ?? []).map((r) => ({
        repoId: r.repoId,
        url: r.url,
        defaultBase: r.defaultBase,
        writePolicy: r.writePolicy,
        role: r.role
      })),
      components: (capability.components ?? []).map((c) => ({
        id: c.id,
        kind: c.kind,
        tech: c.tech,
        status: c.status,
        // Enough to tell a declaration from an observation without opening
        // anything — §2's whole point is that those are different tiers.
        observedBy: (c.provenance?.observed ?? []).map((o) => o.extractor),
        declaredBy: c.provenance?.declared?.by
      })),
      consumes: (capability.consumes ?? []).map((e) => ({
        provider: e.provider,
        component: e.component,
        contract: e.contract?.path
      })),
      knowledge: (capability.knowledge ?? []).map((k) => ({
        kind: k.kind,
        title: k.title,
        url: k.url,
        tags: k.tags ?? [],
        verifiedAt: k.verifiedAt,
        // Surfaced, never garbage-collected (§7.5). Six months is a nag
        // threshold, not a rule about truth.
        stale: k.verifiedAt ? Date.parse(k.verifiedAt) < Date.now() - 180 * 864e5 : false
      })),
      contacts: capability.contacts ?? [],
      tracker: capability.tracker,
      // The fold, rendered. Every row carries where it came from.
      policy: resolved
        ? {
            gates: resolved.requiredGates.map((g) => ({
              on: g.on,
              role: g.role,
              scope: g.scope,
              from: explainGate(forest, id, g) ?? id
            })),
            budgets: Object.entries(resolved.budgets).map(([field, value]) => ({
              field,
              value: value as number,
              // "min of digital $50, pzn $40" — the ancestors that declared this
              // field, so a surprising number is explicable.
              from: resolved.ancestry.filter((ancestorId) => {
                const budgets = forest.byId.get(ancestorId)?.policy?.budgets as
                  | Record<string, number | undefined>
                  | undefined
                return budgets?.[field] !== undefined
              })
            })),
            terminalAllowList: resolved.terminalAllowList,
            allowListFrom: resolved.ancestry.filter(
              (ancestorId) => forest.byId.get(ancestorId)?.policy?.terminalAllowList !== undefined
            ),
            constraints: resolved.constraints.map((c) => ({
              id: c.id,
              forbids: c.forbids,
              selector: c.selector.path
                ? `${c.selector.kind} ${c.selector.path}`
                : c.selector.kind,
              // What the person wrote. A governance row reads better as "no
              // schema writes before the Q3 freeze" than as "writes db.schema",
              // and the typed selector is still there for the machine.
              text: c.text
            }))
          }
        : undefined,
      errors: (errorsById.get(id) ?? []).map((e) => e.problem),
      questions: (elicitationsById.get(id) ?? []).map((e) => e.question),
      pointerFindings: (findingsByCapability.get(id) ?? []).map((f) => ({
        kind: f.kind,
        repoId: f.pointer.repoId,
        detail: f.detail
      })),
      warnings
    })

    for (const child of childrenOf(forest, id)) visit(child.id)
  }

  for (const node of rootsOf(forest)) visit(node.id)

  // Pointers whose capability is not in the forest have no node to hang off, and
  // dropping them would hide a stale pointer entirely.
  const orphanPointers = findings
    .filter((f) => !forest.byId.has(f.pointer.capability))
    .map((f) => ({ kind: f.kind, repoId: f.pointer.repoId, detail: f.detail }))

  return {
    root,
    sources,
    pointerSources,
    nodes,
    issues: issues.map((i) => ({ source: i.source, at: i.at, problem: i.problem })),
    orphanPointers,
    valid: validation.valid && issues.length === 0
  }
}
