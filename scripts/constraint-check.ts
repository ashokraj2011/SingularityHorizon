/**
 * M5 exit criteria.
 *
 * "Do not modify the database schema", said halfway through a run:
 *
 *   1. It parses to a typed constraint, or it is returned for elicitation.
 *      Never silently narrowed — a constraint the parser guessed at produces a
 *      run that obeyed something nobody asked for.
 *   2. What it invalidates is a graph query over declared effects.
 *   3. The constrained step is *denied* a matching write at the policy layer,
 *      not merely told not to. Proven by driving a real ACP session that tries
 *      the write and asserting the file does not appear.
 *   4. Completed work outside the frontier is not re-run.
 *
 * Run with: npm run constraint:check
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentSession } from '../src/main/acp/session'
import { classify, decide, type SessionPolicy } from '../src/main/acp/policy'
import { BUILTIN_AGENTS } from '../src/main/agents'
import { goldenPath } from '../src/main/workflow/goldenPath'
import {
  acceptConstraint,
  forbiddenWritePaths,
  invalidationFrontier,
  matchGlob,
  parseConstraint,
  pathMatchesSelector,
  selectorsIntersect,
  type Constraint
} from '../src/main/workflow/constraints'
import {
  applyConstraint,
  memoryCheckpointStore,
  WorkflowRuntime,
  type AgentRunner,
  type GateResolver
} from '../src/main/workflow/runtime'
import { acpAgentRunner } from '../src/main/workflow/acpRunner'
import type { AgentDefinition, MainEvent } from '../src/shared/ipc'

const watchdog = setTimeout(() => {
  console.error('✗ constraint-check timed out')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* ------------------------------------------------------------- parsing */

const parsed = parseConstraint('Do not modify the database schema')
ok('the constraint parses', parsed.ok)
ok('to a typed prohibition on writes', parsed.ok && parsed.constraint.forbids === 'writes')
ok('against the schema, not the whole database',
   parsed.ok && parsed.constraint.selector.kind === 'db.schema',
   parsed.ok ? parsed.constraint.selector.kind : '')
ok('keeping the words that were used',
   parsed.ok && parsed.constraint.text.includes('database schema'))

// Never silently narrowed. "The database" could mean schema or data, and
// picking one produces a run that obeyed something nobody asked for.
const ambiguous = parseConstraint("Don't touch the database")
ok('an ambiguous target is not narrowed', !ambiguous.ok)
ok('and comes back as a question', !ambiguous.ok && ambiguous.question.length > 10)
ok('offering the readings it could not choose between',
   !ambiguous.ok && (ambiguous.candidates?.length ?? 0) === 2,
   String(!ambiguous.ok ? ambiguous.candidates?.length : ''))

const notAConstraint = parseConstraint('the pricing service looks fine')
ok('a statement that is not a prohibition is refused', !notAConstraint.ok)
ok('and says why', !notAConstraint.ok && notAConstraint.reason.length > 0)

const noTarget = parseConstraint('do not break anything')
ok('a prohibition with no resource is refused', !noTarget.ok)

const byPath = parseConstraint('do not modify src/pricing/**')
ok('an explicit path needs no interpretation', byPath.ok)
ok('and becomes a repo selector',
   byPath.ok && byPath.constraint.selector.kind === 'repo' &&
   byPath.constraint.selector.path === 'src/pricing/**')

const reading = parseConstraint('do not read the config')
ok('a read prohibition is distinguished from a write one',
   reading.ok && reading.constraint.forbids === 'reads')

/* --------------------------------------------------------- glob matching */

ok('** spans directories', matchGlob('**/migrations/**', 'db/migrations/001_init.sql'))
ok('* does not', !matchGlob('src/*.ts', 'src/nested/file.ts'))
ok('* matches within a segment', matchGlob('src/*.ts', 'src/index.ts'))
ok('a suffix pattern matches at any depth', matchGlob('**/*.sql', 'a/b/c/x.sql'))
ok('and does not match a different suffix', !matchGlob('**/*.sql', 'a/b/c/x.ts'))
ok('a literal dot is not a wildcard', !matchGlob('**/schema.prisma', 'db/schemaXprisma'))

const schema = { kind: 'db.schema' as const }
ok('a migration file matches the schema selector',
   pathMatchesSelector(schema, 'db/migrations/001_init.sql'))
ok('a prisma schema matches it', pathMatchesSelector(schema, 'prisma/schema.prisma'))
ok('an ordinary source file does not', !pathMatchesSelector(schema, 'src/pricing/rate.ts'))

// Conservative on purpose: a false intersection costs a re-run, a missed one
// ships work that violated the constraint.
ok('a repo glob covering migrations intersects the schema selector',
   selectorsIntersect({ kind: 'repo', path: 'db/**' }, schema))
