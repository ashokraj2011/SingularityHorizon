import { dump, loadAll } from 'js-yaml'

import type { Capability } from './model'
import type { MaterializationPlan, PlanStep } from './plan'

/**
 * A materialization plan, compiled to GitHub API calls.
 *
 * Pure: this decides *what* requests to make and in what order; `ledger.ts`
 * makes them. Same split as the planner, and for the same reason — the ordering,
 * the compare-and-swap and the required/best-effort handling are where the bugs
 * live, and none of that needs a network to test.
 *
 * The API is a better fit than local git for a ledger, and specifically because
 * of the first four calls below. An orphan branch is a commit with no parents;
 * over HTTP that is blobs → tree → commit(parents: []) → create ref, with no
 * clone, no working tree and no credential helper. `git checkout --orphan` needs
 * a checkout of a repo whose contents we never want to see.
 *
 * Ref updates carry the expected head so the update is a compare-and-swap. That
 * is what makes concurrent writers safe without a lock, and it is the same
 * property §3 wants when it says the root advances only by gated merges.
 *
 * What this cannot do is sign a commit as a person. GitHub signs API-created
 * commits with its own web-flow key, so an enforcement ladder that requires
 * user-signed commits needs a local-git applier instead. The `Applier` seam in
 * ledger.ts exists so that swap does not reach this file.
 */

export interface GitHubCall {
  /** Which plan step this serves, so a failure reports in the plan's language. */
  step: PlanStep['kind']
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  /** Path under the API root, e.g. `/repos/{owner}/{repo}/git/blobs`. */
  path: string
  summary: string
  /** JSON body. Text content is carried raw — the executor base64s it. */
  body?: Record<string, unknown>
  /**
   * Raw file content for calls that must base64-encode. Kept out of `body` so
   * this module needs no Buffer and stays free of node builtins.
   */
  contentText?: string
  /** Where in `body` the encoded content belongs. */
  contentField?: string
  /**
   * Placeholders resolved from earlier responses, e.g. `{blob:capability.yaml}`.
   * Substituted by the executor, which is the only thing that has seen a reply.
   */
  needs?: string[]
  /**
   * What this call's response contributes, and which response field it comes
   * from. Stated rather than inferred from the URL: the executor should not have
   * to know that a POST to /git/trees is the one whose `sha` means "tree".
   */
  provides?: Array<{ key: string; from: string }>
  /**
   * A pure rewrite applied to fetched content before this call sends it. Named
   * rather than inlined so the executor stays free of domain logic.
   */
  transform?: { kind: 'demote-to-stub'; parentId: string; stub: Capability; source: string }
  /** A failure here abandons the run; a best-effort failure is reported and skipped. */
  required: boolean
  /** For CAS ref updates: the placeholder holding the expected head. */
  expect?: string
}

export interface RepoTarget {
  owner: string
  repo: string
}

export interface CallPlan {
  calls: GitHubCall[]
  /** Steps that cannot be compiled — reported rather than silently dropped. */
  blocked: Array<{ step: PlanStep['kind']; reason: string }>
}

/**
 * Demote a child to a stub in its parent's manifest.
 *
 * This is what the `parent-stanza` step actually does, and it is the only
 * transform whose input is not known until a response arrives — hence a pure
 * function the executor calls, rather than logic inside the executor.
 *
 * Before materialization a child lives in its parent's `children:` array — that
 * is what the parser flattens, passing the container down as `parent`. After, the
 * definition lives in the child's own ledger and the parent's entry shrinks to
 * `{id, kind, ledger}`: enough to say *where the child's ledger lives*, which is
 * the sole reason this step is required. Nesting supplies `parent`, so the stub
 * does not restate it.
 *
 * The parser then resolves the duplicate id in favour of the copy carrying a
 * ledger, and treats the stub's missing fields as a reference rather than drift.
 *
 * Returns null rather than guessing when the manifest is multi-document or the
 * parent is not in it; a required step that cannot be performed correctly must
 * report, not improvise.
 */
export function demoteToStub(
  manifestText: string,
  parentId: string,
  stub: Capability
): string | null {
  const documents: unknown[] = []
  try {
    loadAll(manifestText, (doc) => documents.push(doc))
  } catch {
    return null
  }
  if (documents.length !== 1) return null

  const first = documents[0]
  const wasSingle = !Array.isArray(first)
  const entries = (Array.isArray(first) ? first : [first]).filter(
    (e): e is Record<string, unknown> => typeof e === 'object' && e !== null
  )

  const parent = entries.find((e) => e.id === parentId)
  if (!parent) return null

  const children = Array.isArray(parent.children) ? [...(parent.children as unknown[])] : []
  const index = children.findIndex(
    (c) => typeof c === 'object' && c !== null && (c as Record<string, unknown>).id === stub.id
  )
  // `parent` is implied by the nesting; restating it here would be a second
  // source for the same fact.
  const entry = { id: stub.id, kind: stub.kind, ...(stub.ledger ? { ledger: stub.ledger } : {}) }

  if (index >= 0) children[index] = entry
  else children.push(entry)
  parent.children = children

  return dump(wasSingle ? entries[0] : entries, { lineWidth: 100 })
}

