/**
 * M3 exit criteria.
 *
 * The golden-path IR runs end to end against a toy repo — analyse, a human gate
 * binding the design's sha256, implement, a verify loop whose exit conditions
 * are evaluated from real exit codes, and a stubbed PR step — and a run killed
 * mid-loop resumes from its checkpoint without redoing what was already done.
 *
 * Agent steps run through real ACP sessions against scripts/scripted-agent.mjs,
 * so sessions, the M1 capability gate, and client-side writes are all exercised.
 * The only thing standing in for production is the model, which makes the run
 * deterministic — a live model would make "resumed without re-running" an
 * assertion about luck.
 *
 * Run with: npm run workflow:check
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { goldenPath } from '../src/main/workflow/goldenPath'
import { allNodes, validate, type Workflow } from '../src/main/workflow/ir'
import {
  evaluate,
  parseJUnit,
  parseSarif,
  posteriorMean,
  updatePosterior,
  type AcceptanceClaim,
  type Signal
} from '../src/main/workflow/claims'
import {
  approvalStillValid,
  memoryCheckpointStore,
  sha256,
  WorkflowRuntime,
  type AgentRunner,
  type GateResolver
} from '../src/main/workflow/runtime'
import { acpAgentRunner } from '../src/main/workflow/acpRunner'
import { BUILTIN_AGENTS } from '../src/main/agents'

// A deadlock here reports nothing at all, which reads exactly like a suite that
// was never run. Bound it so the failure is visible.
const watchdog = setTimeout(() => {
  console.error('✗ workflow-check timed out — something is waiting on an answer nobody will give')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* ------------------------------------------------------- the executability gate */

const wf = goldenPath()
const base = validate(wf)
ok('the hand-written golden path is runnable', base.runnable,
   base.issues.map((i) => `${i.nodeId}: ${i.problem}`).join('; '))
ok('it uses every node type that matters',
   new Set(allNodes(wf).map((n) => n.type)).size >= 3)

// Per-step policy is the reason the IR exists — assert it actually varies.
const analyse = allNodes(wf).find((n) => n.id === 'analyse')!
const implement = allNodes(wf).find((n) => n.id === 'implement')!
ok('the analyst cannot write, by capability',
   analyse.type === 'agent' && analyse.mode === 'explore')
ok('and runs a cheaper tool profile than the implementer',
   analyse.type === 'agent' && implement.type === 'agent' &&
   analyse.toolProfile === 'lean' && implement.toolProfile === 'full')
ok('every agent id is a registered preset',
   allNodes(wf).filter((n) => n.type === 'agent')
     .every((n) => BUILTIN_AGENTS.some((a) => a.id === (n as { agentId: string }).agentId)))

const broken = (mutate: (w: Workflow) => void): string[] => {
  const copy = JSON.parse(JSON.stringify(goldenPath())) as Workflow
  mutate(copy)
  return validate(copy).issues.map((i) => i.problem)
}

ok('an unbound node is refused',
   broken((w) => { w.nodes[0].maturity = 'FRAGMENT' }).some((p) => p.includes('SPEC_BOUND')))
ok('a node without effects is refused',
   broken((w) => { delete (w.nodes[0] as { effects?: unknown }).effects })
     .some((p) => p.includes('effects')))
ok('a node without a timeout is refused',
   broken((w) => { w.nodes[0].budget = {} as never }).some((p) => p.includes('timeoutSec')))
ok('a gate without a role is refused',
   broken((w) => { (w.nodes[1] as { requiredRole: string }).requiredRole = '' })
     .some((p) => p.includes('role')))
// A hash cannot be authored before the artifact it describes exists.
ok('a pre-authored artifact hash is refused',
   broken((w) => { (w.nodes[1] as { artifactSha256: string }).artifactSha256 = 'deadbeef' })
     .some((p) => p.includes('BIND_AT_RUNTIME')))
ok('a loop with no acceptance claims is refused',
   broken((w) => { (w.nodes[3] as { until: unknown[] }).until = [] })
     .some((p) => p.includes('acceptance claims')))
