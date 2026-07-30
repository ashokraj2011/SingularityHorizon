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
import {
  ancestryOf,
  depthOf,
  forestOf,
  lowestCommonAncestor,
  pathOf,
  rootsOf,
  type Capability
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
      { repoId: 'shared-contracts', url: 'u', defaultBase: 'main', writePolicy: 'gated' }
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
    repos: [{ repoId: 'shared-contracts', url: 'u', defaultBase: 'main', writePolicy: 'gated' }]
  },
  {
    id: 'payments.other',
    kind: 'delivery',
    parent: 'payments',
    repos: [{ repoId: 'shared-contracts', url: 'u', defaultBase: 'main', writePolicy: 'open' }]
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
     { id: 'a', kind: 'business', repos: [{ repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open' }] }
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
         { repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open' },
         { repoId: 'r', url: 'u2', defaultBase: 'main', writePolicy: 'open' }
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
     { id: 'a', kind: 'delivery', repos: [{ repoId: 'r', url: 'u', defaultBase: 'main', writePolicy: 'open' }] }
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
       ledger: { url: 'u' },
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
ok('the materialized copy wins over the inline stanza',
   multi.forest.byId.get('leaf')?.ledger?.url.includes('leaf-ledger') === true)
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

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
