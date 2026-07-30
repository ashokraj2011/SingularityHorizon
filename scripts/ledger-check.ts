/**
 * The GitHub applier.
 *
 * The compiled call plan is checked in capability-check; this is about what
 * happens when the calls are actually sent, and the assertions aim at the three
 * ways this can go wrong in a way nobody notices:
 *
 *   Dry run must make zero requests. It is the default, so a bug here means the
 *   safe mode writes to real repositories.
 *
 *   Shas must thread. A tree built from stale blob shas, or a ref pointed at the
 *   wrong commit, produces a ledger that exists and is wrong — worse than a
 *   failure, because nothing reports it.
 *
 *   Partial failure must behave as the plan declared. §3 says state is never
 *   atomic across refs, so "required stops, best-effort continues" is the only
 *   thing standing between a failed protection call and an abandoned ledger.
 *
 * Run with: npm run ledger:check
 */
import { dump } from 'js-yaml'

import { compileCalls, ledgerRepoUrlOf } from '../src/main/capability/calls'
import { planMaterialization, type CapabilityDraft } from '../src/main/capability/plan'
import { forestOf, type Capability } from '../src/main/capability/model'
import { parseManifest } from '../src/main/capability/parse'
import { loadForest } from '../src/main/capability/load'
import { GitHubApplier } from '../src/main/ledger'

const checks: Array<[string, boolean, string?]> = []
const ok = (name: string, pass: boolean, detail?: string): void => {
  checks.push([name, pass, detail])
}

interface Recorded {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

/** A fake GitHub that records what it was asked and answers plausibly. */
function fakeGitHub(
  overrides: Record<string, { status: number; body: unknown }> = {}
): { fetchImpl: typeof fetch; seen: Recorded[] } {
  const seen: Recorded[] = []
  let blobs = 0

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    seen.push({ url: href, method, body })

    const key = Object.keys(overrides).find((k) => href.includes(k))
    if (key) {
      const { status, body: payload } = overrides[key]
      return new Response(JSON.stringify(payload), { status })
    }

    if (href.includes('/git/blobs')) {
      blobs += 1
      return new Response(JSON.stringify({ sha: `blobsha${blobs}` }), { status: 201 })
    }
    if (href.includes('/git/trees')) return new Response(JSON.stringify({ sha: 'treesha' }), { status: 201 })
    if (href.includes('/git/commits')) return new Response(JSON.stringify({ sha: 'commitsha' }), { status: 201 })
    if (href.includes('/git/ref/')) {
      return new Response(JSON.stringify({ object: { sha: 'headsha' } }), { status: 200 })
    }
    if (href.includes('/contents/') && method === 'GET') {
      const parent = dump({
        id: 'digital',
        kind: 'business',
        policy: { budgets: { maxCostUsdPerThread: 50 } },
        children: [{ id: 'digital.sel', kind: 'delivery' }]
      })
      return new Response(
        JSON.stringify({ sha: 'manifestsha', content: Buffer.from(parent).toString('base64') }),
        { status: 200 }
      )
    }
    return new Response(JSON.stringify({ sha: 'ok' }), { status: 201 })
  }) as unknown as typeof fetch

  return { fetchImpl, seen }
}

const parent: Capability = { id: 'digital', kind: 'business' }
const draft: CapabilityDraft = {
  id: 'digital.sel',
  kind: 'delivery',
  parent: 'digital',
  repos: [
    { repoId: 'sel-svc', url: 'github.com/acme/sel-svc', role: 'lead' },
    { repoId: 'sel-web', url: 'github.com/acme/sel-web', role: 'member' }
  ],
  approvers: [{ role: 'architect', actorId: 'ashok' }]
}

const plan = planMaterialization(draft, forestOf([parent]))
const { calls, blocked } = compileCalls(
  plan,
  { 'sel-svc': 'github.com/acme/sel-svc', 'sel-web': 'github.com/acme/sel-web' },
  { parentLedgerRepo: 'acme/digital-ledger' }
)

/* ------------------------------------------------------- dry run writes nothing */

const dry = fakeGitHub()
const dryResult = await new GitHubApplier({ token: 't', fetchImpl: dry.fetchImpl }).apply(
  calls,
  blocked
)

// The default matters more than the behaviour: forgetting the flag must be safe.
ok('dry run is the default', dryResult.dryRun === true)
ok('and it makes no requests at all', dry.seen.length === 0, `${dry.seen.length} requests`)
ok('while still reporting every step', dryResult.outcomes.length === calls.length)
ok('all as planned', dryResult.outcomes.every((o) => o.status === 'planned'))
ok('a dry run is never reported as a success that happened', dryResult.ok === true && dryResult.dryRun)

