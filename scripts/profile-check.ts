/**
 * Verifies tool profiles reach the spawned process and actually reduce context.
 *
 * A mis-wired profile fails silently: the session starts, everything works, and
 * you simply keep paying full overhead. So this asserts both halves — the flags
 * land in argv, and a lean session really does report less fixed overhead than
 * a full one against the live agent.
 *
 * Run with: npm run profile:check
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentSession } from '../src/main/acp/session'
import { resolveAgent, TOOL_PROFILES } from '../src/main/agents'
import { parseContext } from '../src/shared/contextInfo'
import type { MainEvent, SessionSnapshot } from '../src/shared/ipc'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* --------------------------------------------------- unit: argv assembly */

const full = await resolveAgent('copilot', 'full')
const lean = await resolveAgent('copilot', 'lean')
const minimal = await resolveAgent('copilot', 'minimal')

ok('full profile adds no extra flags', full.args.join(' ') === '--acp --stdio', full.args.join(' '))
ok('lean restricts tools', lean.args.includes('--available-tools=bash,view'))
ok('lean disables MCP', lean.args.includes('--disable-builtin-mcps'))
ok('minimal restricts to bash', minimal.args.includes('--available-tools=bash'))
ok('base ACP flags always survive', lean.args.includes('--acp') && lean.args.includes('--stdio'))
ok('profile recorded on the definition', lean.toolProfile === 'lean', lean.toolProfile)

// A non-Copilot agent must never receive Copilot's flags — it would fail to
// launch on an unrecognised argument.
const gemini = await resolveAgent('gemini', 'lean').catch(() => null)
if (gemini) {
  ok(
    'copilot-only flags are not applied to other agents',
    !gemini.args.some((a) => a.startsWith('--available-tools'))
  )
} else {
  ok('gemini not installed — flag isolation not exercised', true, 'skipped')
}

ok('unknown profile falls back rather than throwing', (await resolveAgent('copilot', 'nope')).args.join(' ') === '--acp --stdio')

/* ------------------------------------------ integration: does it save? */

async function overheadFor(profileId: string): Promise<number | null> {
  const cwd = mkdtempSync(join(tmpdir(), `eh-prof-${profileId}-`))
  writeFileSync(join(cwd, 'readme.md'), '# probe\n')
  const agent = await resolveAgent('copilot', profileId)
  const session = new AgentSession(agent, cwd)
  let snap: SessionSnapshot = session.getSnapshot()
  session.on('event', (e: MainEvent) => {
    if (e.type === 'session:patch') snap = { ...snap, ...e.patch }
  })

  await session.start()
  // /context is unavailable until the agent has handled a real message.
  await session.prompt({ text: 'Say only: ok' })
  const text = await session.runCommandSilent('/context')
  session.dispose()

  const ctx = parseContext(text)
  if (!ctx) return null
  const pick = (label: string): number =>
    ctx.slices.find((s) => s.label === label)?.tokens ?? 0
  return pick('System Prompt') + pick('System Tools') + pick('MCP Tools')
}

const fullOverhead = await overheadFor('full')
const leanOverhead = await overheadFor('lean')

ok('measured full overhead', fullOverhead !== null, String(fullOverhead))
ok('measured lean overhead', leanOverhead !== null, String(leanOverhead))

if (fullOverhead !== null && leanOverhead !== null) {
  const saved = fullOverhead - leanOverhead
  const pct = Math.round((saved / fullOverhead) * 100)
  ok('lean genuinely costs less than full', leanOverhead < fullOverhead, `${leanOverhead} vs ${fullOverhead}`)
  ok('saving is substantial (>40%)', pct > 40, `${pct}%`)
  console.log(
    `\nfixed overhead per request:  full ${fullOverhead}  ->  lean ${leanOverhead}` +
      `   (saves ${saved} tokens, ${pct}%)`
  )
}

console.log(`\nprofiles defined: ${TOOL_PROFILES.map((p) => p.id).join(', ')}`)

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300)