/**
 * Where a node's ledger actually lives, as something addressable.
 *
 * A standalone ledger carries its own URL. A sidecar carries a *repoId*, which
 * only means something against the same node's repo list — so resolving it is a
 * lookup, not a string operation. Lives here rather than inline at the IPC layer
 * because getting it wrong silently omits the parent stanza, and that is the one
 * required step whose absence still validates clean.
 */
export function ledgerRepoUrlOf(capability: Capability | undefined): string | undefined {
  const ledger = capability?.ledger
  if (!ledger) return undefined
  if (ledger.kind === 'repo') return ledger.url
  return capability?.repos?.find((r) => r.repoId === ledger.repo)?.url
}

/** `owner/repo` or a full URL; anything else is not addressable. */
export function parseRepo(reference: string): RepoTarget | null {
  const cleaned = reference
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/\.git$/, '')
  const parts = cleaned.split('/').filter(Boolean)
  if (parts.length < 2) return null
  // Tolerates a host prefix: github.com/org/repo and org/repo both work.
  const [owner, repo] = parts.slice(-2)
  return owner && repo ? { owner, repo } : null
}

const LEDGER_REF = 'refs/heads/singularity/ledger'

/**
 * The stub the parent keeps, projected from the manifest the run writes.
 *
 * Read back out of the planned bytes rather than rebuilt from the draft: two
 * constructions of the same ledger pointer is exactly how a stub comes to name a
 * ref that does not exist.
 */
function stubOf(plan: MaterializationPlan): Capability {
  const manifestStep = plan.steps.find((s) => s.kind === 'manifest')
  const documents: unknown[] = []
  if (manifestStep?.file) {
    try {
      loadAll(manifestStep.file.contents, (doc) => documents.push(doc))
    } catch {
      /* falls through to the id-only stub below */
    }
  }
  const written = (Array.isArray(documents[0]) ? documents[0][0] : documents[0]) as
    | Partial<Capability>
    | undefined

  return {
    id: plan.capabilityId,
    kind: written?.kind ?? 'delivery',
    ...(written?.parent ? { parent: written.parent } : {}),
    ...(written?.ledger ? { ledger: written.ledger } : {})
  } as Capability
}

/**
 * Compile a plan into ordered calls.
 *
 * `repoUrls` maps a repoId to whatever the manifest recorded, because a plan
 * speaks in repoIds and the API needs owner/repo.
 */