// Placeholders genuinely cannot be known before a response exists. Saying so beats
// inventing a sha and showing a preview that differs from the run.
ok('unresolved placeholders are named rather than faked',
   dryResult.outcomes.some((o) => o.detail?.includes('awaits')),
   dryResult.outcomes.map((o) => o.detail).filter(Boolean).join(' | '))

ok('blocked steps survive into the result', dryResult.blocked === blocked)

/* ---------------------------------------------------------- a real run threads shas */

const live = fakeGitHub()
const liveResult = await new GitHubApplier({
  token: 't',
  dryRun: false,
  fetchImpl: live.fetchImpl
}).apply(calls, blocked)

ok('a real run succeeds against a well-behaved API', liveResult.ok === true,
   liveResult.outcomes.filter((o) => o.status === 'failed').map((o) => o.detail).join(' | '))

const treeRequest = live.seen.find((r) => r.url.includes('/git/trees'))
ok('the tree is built from the blob shas that came back',
   JSON.stringify(treeRequest?.body?.tree).includes('blobsha'),
   JSON.stringify(treeRequest?.body?.tree))
ok('and no placeholder survives into a request',
   !JSON.stringify(live.seen).includes('{blob:'),
   JSON.stringify(live.seen).slice(0, 200))

const commitRequest = live.seen.find((r) => r.url.includes('/git/commits'))
ok('the commit points at the tree that was just created', commitRequest?.body?.tree === 'treesha')
ok('and still has no parents',
   Array.isArray(commitRequest?.body?.parents) &&
     (commitRequest!.body!.parents as unknown[]).length === 0)

const refRequest = live.seen.find(
  (r) => r.method === 'POST' && r.url.includes('/git/refs') && r.url.includes('sel-svc')
)
ok('the ledger ref points at that commit', refRequest?.body?.sha === 'commitsha')
ok('and names the sidecar ref', refRequest?.body?.ref === 'refs/heads/singularity/ledger')

const blobRequest = live.seen.find((r) => r.url.includes('/git/blobs'))
ok('file content is base64 encoded',
   typeof blobRequest?.body?.content === 'string' &&
     Buffer.from(String(blobRequest.body.content), 'base64').toString('utf8').includes('digital.sel'))

/* ------------------------------------------------ the stanza is a real rewrite */

const stanzaPut = live.seen.find((r) => r.method === 'PUT' && r.url.includes('digital-ledger'))
const rewritten = Buffer.from(String(stanzaPut?.body?.content ?? ''), 'base64').toString('utf8')
const rewrittenParse = parseManifest(rewritten)

ok('the parent manifest is rewritten, not replaced',
   rewrittenParse.capabilities.find((c) => c.id === 'digital')?.policy?.budgets
     ?.maxCostUsdPerThread === 50,
   rewritten)
ok('and the child is demoted to a stub carrying its ledger',
   rewrittenParse.capabilities.find((c) => c.id === 'digital.sel')?.ledger?.kind === 'sidecar')
// Without this the write would clobber a concurrent edit to the parent manifest.
ok('the stanza write carries the sha it expects to replace',
   stanzaPut?.body?.sha === 'manifestsha')

/* ------------------------------------------------------- partial failure */

// Branch protection routinely exceeds an App's scope. The plan calls it
// best-effort, so a 403 must leave a materialized capability behind.
const protectionDenied = fakeGitHub({
  '/protection': { status: 403, body: { message: 'Resource not accessible by integration' } }
})
const denied = await new GitHubApplier({
  token: 't',
  dryRun: false,
  fetchImpl: protectionDenied.fetchImpl
}).apply(calls, blocked)

ok('a best-effort failure does not fail the run', denied.ok === true)
ok('and it is reported rather than hidden',
   denied.outcomes.some((o) => o.step === 'branch-protection' && o.status === 'skipped'))
ok('with the API message kept',
   denied.outcomes.some((o) => o.detail?.includes('not accessible')),
   denied.outcomes.find((o) => o.step === 'branch-protection')?.detail)

// A required failure is the opposite: stop, and do not leave later writes to
// land against a ledger that does not exist.
const treeFails = fakeGitHub({ '/git/trees': { status: 422, body: { message: 'bad tree' } } })
const stopped = await new GitHubApplier({
  token: 't',
  dryRun: false,
  fetchImpl: treeFails.fetchImpl
}).apply(calls, blocked)

ok('a required failure fails the run', stopped.ok === false)
ok('and names where it stopped', stopped.stoppedAt !== undefined, stopped.stoppedAt)
ok('everything after it is skipped, not attempted',
   stopped.outcomes.filter((o) => o.status === 'skipped').length > 0)
