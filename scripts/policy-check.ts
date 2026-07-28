/**
 * Verifies cost aggregation and policy enforcement.
 *
 * Both have a failure mode worse than not existing: a cost total that silently
 * understates spend, and a policy that can be talked around. The assertions
 * here target those specifically.
 *
 * Run with: npm run policy:check
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseMultiplier, summarizeUsage } from '../src/main/usageSummary'
import {
  agentAllowed,
  configChangeRefusal,
  enforceToolProfile,
  invalidatePolicy,
  loadPolicy,
  modelAllowed
} from '../src/main/policy'
import type { PersistedSession, Policy } from '../src/shared/ipc'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => { checks.push([n, p, d]) }

/* -------------------------------------------------------- multipliers */

ok('parses a whole multiplier', parseMultiplier('15x') === 15)
ok('parses a fractional multiplier', parseMultiplier('0.33x') === 0.33)
ok('parses 1x', parseMultiplier('1x') === 1)
ok('rejects nonsense', parseMultiplier('free') === null)
ok('rejects undefined', parseMultiplier(undefined) === null)

/* ---------------------------------------------------------- aggregation */

const session = (over: Partial<PersistedSession>): PersistedSession => ({
  id: Math.random().toString(36).slice(2),
  title: 'x',
  cwd: '/repo/a',
  agentId: 'copilot',
  createdAt: Date.parse('2026-07-20T10:00:00Z'),
  updatedAt: Date.parse('2026-07-20T10:00:00Z'),
  turns: 1,
  ...over
})

const sessions: PersistedSession[] = [
  session({
    cwd: '/repo/a',
    model: 'claude-opus-5',
    modelMultiplier: '15x',
    usage: { requests: 10, inputTokens: 1000, outputTokens: 100, cachedTokens: 900 }
  }),
  session({
    cwd: '/repo/a',
    model: 'claude-haiku-4.5',
    modelMultiplier: '0.33x',
    usage: { requests: 10, inputTokens: 500, outputTokens: 50, cachedTokens: 400 }
  }),
  session({
    cwd: '/repo/b',
    model: 'claude-sonnet-5',
    modelMultiplier: '1x',
    usage: { requests: 4, inputTokens: 200, outputTokens: 20, cachedTokens: 100 },
    updatedAt: Date.parse('2026-07-21T10:00:00Z')
  }),
  // No usage reading at all — must not be silently treated as zero cost.
  session({ cwd: '/repo/b', model: 'claude-sonnet-5', modelMultiplier: '1x' })
]

const sum = summarizeUsage(sessions)

ok('counts every session', sum.totalSessions === 4, `${sum.totalSessions}`)
ok('counts how many actually reported usage', sum.sessionsWithUsage === 3, `${sum.sessionsWithUsage}`)
ok('flags the total as partial', sum.partial === true)
ok('sums raw requests', sum.totalRequests === 24, `${sum.totalRequests}`)
// 10*15 + 10*0.33 + 4*1 = 157.3 — the number that tracks the invoice.
ok('weights requests by multiplier', Math.abs(sum.totalWeightedRequests - 157.3) < 0.01,
   `${sum.totalWeightedRequests}`)
ok('sums input tokens', sum.totalInputTokens === 1700, `${sum.totalInputTokens}`)
ok('sums cached tokens', sum.totalCachedTokens === 1400, `${sum.totalCachedTokens}`)

const opus = sum.byModel.find((b) => b.key === 'claude-opus-5')
const haiku = sum.byModel.find((b) => b.key === 'claude-haiku-4.5')
ok('groups by model', sum.byModel.length === 3, `${sum.byModel.length}`)
ok('the expensive model sorts first', sum.byModel[0].key === 'claude-opus-5', sum.byModel[0].key)
// Same request count, 45x apart in weight — the whole point of the report.
ok('equal requests differ hugely once weighted',
   !!opus && !!haiku && Math.round(opus.weightedRequests / haiku.weightedRequests) === 45,
   `${opus?.weightedRequests} vs ${haiku?.weightedRequests}`)
ok('keeps the multiplier for display', opus?.multiplier === '15x')

ok('groups by repo', sum.byRepo.length === 2, `${sum.byRepo.length}`)
ok('repo bucket counts its sessions', sum.byRepo.find((b) => b.key === '/repo/b')?.sessions === 2)
ok('groups by day', sum.byDay.length === 2, `${sum.byDay.length}`)
ok('days sort newest first', sum.byDay[0].key === '2026-07-21', sum.byDay[0].key)

// An unknown multiplier must count as 1x, never as free.
const unknown = summarizeUsage([session({ usage: { requests: 5 } })])
ok('unknown multiplier counts as 1x, not zero', unknown.totalWeightedRequests === 5,
   `${unknown.totalWeightedRequests}`)

ok('an empty history summarizes cleanly', summarizeUsage([]).totalSessions === 0)

/* -------------------------------------------------------------- policy */

const strict: Policy = {
  pinToolProfile: 'lean',
  allowedAgents: ['copilot'],
  allowedModels: ['claude-sonnet-5', 'claude-haiku-4.5'],
  disableAllowAll: true,
  disableAutopilot: true
}

