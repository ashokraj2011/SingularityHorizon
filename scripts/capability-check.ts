/**
 * Capability Model, spec v1 — the pure core.
 *
 * The spec puts the parser, validator and resolver first and says they are "most
 * of the real work and all of the correctness risk". The assertions here are
 * aimed at that risk rather than at coverage:
 *
 *   Single ownership is checked across the forest, not per manifest, because the
 *   failure is invisible from inside either claimant. The spec's own example
 *   manifest contains the mistake deliberately.
 *
 *   Monotonicity is asserted as a property over every node, not as a case. If a
 *   child can ever end up looser than its parent, one of the four fold
 *   operations is wrong, and that is a much worse bug than a bad manifest.
 *
 *   `parent` is authoritative and `id` is decoration. Every ancestry-dependent
 *   answer is checked against a forest where the two deliberately disagree.
 *
 * Run with: npm run capability:check
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadForest } from '../src/main/capability/load'
import { parseManifest, parseManifests } from '../src/main/capability/parse'
import { SIDECAR_LEDGER_REF } from '../src/main/capability/model'
import { reconcilePointers } from '../src/main/capability/validate'
import { buildCapabilityView } from '../src/main/capability/view'
import { planMaterialization, type CapabilityDraft } from '../src/main/capability/plan'
import {
  ancestryOf,
  depthOf,
  forestOf,
  lowestCommonAncestor,
  pathOf,
  rootsOf,
  type Capability,
  type CapabilityForest
} from '../src/main/capability/model'
import {
  emptyNodes,
  pendingMaterialization,
  validateForest
} from '../src/main/capability/validate'
import {
  explainGate,
  foldFragment,
  isAtLeastAsTight,
  monotonicityViolations,
  resolvePolicy,
  toSessionPolicy
} from '../src/main/capability/resolve'
import { classify, decide } from '../src/main/acp/policy'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* ----------------------------------------------------------------- parsing */

const MANIFEST = `
id: payments
kind: business
name: Payments
policy:
  requiredGates: [{ on: deliver, role: architect, scope: cross-capability }]
  budgets: { maxCostUsdPerThread: 50 }
  terminalAllowList: [npm test, npm run lint, git push]
children:
  - id: payments.retry-engine
    kind: delivery
    repos:
      - { repoId: retry-svc, url: "github.com/org/retry-svc", defaultBase: main, writePolicy: open }
    consumes:
      - { provider: platform.contracts, contract: contracts/payments-v2.yaml }
    policy:
      budgets: { maxCostUsdPerThread: 500, maxTokensPerStep: 80000 }
      terminalAllowList: [npm test, curl]
    components:
      - id: orders-db
        kind: database
        tech: postgres
        status: confirmed
        provenance:
          declared: { by: ashok }
          observed:
            - { extractor: flyway, repo: retry-svc, path: db/migrations, sha: abc123 }
`

const parsed = parseManifest(MANIFEST, 'payments/capability.yaml')
ok('a manifest parses', parsed.issues.length === 0,
   parsed.issues.map((i) => `${i.at}: ${i.problem}`).join('; '))
ok('the inline child is flattened out', parsed.capabilities.length === 2)

const child = parsed.capabilities.find((c) => c.id === 'payments.retry-engine')
// Nesting supplies the parent — not the dotted id, which is convention only.
ok('an inline child takes its parent from the nesting', child?.parent === 'payments')
ok('the child is delivery kind', child?.kind === 'delivery')
ok('its repo is read', child?.repos?.[0]?.repoId === 'retry-svc')
ok('a repo defaults to an open write policy', child?.repos?.[0]?.writePolicy === 'open')
ok('a consumer edge is read', child?.consumes?.[0]?.provider === 'platform.contracts')
ok('a string contract is accepted as a path',
   child?.consumes?.[0]?.contract?.path === 'contracts/payments-v2.yaml')
ok('a component is read with its provenance',
   child?.components?.[0]?.provenance?.observed?.[0]?.extractor === 'flyway')

const root = parsed.capabilities.find((c) => c.id === 'payments')
ok('a root has no parent', root?.parent === undefined)
ok('gates are read', root?.policy?.requiredGates?.[0]?.role === 'architect')

/* ------------------------------------------------------- parse refusals */

const bad = (text: string): string[] =>
  parseManifest(text).issues.map((i) => i.problem)

ok('a node without an id is refused', bad('kind: business').some((p) => p.includes('id')))
ok('an unknown kind is refused',
   bad('id: x\nkind: platform').some((p) => p.includes('business')))
ok('unparseable YAML is refused, not thrown',
   bad('id: [unclosed').some((p) => p.includes('YAML')))
ok('an empty manifest is refused', bad('').some((p) => p.includes('empty')))
ok('an unknown write policy is refused',
   bad('id: x\nkind: delivery\nrepos: [{ repoId: a, writePolicy: sometimes }]')
     .some((p) => p.includes('open')))
ok('a gate missing a role is refused',
   bad('id: x\nkind: business\npolicy: { requiredGates: [{ on: deliver }] }')
     .some((p) => p.includes('role')))
ok('a non-numeric budget is refused',
   bad('id: x\nkind: business\npolicy: { budgets: { maxCostUsdPerThread: lots } }')
     .some((p) => p.includes('number')))
ok('an unknown component kind is refused',
   bad('id: x\nkind: delivery\ncomponents: [{ id: c, kind: spreadsheet }]')
     .some((p) => p.includes('database')))
// A claim nobody confirmed is a proposal; defaulting to confirmed would let the
// manifest assert its own evidence.
ok('a component with no status defaults to proposed',
   parseManifest('id: x\nkind: delivery\ncomponents: [{ id: c, kind: api }]')
     .capabilities[0].components?.[0].status === 'proposed')
// Guessing which of two contradictory parents was meant is worse than refusing.
ok('a child contradicting its nesting is refused',
   bad('id: a\nkind: business\nchildren: [{ id: b, kind: delivery, parent: elsewhere }]')
     .some((p) => p.includes('nested under')))

/* ------------------------------------------------- single ownership */

const forest = forestOf(parsed.capabilities)
const withProvider = forestOf([
  ...parsed.capabilities,
  { id: 'platform', kind: 'business' },
  {
    id: 'platform.contracts',
    kind: 'delivery',
    parent: 'platform',
    repos: [
      { repoId: 'shared-contracts', url: 'u', defaultBase: 'main', writePolicy: 'gated', role: 'lead' }
    ]
  }
])

const clean = validateForest(withProvider)
ok('a well-formed forest validates', clean.valid,
   clean.errors.map((e) => `${e.capabilityId}: ${e.problem}`).join('; '))