ok('a loop referencing an undeclared claim is refused',
   broken((w) => { (w.nodes[3] as { until: Array<{ claimId: string }> }).until = [{ claimId: 'nope' }] })
     .some((p) => p.includes('undeclared')))
ok('an input nothing emits is refused',
   broken((w) => { (w.nodes[2] as { inputs: string[] }).inputs = ['nonexistent'] })
     .some((p) => p.includes('never emitted')))
ok('a gate on an artifact nothing emits is refused',
   broken((w) => { (w.nodes[1] as { artifact: string }).artifact = 'ghost' })
     .some((p) => p.includes('no step emits')))

/* ------------------------------------------------------------------- claims */

const testClaim: AcceptanceClaim = {
  claimClass: 'unit-tests',
  predicate: { select: 'unit.exitCode', op: 'eq', value: 0 },
  evidenceTier: 'PRODUCTION',
  acceptThreshold: 0.5
}
const captured = (fields: Signal['fields']): Signal =>
  ({ name: 'unit', source: 'client-terminal', fields })

ok('a claim holds on a captured zero exit code', evaluate(testClaim, [captured({ exitCode: 0 })]).accepted)
ok('and fails on a non-zero one', !evaluate(testClaim, [captured({ exitCode: 1 })]).accepted)
// A missing signal is not a pass. This is the difference between "verified" and
// "nothing contradicted it".
const missing = evaluate(testClaim, [])
ok('a missing signal is not a pass', !missing.accepted && missing.reason === 'no-signal')

// The rule the whole design turns on.
const fromAgent: Signal = { name: 'unit', source: 'agent', fields: { exitCode: 0 } }
const refused = evaluate(testClaim, [fromAgent])
ok('an agent-reported pass is refused outright', !refused.accepted)
ok('and refused for being untrusted, not for failing',
   refused.reason === 'untrusted-source', refused.reason)

// Calibration: a class with a bad record does not clear its threshold on one
// green run.
let posterior = { alpha: 1, beta: 1 }
for (let i = 0; i < 8; i++) posterior = updatePosterior(posterior, false)
const distrusted = evaluate({ ...testClaim, posterior, acceptThreshold: 0.7 }, [captured({ exitCode: 0 })])
ok('a claim class with a poor record does not exit a loop alone', !distrusted.accepted)
ok('and says so as below-threshold', distrusted.reason === 'below-threshold', distrusted.reason)
ok('a good record clears the same threshold',
   evaluate({ ...testClaim, posterior: { alpha: 9, beta: 1 }, acceptThreshold: 0.7 },
     [captured({ exitCode: 0 })]).accepted)
ok('the uninformative prior sits at 0.5', posteriorMean() === 0.5)

const junit = parseJUnit('<testsuites tests="12" failures="2" errors="1"><testsuite tests="12"/></testsuites>')
ok('junit failures are parsed', junit.failures === 2 && junit.errors === 1)
ok('and the outer counts are not double-counted', junit.tests === 12, String(junit.tests))
ok('sarif errors are parsed',
   parseSarif('{"runs":[{"results":[{"level":"error"},{"level":"warning"},{"level":"error"}]}]}').errors === 2)
// A report that will not parse must never read as a clean one.
ok('an unparseable report yields no signal, not a pass',
   Object.keys(parseSarif('{not json')).length === 0)

/* ------------------------------------------------ end to end on a toy repo */

function toyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eh-wf-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'toy',
    version: '1.0.0',
    scripts: { test: 'node test.js', lint: 'node lint.js' }
  }, null, 2))
  // Real commands with real exit codes — the evidence the claims are scored on.
  writeFileSync(join(dir, 'test.js'), `
const assert = require('assert')
const sum = require('./src/sum.js')
assert.strictEqual(sum(2, 2), 4)
console.log('ok')
`)
  writeFileSync(join(dir, 'lint.js'), `console.log('lint ok')`)
  return dir
}

const gates: GateResolver & { asked: Array<{ artifact: string; hash: string }> } = {
  asked: [],
  async ask(gate) {
    this.asked.push({ artifact: gate.artifact, hash: gate.artifactSha256 })
    return { approver: 'tech-lead@example.com' }
  }
}

