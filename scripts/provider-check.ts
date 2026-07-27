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

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