// The mistake the spec's example manifest contains on purpose.
const dualOwnership = forestOf([
  ...parsed.capabilities,
  { id: 'platform', kind: 'business' },
  {
    id: 'platform.contracts',
    kind: 'delivery',
    parent: 'platform',
    repos: [{ repoId: 'shared-contracts', url: 'u', defaultBase: 'main', writePolicy: 'gated', role: 'lead' }]
  },
  {
    id: 'payments.other',
    kind: 'delivery',
    parent: 'payments',
    repos: [{ repoId: 'shared-contracts', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' }]
  }
])
const dual = validateForest(dualOwnership)
ok('a repo owned twice is refused', !dual.valid)
// Reported against both, because the fix needs to know who the other one is.
ok('and reported against both claimants',
   dual.errors.filter((e) => e.problem.includes('shared-contracts')).length === 2,
   String(dual.errors.filter((e) => e.problem.includes('shared-contracts')).length))
ok('the refusal says what to do instead',
   dual.errors.some((e) => e.problem.includes('consumer edge')))

/* ------------------------------------------------------ other tree rules */

const invalid = (capabilities: Capability[]): string[] =>
  validateForest(forestOf(capabilities)).errors.map((e) => e.problem)

ok('a missing parent is refused',
   invalid([{ id: 'a', kind: 'delivery', parent: 'ghost' }]).some((p) => p.includes('does not exist')))
ok('a business node owning repos is refused',
   invalid([
     { id: 'a', kind: 'business', repos: [{ repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' }] }
   ]).some((p) => p.includes('governance and rollup')))
ok('a negative budget is refused',
   invalid([{ id: 'a', kind: 'business', policy: { budgets: { maxCostUsdPerThread: -1 } } }])
     .some((p) => p.includes('negative')))
ok('a duplicate repo within one node is refused',
   invalid([
     {
       id: 'a',
       kind: 'delivery',
       repos: [
         { repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' },
         { repoId: 'r', url: 'u2', defaultBase: 'main', writePolicy: 'open', role: 'member' }
       ]
     }
   ]).some((p) => p.includes('twice')))
ok('a consumer edge to a non-capability is refused',
   invalid([{ id: 'a', kind: 'delivery', consumes: [{ provider: 'nowhere' }] }])
     .some((p) => p.includes('not a capability')))
ok('consuming from yourself is refused',
   invalid([{ id: 'a', kind: 'delivery', consumes: [{ provider: 'a' }] }])
     .some((p) => p.includes('itself')))

// Ownership is a tree; a cycle in it is not recoverable.
const cyclic = forestOf([
  { id: 'a', kind: 'business', parent: 'b' },
  { id: 'b', kind: 'business', parent: 'a' }
])
ok('a parent cycle is refused', !validateForest(cyclic).valid)
ok('and ancestry refuses to answer rather than truncating',
   ancestryOf(cyclic, 'a') === null)

// Usage is a graph. Cycles there are legal and must not be reported.
const mutualConsumers = forestOf([
  { id: 'a', kind: 'delivery', consumes: [{ provider: 'b' }] },
  { id: 'b', kind: 'delivery', consumes: [{ provider: 'a' }] }
])
ok('a cycle in the consumer graph is legal', validateForest(mutualConsumers).valid,
   validateForest(mutualConsumers).errors.map((e) => e.problem).join('; '))

/* --------------------------------------------- components: elicit, not fail */

const proposedComponent = forestOf([
  { id: 'p', kind: 'delivery', components: [{ id: 'api-v2', kind: 'api', status: 'proposed' }] },
  { id: 'c', kind: 'delivery', consumes: [{ provider: 'p', component: 'api-v2' }] }
])
const proposedResult = validateForest(proposedComponent)
// Reporting this as a failure would push people to confirm components purely to
// quiet the validator, which is how a governance record becomes fiction.
ok('referencing a proposed component does not fail', proposedResult.valid)
ok('it elicits instead', proposedResult.elicitations.length === 1)
ok('and the question names the component',
   proposedResult.elicitations[0].question.includes('api-v2'))

const confirmedComponent = forestOf([
  { id: 'p', kind: 'delivery', components: [{ id: 'api-v2', kind: 'api', status: 'confirmed' }] },
  { id: 'c', kind: 'delivery', consumes: [{ provider: 'p', component: 'api-v2' }] }
])
ok('referencing a confirmed component elicits nothing',
   validateForest(confirmedComponent).elicitations.length === 0)
ok('referencing a component the provider never declares is an error',
   invalid([
     { id: 'p', kind: 'delivery' },
     { id: 'c', kind: 'delivery', consumes: [{ provider: 'p', component: 'ghost' }] }
   ]).some((x) => x.includes('does not declare')))

/* --------------------------------------------------------- the fold */

const resolved = resolvePolicy(withProvider, 'payments.retry-engine')!

ok('resolution walks the whole path', resolved.ancestry.join('>') === 'payments>payments.retry-engine')
// The four operations, each asserted as the one the spec names.
ok('gates union upward', resolved.requiredGates.some((g) => g.role === 'architect'))
// The child asked for 500 and the parent allows 50.
ok('budgets take the elementwise minimum', resolved.budgets.maxCostUsdPerThread === 50,
   String(resolved.budgets.maxCostUsdPerThread))
ok('a budget only the child sets still applies', resolved.budgets.maxTokensPerStep === 80_000)
ok('allowlists intersect',
   JSON.stringify(resolved.terminalAllowList) === JSON.stringify(['npm test']),
   JSON.stringify(resolved.terminalAllowList))
// `curl` was in the child's list and never in the parent's.
ok('a child cannot add a command the parent never permitted',
   !resolved.terminalAllowList?.includes('curl'))
ok('the path is denormalized at resolve time',
   resolved.capabilityPath === 'payments / payments.retry-engine', resolved.capabilityPath)

ok('a gate is traceable to where it was declared',
   explainGate(withProvider, 'payments.retry-engine', resolved.requiredGates[0]) === 'payments')

// Absent and empty must stay distinguishable: absent is unrestricted, empty
// permits nothing.
const noList = resolvePolicy(forestOf([{ id: 'a', kind: 'business' }]), 'a')!
ok('no allow-list anywhere means unrestricted', noList.terminalAllowList === undefined)
const emptyList = resolvePolicy(
  forestOf([{ id: 'a', kind: 'business', policy: { terminalAllowList: [] } }]),
  'a'
)!
ok('an empty declared list is not the same as none',
   emptyList.terminalAllowList === undefined || emptyList.terminalAllowList.length === 0)

ok('the same gate declared twice yields one gate',
   foldFragment(
     { requiredGates: [{ on: 'deliver', role: 'architect' }], constraints: [], budgets: {} },
     { requiredGates: [{ on: 'deliver', role: 'architect' }] }
   ).requiredGates.length === 1)

ok('resolving an unknown capability returns null', resolvePolicy(withProvider, 'nope') === null)
ok('resolving inside a cycle returns null', resolvePolicy(cyclic, 'a') === null)

/* ------------------------------------------- monotonicity, as a property */

// Asserted over every node rather than as a case: a child that can end up looser
// than its parent means one of the four operations is wrong, which is worse than
// any single bad manifest.
const loosening = forestOf([
  {
    id: 'root',
    kind: 'business',
    policy: {
      requiredGates: [{ on: 'deliver', role: 'architect' }],
      budgets: { maxCostUsdPerThread: 10, maxTokensPerStep: 1000 },
      terminalAllowList: ['npm test']
    }
  },
  {
    id: 'child',
    kind: 'delivery',
    parent: 'root',
    // Every field here is an attempt to loosen.
    policy: {
      budgets: { maxCostUsdPerThread: 10_000, maxTokensPerStep: 999_999 },
      terminalAllowList: ['npm test', 'rm -rf /']
    }
  }
])
ok('no node in the forest is looser than its parent',
   monotonicityViolations(loosening).length === 0,
   monotonicityViolations(loosening).join(','))

const loosened = resolvePolicy(loosening, 'child')!
const tightener = resolvePolicy(loosening, 'root')!
ok('an attempt to raise a budget is ignored', loosened.budgets.maxCostUsdPerThread === 10)
ok('an attempt to widen an allow-list is ignored',
   !loosened.terminalAllowList?.includes('rm -rf /'))
ok('an ancestor gate cannot be dropped', loosened.requiredGates.length === 1)
ok('the tightness predicate agrees', isAtLeastAsTight(loosened, tightener))
// And it must be able to detect the violation it exists to rule out, or "zero
// violations" means nothing.
ok('the predicate detects a genuinely looser policy',
   !isAtLeastAsTight(tightener, { ...tightener, budgets: { maxCostUsdPerThread: 5 } }))

/* ----------------------------------- parent is authoritative, id is decoration */

// The ids say one thing and the parent links say another. Every ancestry answer
// must follow the links.
const misleading = forestOf([
  { id: 'platform', kind: 'business' },
  { id: 'payments', kind: 'business' },
  // Reads like it belongs to payments; actually parented under platform.
  { id: 'payments.retry-engine', kind: 'delivery', parent: 'platform' }
])
ok('ancestry follows parent, not the dotted id',
   ancestryOf(misleading, 'payments.retry-engine')?.join('>') === 'platform>payments.retry-engine')
ok('the path follows parent too',
   pathOf(misleading, 'payments.retry-engine') === 'platform / payments.retry-engine')
ok('depth follows parent', depthOf(misleading, 'payments.retry-engine') === 1)
ok('roots are those with no parent', rootsOf(misleading).length === 2)

/* ------------------------------------ coordination cost = LCA depth (§4) */

const org = forestOf([
  { id: 'org', kind: 'business' },
  { id: 'org.payments', kind: 'business', parent: 'org' },
  { id: 'org.payments.retry', kind: 'delivery', parent: 'org.payments' },
  { id: 'org.payments.ledger', kind: 'delivery', parent: 'org.payments' },
  { id: 'org.platform', kind: 'business', parent: 'org' },
  { id: 'org.platform.contracts', kind: 'delivery', parent: 'org.platform' }
])

const siblings = lowestCommonAncestor(org, ['org.payments.retry', 'org.payments.ledger'])
ok('sibling changes share a deep ancestor', siblings.id === 'org.payments' && siblings.depth === 1,
   `${siblings.id}@${siblings.depth}`)
const crossSubtree = lowestCommonAncestor(org, ['org.payments.retry', 'org.platform.contracts'])
// The case that warrants an architect gate: they meet only at the root.
ok('cross-subtree changes meet nearer the root',
   crossSubtree.id === 'org' && crossSubtree.depth === 0, `${crossSubtree.id}@${crossSubtree.depth}`)
ok('coordination cost orders the two correctly',
   (crossSubtree.depth ?? 9) < (siblings.depth ?? 0))
ok('one capability is its own ancestor',
   lowestCommonAncestor(org, ['org.payments.retry']).id === 'org.payments.retry')
// Different roots have no common ancestor, which is stronger than "the root".
ok('capabilities in different forests have no common ancestor',
   lowestCommonAncestor(forestOf([
     { id: 'a', kind: 'business' },
     { id: 'b', kind: 'business' }
   ]), ['a', 'b']).id === null)

/* ------------------------------------------- handing off to the kernel */

// What crosses into the session layer is flat: a SessionPolicy the M1 gate
// already enforces, plus an id. Nothing below this line knows a tree exists.
const governed = forestOf([
  {
    id: 'root',
    kind: 'business',
    policy: {
      terminalAllowList: ['npm test'],
      constraints: [
        {
          id: 'no-schema',
          forbids: 'writes',
          selector: { kind: 'db.schema' },
          text: 'do not modify the database schema',
          at: 0
        }
      ]
    }
  },
  { id: 'leaf', kind: 'delivery', parent: 'root' }
])

const sessionPolicy = toSessionPolicy(resolvePolicy(governed, 'leaf')!, 'verify')
ok('the resolved policy becomes a SessionPolicy', sessionPolicy.mode === 'verify')
ok('the allow-list carries through',
   JSON.stringify(sessionPolicy.commandAllowList) === JSON.stringify(['npm test']))
ok('an inherited constraint becomes a forbidden write path',
   (sessionPolicy.forbiddenWrites ?? []).includes('**/migrations/**'))

// And the M1 gate enforces it, unchanged — the point of resolving host-side.
const migrationWrite = classify('fs/write_text_file', { path: '/repo/db/migrations/1.sql' })!
ok('the gate refuses a write an ancestor forbade',
   decide({ ...sessionPolicy, grants: [{ toolClass: 'fs.write', scope: 'always' }] }, migrationWrite)
     .kind === 'deny')
const sourceWrite = classify('fs/write_text_file', { path: '/repo/src/a.ts' })!
ok('and permits an unrelated one',
   decide({ ...sessionPolicy, grants: [{ toolClass: 'fs.write', scope: 'always' }] }, sourceWrite)
     .kind === 'allow')
ok('a command outside the inherited list is refused',
   decide(sessionPolicy, classify('terminal/create', { command: 'curl', args: ['x'] })!).kind ===
     'deny')

/* ------------------------------------------------ lazy materialization */

// Repos alone must not trigger a ledger, or this becomes one repo per box on the
// EA map — the thing §3 and §10 exist to prevent.
ok('owning a repo alone does not require materialization',
   pendingMaterialization(forestOf([
     { id: 'a', kind: 'delivery', repos: [{ repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' }] }
   ])).length === 0)
ok('a budget allocation does require it',
   pendingMaterialization(forestOf([
     { id: 'a', kind: 'business', policy: { budgets: { maxCostUsdPerThread: 5 } } }
   ])).includes('a'))
ok('a gate requires it too',
   pendingMaterialization(forestOf([
     { id: 'a', kind: 'business', policy: { requiredGates: [{ on: 'deliver', role: 'x' }] } }
   ])).includes('a'))
ok('a node that already has a ledger is not pending',
   pendingMaterialization(forestOf([
     {
       id: 'a',
       kind: 'business',
       ledger: { kind: 'repo', url: 'u' },
       policy: { budgets: { maxCostUsdPerThread: 5 } }
     }
   ])).length === 0)

// An imported EA map is mostly empty nodes on day one. Surfaced, never refused —
// onboarding is an import, not a modeling workshop.
ok('empty nodes are surfaced, not rejected', emptyNodes(org).length > 0)
ok('and an all-empty import still validates',
   validateForest(forestOf([
     { id: 'a', kind: 'business' },
     { id: 'a.b', kind: 'business', parent: 'a' }
   ])).valid)

/* --------------------------------------- several manifests, one forest */

const multi = parseManifests([
  { text: 'id: root\nkind: business\nchildren: [{ id: leaf, kind: delivery }]', source: 'root.yaml' },
  // The same node, now materialized with its own ledger.
  { text: 'id: leaf\nkind: delivery\nparent: root\nledger: { url: "github.com/org/leaf-ledger" }', source: 'leaf.yaml' }
])
ok('manifests merge into one forest', multi.forest.byId.size === 2)
// During materialization a node is legitimately in both places; the one with the
// ledger is the real one.
const leafLedger = multi.forest.byId.get('leaf')?.ledger
ok('the materialized copy wins over the inline stanza',
   leafLedger?.kind === 'repo' && leafLedger.url.includes('leaf-ledger'))
ok('and merging reports no drift when they agree',
   multi.issues.filter((i) => i.problem.includes('drifted')).length === 0,
   multi.issues.map((i) => i.problem).join('; '))

const drifted = parseManifests([
  { text: 'id: root\nkind: business\nchildren: [{ id: leaf, kind: delivery }]' },
  { text: 'id: leaf\nkind: business\nparent: root\nledger: { url: u }' }
])
ok('a drifted inline copy is reported',
   drifted.issues.some((i) => i.problem.includes('drifted')))

/* ------------------------------------------------- loading from disk */

// The pure core has no idea a filesystem exists; load.ts is the only file in the
// directory that does. Tested here so that separation stays real rather than
// being a claim in a comment.
const dir = mkdtempSync(join(tmpdir(), 'eh-cap-'))
mkdirSync(join(dir, 'a-ledger'), { recursive: true })
mkdirSync(join(dir, 'nested', 'b-ledger'), { recursive: true })
mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
writeFileSync(
  join(dir, 'a-ledger', 'capability.yaml'),
  'id: a\nkind: business\nledger: { url: u }\nchildren: [{ id: a.svc, kind: delivery }]'
)
writeFileSync(
  join(dir, 'nested', 'b-ledger', 'capability.yaml'),
  'id: b\nkind: business\nledger: { url: u }'
)
// A manifest inside node_modules is someone else's package, not our forest.
writeFileSync(join(dir, 'node_modules', 'pkg', 'capability.yaml'), 'id: nope\nkind: business')

const loaded = await loadForest(dir)
ok('manifests are discovered by walking', loaded.sources.length === 2, loaded.sources.join(', '))
ok('nested ledgers are found', loaded.forest.byId.has('b'))
ok('inline children come along', loaded.forest.byId.has('a.svc'))
ok('node_modules is not walked', !loaded.forest.byId.has('nope'))
ok('the loaded forest validates', validateForest(loaded.forest).valid)

// A caller pointing at one ledger repo usually means that one manifest.
const single = await loadForest(join(dir, 'a-ledger', 'capability.yaml'))
ok('a single manifest can be named directly', single.forest.byId.size === 2)

const missing = await loadForest(join(dir, 'nowhere'))
ok('a missing directory reports rather than throws',
   missing.issues.some((i) => i.problem.includes('no such directory')))
ok('and yields an empty forest', missing.forest.byId.size === 0)

const emptyDir = mkdtempSync(join(tmpdir(), 'eh-cap-empty-'))
ok('a directory with no manifests is not an error',
   (await loadForest(emptyDir)).issues.length === 0)

/* ============================ spec v1 delta ============================== */

/* ------------------------------------------------------------ repo roles */

const repoRoles = (yaml: string): Array<{ repoId: string; role: string }> =>
  (parseManifest(yaml).capabilities[0]?.repos ?? []).map((r) => ({ repoId: r.repoId, role: r.role }))

const ONE_REPO = 'id: x\nkind: delivery\nrepos: [{ repoId: a, url: u }]'
ok('a single repo with no role is the lead', repoRoles(ONE_REPO)[0]?.role === 'lead',
   JSON.stringify(repoRoles(ONE_REPO)))
// Over-eager inference would silently choose where the ledger lives.
ok('two repos with no roles get no inferred lead',
   repoRoles('id: x\nkind: delivery\nrepos: [{ repoId: a, url: u }, { repoId: b, url: u }]')
     .every((r) => r.role === 'member'))
// The raw-vs-pushed length trap: one malformed sibling must not promote the survivor.
ok('a repo skipped for being malformed does not promote its sibling to lead',
   repoRoles('id: x\nkind: delivery\nrepos: [{ repoId: a, url: u }, { url: no-id }]')
     .every((r) => r.role === 'member'),
   JSON.stringify(repoRoles('id: x\nkind: delivery\nrepos: [{ repoId: a, url: u }, { url: no-id }]')))
ok('a declared member stays a member',
   repoRoles('id: x\nkind: delivery\nrepos: [{ repoId: a, url: u, role: member }]')[0]?.role ===
     'member')
ok('an explicit lead is kept',
   repoRoles('id: x\nkind: delivery\nrepos: [{ repoId: a, url: u, role: lead }, { repoId: b, url: u }]')
     .filter((r) => r.role === 'lead').length === 1)
// Coercing `role: leed` to member would make the resulting error point at the wrong thing.
ok('an unknown repo role is refused',
   bad('id: x\nkind: delivery\nrepos: [{ repoId: a, url: u, role: leed }]')
     .some((p) => p.includes('lead')))

const leadErrors = (caps: Capability[]): string[] => invalid(caps)
const twoRepos = (roles: Array<'lead' | 'member'>): Capability[] => [
  {
    id: 'd',
    kind: 'delivery',
    repos: roles.map((role, i) => ({
      repoId: `r${i}`,
      url: 'u',
      defaultBase: 'main',
      writePolicy: 'open' as const,
      role
    }))
  }
]

ok('a delivery node with two repos and no lead is refused',
   leadErrors(twoRepos(['member', 'member'])).some((p) => p.includes('names no lead')))
ok('the refusal names the candidate repos',
   leadErrors(twoRepos(['member', 'member'])).some((p) => p.includes('r0, r1')))
ok('two leads in one capability is refused',
   leadErrors(twoRepos(['lead', 'lead'])).some((p) => p.includes('2 leads')))
ok('and the refusal names both claimants',
   leadErrors(twoRepos(['lead', 'lead'])).some((p) => p.includes('r0, r1')))
ok('exactly one lead validates', leadErrors(twoRepos(['lead', 'member'])).length === 0,
   leadErrors(twoRepos(['lead', 'member'])).join('; '))
// The regression guard that matters most: repo-less delivery nodes are legal and
// common, and an unscoped rule would fail most of the fixtures above.
ok('a delivery node with no repos needs no lead',
   leadErrors([{ id: 'd', kind: 'delivery' }]).length === 0)
ok('a business node with repos is not also told about leads',
   invalid([
     {
       id: 'b',
       kind: 'business',
       repos: [{ repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'member' }]
     }
   ]).filter((p) => p.includes('lead')).length === 0)

/* ---------------------------------------------------------- ledger union */

const ledgerOf = (yaml: string): unknown => parseManifest(yaml).capabilities[0]?.ledger

ok('a flat ledger parses as a repo ledger',
   JSON.stringify(ledgerOf('id: x\nkind: business\nledger: { url: "u" }')) ===
     JSON.stringify({ kind: 'repo', url: 'u' }))
ok('a flat ledger keeps its defaultBase',
   JSON.stringify(ledgerOf('id: x\nkind: business\nledger: { url: "u", defaultBase: trunk }')).includes('trunk'))
// Previously `{}` yielded url:'' — materialized while pointing nowhere.
ok('an empty ledger block is refused',
   bad('id: x\nkind: business\nledger: {}').some((p) => p.includes('kind: sidecar')))
ok('a sidecar ledger defaults its ref',
   JSON.stringify(ledgerOf('id: x\nkind: delivery\nledger: { kind: sidecar, repo: a }')) ===
     JSON.stringify({ kind: 'sidecar', repo: 'a', ref: SIDECAR_LEDGER_REF }))
ok('a sidecar ledger with a different ref is refused',
   bad('id: x\nkind: delivery\nledger: { kind: sidecar, repo: a, ref: refs/heads/other }')
     .some((p) => p.includes(SIDECAR_LEDGER_REF)))
ok('a sidecar with no repo is refused',
   bad('id: x\nkind: delivery\nledger: { kind: sidecar }').some((p) => p.includes('needs a repo')))
// The trap the migration design itself creates: absent kind means legacy, so a
// typo could fall through into {kind:'repo', url:''}.
ok('an unknown ledger kind is refused',
   bad('id: x\nkind: delivery\nledger: { kind: sidecart, repo: a }')
     .some((p) => p.includes('"sidecar" or "repo"')))
ok('and it does not silently become a repo ledger',
   ledgerOf('id: x\nkind: delivery\nledger: { kind: sidecart, repo: a }') === undefined)

const sidecar = (repo: string, roles: Array<'lead' | 'member'>): Capability[] => [
  {
    id: 'd',
    kind: 'delivery',
    ledger: { kind: 'sidecar', repo, ref: SIDECAR_LEDGER_REF },
    repos: roles.map((role, i) => ({
      repoId: `r${i}`,
      url: 'u',
      defaultBase: 'main',
      writePolicy: 'open' as const,
      role
    }))
  }
]

ok('a sidecar in a repo the capability does not own is refused',
   invalid(sidecar('elsewhere', ['lead'])).some((p) => p.includes('does not own')))
ok('and the refusal cites single ownership',
   invalid(sidecar('elsewhere', ['lead'])).some((p) => p.includes('single ownership')))
// Without this, `role: lead` would be decorative.
ok('a sidecar in a member repo is refused',
   invalid(sidecar('r1', ['lead', 'member'])).some((p) => p.includes('the lead is "r0"')))
ok('and it offers both fixes',
   invalid(sidecar('r1', ['lead', 'member'])).some((p) => p.includes('move role: lead')))
ok('a sidecar in the lead repo validates', invalid(sidecar('r0', ['lead'])).length === 0,
   invalid(sidecar('r0', ['lead'])).join('; '))

ok('a business node with a sidecar ledger is refused',
   invalid([{ id: 'b', kind: 'business', ledger: { kind: 'sidecar', repo: 'r', ref: SIDECAR_LEDGER_REF } }])
     .some((p) => p.includes('owns no repo')))
ok('and it is told to use a standalone repo',
   invalid([{ id: 'b', kind: 'business', ledger: { kind: 'sidecar', repo: 'r', ref: SIDECAR_LEDGER_REF } }])
     .some((p) => p.includes('kind: repo')))
ok('and it is not also told it does not own the repo',
   invalid([{ id: 'b', kind: 'business', ledger: { kind: 'sidecar', repo: 'r', ref: SIDECAR_LEDGER_REF } }])
     .filter((p) => p.includes('does not own')).length === 0)

// Back-compat, pinned so tightening it later is deliberate.
const legacyDelivery = forestOf([
  { id: 'd', kind: 'delivery', ledger: { kind: 'repo', url: 'u' } }
])
ok('a delivery node with a standalone ledger repo elicits rather than fails',
   validateForest(legacyDelivery).elicitations.some((e) => e.about === 'ledger placement'))
ok('and the forest still validates', validateForest(legacyDelivery).valid)

ok('a node with a sidecar ledger is not pending materialization',
   pendingMaterialization(forestOf([
     {
       id: 'd',
       kind: 'delivery',
       ledger: { kind: 'sidecar', repo: 'r0', ref: SIDECAR_LEDGER_REF },
       repos: [{ repoId: 'r0', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' }],
       policy: { budgets: { maxCostUsdPerThread: 5 } }
     }
   ])).length === 0)

/* --------------------------------------- knowledge, contacts, tracker */

const KNOW = `
id: x
kind: delivery
knowledge:
  - { kind: design, title: Design note, url: "https://wiki/x", tags: [design, current], verifiedAt: 2026-07-01 }
contacts:
  - { actorId: ashok, role: architect }
tracker: { system: jira, projectKey: PZN }
`
const known = parseManifest(KNOW)
ok('knowledge, contacts and tracker parse', known.issues.length === 0,
   known.issues.map((i) => i.problem).join('; '))
ok('a knowledge ref keeps its tags',
   JSON.stringify(known.capabilities[0].knowledge?.[0].tags) === JSON.stringify(['design', 'current']))
ok('a tracker parses', known.capabilities[0].tracker?.projectKey === 'PZN')
ok('a contact parses', known.capabilities[0].contacts?.[0].role === 'architect')

ok('a knowledge ref with no url is refused',
   bad('id: x\nkind: delivery\nknowledge: [{ kind: adr, title: T }]').some((p) => p.includes('url')))
ok('a knowledge ref with no kind defaults to other',
   parseManifest('id: x\nkind: delivery\nknowledge: [{ title: T, url: u }]')
     .capabilities[0].knowledge?.[0].kind === 'other')
// With `other` in the enum, coercion would silently rot the taxonomy tags depend on.
ok('an unknown knowledge kind is refused',
   bad('id: x\nkind: delivery\nknowledge: [{ kind: runbok, title: T, url: u }]')
     .some((p) => p.includes('runbook')))
ok('a malformed verifiedAt is refused',
   bad('id: x\nkind: delivery\nknowledge: [{ title: T, url: u, verifiedAt: last tuesday }]')
     .some((p) => p.includes('YYYY-MM-DD')))
ok('a contact needs both fields',
   bad('id: x\nkind: delivery\ncontacts: [{ actorId: ashok }]').some((p) => p.includes('role')))
ok('an unknown tracker system is refused',
   bad('id: x\nkind: delivery\ntracker: { system: linear, projectKey: X }')
     .some((p) => p.includes('jira')))

// One person legitimately holds two roles; dedupe is on the pair.
ok('the same actor in two roles is legal',
   invalid([{ id: 'x', kind: 'delivery', contacts: [
     { actorId: 'a', role: 'architect' }, { actorId: 'a', role: 'deliver' }] }]).length === 0)
ok('the same actor and role twice is refused',
   invalid([{ id: 'x', kind: 'delivery', contacts: [
     { actorId: 'a', role: 'architect' }, { actorId: 'a', role: 'architect' }] }])
     .some((p) => p.includes('twice as architect')))

ok('a node with only knowledge is not empty',
   !emptyNodes(forestOf([
     { id: 'x', kind: 'delivery', knowledge: [{ kind: 'wiki', title: 'T', url: 'u' }] }
   ])).includes('x'))
// A wiki link is not governance.
ok('a node with only knowledge does not need a ledger',
   pendingMaterialization(forestOf([
     { id: 'x', kind: 'delivery', knowledge: [{ kind: 'wiki', title: 'T', url: 'u' }] }
   ])).length === 0)

/* ------------------------------------------- gate satisfiability (R18) */

const gated = (contacts: Array<{ actorId: string; role: string }>, at: 'root' | 'leaf'): CapabilityForest =>
  forestOf([
    {
      id: 'root',
      kind: 'business',
      ...(at === 'root' ? { contacts } : {})
    },
    {
      id: 'leaf',
      kind: 'delivery',
      parent: 'root',
      policy: { requiredGates: [{ on: 'deliver', role: 'architect' }] },
      ...(at === 'leaf' ? { contacts } : {})
    }
  ])

const unsatisfiable = validateForest(gated([], 'leaf'))
ok('a gate no contact can satisfy elicits',
   unsatisfiable.elicitations.some((e) => e.about === 'gate deliver/architect'))
// Warn, not fail: failing would push people to add placeholder contacts.
ok('and the forest still validates', unsatisfiable.valid)
ok('the question names the path',
   unsatisfiable.elicitations.some((e) => e.question.includes('root / leaf')))
ok('a contact on the node satisfies its own gate',
   validateForest(gated([{ actorId: 'a', role: 'architect' }], 'leaf'))
     .elicitations.filter((e) => e.about.startsWith('gate')).length === 0)
// Inherited authority counts — the whole point of resolving along the path.
ok('a contact on an ancestor satisfies a descendant gate',
   validateForest(gated([{ actorId: 'a', role: 'architect' }], 'root'))
     .elicitations.filter((e) => e.about.startsWith('gate')).length === 0)

/* ---------------------------------------------------------- pointer files */

const POINTER = 'pointer: capability\ncapability: payments.retry\nrepoId: retry-svc'
const pointerParsed = parseManifest(POINTER, '.singularity/capability.yaml')

// The phantom-duplicate failure.
ok('a pointer file yields no capability', pointerParsed.capabilities.length === 0)
ok('a pointer is returned as a pointer', pointerParsed.pointers.length === 1)
// Optional-chained on purpose: when the classification breaks, this should
// report a named failure rather than crashing the harness before the results.
ok('with its back-reference', pointerParsed.pointers[0]?.capability === 'payments.retry')
// Classification by absent `kind` would emit "missing kind" here.
ok('a pointer is not reported as a broken manifest', pointerParsed.issues.length === 0,
   pointerParsed.issues.map((i) => i.problem).join('; '))
// The negative control: a positive marker must not swallow broken manifests.
ok('a manifest missing kind is still refused as a manifest',
   bad('id: x').some((p) => p.includes('kind must be')))
ok('a file that is both pointer and manifest is refused',
   bad('pointer: capability\ncapability: c\nrepoId: r\nkind: delivery')
     .some((p) => p.includes('one or the other')))
ok('a pointer with no repoId is refused',
   bad('pointer: capability\ncapability: c').some((p) => p.includes('repoId')))
ok('an unknown pointer value is refused',
   bad('pointer: something\ncapability: c\nrepoId: r').some((p) => p.includes('"capability"')))

const withLead = forestOf([
  {
    id: 'payments.retry',
    kind: 'delivery',
    repos: [
      { repoId: 'retry-svc', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' },
      { repoId: 'retry-web', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'member' }
    ]
  }
])

ok('a pointer at a member repo reconciles clean',
   reconcilePointers(withLead, [{ capability: 'payments.retry', repoId: 'retry-web' }]).length === 0)
// Ties pointers back to roles: the lead carries the manifest, not a pointer.
ok('a pointer at the lead repo is reported',
   reconcilePointers(withLead, [{ capability: 'payments.retry', repoId: 'retry-svc' }])[0]?.kind ===
     'points-at-lead')
ok('a pointer file contributes nothing to the forest',
   parseManifests([{ text: POINTER }]).forest.byId.size === 0)
ok('a stale pointer repoId is reported',
   reconcilePointers(withLead, [{ capability: 'payments.retry', repoId: 'gone' }])[0]?.kind ===
     'unknown-repo')
// A partial scan must not read as a broken pointer.
ok('a pointer to an unknown capability is informational',
   reconcilePointers(withLead, [{ capability: 'nope', repoId: 'r' }])[0]?.kind ===
     'unknown-capability')
// Single ownership from the repo side — invisible to the manifest-side rule when
// one of the two manifests was never scanned.
ok('two pointers claiming one repo for different capabilities is reported',
   reconcilePointers(withLead, [
     { capability: 'payments.retry', repoId: 'shared' },
     { capability: 'other', repoId: 'shared' }
   ]).filter((f) => f.kind === 'repo-claimed-elsewhere').length === 2)
// The factoring assertion: validity must not depend on scan completeness.
ok('validateForest never depends on pointers',
   validateForest(withLead).valid === validateForest(withLead).valid &&
     validateForest(withLead).elicitations.length ===
       validateForest(forestOf([...withLead.byId.values()])).elicitations.length)

/* --------------------------------------------- the loader finds pointers */

const pdir = mkdtempSync(join(tmpdir(), 'eh-ptr-'))
mkdirSync(join(pdir, 'lead-repo'), { recursive: true })
mkdirSync(join(pdir, 'member-repo', '.singularity'), { recursive: true })
mkdirSync(join(pdir, 'member-repo', '.git'), { recursive: true })
writeFileSync(
  join(pdir, 'lead-repo', 'capability.yaml'),
  'id: d\nkind: delivery\nledger: { kind: sidecar, repo: lead }\n' +
    'repos: [{ repoId: lead, url: u, role: lead }, { repoId: member, url: u }]'
)
writeFileSync(
  join(pdir, 'member-repo', '.singularity', 'capability.yaml'),
  'pointer: capability\ncapability: d\nrepoId: member'
)
// A manifest inside .git must still be invisible.
writeFileSync(join(pdir, 'member-repo', '.git', 'capability.yaml'), 'id: ghost\nkind: business')

const withPointers = await loadForest(pdir)
// The load.ts:57 finding — a silent no-op without the exception.
ok('.singularity is walked into', withPointers.pointers.length === 1,
   JSON.stringify(withPointers.pointerSources))
ok('other dot directories are still skipped', !withPointers.forest.byId.has('ghost'))
ok('pointers are counted apart from manifests',
   withPointers.sources.length === 1 && withPointers.pointerSources.length === 1,
   `${withPointers.sources.length}/${withPointers.pointerSources.length}`)
ok('the pointer creates no phantom capability', withPointers.forest.byId.size === 1)
ok('and the loaded forest validates', validateForest(withPointers.forest).valid,
   validateForest(withPointers.forest).errors.map((e) => e.problem).join('; '))
ok('the member pointer reconciles clean',
   reconcilePointers(withPointers.forest, withPointers.pointers).length === 0)

/* ------------------------------------------- the Navigator's read model */

// §7.0: every pane is a pure function of (projection state, route). So the
// projection is fixture-testable without a window, and that is asserted here
// rather than assumed.
const viewForest = forestOf([
  {
    id: 'digital',
    kind: 'business',
    ledger: { kind: 'repo', url: 'github.com/org/digital-ledger' },
    contacts: [{ actorId: 'ashok', role: 'architect' }],
    policy: {
      requiredGates: [{ on: 'deliver', role: 'architect' }],
      budgets: { maxCostUsdPerThread: 50 },
      terminalAllowList: ['npm test', 'npm run lint']
    }
  },
  {
    id: 'digital.sel',
    kind: 'delivery',
    parent: 'digital',
    ledger: { kind: 'sidecar', repo: 'sel-svc', ref: SIDECAR_LEDGER_REF },
    repos: [
      { repoId: 'sel-svc', url: 'u', defaultBase: 'main', writePolicy: 'open', role: 'lead' },
      { repoId: 'sel-web', url: 'u', defaultBase: 'main', writePolicy: 'gated', role: 'member' }
    ],
    components: [{ id: 'sel-db', kind: 'database', status: 'proposed' }],
    knowledge: [{ kind: 'design', title: 'Note', url: 'https://w/x', verifiedAt: '2020-01-01' }],
    policy: {
      budgets: { maxCostUsdPerThread: 500 },
      terminalAllowList: ['npm test', 'curl'],
      // A constraint selecting a still-proposed component: the moment it becomes
      // load-bearing, §2 says elicit rather than fail.
      constraints: [
        {
          id: 'no-sel-db',
          forbids: 'writes',
          selector: { kind: 'db.schema', component: 'sel-db' } as never,
          text: 'do not touch the selector schema',
          at: 0
        }
      ]
    }
  }
])

const view = buildCapabilityView(
  '/tmp/root',
  viewForest,
  [{ capability: 'digital.sel', repoId: 'sel-web' }],
  [],
  ['digital/capability.yaml'],
  ['sel-web/.singularity/capability.yaml']
)

const leaf = view.nodes.find((n) => n.id === 'digital.sel')!
ok('the view is ordered depth-first from the roots',
   view.nodes.map((n) => n.id).join('>') === 'digital>digital.sel',
   view.nodes.map((n) => n.id).join('>'))
ok('depth is precomputed so the renderer only indents', leaf.depth === 1)
ok('the ledger renders as a label', leaf.ledger?.label === 'sel-svc · singularity/ledger')
ok('a business ledger renders its url',
   view.nodes[0].ledger?.kind === 'repo' && view.nodes[0].ledger.label.includes('digital-ledger'))
ok('the lead repo is identified', leaf.leadRepoId === 'sel-svc')

// §7.1/§7.5: policy rows always carry provenance.
ok('an inherited gate names the ancestor that declared it',
   leaf.policy?.gates[0]?.from === 'digital', leaf.policy?.gates[0]?.from)
ok('the budget is the minimum along the path',
   leaf.policy?.budgets.find((b) => b.field === 'maxCostUsdPerThread')?.value === 50)
// "min of digital $50, pzn $40" — a surprising number stays explicable.
ok('and it lists every ancestor that declared that field',
   leaf.policy?.budgets.find((b) => b.field === 'maxCostUsdPerThread')?.from.join(',') ===
     'digital,digital.sel')
ok('the allow-list is the intersection',
   JSON.stringify(leaf.policy?.terminalAllowList) === JSON.stringify(['npm test']))
ok('and names where it was intersected from',
   leaf.policy?.allowListFrom.join(',') === 'digital,digital.sel')

ok('a component carries its status for a chip', leaf.components[0]?.status === 'proposed')
// Declaration and observation are different tiers (§2) and must be tellable apart.
ok('a component with no observation shows none', leaf.components[0]?.observedBy.length === 0)
// Nags, never garbage-collects (§7.5).
ok('an old knowledge link is flagged stale', leaf.knowledge[0]?.stale === true)
ok('a recent one is not',
   buildCapabilityView('/r', forestOf([
     { id: 'x', kind: 'delivery',
       knowledge: [{ kind: 'wiki', title: 'T', url: 'u',
         verifiedAt: new Date().toISOString().slice(0, 10) }] }
   ]), [], [], [], []).nodes[0].knowledge[0].stale === false)

ok('a pointer at a member repo produces no finding', leaf.pointerFindings.length === 0)
ok('an unmaterialized node says so',
   buildCapabilityView('/r', forestOf([
     { id: 'x', kind: 'business', policy: { budgets: { maxCostUsdPerThread: 5 } } }
   ]), [], [], [], []).nodes[0].warnings.some((w) => w.includes('not yet materialized')))
// Elicitations reach the UI as questions and must not make the view invalid —
// a constraint selecting a proposed component is a question, not a failure.
ok('a question surfaces on the node it concerns', leaf.questions.length === 1,
   `${leaf.questions.length}`)
ok('and it does not invalidate the view', view.valid)
ok('a satisfiable gate raises no question',
   !leaf.questions.some((q) => q.includes('cannot be satisfied')))
// The one that would fire if nobody held the role.
ok('an unsatisfiable gate does raise one',
   buildCapabilityView('/r', forestOf([
     { id: 'g', kind: 'delivery', policy: { requiredGates: [{ on: 'deliver', role: 'nobody' }] } }
   ]), [], [], [], []).nodes[0].questions.some((q) => q.includes('cannot be satisfied')))

// A pointer whose capability was never scanned has no node to hang off, and
// dropping it would hide a stale pointer entirely.
const orphaned = buildCapabilityView('/r', forestOf([]), [{ capability: 'gone', repoId: 'r' }], [], [], [])
ok('a pointer with no capability in the scan is still surfaced',
   orphaned.orphanPointers.length === 1)

/* ==================== materialization plan (§7.3 preview) ================= */

const existing = forestOf([
  { id: 'digital', kind: 'business', ledger: { kind: 'repo', url: 'u' } },
  {
    id: 'platform.contracts',
    kind: 'delivery',
    repos: [{ repoId: 'shared', url: 'u', defaultBase: 'main', writePolicy: 'gated', role: 'lead' }]
  }
])

const draft: CapabilityDraft = {
  id: 'digital.sel',
  name: 'Selector',
  kind: 'delivery',
  parent: 'digital',
  repos: [
    { repoId: 'sel-svc', url: 'github.com/org/sel-svc', role: 'lead' },
    { repoId: 'sel-web', url: 'github.com/org/sel-web', role: 'member' }
  ],
  approvers: [{ role: 'architect', actorId: 'ashok' }]
}

const plan = planMaterialization(draft, existing)
const step = (kind: string): (typeof plan.steps)[number] | undefined =>
  plan.steps.find((s) => s.kind === kind)

ok('a clean draft plans without errors', plan.errors.length === 0, plan.errors.join('; '))
ok('a delivery node gets a sidecar ledger', plan.ledgerKind === 'sidecar')
ok('in its lead repo', plan.leadRepoId === 'sel-svc')
ok('the plan creates the orphan branch', step('orphan-branch')?.target === 'sel-svc')
ok('and writes the manifest', !!step('manifest')?.file)
ok('and CODEOWNERS naming the approver',
   step('codeowners')?.file?.contents.includes('@ashok') === true)
ok('CODEOWNERS covers approvals and workflows',
   step('codeowners')?.file?.contents.includes('approvals/') === true &&
     step('codeowners')?.file?.contents.includes('workflows/') === true)

// The strongest assertion available: what the plan would write must parse back
// through the real parser. A preview that emits something the parser rejects is
// worse than no preview.
const roundTrip = parseManifest(step('manifest')!.file!.contents)
ok('the planned manifest parses back cleanly', roundTrip.issues.length === 0,
   roundTrip.issues.map((i) => i.problem).join('; '))
ok('and yields the same capability', roundTrip.capabilities[0]?.id === 'digital.sel')
ok('with the sidecar ledger intact',
   roundTrip.capabilities[0]?.ledger?.kind === 'sidecar')
ok('and the lead preserved',
   roundTrip.capabilities[0]?.repos?.find((r) => r.role === 'lead')?.repoId === 'sel-svc')
// And the round-tripped node must satisfy the validator, not merely parse.
ok('the planned manifest also validates',
   validateForest(forestOf([...existing.byId.values(), roundTrip.capabilities[0]])).valid)

/* ------------------------------- required vs best-effort (the B2 answer) */

// Materialization is several writes across repos and is never atomic, so each
// step has to say whether the capability exists without it.
ok('the orphan branch is required', step('orphan-branch')?.required === true)
ok('the manifest is required', step('manifest')?.required === true)
ok('CODEOWNERS is required', step('codeowners')?.required === true)
// The call worth arguing about: without it the node has a ledger and no parent
// knows it exists, which validates clean today.
ok('the parent stanza update is required', step('parent-stanza')?.required === true)
ok('pointer PRs are best-effort', step('pointer-pr')?.required === false)
ok('branch protection is best-effort', step('branch-protection')?.required === false)

ok('a pointer PR is planned for the member repo', step('pointer-pr')?.target === 'sel-web')
ok('and not for the lead',
   plan.steps.filter((s) => s.kind === 'pointer-pr').every((s) => s.target !== 'sel-svc'))
ok('the pointer file is a back-reference only',
   step('pointer-pr')?.file?.contents.includes('pointer: capability') === true)
// And it must be classified as a pointer by the real parser, not a capability.
ok('and the parser reads it as a pointer',
   parseManifest(step('pointer-pr')!.file!.contents).pointers.length === 1)
ok('yielding no capability',
   parseManifest(step('pointer-pr')!.file!.contents).capabilities.length === 0)

/* ------------------- validated against the prospective forest */

// Single ownership can only be checked against what the forest WOULD be. A
// failed push halfway through is a much worse place to learn this.
const conflicting = planMaterialization(
  { ...draft, repos: [{ repoId: 'shared', url: 'u', role: 'lead' }] },
  existing
)
ok('a repo already owned elsewhere blocks the plan', conflicting.errors.length > 0)
ok('and the error names the existing owner',
   conflicting.errors.some((e) => e.includes('platform.contracts')),
   conflicting.errors.join(' | '))

ok('an unknown parent blocks the plan',
   planMaterialization({ ...draft, parent: 'ghost' }, existing).errors.some((e) =>
     e.includes('not in the forest')
   ))
ok('an id that already exists blocks the plan',
   planMaterialization({ ...draft, id: 'digital' }, existing).errors.some((e) =>
     e.includes('already exists')
   ))
ok('a business node owning repos blocks the plan',
   planMaterialization({ ...draft, kind: 'business' }, existing).errors.some((e) =>
     e.includes('governance and rollup')
   ))

/* ---------------------------------------------- business nodes and defaults */

const businessPlan = planMaterialization(
  { id: 'digital.pzn', kind: 'business', parent: 'digital' },
  existing
)
ok('a business node gets a standalone ledger repo', businessPlan.ledgerKind === 'repo')
ok('and no orphan branch', !businessPlan.steps.some((s) => s.kind === 'orphan-branch'))
ok('and no snapshot, having no repos to pin',
   !businessPlan.steps.some((s) => s.kind === 'snapshot'))

// Mirrors the parser: one repo and no roles stated means that repo leads.
const inferred = planMaterialization(
  { id: 'x', kind: 'delivery', repos: [{ repoId: 'only', url: 'u' }] },
  forestOf([])
)
ok('a single repo with no role is planned as the lead', inferred.leadRepoId === 'only')
ok('and its manifest round-trips with that lead',
   parseManifest(inferred.steps.find((s) => s.kind === 'manifest')!.file!.contents)
     .capabilities[0]?.repos?.[0].role === 'lead')

/* ------------------------------------------------- runnability is honest */

// sgh 0.2.1 has gate/approve/stamp/wm and no capability subcommand, so a plan is
// not runnable regardless of how clean it is. A button that claimed otherwise
// would be the lie this preview exists to avoid.
ok('a clean plan is not runnable without the sgh subcommand', plan.runnable === false)
ok('it names the command that would run it',
   plan.command === 'sgh capability materialize digital.sel', plan.command)
ok('and becomes runnable once that command exists',
   planMaterialization(draft, existing, { sghHasCapabilityCommand: true }).runnable === true)
ok('but never runnable while errors stand',
   planMaterialization({ ...draft, parent: 'ghost' }, existing, {
     sghHasCapabilityCommand: true
   }).runnable === false)

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
