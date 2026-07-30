import { dump } from 'js-yaml'

import type { Capability, CapabilityForest } from './model'
import { SIDECAR_LEDGER_REF } from './model'
import { forestOf } from './model'
import { validateForest } from './validate'

/**
 * What materializing a capability would do — computed, not performed.
 *
 * §7.3's review step is "a DIFF PREVIEW, not a settings save", and that is the
 * whole of this file: a pure function from (draft, existing forest) to the exact
 * set of files, branches and PRs the act would create. Nothing here touches git
 * or the network.
 *
 * It exists now, before `sgh capability materialize` does, for two reasons. The
 * preview is the honest UI for a command bus that has not landed — forms in,
 * plan out, with the command named rather than a button that lies. And when the
 * command does land, this plan is its input, already tested.
 *
 * The part worth reading is `required`. Materialization is several writes across
 * two or more repositories and §3 says state is never atomic across refs, so
 * "did it work" is not a yes/no. Each step declares whether the capability
 * exists without it:
 *
 *   required     — the node is not real until this lands. A failure here leaves
 *                  nothing, which is recoverable.
 *   best-effort  — the node is real; this is missing and visible. A failure here
 *                  leaves a chip, not a broken forest.
 *
 * The parent stanza is required, and that is the interesting call. Without it a
 * node has a ledger and no parent knows it exists — which validates clean today,
 * because nothing checks that a materialized node is reachable from a parent
 * manifest. That is the silent state this classification exists to prevent.
 */

export interface CapabilityDraft {
  id: string
  name?: string
  kind: 'business' | 'delivery'
  parent?: string
  repos?: Array<{ repoId: string; url: string; defaultBase?: string; writePolicy?: 'open' | 'gated'; role?: 'lead' | 'member' }>
  knowledge?: Array<{ kind: string; title: string; url: string }>
  contacts?: Array<{ actorId: string; role: string }>
  tracker?: { system: 'jira'; projectKey: string }
  /** Roles that hold approval on the ledger, written to CODEOWNERS. */
  approvers?: Array<{ role: string; actorId: string }>
}

export type PlanStepKind =
  | 'orphan-branch'
  | 'manifest'
  | 'codeowners'
  | 'snapshot'
  | 'pointer-pr'
  | 'parent-stanza'
  | 'branch-protection'
  | 'ledger-repo'

export interface PlanStep {
  kind: PlanStepKind
  /** Where it lands: a repoId, or the ledger repo. */
  target: string
  summary: string
  required: boolean
  /** File content, when the step writes one. */
  file?: { path: string; contents: string }
}

export interface MaterializationPlan {
  capabilityId: string
  /** Absent for a business node, which gets a standalone ledger repo. */
  leadRepoId?: string
  ledgerKind: 'sidecar' | 'repo'
  steps: PlanStep[]
  /** Blocking: these mean the draft cannot be materialized as written. */
  errors: string[]
  /** Non-blocking questions, in the same channel components use. */
  questions: string[]
  /** The command that would execute this. May not exist yet — see plan.ts. */
  command: string
  runnable: boolean
}

const CODEOWNERS_HEADER = [
  '# Generated for a capability ledger.',
  '# CODEOWNERS is read from the PR target branch, so this lives on the ledger',
  '# ref itself — that is what makes requiredGates.role enforceable by GitHub',
  '# review rather than by something we would have to build.',
  ''
].join('\n')

function codeowners(approvers: CapabilityDraft['approvers']): string {
  const lines = [CODEOWNERS_HEADER]
  const owners = (approvers ?? []).map((a) => `@${a.actorId.replace(/^@/, '')}`)
  const list = owners.length ? owners.join(' ') : '# no approvers named yet'
  lines.push(`approvals/  ${list}`)
  lines.push(`workflows/  ${list}`)
  return lines.join('\n') + '\n'
}

/** The manifest as it would be written, with parser defaults made explicit. */
function manifestFor(draft: CapabilityDraft): Capability {
  const repos = (draft.repos ?? []).map((r, i, all) => ({
    repoId: r.repoId,
    url: r.url,
    defaultBase: r.defaultBase ?? 'main',
    writePolicy: r.writePolicy ?? ('open' as const),
    // Mirrors the parser: one repo and no roles stated means that repo leads.
    role:
      r.role ??
      (all.length === 1 && !all.some((x) => x.role) ? ('lead' as const) : ('member' as const))
  }))

  const lead = repos.find((r) => r.role === 'lead')

  return {
    id: draft.id,
    ...(draft.name ? { name: draft.name } : {}),
    kind: draft.kind,
    ...(draft.parent ? { parent: draft.parent } : {}),
    ...(repos.length ? { repos } : {}),
    ...(draft.kind === 'delivery' && lead
      ? { ledger: { kind: 'sidecar' as const, repo: lead.repoId, ref: SIDECAR_LEDGER_REF } }
      : draft.kind === 'business'
        ? { ledger: { kind: 'repo' as const, url: `<${draft.id}-ledger>` } }
        : {}),
    ...(draft.knowledge?.length
      ? { knowledge: draft.knowledge.map((k) => ({ ...k, kind: k.kind as never })) }
      : {}),
    ...(draft.contacts?.length ? { contacts: draft.contacts } : {}),
    ...(draft.tracker ? { tracker: draft.tracker } : {})
  }
}