// Real ACP sessions against the scripted agent. Every preset is remapped to it,
// so agentId still selects a session per step but no model is contacted.
const scripted = { command: process.execPath, args: [join(process.cwd(), 'scripts', 'scripted-agent.mjs')] }
for (const agent of BUILTIN_AGENTS) {
  agent.command = scripted.command
  agent.args = scripted.args
  agent.altCommands = []
}

const agentCalls: string[] = []
// Captured so the run can be asked how its permissions were answered, not just
// whether it finished.
const permissionBlocks: Array<{ unattended?: boolean; resolvedOptionId?: string }> = []
const realRunner = acpAgentRunner({
  onEvent: (_nodeId, event) => {
    if (event.type !== 'session:blocks') return
    for (const block of event.blocks) {
      if (block.kind === 'permission') permissionBlocks.push(block.request)
    }
  }
})
const agents: AgentRunner = {
  async run(node, ctx) {
    agentCalls.push(node.id)
    return realRunner.run(node, ctx)
  }
}

const cwd = toyRepo()
const store = memoryCheckpointStore()
const events: Array<{ type: string; nodeId?: string }> = []

const runtime = new WorkflowRuntime()
const state = await runtime.run(goldenPath(), {
  runId: 'run-1',
  cwd,
  agents,
  gates,
  store,
  onEvent: (e) => events.push(e)
})

ok('the run completed', state.status === 'completed', `${state.status}: ${state.reason ?? ''}`)
ok('the analyst produced a design artifact', existsSync(join(cwd, 'design.md')))
ok('the design was hashed', !!state.artifactHashes.design)
ok('the gate bound the artifact hash, not its name',
   gates.asked[0]?.hash === state.artifactHashes.design && gates.asked[0].hash.length === 64)
ok('the approval records the hash', state.approvals[0]?.artifactSha256 === state.artifactHashes.design)

// The point of hash binding: an approval must not survive the artifact changing.
const approval = state.approvals[0]
ok('the approval validates against the approved content',
   approvalStillValid(approval, readFileSync(join(cwd, 'design.md'), 'utf8')))
ok('and stops validating once the artifact changes',
   !approvalStillValid(approval, readFileSync(join(cwd, 'design.md'), 'utf8') + '\nedited'))

// The loop ran because the first implementation was genuinely wrong, and the
// exit codes proving it came from this process, not from the agent.
ok('the implementation was repaired to a passing state',
   readFileSync(join(cwd, 'src', 'sum.js'), 'utf8').includes('a + b'))
ok('the verify loop needed more than one iteration',
   Number(state.outputs['verify.iterations']) >= 2, state.outputs['verify.iterations'])
ok('the repair step actually ran', agentCalls.includes('repair'))
ok('every signal scored came from the client, never the agent',
   state.signals.every((s) => s.source === 'client-terminal'))
ok('a failing exit code was recorded before the fix',
   state.evidence.some((e) => e.verdict?.reason === 'predicate-failed'))
ok('both claim classes were scored',
   new Set(state.evidence.filter((e) => e.claimClass).map((e) => e.claimClass)).size === 2)
ok('the PR step ran last', state.checkpoints.at(-1)?.nodeId === 'open-pr')

// A governed step has no human at the keyboard, so an agent that politely asks
// must be answered from the standing grant — otherwise the run deadlocks at the
// first well-behaved agent, which is what happened before this was handled.
ok('the agent asked permission and was answered', permissionBlocks.length > 0,
   `${permissionBlocks.length} requests`)
ok('answered from the standing grant, not by a person',
   permissionBlocks.every((r) => r.unattended === true))
ok('and the transcript records what was allowed',
   permissionBlocks.every((r) => !!r.resolvedOptionId))

// The posterior tracks whether accepting a claim was right, not how often the
// check failed. Counting failed iterations against it drove the class below its
// own threshold after one failure, and the loop could then never exit.
ok('a failing iteration does not make the claim class untrustworthy',
   state.posteriors['unit-tests']?.beta === 1,
   JSON.stringify(state.posteriors['unit-tests']))