ok('an unrelated repo glob does not',
   !selectorsIntersect({ kind: 'repo', path: 'docs/*.md' }, schema))
ok('a whole-repo selector intersects everything',
   selectorsIntersect({ kind: 'repo', path: '**' }, schema))
ok('unrelated kinds do not intersect',
   !selectorsIntersect({ kind: 'external' }, { kind: 'config' }))

/* ------------------------------------------------- the invalidation frontier */

const constraint: Constraint = acceptConstraint(
  (parseConstraint('Do not modify the database schema') as { ok: true; constraint: Omit<Constraint, 'id' | 'at'> }).constraint,
  'c1',
  1_000
)

// The golden path writes src/**, which does not touch the schema — a constraint
// that invalidated it anyway would be useless.
const noneAffected = invalidationFrontier(goldenPath(), constraint)
ok('a constraint that collides with nothing invalidates nothing',
   noneAffected.all.length === 0, noneAffected.all.join(','))

// A workflow that does touch the schema.
const schemaWorkflow = JSON.parse(JSON.stringify(goldenPath())) as ReturnType<typeof goldenPath>
const implement = schemaWorkflow.nodes.find((n) => n.id === 'implement')!
implement.effects.writes = [
  { kind: 'repo', path: 'src/**' },
  { kind: 'db.schema' }
]

const frontier = invalidationFrontier(schemaWorkflow, constraint)
ok('the step whose writes collide is in the frontier', frontier.direct.includes('implement'))
ok('the analyst, which only reads, is not', !frontier.all.includes('analyse'))
// Transitive, through the dataflow edges — repair consumes `implementation`.
ok('a step that consumed its output is invalidated too',
   frontier.dependents.includes('repair'), frontier.dependents.join(','))
ok('and the loop containing it is invalidated', frontier.all.includes('verify'))
ok('the frontier is ordered as the workflow runs',
   frontier.all.indexOf('implement') < frontier.all.indexOf('verify'))
ok('the PR step, which reads nothing it produced, is untouched',
   !frontier.all.includes('open-pr'), frontier.all.join(','))

ok('forbidden paths are derived from the selector',
   forbiddenWritePaths([constraint]).includes('**/migrations/**'))
ok('a read constraint contributes no write bans',
   forbiddenWritePaths([{ ...constraint, forbids: 'reads' }]).length === 0)

/* --------------------------------------------- the gate refuses, not the prompt */

const constrained: SessionPolicy = {
  mode: 'edit',
  grants: [{ toolClass: 'fs.write', scope: 'always' }],
  forbiddenWrites: forbiddenWritePaths([constraint]),
  matchPath: matchGlob
}

const forbiddenWrite = classify('fs/write_text_file', { path: '/repo/db/migrations/002.sql' })!
const allowedWrite = classify('fs/write_text_file', { path: '/repo/src/pricing.ts' })!

const refusal = decide(constrained, forbiddenWrite)
ok('a write matching the constraint is refused', refusal.kind === 'deny')
ok('even though a standing grant covers the class', refusal.kind === 'deny')
ok('and the refusal names the pattern it matched',
   refusal.kind === 'deny' && refusal.reason.includes('migrations'),
   refusal.kind === 'deny' ? refusal.reason : '')
ok('an unrelated write still proceeds', decide(constrained, allowedWrite).kind === 'allow')
ok('reads are unaffected by a write constraint',
   decide(constrained, classify('fs/read_text_file', { path: '/repo/db/migrations/002.sql' })!)
     .kind === 'allow')

/* ------------------------------ the same thing, through a real ACP session */

const box = mkdtempSync(join(tmpdir(), 'eh-constraint-'))
mkdirSync(join(box, 'db', 'migrations'), { recursive: true })
const forbiddenTarget = join(box, 'db', 'migrations', '002_add_column.sql')

const rude: AgentDefinition = {
  id: 'rude',
  name: 'rude',
  command: process.execPath,
  args: [join(process.cwd(), 'scripts', 'rude-agent.mjs')],
  env: { ...(process.env as Record<string, string>), RUDE_TARGET_PATH: forbiddenTarget }
}

const session = new AgentSession(rude, box)
// A governed step: standing grant, and the constraint on top of it.
session.setMode('edit', {
  autoGrant: true,
  forbiddenWrites: forbiddenWritePaths([constraint]),
  matchPath: matchGlob
})

const notices: string[] = []
session.on('event', (e: MainEvent) => {
  if (e.type !== 'session:blocks') return
  for (const b of e.blocks) if (b.kind === 'notice') notices.push(b.text)
})

await session.start()
await session.prompt({ text: 'go' })
session.dispose()

// The assertion the milestone exists for.
ok('a constrained session does not write the forbidden file', !existsSync(forbiddenTarget))
ok('and the refusal was recorded as a constraint, not a mode limit',
   notices.some((n) => n.includes('constraint on this run forbids')), notices.join(' | '))
