/**
 * Verifies the workflow integration is genuinely optional.
 *
 * The standalone tool must behave identically on a repo that knows nothing
 * about any workflow system, and a registered provider must never be able to
 * break session setup — however badly it misbehaves.
 *
 * Run with: npm run provider:check
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearProviders,
  collectContextDocuments,
  detectAll,
  registerProvider,
  registeredProviders
} from '../src/main/providers/registry'
import { singularityFlowProvider } from '../src/main/providers/singularityFlow'
import { availableProviderIds, loadProvidersFromEnv } from '../src/main/providers/load'
import type { WorkspaceProvider } from '../src/main/providers/types'
import { discoverRepo } from '../src/main/repo'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => { checks.push([n, p, d]) }

const plain = mkdtempSync(join(tmpdir(), 'eh-plain-'))
execFileSync('git', ['init', '-q'], { cwd: plain })
writeFileSync(join(plain, 'a.ts'), 'export const a = 1\n')

/* ------------------------------------------- 1. standalone: no providers */

clearProviders()
ok('no providers registered by default', registeredProviders().length === 0)

const bare = await discoverRepo(plain)
ok('repo discovery works with zero providers', bare.root.length > 0)
ok('providers list is empty, not undefined', Array.isArray(bare.providers) && bare.providers.length === 0)
ok('core still reports git', bare.isGit === true)

/* --------------------------------- 2. a hostile provider cannot break it */

const hostile: WorkspaceProvider = {
  id: 'hostile',
  name: 'Hostile',
  async detect() { throw new Error('boom') },
  async contextDocuments() { throw new Error('also boom') }
}
registerProvider(hostile)

const survived = await discoverRepo(plain)
ok('a throwing provider does not break discovery', survived.root.length > 0)
ok('a throwing detect() contributes nothing', survived.providers.length === 0)
ok('a throwing contextDocuments() yields none', (await collectContextDocuments(plain)).length === 0)

// A provider that hangs must not hang session setup either.
clearProviders()
registerProvider({
  id: 'slow',
  name: 'Slow',
  detect: () => new Promise(() => {})   // never resolves
})
const t0 = Date.now()
const timed = await Promise.race([
  detectAll(plain),
  new Promise((r) => setTimeout(() => r('TIMED_OUT_IN_TEST'), 20_000))
])
ok('a hanging provider is bounded by the registry timeout',
   Array.isArray(timed) && timed.length === 0,
   `${Date.now() - t0}ms, got ${Array.isArray(timed) ? 'array' : timed}`)

/* -------------------------------- 3. sflow provider only where it applies */

clearProviders()
registerProvider(singularityFlowProvider())

const onPlain = await detectAll(plain)
// The CLI is installed on this machine, so the provider legitimately reports
// itself — but it must say there is no work item rather than inventing one.
if (onPlain.length) {
  ok('reports no active work item on a plain repo',
     onPlain[0].detail?.hasWorkItems === false, JSON.stringify(onPlain[0].detail))
  ok('status carries a stable id', onPlain[0].id === 'singularity-flow')
} else {
  ok('provider correctly inactive where the CLI is absent', true, 'CLI not installed')
}

// A repo with the on-disk shape but no CLI-managed state.
const flowish = mkdtempSync(join(tmpdir(), 'eh-flowish-'))
execFileSync('git', ['init', '-q'], { cwd: flowish })
mkdirSync(join(flowish, 'singularity', 'work-items', 'WORK-142'), { recursive: true })
writeFileSync(
  join(flowish, 'singularity', 'work-items', 'WORK-142', 'workflow.json'),
  JSON.stringify({ currentPhase: 'implementation' })
)
writeFileSync(
  join(flowish, 'singularity', 'work-items', 'WORK-142', 'handoff.md'),
  '# Handoff\nCarry these decisions forward.\n'
)

const onFlow = await detectAll(flowish)
ok('detects a work-item repo', onFlow.length === 1, `${onFlow.length}`)
ok('reads the active work item', onFlow[0]?.detail?.workItemId === 'WORK-142',
   String(onFlow[0]?.detail?.workItemId))