ok('and an acceptance does raise confidence in it',
   (state.posteriors['unit-tests']?.alpha ?? 0) > 1,
   JSON.stringify(state.posteriors['unit-tests']))
ok('a checkpoint was written for every node that ran',
   state.checkpoints.length >= allNodes(goldenPath()).length)

/* ------------------------------------------------ killed mid-loop, resumed */

const cwd2 = toyRepo()
const store2 = memoryCheckpointStore()
const calls2: string[] = []
const counting: AgentRunner = {
  async run(node, ctx) {
    calls2.push(node.id)
    return realRunner.run(node, ctx)
  }
}

// Its own recorder: the two toy repos produce a byte-identical design.md, so a
// shared one cannot tell this run's gate from the previous run's.
const gates2: GateResolver & { asked: Array<{ artifact: string; hash: string }> } = {
  asked: [],
  async ask(gate) {
    this.asked.push({ artifact: gate.artifact, hash: gate.artifactSha256 })
    return { approver: 'tech-lead@example.com' }
  }
}

const killed = await new WorkflowRuntime().run(goldenPath(), {
  runId: 'run-2',
  cwd: cwd2,
  agents: counting,
  gates: gates2,
  store: store2,
  stopBefore: 'repair'
})
ok('a killed run stops where it was killed', killed.stoppedAt === 'repair', killed.stoppedAt)
ok('and did not reach the PR step', !killed.checkpoints.some((c) => c.nodeId === 'open-pr'))

const before = [...calls2]
const resumed = await new WorkflowRuntime().run(goldenPath(), {
  runId: 'run-2',
  cwd: cwd2,
  agents: counting,
  gates: gates2,
  store: store2
})

ok('the resumed run completes', resumed.status === 'completed',
   `${resumed.status}: ${resumed.reason ?? ''}`)
// The whole value of a checkpoint: expensive work already done stays done.
const rerun = calls2.slice(before.length)
ok('resuming did not re-run the analyst', !rerun.includes('analyse'))
ok('resuming did not re-run the implementer', !rerun.includes('implement'))
ok('resuming did continue from the frontier', rerun.includes('repair'))
ok('the design hash survived the restart', resumed.artifactHashes.design === killed.artifactHashes.design)
ok('the approval survived the restart', resumed.approvals.length === killed.approvals.length)
// A resumed run must not re-ask for approval already given — a gate that
// re-prompts on every restart trains people to approve without reading.
ok('and the gate was not asked a second time', gates2.asked.length === 1,
   `${gates2.asked.length} asks`)

/* ------------------------------------------------------- a loop that cannot pass */

const hopeless = goldenPath()
// A claim nothing can satisfy: prove the loop stops rather than spinning.
hopeless.claims['unit-tests'].predicate = { select: 'unit.exitCode', op: 'eq', value: 99 }
const cwd3 = toyRepo()
const exhausted = await new WorkflowRuntime().run(hopeless, {
  runId: 'run-3',
  cwd: cwd3,
  agents,
  gates,
  store: memoryCheckpointStore()
})
ok('an unsatisfiable loop exits as budget-exhausted', exhausted.status === 'budget-exhausted',
   exhausted.status)
ok('and names the loop that gave up', exhausted.stoppedAt === 'verify')
ok('and did not proceed to the PR step',
   !exhausted.checkpoints.some((c) => c.nodeId === 'open-pr'))

/* --------------------------------------------------------- a declined gate */

const cwd4 = toyRepo()
const declining: GateResolver = { async ask() { return null } }
const rejected = await new WorkflowRuntime().run(goldenPath(), {
  runId: 'run-4',
  cwd: cwd4,
  agents,
  gates: declining,
  store: memoryCheckpointStore()
})
ok('a declined gate stops the run', rejected.status === 'rejected', rejected.status)
ok('and nothing downstream of it ran', !rejected.checkpoints.some((c) => c.nodeId === 'implement'))

/* ------------------------------------------------------------------ report */

clearTimeout(watchdog)
console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
