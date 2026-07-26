/**
 * Verifies attachments end to end against the real agent: build blocks from
 * files/folders, send them, and confirm the model can read content it could not
 * have obtained any other way.
 *
 * Run with: npm run attach:check
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentSession } from '../src/main/acp/session'
import { resolveAgent } from '../src/main/agents'
import { buildAttachments } from '../src/main/attachments'
import type { MainEvent, SessionSnapshot } from '../src/shared/ipc'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* ------------------------------------------- unit: block construction */

const work = mkdtempSync(join(tmpdir(), 'eh-attach-'))
// Marker lives ONLY inside the attached file, and the session cwd is a
// different directory — so no tool could find it by searching. If the model
// reports it, the attachment genuinely carried the content.
const secretFile = join(work, 'secret-notes.txt')
writeFileSync(secretFile, 'The clearance codeword is ZEPHYR-8814.\n')

const binFile = join(work, 'blob.bin')
writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]))

const bigFile = join(work, 'big.txt')
writeFileSync(bigFile, 'x'.repeat(400 * 1024))

const folder = join(work, 'tree')
mkdirSync(join(folder, 'nested'), { recursive: true })
writeFileSync(join(folder, 'alpha.ts'), 'export const a = 1\n')
writeFileSync(join(folder, 'nested', 'beta.ts'), 'export const b = 2\n')
mkdirSync(join(folder, 'node_modules', 'junk'), { recursive: true })
writeFileSync(join(folder, 'node_modules', 'junk', 'no.js'), 'nope\n')

const built = await buildAttachments(
  [
    { path: secretFile, kind: 'file' },
    { path: binFile, kind: 'file' },
    { path: bigFile, kind: 'file' },
    { path: folder, kind: 'folder' },
    { path: join(work, 'does-not-exist.txt'), kind: 'file' }
  ],
  work
)

const textFileBlock = built.blocks.find(
  (b) => b.type === 'resource' && 'text' in b.resource && b.resource.text.includes('ZEPHYR')
)
ok('text file embedded as a resource block', !!textFileBlock)

const binBlock = built.blocks.find((b) => b.type === 'resource_link' && b.name === 'blob.bin')
ok('binary file referenced by link, not embedded as text', !!binBlock)
ok(
  'binary marked in its summary',
  built.summaries.find((s) => s.name === 'blob.bin')?.binary === true
)

const bigSummary = built.summaries.find((s) => s.name === 'big.txt')
ok('oversized file truncated', bigSummary?.truncated === true)
const bigBlock = built.blocks.find(
  (b) => b.type === 'resource' && 'text' in b.resource && b.resource.text.startsWith('xxx')
)
ok(
  'truncation is disclosed in the embedded text',
  !!bigBlock && bigBlock.type === 'resource' && 'text' in bigBlock.resource
    ? bigBlock.resource.text.includes('[truncated:')
    : false
)

const listing = built.blocks.find((b) => b.type === 'text' && b.text.includes('Attached folder'))
ok('folder produced a listing block', !!listing)
const listingText = listing && listing.type === 'text' ? listing.text : ''
ok('folder listing includes nested files', listingText.includes('beta.ts'))
ok('folder listing excludes node_modules', !listingText.includes('no.js'))

const missing = built.summaries.find((s) => s.name === 'does-not-exist.txt')
ok('missing file reported as an error, not a crash', !!missing?.error)
ok(
  'a failed attachment does not block the others',
  built.summaries.filter((s) => !s.error).length === 4
)

/* --------------------------------------- integration: does the model see it */

const sessionCwd = mkdtempSync(join(tmpdir(), 'eh-attach-cwd-'))
writeFileSync(join(sessionCwd, 'unrelated.md'), '# nothing useful here\n')

const agent = await resolveAgent('copilot')
const session = new AgentSession(agent, sessionCwd)
let snapshot: SessionSnapshot = session.getSnapshot()

session.on('event', (e: MainEvent) => {
  if (e.type === 'session:blocks') snapshot = { ...snapshot, blocks: e.blocks }
  if (e.type === 'session:patch') snapshot = { ...snapshot, ...e.patch }
  if (e.type === 'session:blocks') {
    for (const b of e.blocks) {
      if (b.kind === 'permission' && !b.request.resolvedOptionId && !b.request.cancelled) {
        const allow =
          b.request.options.find((o) => o.kind === 'allow_always') ?? b.request.options[0]
        session.resolvePermission(b.request.requestId, allow?.optionId ?? null)
      }
    }
  }
})

const timer = setTimeout(() => {
  console.error('✗ timed out')
  session.dispose()
  process.exit(1)
}, 240_000)

await session.start()

await session.prompt({
  text: 'What is the clearance codeword? Reply with just the codeword.',
  attachments: [{ path: secretFile, kind: 'file' }]
})

const answer = snapshot.blocks
  .filter((b) => b.kind === 'assistant')
  .map((b) => (b as { text: string }).text)
  .join(' ')

ok('model read the attached file content', /ZEPHYR-8814/i.test(answer), answer.slice(0, 140))

const userBlock = snapshot.blocks.find((b) => b.kind === 'user') as
  | { attachments?: Array<{ name: string }> }
  | undefined
ok('attachment recorded on the user block', userBlock?.attachments?.length === 1)
ok(
  'transcript names the attached file',
  userBlock?.attachments?.[0]?.name === 'secret-notes.txt'
)

/* ------------------------------- integration: silent commands stay silent */

const blocksBefore = snapshot.blocks.length
const contextText = await session.runCommandSilent('/context')
ok('silent /context returned text', contextText.length > 0, `${contextText.length} chars`)
ok(
  'silent command added nothing to the transcript',
  snapshot.blocks.length === blocksBefore,
  `${blocksBefore} -> ${snapshot.blocks.length}`
)

await session.refreshContext()
ok('context parsed into the snapshot', snapshot.context !== undefined)
ok(
  'context has a sane total window',
  (snapshot.context?.totalTokens ?? 0) > 1000,
  String(snapshot.context?.totalTokens)
)
ok('usage parsed into the snapshot', snapshot.usage !== undefined)
ok(
  'usage reports input tokens',
  (snapshot.usage?.inputTokens ?? 0) > 0,
  String(snapshot.usage?.inputTokens)
)

clearTimeout(timer)
session.dispose()

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
if (snapshot.context) {
  console.log(
    `\ncontext: ${snapshot.context.usedTokens}/${snapshot.context.totalTokens} ` +
      `(${snapshot.context.percent}%), ${snapshot.context.slices.length} slices`
  )
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300)