ok('reads the current phase', onFlow[0]?.phase === 'implementation', onFlow[0]?.phase)
ok('summary names item and phase', (onFlow[0]?.summary ?? '').includes('WORK-142'), onFlow[0]?.summary)

const docs = await collectContextDocuments(flowish)
const handoff = docs.find((d) => d.title.includes('handoff'))
ok('handoff document collected', !!handoff, docs.map((d) => d.title).join(', '))
ok('handoff carries its text', (handoff?.text ?? '').includes('Carry these decisions'))
ok('document is attributed to its provider', handoff?.providerId === 'singularity-flow')
ok('document explains why it is being injected', !!handoff?.reason)
const exactDocs = await collectContextDocuments(flowish, {
  hostContext: {
    work: { kind: 'story', id: 'WORK-142', phase: 'implementation' },
    persona: 'developer'
  }
})
const exactHandoff = exactDocs.find((d) => d.title.includes('WORK-142') && d.title.includes('handoff'))
ok('host-selected work context resolves the exact Story', !!exactHandoff, exactDocs.map((d) => d.title).join(', '))
ok('handoff is explicitly treated as evidence', exactHandoff?.kind === 'evidence', exactHandoff?.kind)

/* --------------------------------------------- 4. registry hygiene */

clearProviders()
registerProvider({ id: 'x', name: 'X', detect: async () => null })
let rejected = false
try { registerProvider({ id: 'x', name: 'X again', detect: async () => null }) }
catch { rejected = true }
ok('duplicate registration rejected', rejected)

const unregister = registerProvider({ id: 'y', name: 'Y', detect: async () => null })
ok('two providers registered', registeredProviders().length === 2)
unregister()
ok('unregister removes exactly one', registeredProviders().length === 1)

clearProviders()

/* -------------------------------- 5. env-driven opt-in loading */

clearProviders()
ok('no providers loaded when the env var is unset',
   (await loadProvidersFromEnv(undefined)).length === 0 && registeredProviders().length === 0)

clearProviders()
ok('empty env var loads nothing', (await loadProvidersFromEnv('')).length === 0)

clearProviders()
const loadedIds = await loadProvidersFromEnv('singularity-flow')
ok('named provider loads on request', loadedIds.includes('singularity-flow'), loadedIds.join(','))
ok('and lands in the registry', registeredProviders().some((p) => p.id === 'singularity-flow'))

clearProviders()
const mixed = await loadProvidersFromEnv('singularity-flow, not-a-real-provider')
ok('unknown id is skipped, known one still loads',
   mixed.length === 1 && mixed[0] === 'singularity-flow', mixed.join(','))

clearProviders()
ok('unknown id alone does not throw', (await loadProvidersFromEnv('nope')).length === 0)
ok('singularity-flow is advertised as available',
   availableProviderIds().includes('singularity-flow'))

/* ------------------------------------- work threads, over a stand-in CLI */

/**
 * A fake `singularity-flow` that answers `--json`.
 *
 * The real CLI could not be exercised here: `status --json` and `about --json`
 * both exit 0 with no output in a repository that has no active work item, and
 * inventing a shape from the source would test my reading of it rather than the
 * mapping. So the contract is pinned to a fixture, and what is asserted is the
 * translation into Event Horizon's vocabulary — which is the part core depends
 * on and the part that must not drift.
 */
function fakeFlowCli(payload: Record<string, unknown>, inbox: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'eh-flow-'))
  const bin = join(dir, 'singularity-flow')
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    'const a = process.argv.slice(2)',
    'if (a[0] === "--version") { console.log("0.9.0"); process.exit(0) }',
    'if (!a.includes("--json")) { console.log("human readable output"); process.exit(0) }',
    `if (a[0] === "status") { console.log(${JSON.stringify(JSON.stringify(payload))}); process.exit(0) }`,
    `if (a[0] === "inbox") { console.log(${JSON.stringify(JSON.stringify(inbox))}); process.exit(0) }`,
    'process.exit(0)'
  ].join('\n'))
  execFileSync('chmod', ['+x', bin])
  return bin
}