/**
 * Plan a materialization.
 *
 * Validation runs against the *prospective* forest — what the forest would look
 * like with this node in it — which is the only way single ownership can be
 * checked before anything is written. A repo already owned elsewhere is caught
 * here rather than by a failed push halfway through.
 */
export function planMaterialization(
  draft: CapabilityDraft,
  forest: CapabilityForest,
  opts: { sghHasCapabilityCommand?: boolean } = {}
): MaterializationPlan {
  const errors: string[] = []
  const questions: string[] = []

  if (!draft.id.trim()) errors.push('The capability needs an id.')
  if (draft.parent && !forest.byId.has(draft.parent)) {
    errors.push(`Parent "${draft.parent}" is not in the forest.`)
  }
  if (forest.byId.has(draft.id)) {
    errors.push(`"${draft.id}" already exists — this form creates, it does not edit.`)
  }

  const manifest = manifestFor(draft)
  const lead = manifest.repos?.find((r) => r.role === 'lead')

  // What would be true if this landed. Reuses the whole validator rather than
  // re-deriving a subset of it, so a rule added there is enforced here for free.
  const prospective = forestOf([...forest.byId.values(), manifest])
  const check = validateForest(prospective)
  for (const error of check.errors) {
    if (error.capabilityId === draft.id || error.problem.includes(draft.id)) {
      errors.push(error.problem)
    } else if (manifest.repos?.some((r) => error.problem.includes(`"${r.repoId}"`))) {
      // Single ownership is reported against both claimants; the other one is a
      // real conflict with this draft even though it names a different node.
      errors.push(`${error.capabilityId}: ${error.problem}`)
    }
  }
  for (const item of check.elicitations) {
    if (item.capabilityId === draft.id) questions.push(item.question)
  }

  const steps: PlanStep[] = []
  const ledgerKind: 'sidecar' | 'repo' = draft.kind === 'delivery' && lead ? 'sidecar' : 'repo'

  if (ledgerKind === 'sidecar' && lead) {
    steps.push({
      kind: 'orphan-branch',
      target: lead.repoId,
      // No shared ancestry with code: checkouts never see state, and state never
      // triggers code CI.
      summary: `create the orphan branch ${SIDECAR_LEDGER_REF} in ${lead.repoId}`,
      required: true
    })
  } else {
    steps.push({
      kind: 'ledger-repo',
      target: `${draft.id}-ledger`,
      summary: `create the standalone ledger repo for ${draft.id}`,
      required: true
    })
  }

  const ledgerTarget = ledgerKind === 'sidecar' && lead ? lead.repoId : `${draft.id}-ledger`

  steps.push({
    kind: 'manifest',
    target: ledgerTarget,
    summary: 'write capability.yaml',
    required: true,
    file: { path: 'capability.yaml', contents: dump(manifest, { lineWidth: 100 }) }
  })

  steps.push({
    kind: 'codeowners',
    target: ledgerTarget,
    summary: 'write CODEOWNERS over approvals/ and workflows/',
    required: true,
    file: { path: 'CODEOWNERS', contents: codeowners(draft.approvers) }
  })

  if (manifest.repos?.length) {
    steps.push({
      kind: 'snapshot',
      target: ledgerTarget,
      summary: `pin the first snapshot across ${manifest.repos.length} repo(s)`,
      required: true,
      file: {
        path: 'snapshots/README.md',
        contents:
          '# Snapshots\n\nOne file per thread: `{repoId: sha}` pinned before the first session.\n' +
          'No thread runs against floating heads.\n'
      }
    })
  }

  // Members get a back-reference so a checkout can say what it belongs to.
  for (const repo of manifest.repos?.filter((r) => r.role === 'member') ?? []) {
    steps.push({
      kind: 'pointer-pr',
      target: repo.repoId,
      summary: `open a PR adding .singularity/capability.yaml to ${repo.repoId}`,
      // Best-effort: the capability is real without it. The pointer only helps
      // discovery, and §7.3 shows these as pending and non-blocking.
      required: false,
      file: {
        path: '.singularity/capability.yaml',
        contents: dump({ pointer: 'capability', capability: draft.id, repoId: repo.repoId })
      }
    })
  }

  if (draft.parent) {
    steps.push({
      kind: 'parent-stanza',
      target: `${draft.parent} ledger`,
      summary: `update ${draft.parent}'s manifest so the new node is reachable`,
      // Required, deliberately. Without it the node has a ledger and no parent
      // knows it exists, which the validator cannot currently detect.
      required: true
    })
  }

  steps.push({
    kind: 'branch-protection',
    target: ledgerTarget,
    summary: 'apply branch protection and require sgh guard as a status check',
    // May exceed the App's scope. §7.3 says materialize anyway with a visible
    // chip; guard rung 1 still holds without it.
    required: false
  })

  const runnable = errors.length === 0 && opts.sghHasCapabilityCommand === true

  return {
    capabilityId: draft.id,
    leadRepoId: lead?.repoId,
    ledgerKind,
    steps,
    errors,
    questions,
    command: `sgh capability materialize ${draft.id || '<id>'}`,
    runnable
  }
}
