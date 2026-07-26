/**
 * Tests the /context and /usage parsers against real captured output.
 * Run with: npm run context:check
 *
 * The fixtures below are verbatim captures from `copilot --acp --stdio`
 * (1.0.75), glyph columns included. If GitHub changes the rendering these
 * tests are the tripwire.
 */
import { parseContext, parseTokenCount, parseUsage } from '../src/shared/contextInfo'

const CONTEXT_FIXTURE = `Context Usage

○ ○ ◌ ◌ ◌ ● ◉ · · ·   claude-sonnet-5 · 19k/264k tokens (7%)
· · · · · · · · · ·   ○ System Prompt           7.4k   (3%)
· · · · · · · · · ·   ◌ System Tools            9.8k   (4%)
· · · · · · · · · ·   ● MCP Tools               1.1k  (<1%)
· · · · · · · · · ·   ◉ Messages                 426  (<1%)
◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎   · Free Space            171.3k  (65%)
◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎   ◎ Buffer                 74.0k  (28%)`

const USAGE_FIXTURE = `Session Usage

Changes: +12 -3
Requests: 2 AI Units (13s)
Tokens: input 73.8k, output 148, cached 65.5k, reasoning 18`

const NOT_READY = 'Context information is not yet available. Send a message first so Copilot can initialize the agent context.'

const checks: Array<[string, boolean, string?]> = []
const ok = (name: string, pass: boolean, detail?: string): void => {
  checks.push([name, pass, detail])
}

/* ------------------------------------------------------------ token counts */

ok('parses plain integer', parseTokenCount('426') === 426)
ok('parses k suffix', parseTokenCount('7.4k') === 7400)
ok('parses large k', parseTokenCount('171.3k') === 171300)
ok('parses M suffix', parseTokenCount('1.2M') === 1200000)
ok('rejects non-numeric', parseTokenCount('Buffer') === null)
ok('rejects empty', parseTokenCount('') === null)

/* ---------------------------------------------------------------- context */

const ctx = parseContext(CONTEXT_FIXTURE)
ok('parsed context', ctx !== null)
ok('read model', ctx?.model === 'claude-sonnet-5', ctx?.model)
ok('read used tokens', ctx?.usedTokens === 19000, String(ctx?.usedTokens))
ok('read total tokens', ctx?.totalTokens === 264000, String(ctx?.totalTokens))
ok('read percent', ctx?.percent === 7, String(ctx?.percent))
ok('found all six slices', ctx?.slices.length === 6, `${ctx?.slices.length}`)

const slice = (label: string): number | undefined =>
  ctx?.slices.find((s) => s.label === label)?.tokens

ok('System Prompt slice', slice('System Prompt') === 7400, String(slice('System Prompt')))
ok('System Tools slice', slice('System Tools') === 9800, String(slice('System Tools')))
ok('MCP Tools slice', slice('MCP Tools') === 1100, String(slice('MCP Tools')))
ok('Messages slice (no suffix)', slice('Messages') === 426, String(slice('Messages')))
ok('Free Space slice', slice('Free Space') === 171300, String(slice('Free Space')))
ok('Buffer slice', slice('Buffer') === 74000, String(slice('Buffer')))
ok(
  '"<1%" becomes a visible sliver, not zero',
  ctx?.slices.find((s) => s.label === 'MCP Tools')?.percent === 0.5
)
ok(
  'header line is not counted as a slice',
  !ctx?.slices.some((s) => /token/i.test(s.label))
)

/* ------------------------------------------------------------------ usage */

const usage = parseUsage(USAGE_FIXTURE)
ok('parsed usage', usage !== null)
ok('input tokens', usage?.inputTokens === 73800, String(usage?.inputTokens))
ok('output tokens', usage?.outputTokens === 148, String(usage?.outputTokens))
ok('cached tokens', usage?.cachedTokens === 65500, String(usage?.cachedTokens))
ok('reasoning tokens', usage?.reasoningTokens === 18, String(usage?.reasoningTokens))
ok('requests', usage?.requests === 2, String(usage?.requests))
ok('lines added', usage?.linesAdded === 12, String(usage?.linesAdded))
ok('lines removed', usage?.linesRemoved === 3, String(usage?.linesRemoved))

/* --------------------------------------------------------- degradation */

ok('the "not yet available" message yields null, not a throw', parseContext(NOT_READY) === null)
ok('empty input yields null', parseContext('') === null)
ok('garbage yields null', parseContext('total nonsense here') === null)
ok('empty usage yields null', parseUsage('') === null)
ok(
  'a future format change degrades to null rather than bad numbers',
  parseContext('Context Usage\n\nsomething completely different') === null
)

/* ---------------------------------------------------------------- report */

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