// The other half of why this holds: an `edit` step has no terminal at all, so
// there is no shell through which the write could have happened instead.
ok('and the shell it tried first was refused by the mode',
   notices.some((n) => n.includes('edit mode')), notices.join(' | '))

/* ------------------------------------------- injection mid-run, then resume */

function toyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eh-c-run-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'toy', version: '1.0.0', scripts: { test: 'node test.js', lint: 'node lint.js' }
  }))
  writeFileSync(join(dir, 'test.js'),
    "const a=require('assert');const s=require('./src/sum.js');a.strictEqual(s(2,2),4);console.log('ok')")
  writeFileSync(join(dir, 'lint.js'), "console.log('lint ok')")
  return dir
}

for (const agent of BUILTIN_AGENTS) {
  agent.command = process.execPath
  agent.args = [join(process.cwd(), 'scripts', 'scripted-agent.mjs')]
  agent.altCommands = []
}

const calls: string[] = []
const real = acpAgentRunner()
const counting: AgentRunner = {
  async run(node, ctx) {
    calls.push(node.id)
    return real.run(node, ctx)
  }
}
const gates: GateResolver = { async ask() { return { approver: 'tech-lead' } } }

const cwd = toyRepo()
const store = memoryCheckpointStore()

// Stop mid-loop, exactly as a person interrupting a running workflow would.
const killed = await new WorkflowRuntime().run(schemaWorkflow, {
  runId: 'c-run', cwd, agents: counting, gates, store, stopBefore: 'repair'
})
ok('the run reached the loop before the constraint arrived',
   killed.checkpoints.some((c) => c.nodeId === 'implement'))

const applied = applyConstraint(schemaWorkflow, killed, constraint)
await store.save('c-run', applied.state)

ok('applying the constraint reports what it invalidated',
   applied.frontier.includes('implement') && applied.frontier.includes('repair'))
ok('completed frontier work is marked stale', applied.stale.includes('implement'))
// Kept, not deleted: it is the only account of what the run did before the
// rules changed.
ok('its artifacts are kept', Object.keys(applied.state.artifactHashes).includes('design'))
ok('its evidence is retained', applied.state.evidence.length === killed.evidence.length)

// Demotion needs evidence that belongs to an invalidated step and carries a
// tier. The killed run above has neither — its only evidence is tool signals
// from steps outside the frontier — so asserting against it would pass without
// testing anything. Constructed explicitly instead.
const withEvidence = {
  ...killed,
  evidence: [
    { id: 'e1', nodeId: 'implement', claimClass: 'spec-conformance', tier: 'PRODUCTION', at: 1 },
    { id: 'e2', nodeId: 'analyse', claimClass: 'read-only', tier: 'PRODUCTION', at: 1 }
  ]
}
const demoted = applyConstraint(schemaWorkflow, withEvidence, constraint).state
const forImplement = demoted.evidence.find((e) => e.id === 'e1')
const forAnalyse = demoted.evidence.find((e) => e.id === 'e2')

ok('evidence for invalidated work is demoted a tier', forImplement?.tier === 'STAGING',
   String(forImplement?.tier))
ok('and marked with the constraint that invalidated it', forImplement?.staleUnder === 'c1')
ok('but it is kept, not deleted', !!forImplement)
// It was true when it was captured; it was captured under rules that have since
// changed. Deleting it would destroy the only account of what the run did.
ok('evidence outside the frontier keeps its tier', forAnalyse?.tier === 'PRODUCTION')
ok('and is not marked stale', forAnalyse?.staleUnder === undefined)
ok('checkpoints for invalidated nodes are dropped so they re-run',
   !applied.state.checkpoints.some((c) => c.nodeId === 'implement'))
ok('checkpoints outside the frontier survive',
   applied.state.checkpoints.some((c) => c.nodeId === 'analyse'))
ok('the rewind point is the checkpoint before the frontier',
   applied.rewoundTo === 'approve-design', String(applied.rewoundTo))

const before = calls.length
const resumed = await new WorkflowRuntime().run(schemaWorkflow, {
  runId: 'c-run', cwd, agents: counting, gates, store
})
const rerun = calls.slice(before)

ok('the constrained run completes', resumed.status === 'completed',
   `${resumed.status}: ${resumed.reason ?? ''}`)
// The point of a frontier rather than a restart.
ok('unaffected completed work is not re-run', !rerun.includes('analyse'), rerun.join(','))
ok('invalidated work is re-run', rerun.includes('implement'), rerun.join(','))
ok('the constraint is carried on the resumed run',
   resumed.constraints.some((c) => c.id === 'c1'))
ok('and the gate was not asked again', resumed.approvals.length === killed.approvals.length)

clearTimeout(watchdog)
console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