ok('pinned profile overrides the request', enforceToolProfile(strict, 'full') === 'lean')
ok('pinned profile overrides no request', enforceToolProfile(strict, undefined) === 'lean')
ok('no pin leaves the request alone', enforceToolProfile({}, 'full') === 'full')

ok('permitted agent allowed', agentAllowed(strict, 'copilot'))
ok('other agents refused', !agentAllowed(strict, 'gemini'))
ok('no list means all agents allowed', agentAllowed({}, 'anything'))

ok('permitted model allowed', modelAllowed(strict, 'claude-sonnet-5'))
ok('expensive model refused', !modelAllowed(strict, 'claude-opus-5'))

const allowAll = configChangeRefusal(strict, 'allow_all', 'on')
ok('allow-all is refused', allowAll !== null)
ok('refusal explains itself', !!allowAll && allowAll.length > 20, allowAll ?? undefined)
ok('turning allow-all OFF is always permitted', configChangeRefusal(strict, 'allow_all', 'off') === null)
ok('banned model is refused', configChangeRefusal(strict, 'model', 'claude-opus-5') !== null)
ok('permitted model passes', configChangeRefusal(strict, 'model', 'claude-sonnet-5') === null)
ok('autopilot is refused',
   configChangeRefusal(strict, 'mode', 'https://agentclientprotocol.com/protocol/session-modes#autopilot') !== null)
ok('agent mode passes',
   configChangeRefusal(strict, 'mode', 'https://agentclientprotocol.com/protocol/session-modes#agent') === null)
ok('an empty policy refuses nothing', configChangeRefusal({}, 'allow_all', 'on') === null)

/* ------------------------------------------------------ file loading */

const repo = mkdtempSync(join(tmpdir(), 'eh-policy-'))
mkdirSync(join(repo, '.event-horizon'), { recursive: true })
writeFileSync(
  join(repo, '.event-horizon', 'policy.json'),
  JSON.stringify({ pinToolProfile: 'minimal', allowedModels: ['claude-haiku-4.5'] })
)

invalidatePolicy()
const repoPolicy = await loadPolicy(repo)
ok('repo policy is read', repoPolicy.pinToolProfile === 'minimal', repoPolicy.pinToolProfile)

// An org policy must be able to narrow, and a repo must not widen it.
const orgFile = join(repo, 'org-policy.json')
writeFileSync(orgFile, JSON.stringify({ allowedModels: ['claude-haiku-4.5', 'gpt-5-mini'], disableAllowAll: true }))
process.env.EVENT_HORIZON_POLICY = orgFile
invalidatePolicy()
const merged = await loadPolicy(repo)
ok('org policy applies', merged.disableAllowAll === true)
ok('lists intersect rather than replace',
   JSON.stringify(merged.allowedModels) === JSON.stringify(['claude-haiku-4.5']),
   JSON.stringify(merged.allowedModels))
delete process.env.EVENT_HORIZON_POLICY

// A typo must not lock someone out of their own tool.
writeFileSync(join(repo, '.event-horizon', 'policy.json'), '{ not json')
invalidatePolicy()
const broken = await loadPolicy(repo)
ok('a malformed policy fails open, not closed', broken.pinToolProfile === undefined)
ok('and refuses nothing', configChangeRefusal(broken, 'allow_all', 'on') === null)

// Policy must not depend on git: a plain directory still carries its own.
const plain = mkdtempSync(join(tmpdir(), 'eh-nogit-'))
mkdirSync(join(plain, '.event-horizon'), { recursive: true })
writeFileSync(join(plain, '.event-horizon', 'policy.json'), JSON.stringify({ disableAllowAll: true }))
invalidatePolicy()
ok('a non-git directory still gets its policy', (await loadPolicy(plain)).disableAllowAll === true)

// And a subdirectory inherits it by walking up.
const nested = join(plain, 'src', 'deep')
mkdirSync(nested, { recursive: true })
invalidatePolicy()
ok('a subdirectory inherits the policy above it', (await loadPolicy(nested)).disableAllowAll === true)

// The nearest policy wins on scalars but lists still intersect upward.
mkdirSync(join(nested, '.event-horizon'), { recursive: true })
writeFileSync(join(nested, '.event-horizon', 'policy.json'),
  JSON.stringify({ pinToolProfile: 'lean', allowedModels: ['a', 'b'] }))
writeFileSync(join(plain, '.event-horizon', 'policy.json'),
  JSON.stringify({ disableAllowAll: true, allowedModels: ['b', 'c'] }))
invalidatePolicy()
const walked = await loadPolicy(nested)
ok('the nearest policy applies', walked.pinToolProfile === 'lean', walked.pinToolProfile)
ok('an outer policy still applies', walked.disableAllowAll === true)
ok('a nested policy cannot widen an outer list',
   JSON.stringify(walked.allowedModels) === JSON.stringify(['b']),
   JSON.stringify(walked.allowedModels))

invalidatePolicy()
const none = await loadPolicy(mkdtempSync(join(tmpdir(), 'eh-nopolicy-')))
ok('no policy file means unrestricted', Object.keys(none).length === 0 || none.pinToolProfile === undefined)

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