export function compileCalls(
  plan: MaterializationPlan,
  repoUrls: Record<string, string>,
  opts: { message?: string; parentLedgerRepo?: string } = {}
): CallPlan {
  const calls: GitHubCall[] = []
  const blocked: CallPlan['blocked'] = []
  const message = opts.message ?? `capability: materialize ${plan.capabilityId}`

  const target = (repoId: string): RepoTarget | null => parseRepo(repoUrls[repoId] ?? repoId)

  /* ------------------------------------------ the ledger, as an orphan branch */

  const ledgerRepoId = plan.ledgerKind === 'sidecar' ? plan.leadRepoId : undefined
  const ledgerTarget = ledgerRepoId ? target(ledgerRepoId) : null

  if (plan.ledgerKind === 'repo') {
    // Creating a repository is an org-level act with its own approvals; the API
    // can do it, but silently creating repos from a desktop app is not a
    // decision this should make on someone's behalf.
    blocked.push({
      step: 'ledger-repo',
      reason: 'creating a standalone ledger repository is an org-level act — create it, then re-run'
    })
  } else if (!ledgerTarget) {
    blocked.push({
      step: 'orphan-branch',
      reason: `no addressable URL for the lead repo "${ledgerRepoId ?? '(none)'}"`
    })
  } else {
    const base = `/repos/${ledgerTarget.owner}/${ledgerTarget.repo}`
    const files = plan.steps.filter((s) => s.file && s.target === ledgerRepoId)

    for (const step of files) {
      calls.push({
        step: step.kind,
        method: 'POST',
        path: `${base}/git/blobs`,
        summary: `upload ${step.file!.path}`,
        body: { encoding: 'base64' },
        contentText: step.file!.contents,
        contentField: 'content',
        provides: [{ key: `blob:${step.file!.path}`, from: 'sha' }],
        required: step.required
      })
    }

    calls.push({
      step: 'manifest',
      method: 'POST',
      path: `${base}/git/trees`,
      summary: 'build the ledger tree',
      // No base_tree: an orphan branch starts from nothing, which is the point —
      // no shared ancestry with code, so a checkout never sees ledger state and
      // ledger writes never trigger code CI.
      body: {
        tree: files.map((s) => ({
          path: s.file!.path,
          mode: '100644',
          type: 'blob',
          sha: `{blob:${s.file!.path}}`
        }))
      },
      needs: files.map((s) => `blob:${s.file!.path}`),
      provides: [{ key: 'tree', from: 'sha' }],
      required: true
    })

    calls.push({
      step: 'orphan-branch',
      method: 'POST',
      path: `${base}/git/commits`,
      summary: 'commit with no parents',
      // The whole orphan-branch trick, in one field.
      body: { message, tree: '{tree}', parents: [] },
      needs: ['tree'],
      provides: [{ key: 'commit', from: 'sha' }],
      required: true
    })

    calls.push({
      step: 'orphan-branch',
      method: 'POST',
      path: `${base}/git/refs`,
      summary: `create ${LEDGER_REF}`,
      body: { ref: LEDGER_REF, sha: '{commit}' },
      needs: ['commit'],
      required: true
    })
  }

  /* ------------------------------------------------ pointer PRs to members */

  for (const step of plan.steps.filter((s) => s.kind === 'pointer-pr')) {
    const memberTarget = target(step.target)
    if (!memberTarget) {
      blocked.push({ step: step.kind, reason: `no addressable URL for "${step.target}"` })
      continue
    }
    const base = `/repos/${memberTarget.owner}/${memberTarget.repo}`
    const branch = `singularity/pointer-${plan.capabilityId.replace(/[^\w.-]/g, '-')}`

    calls.push({
      step: step.kind,
      method: 'GET',
      path: `${base}/git/ref/heads/main`,
      summary: `read ${step.target} head`,
      provides: [{ key: `head:${step.target}`, from: 'object.sha' }],
      required: false
    })
    calls.push({
      step: step.kind,
      method: 'POST',
      path: `${base}/git/refs`,
      summary: `branch ${branch}`,
      body: { ref: `refs/heads/${branch}`, sha: `{head:${step.target}}` },
      needs: [`head:${step.target}`],
      required: false
    })
    calls.push({
      step: step.kind,
      method: 'PUT',
      path: `${base}/contents/.singularity/capability.yaml`,
      summary: `add the pointer to ${step.target}`,
      body: { message: `capability: point ${step.target} at ${plan.capabilityId}`, branch },
      contentText: step.file?.contents ?? '',
      contentField: 'content',
      required: false
    })
    calls.push({
      step: step.kind,
      method: 'POST',
      path: `${base}/pulls`,
      summary: `open the pointer PR on ${step.target}`,
      body: {
        title: `Point ${step.target} at ${plan.capabilityId}`,
        head: branch,
        base: 'main',
        body: 'Adds a back-reference so a checkout can say which capability owns it.'
      },
      // Best-effort by design: the capability is real without the pointer, which
      // only helps discovery. §7.3 shows these as pending and non-blocking.
      required: false
    })
  }

  /* ------------------------------------------------------ the parent stanza */

  const parentStep = plan.steps.find((s) => s.kind === 'parent-stanza')
  if (parentStep) {
    const parentTarget = opts.parentLedgerRepo ? parseRepo(opts.parentLedgerRepo) : null
    if (!parentTarget) {
      // Required and uncompilable: reported loudly, because skipping it leaves a
      // node with a ledger that no parent knows about — and that validates clean.
      blocked.push({
        step: 'parent-stanza',
        reason:
          "the parent's ledger location is unknown, and this step is required — " +
          'without it the new node is unreachable from its parent manifest'
      })
    } else {
      const base = `/repos/${parentTarget.owner}/${parentTarget.repo}`
      calls.push({
        step: 'parent-stanza',
        method: 'GET',
        path: `${base}/contents/capability.yaml?ref=singularity/ledger`,
        summary: "read the parent's manifest",
        provides: [
          { key: 'parent-manifest', from: 'content' },
          { key: 'parent-manifest-sha', from: 'sha' }
        ],
        required: true
      })
      calls.push({
        step: 'parent-stanza',
        method: 'PUT',
        path: `${base}/contents/capability.yaml`,
        summary: `demote ${plan.capabilityId} to a stub pointing at its ledger`,
        // The existing blob sha makes this a compare-and-swap: a concurrent edit
        // to the parent manifest fails here rather than silently overwriting.
        body: { message: `capability: register ${plan.capabilityId}`, branch: 'singularity/ledger' },
        needs: ['parent-manifest'],
        expect: 'parent-manifest-sha',
        contentField: 'content',
        // Derived from the exact manifest bytes the run writes, so the stub's
        // ledger pointer cannot disagree with the ledger it points at.
        transform: {
          kind: 'demote-to-stub',
          parentId: stubOf(plan).parent ?? '',
          stub: stubOf(plan),
          source: 'parent-manifest'
        },
        required: true
      })
    }
  }

  /* -------------------------------------------------------- branch protection */

  if (plan.steps.some((s) => s.kind === 'branch-protection') && ledgerTarget) {
    calls.push({
      step: 'branch-protection',
      method: 'PUT',
      path: `/repos/${ledgerTarget.owner}/${ledgerTarget.repo}/branches/singularity/ledger/protection`,
      summary: 'protect the ledger ref and require the guard',
      body: {
        required_status_checks: { strict: true, contexts: ['sgh guard'] },
        enforce_admins: true,
        required_pull_request_reviews: { required_approving_review_count: 1 },
        restrictions: null
      },
      // Frequently exceeds an App's scope. §7.3 says materialize anyway and show
      // a chip; guard rung 1 still holds without it.
      required: false
    })
  }

  return { calls, blocked }
}
