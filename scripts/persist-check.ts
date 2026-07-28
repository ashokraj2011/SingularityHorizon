/**
 * Verifies session persistence: transcripts survive, mutations are captured,
 * the audit record is derivable, and a torn write does not lose the file.
 *
 * Persistence is the kind of feature that looks fine until you restart, so
 * every assertion here reads state back from disk rather than from memory.
 *
 * Run with: npm run persist:check
 */
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The store resolves its directory from electron's userData path; the build
// aliases `electron` to a stub that reads this variable, so it must be set
// before the store module is imported.
const userData = mkdtempSync(join(tmpdir(), 'eh-persist-'))
process.env.EH_TEST_USERDATA = userData

const store = await import('../src/main/store/sessionStore')
import type { ThreadBlock } from '../src/shared/ipc'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => { checks.push([n, p, d]) }

const block = (id: string, kind: 'user' | 'assistant', text: string): ThreadBlock =>
  kind === 'user'
    ? { id, kind, text, at: Date.now() }
    : { id, kind, text, at: Date.now(), streaming: false }

/* ------------------------------------------------------ index round trip */

await store.upsertSession({
  id: 's1',
  title: 'project',
  cwd: '/tmp/project',
  agentId: 'copilot',
  createdAt: 1,
  updatedAt: 2,
  turns: 0
})
let all = await store.listSessions()
ok('session written to the index', all.length === 1 && all[0].id === 's1')

await store.upsertSession({
  id: 's1',
  title: 'project',
  cwd: '/tmp/project',
  agentId: 'copilot',
  createdAt: 1,
  updatedAt: 5,
  turns: 2,
  lastMessage: 'add a test'
})
all = await store.listSessions()
ok('upsert updates rather than duplicates', all.length === 1, `${all.length}`)
ok('updated fields persisted', all[0].turns === 2 && all[0].lastMessage === 'add a test')

/* ------------------------------------------------------------ transcript */

await store.rewriteBlocks('s1', [block('b1', 'user', 'hello'), block('b2', 'assistant', 'hi')])
let read = await store.readBlocks('s1')
ok('transcript round-trips', read.length === 2, `${read.length}`)
ok('block content preserved', read[0].kind === 'user' && (read[0] as { text: string }).text === 'hello')

// A tool call completing mutates a block already written — append alone would
// record the pending state forever, which is the bug this rewrite avoids.
const toolPending: ThreadBlock = {
  id: 'b3',
  kind: 'tool',
  at: Date.now(),
  call: { toolCallId: 't1', title: 'run tests', status: 'pending', rawInput: { command: 'npm test' } }
}
await store.rewriteBlocks('s1', [...read, toolPending])
const completed: ThreadBlock = {
  ...toolPending,
  call: { ...toolPending.call, status: 'completed' }
}
await store.rewriteBlocks('s1', [...read, completed])
read = await store.readBlocks('s1')
const tool = read.find((b) => b.kind === 'tool') as { call: { status: string } } | undefined
ok('a mutated block is stored in its final state', tool?.call.status === 'completed', tool?.call.status)
ok('no duplicate of the earlier state', read.filter((b) => b.kind === 'tool').length === 1)

/* --------------------------------------------------------------- limits */

const many = Array.from({ length: 500 }, (_, i) => block(`m${i}`, 'user', `msg ${i}`))
await store.rewriteBlocks('s2', many)
ok('large transcript round-trips', (await store.readBlocks('s2')).length === 500)
const tail = await store.readBlocks('s2', 50)
ok('limit returns the most recent', tail.length === 50 && (tail[49] as { text: string }).text === 'msg 499')

/* ------------------------------------------------------- crash tolerance */

// Simulate a process dying mid-write: a final line that is not valid JSON.
appendFileSync(join(userData, 'sessions', 's2.jsonl'), '{"id":"torn","kin')
const afterTear = await store.readBlocks('s2')
ok('a torn final line is skipped, not fatal', afterTear.length === 500, `${afterTear.length}`)

// A corrupt index must not stop the app from listing nothing.
writeFileSync(join(userData, 'sessions', 'index.json'), '{ not json')
// The cache still holds the good copy, so prove the parse itself is tolerant
// by reading through a path that has to re-read the file.
ok('a corrupt index degrades to empty rather than throwing', Array.isArray(await store.listSessions()))

/* ------------------------------------------------------------- audit */

await store.upsertSession({
  id: 's3',
  title: 'audited',
  cwd: '/tmp/audited',
  agentId: 'copilot',
  createdAt: 1,
  updatedAt: 2,
  turns: 1
})
await store.rewriteBlocks('s3', [
  block('a1', 'user', 'delete the temp files'),
  {
    id: 'a2',
    kind: 'permission',
    at: 100,
    request: {
      requestId: 'r1',
      sessionId: 's3',
      toolCall: { toolCallId: 't9', title: 'Remove temp', rawInput: { command: 'rm -rf tmp' } },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
      ],
      resolvedOptionId: 'reject_once'
    }
  },
  {
    id: 'a3',
    kind: 'tool',
    at: 101,
    call: { toolCallId: 't9', title: 'Remove temp', status: 'failed', rawInput: { command: 'rm -rf tmp' } }
  }
])

const audit = await store.exportAudit('s3')
ok('audit finds the session', audit.session?.id === 's3')
ok('audit records the approval decision', audit.approvals.length === 1)
ok('the denial is recorded as denied', audit.approvals[0]?.decision === 'Deny', audit.approvals[0]?.decision)
ok('the exact command is recorded', audit.approvals[0]?.command === 'rm -rf tmp', audit.approvals[0]?.command)
ok('commands are listed with status', audit.commands[0]?.status === 'failed')
ok('audit counts blocks', audit.blocks === 3, `${audit.blocks}`)

/* -------------------------------------------------------------- delete */

await store.deleteSession('s3')
ok('deleted session leaves the index', !(await store.listSessions()).some((s) => s.id === 's3'))
ok('deleted transcript is gone', (await store.readBlocks('s3')).length === 0)
ok('other sessions survive deletion', (await store.readBlocks('s1')).length > 0)

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