const flowRepo = mkdtempSync(join(tmpdir(), 'eh-flowrepo-'))
mkdirSync(join(flowRepo, 'singularity', 'work-items', 'ENG-142'), { recursive: true })
// Committed work-item state, which is what Flow actually leaves on disk. An
// empty directory is correctly not a work item — the fallback reads state, not
// the existence of a folder.
writeFileSync(
  join(flowRepo, 'singularity', 'work-items', 'ENG-142', 'workflow.json'),
  JSON.stringify({ id: 'ENG-142', phase: 'implementation' })
)

const cli = fakeFlowCli(
  {
    workItemId: 'ENG-142',
    title: 'Pricing rounds down on annual plans',
    phase: 'implementation',
    state: 'awaiting-approval',
    artifacts: [
      { path: 'singularity/work-items/ENG-142/artifacts/design.md', sha256: 'abc123', phase: 'design' },
      { path: 'no-hash.md' }
    ],
    approvals: [{ decision: 'approved', phase: 'design', at: '2026-07-20T10:00:00Z', by: 'tech-lead' }]
  },
  [{ workItemId: 'ENG-9', title: 'Other work', phase: 'design', state: 'active' }]
)

const flow = singularityFlowProvider({ command: cli })

ok('the provider declares what it supports',
   (flow.capabilities ?? []).includes('workThreads'))
ok('and does not claim capabilities it lacks',
   !(flow.capabilities ?? []).includes('nonexistent' as never))

const thread = await flow.workThread!(flowRepo)
ok('a work item becomes a work thread', thread?.id === 'ENG-142', String(thread?.id))
ok('with its title', thread?.title?.includes('Pricing') === true)
ok('and its phase', thread?.phase === 'implementation')
// Flow's vocabulary is translated, not passed through.
ok("Flow's state maps onto Event Horizon's", thread?.status === 'awaiting-approval', thread?.status)
ok('artifacts carry their content hash',
   thread?.artifacts?.[0]?.sha256 === 'abc123')
ok('an artifact without a hash is kept, not dropped',
   thread?.artifacts?.length === 2, String(thread?.artifacts?.length))
ok('approvals become decisions', thread?.decisions?.[0]?.text.includes('approved') === true)
ok('with the person who made them', thread?.decisions?.[0]?.by === 'tech-lead')

// Blast radius is declared, because a host that cannot tell reading from
// submitting will eventually submit something.
const submit = thread?.actions?.find((a) => a.id === 'submit')
const status = thread?.actions?.find((a) => a.id === 'status')
ok('actions declare their effect', status?.effect === 'read-only' && submit?.effect === 'mutates-repo')
ok('an action that cannot run right now says so',
   !!submit?.unavailable, submit?.unavailable)
ok('and the one that can does not',
   thread?.actions?.find((a) => a.id === 'approve')?.unavailable === undefined)

const inbox = await flow.listWorkThreads!(flowRepo)
ok('the inbox lists other threads', inbox.some((t) => t.id === 'ENG-9'))

const ran = await flow.runAction!(flowRepo, 'status')
ok('an offered action runs', ran.ok)
// The mapping is an allow-list, not a shell.
const refused = await flow.runAction!(flowRepo, 'rm -rf /')
ok('an action that was never offered is refused', !refused.ok)
ok('and named in the refusal', refused.message.includes('rm -rf'))

// A CLI that says nothing is a healthy repo with no work item, not a failure.
const silent = singularityFlowProvider({ command: '/nonexistent/singularity-flow' })
const none = await silent.workThread!(flowRepo)
ok('a missing CLI falls back to what is on disk', none?.id === 'ENG-142', String(none?.id))
const emptyRepo = mkdtempSync(join(tmpdir(), 'eh-empty-'))
ok('and a repo with no work item yields nothing rather than an error',
   (await silent.workThread!(emptyRepo)) === null)

clearProviders()

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
