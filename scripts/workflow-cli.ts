/**
 * Run the golden-path workflow for real, in a workspace you can open.
 *
 * The runtime was previously reachable only from workflow-check, which runs it
 * in a temp directory and deletes the evidence with it. That makes the POC
 * provable and not inspectable — you can see 63 assertions pass, but not the
 * design note the analyst wrote or the broken implementation the loop repaired.
 *
 * This runs the same workflow, through the same WorkflowRuntime and the same
 * real ACP sessions, into a directory that stays. The only thing it adds is a
 * console and a place to look afterwards.
 *
 * Usage:
 *   npm run workflow                      scripted agent, auto-approve the gate
 *   npm run workflow -- --agent harness   the built-in harness, so a real model
 *   npm run workflow -- --reject          decline the gate; nothing downstream runs
 *   npm run workflow -- --kill implement  stop before a node, then resume
 *   npm run workflow -- --cwd <dir>       run against your own repo
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_AGENTS } from '../src/main/agents'
import { goldenPath } from '../src/main/workflow/goldenPath'
import { acpAgentRunner } from '../src/main/workflow/acpRunner'
import {
  WorkflowRuntime,
  memoryCheckpointStore,
  type GateResolver
} from '../src/main/workflow/runtime'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1]?.startsWith('--') ? '' : argv[i + 1]) : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const agentChoice = flag('agent') ?? 'scripted'
const killBefore = flag('kill')
const reject = has('reject')

/**
 * A repo small enough to reason about, with real commands and real exit codes.
 *
 * The verify loop scores its claims on what `npm test` actually returned, so the
 * test has to be able to genuinely fail — a stub that always passes would make
 * the loop's repair step unobservable, which is the one part worth watching.
 */
function toyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eh-poc-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'toy', version: '1.0.0', scripts: { test: 'node test.js', lint: 'node lint.js' } },
      null,
      2
    )
  )
  writeFileSync(
    join(dir, 'test.js'),
    "const assert = require('assert')\n" +
      "const sum = require('./src/sum.js')\n" +
      "assert.strictEqual(sum(2, 2), 4)\n" +
      "console.log('ok')\n"
  )
  writeFileSync(join(dir, 'lint.js'), "console.log('lint ok')")
  return dir
}

const cwd = flag('cwd') || toyRepo()

// The scripted agent decides from the workspace, not from a model: free,
// deterministic, and offline. `--agent harness` swaps in a real model without
// changing anything else, which is the point of every step being an ACP session.
if (agentChoice === 'scripted') {
  const scripted = { command: process.execPath, args: [join(process.cwd(), 'scripts', 'scripted-agent.mjs')] }
  for (const agent of BUILTIN_AGENTS) {
    agent.command = scripted.command
    agent.args = scripted.args
    agent.altCommands = []
  }
}

const gates: GateResolver = {
  async ask(gate) {
    console.log(`\n  ⏸  GATE: ${gate.artifact}`)
    // The hash, not the filename, is what the approval binds to — an artifact
    // edited after approval no longer matches what was approved.
    console.log(`      sha256 ${gate.artifactSha256.slice(0, 16)}…`)

    // gate.artifact is the logical name; the file is whatever node declared it.
    const producer = goldenPath().nodes.find(
      (n) => 'artifactPath' in n && (n as { output?: string }).output === gate.artifact
    ) as { artifactPath?: string } | undefined
    const file = producer?.artifactPath ?? `${gate.artifact}.md`
    const body = existsSync(join(cwd, file))
      ? readFileSync(join(cwd, file), 'utf8').trimEnd()
      : `(no file for "${gate.artifact}" — looked for ${file})`
    console.log(body.split('\n').map((l) => `      │ ${l}`).join('\n'))
    if (reject) {
      // null is a decline. The runtime stops the run rather than treating an
      // unanswered gate as permission.
      console.log('      ✗ declined (--reject)\n')
      return null
    }
    console.log('      ✓ approved\n')
    return { approver: 'cli@localhost' }
  }
}

const store = memoryCheckpointStore()
const runner = acpAgentRunner()

console.log(`\nworkflow · golden-path-v1`)
console.log(`  agent      ${agentChoice}`)
console.log(`  workspace  ${cwd}\n`)

const run = async (label: string, stopBefore?: string): Promise<void> => {
  const state = await new WorkflowRuntime().run(goldenPath(), {
    runId: 'poc-1',
    cwd,
    agents: runner,
    gates,
    store,
    capability: { id: 'payments.retry-engine', path: 'payments / payments.retry-engine' },
    ...(stopBefore ? { stopBefore } : {}),
    onEvent: (e) => {
      // The runtime emits one 'node' event as each node is entered, carrying the
      // node type; a loop body re-emits per iteration, which is what makes the
      // repair cycle visible.
      if (e.type === 'node') console.log(`  ▸ ${e.nodeId}  (${String(e.detail)})`)
      if (e.type === 'skipped') console.log(`  ⤼ ${e.nodeId} skipped — already done`)
    }
  })

  console.log(`\n${label}: ${state.status}${state.reason ? ` — ${state.reason}` : ''}`)
  for (const [name, hash] of Object.entries(state.artifactHashes)) {
    console.log(`  artifact  ${name}  ${String(hash).slice(0, 16)}…`)
  }
  // Calibrated acceptance is the whole reason the verify loop exists. The
  // posterior is what makes "the tests passed" and "we believe this works"
  // different statements — a class that failed earlier stays less trusted even
  // once it passes.
  for (const [claim, { alpha, beta }] of Object.entries(state.posteriors)) {
    const mean = alpha / (alpha + beta)
    console.log(`  claim     ${claim}  ${mean.toFixed(2)}  (α${alpha} β${beta})`)
  }
  for (const approval of state.approvals) {
    console.log(
      `  approval  ${approval.artifact} @${approval.artifactSha256.slice(0, 12)} by ${approval.approver}`
    )
  }
  console.log(`  evidence  ${state.evidence.length} records`)
}

if (killBefore) {
  console.log(`-- run 1, stopping before "${killBefore}" --`)
  await run('killed', killBefore)
  console.log(`\n-- run 2, resuming from the checkpoint --`)
  await run('resumed')
} else {
  await run('finished')
}

console.log(`\nlook at: ${cwd}`)

// Each agent step leaves a live ACP session, and nothing here owns their
// lifecycle — without this the run finishes and the process sits forever, which
// reads as a hang.
process.exit(0)