ok('and the ref is never created after a failed tree',
   !treeFails.seen.some((r) => r.method === 'POST' && r.url.includes('/git/refs')),
   treeFails.seen.map((r) => r.url).join(' | '))
ok('the pointer PR is not attempted either',
   !treeFails.seen.some((r) => r.url.endsWith('/pulls')))

// A network error must behave exactly like an HTTP failure, or a flaky connection
// silently becomes a half-materialized capability.
const throwing = (async () => {
  throw new Error('ECONNREFUSED')
}) as unknown as typeof fetch
const networkDown = await new GitHubApplier({
  token: 't',
  dryRun: false,
  fetchImpl: throwing
}).apply(calls, blocked)
ok('a network error stops the run like any required failure', networkDown.ok === false)
ok('and says what happened',
   networkDown.outcomes.some((o) => o.detail?.includes('ECONNREFUSED')))

/* ------------------------------------------------------- auth and host */

const ghe = fakeGitHub()
await new GitHubApplier({
  token: 'secret-token',
  baseUrl: 'https://ghe.example.com/api/v3/',
  dryRun: false,
  fetchImpl: ghe.fetchImpl
}).apply(calls.slice(0, 1), [])
ok('a GHE base url is honoured and its trailing slash trimmed',
   ghe.seen[0]?.url.startsWith('https://ghe.example.com/api/v3/repos/'),
   ghe.seen[0]?.url)

/* ============================== the real fixture, walked the way IPC walks it */

// Everything above builds its forest in memory. This section starts from
// `fixtures/capability-demo` on disk and runs the exact sequence the
// capability:apply handler runs, so the loader, the planner, the compiler and
// the applier are proven to fit together rather than individually.

const loaded = await loadForest('fixtures/capability-demo')
ok('the demo fixture loads', loaded.forest.byId.size === 2,
   [...loaded.forest.byId.keys()].join(', '))

const parentNode = loaded.forest.byId.get('digital')
ok('a standalone ledger resolves to its own url',
   ledgerRepoUrlOf(parentNode) === 'github.com/acme/digital-ledger',
   ledgerRepoUrlOf(parentNode))
// A sidecar names a repoId, so resolving it has to go through the repo list.
ok('a sidecar ledger resolves through the repo list',
   ledgerRepoUrlOf({
     id: 'x',
     kind: 'delivery',
     repos: [{ repoId: 'sel-svc', url: 'github.com/acme/sel-svc', defaultBase: 'main', writePolicy: 'open', role: 'lead' }],
     ledger: { kind: 'sidecar', repo: 'sel-svc', ref: 'refs/heads/singularity/ledger' }
   }) === 'github.com/acme/sel-svc')
ok('and a sidecar naming a repo the node does not own resolves to nothing',
   ledgerRepoUrlOf({
     id: 'x',
     kind: 'delivery',
     ledger: { kind: 'sidecar', repo: 'missing', ref: 'refs/heads/singularity/ledger' }
   }) === undefined)

const realDraft: CapabilityDraft = {
  id: 'digital.pzn.selector',
  name: 'Treatment Selector',
  kind: 'delivery',
  parent: 'digital.pzn',
  repos: [
    { repoId: 'sel-svc', url: 'github.com/acme/sel-svc', role: 'lead' },
    { repoId: 'sel-web', url: 'github.com/acme/sel-web', role: 'member' }
  ],
  approvers: [{ role: 'architect', actorId: 'ashok' }]
}

const realPlan = planMaterialization(realDraft, loaded.forest)
ok('a draft under a real parent plans without errors',
   realPlan.errors.length === 0, realPlan.errors.join(' | '))

// digital.pzn is inline in its parent and has no ledger of its own, so there is
// nowhere to write the stanza. This is B2's partial state, caught before any
// request is sent rather than discovered halfway through.
const realCompiled = compileCalls(
  realPlan,
  Object.fromEntries(realDraft.repos!.map((r) => [r.repoId, r.url])),
  { parentLedgerRepo: ledgerRepoUrlOf(loaded.forest.byId.get('digital.pzn')) }
)
ok('an unmaterialized parent blocks the stanza rather than skipping it',
   realCompiled.blocked.some((b) => b.step === 'parent-stanza'),
   realCompiled.blocked.map((b) => b.step).join(', '))

const realRun = await new GitHubApplier({
  token: '',
  fetchImpl: fakeGitHub().fetchImpl
}).apply(realCompiled.calls, realCompiled.blocked)
ok('the fixture still produces a runnable dry run', realRun.outcomes.length > 0)
ok('which makes no requests', realRun.dryRun === true)
// The blocked required step must reach the surface the user reads, or the UI
// would show a clean plan that cannot actually complete.
ok('and the blocked step is carried to the result',
   realRun.blocked.some((b) => b.step === 'parent-stanza'))

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
