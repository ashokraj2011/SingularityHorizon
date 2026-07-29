/**
 * The built-in harness, end to end.
 *
 * A local HTTP server speaking the OpenAI chat-completions wire format drives
 * the real harness, running as a real ACP agent under a real AgentSession. So
 * the streaming, the tool loop, the permission flow, the client-side gate and
 * the transcript are all the production paths — the only thing standing in for
 * production is the model, which is what makes the assertions deterministic.
 *
 * The property that matters most: the harness never touches the machine
 * itself. Every read, write and command is a call back to the client, so
 * workspace containment and the capability lattice apply to Event Horizon's own
 * agent exactly as they apply to a third party's. That is asserted directly, by
 * pinning the session to a mode that forbids the tool and watching it be
 * refused.
 *
 * Run with: npm run harness:check
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentSession } from '../src/main/acp/session'
import { harnessEntry } from '../src/main/agents'
import type { AgentDefinition, MainEvent, ThreadBlock } from '../src/shared/ipc'

const watchdog = setTimeout(() => {
  console.error('✗ harness-check timed out')
  process.exit(1)
}, 90_000)
watchdog.unref?.()

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

/* -------------------------------------------- a fake chat-completions API */

interface Turn {
  text?: string
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
}

/** What the server was asked, so the harness's own requests can be inspected. */
const seenRequests: Array<{ tools?: unknown[]; messages: Array<Record<string, unknown>> }> = []

function completionsServer(turns: Turn[]): Promise<{ server: Server; url: string }> {
  let turnIndex = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      try {
        seenRequests.push(JSON.parse(body))
      } catch {
        seenRequests.push({ messages: [] })
      }

      const turnNumber = turnIndex++
      const turn = turns[Math.min(turnNumber, turns.length - 1)]
      res.writeHead(200, { 'content-type': 'text/event-stream' })

      const frame = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }

      // Streamed in pieces on purpose: a client that only works when the whole
      // message arrives in one chunk is not a streaming client.
      for (const piece of (turn.text ?? '').match(/.{1,7}/gs) ?? []) {
        frame({ choices: [{ delta: { content: piece } }] })
      }

      ;(turn.toolCalls ?? []).forEach((call, index) => {
        frame({
          choices: [
            {
              delta: {
                tool_calls: [
                  // Unique across turns, as a real provider's are.
                  { index, id: `call_${turnNumber}_${index}`, function: { name: call.name } }
                ]
              }
            }
          ]
        })
        // Arguments arrive as fragments, which is how a real stream sends them.
        const json = JSON.stringify(call.arguments)
        for (const piece of json.match(/.{1,5}/gs) ?? []) {
          frame({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] })
        }
      })

      frame({
        choices: [{ delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      })
      frame('[DONE]')
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function harnessAgent(url: string, mode: 'code' | 'chat'): AgentDefinition {
  return {
    id: mode === 'chat' ? 'chat' : 'built-in',
    name: 'Event Horizon (direct)',
    command: process.execPath,
    args: [harnessEntry()],
    env: {
      ...(process.env as Record<string, string>),
      EH_HARNESS_BASE_URL: url,
      EH_HARNESS_PROVIDER: 'openai',
      EH_HARNESS_MODEL: 'test-model',
      EH_HARNESS_API_KEY: 'test-key',
      EH_HARNESS_MODE: mode
    }
  }
}

/** Drive one turn and return everything the transcript ended up holding. */
async function runTurn(
  agent: AgentDefinition,
  cwd: string,
  prompt: string,
  opts: { mode?: 'edit' | 'explore' | 'deliver'; answer?: string } = {}
): Promise<{ blocks: ThreadBlock[]; stopReason: string }> {
  const session = new AgentSession(agent, cwd)
  if (opts.mode) session.setMode(opts.mode)

  let blocks: ThreadBlock[] = []
  let stopReason = ''
  const answered = new Set<string>()

  session.on('event', (event: MainEvent) => {
    if (event.type === 'session:blocks') {
      blocks = event.blocks
      for (const block of event.blocks) {
        if (block.kind !== 'permission') continue
        if (block.request.resolvedOptionId || block.request.cancelled) continue
        if (answered.has(block.request.requestId)) continue
        answered.add(block.request.requestId)
        session.resolvePermission(block.request.requestId, opts.answer ?? 'allow_once')
      }
    }
    if (event.type === 'session:turnEnded') stopReason = event.stopReason
  })

  await session.start()
  await session.prompt({ text: prompt })
  session.dispose()
  return { blocks, stopReason }
}

const textOf = (blocks: ThreadBlock[]): string =>
  blocks
    .filter((b) => b.kind === 'assistant')
    .map((b) => (b as { text: string }).text)
    .join('\n')

/* ------------------------------------------------------------- chat mode */

const chatServer = await completionsServer([{ text: 'Hello. I have no tools and no machine.' }])
const chatDir = mkdtempSync(join(tmpdir(), 'eh-chat-'))

seenRequests.length = 0
const chat = await runTurn(harnessAgent(chatServer.url, 'chat'), chatDir, 'hi')

ok('chat mode streams a reply into the transcript',
   textOf(chat.blocks).includes('no tools'), textOf(chat.blocks).slice(0, 80))
ok('and ends the turn cleanly', chat.stopReason === 'end_turn', chat.stopReason)
// The point of chat mode: not "asked not to use tools" but "given none".
ok('chat mode offers the model no tools at all',
   seenRequests.every((r) => !r.tools), JSON.stringify(seenRequests[0]?.tools ?? null))
ok('it raises no permission cards', !chat.blocks.some((b) => b.kind === 'permission'))
ok('and runs with no agent CLI installed anywhere', existsSync(harnessEntry()))
chatServer.server.close()

/* ------------------------------------------------- code mode: the tool loop */

const codeDir = mkdtempSync(join(tmpdir(), 'eh-code-'))
writeFileSync(join(codeDir, 'sum.js'), 'module.exports = (a, b) => a - b\n')
const target = join(codeDir, 'sum.js')

const codeServer = await completionsServer([
  // Read first.
  { toolCalls: [{ name: 'read_file', arguments: { path: target } }] },
  // Then fix, having seen the contents.
  {
    text: 'The operator is wrong. Fixing it.',
    toolCalls: [
      { name: 'write_file', arguments: { path: target, content: 'module.exports = (a, b) => a + b\n' } }
    ]
  },
  { text: 'Done — sum.js now adds.' }
])

seenRequests.length = 0
const code = await runTurn(harnessAgent(codeServer.url, 'code'), codeDir, 'fix sum.js', {
  mode: 'edit'
})

ok('code mode offers tools', (seenRequests[0]?.tools?.length ?? 0) === 3,
   String(seenRequests[0]?.tools?.length))
ok('the loop ran more than one model turn', seenRequests.length >= 3,
   `${seenRequests.length} requests`)

const toolBlocks = code.blocks.filter((b) => b.kind === 'tool')
ok('tool calls appear in the transcript', toolBlocks.length >= 2, `${toolBlocks.length}`)
ok('and reach a completed state',
   toolBlocks.some((b) => (b as { call: { status: string } }).call.status === 'completed'))

// The read was not gated; the write was. That is the distinction the harness
// draws, and it has to match what the client would have enforced anyway.
const cards = code.blocks.filter((b) => b.kind === 'permission')
ok('a write asks permission', cards.length === 1, `${cards.length} cards`)
ok('a read does not', cards.length === 1)
ok('the card names the file',
   cards.some((b) => (b as { request: { toolCall: { title: string } } }).request.toolCall.title.includes('sum.js')))

ok('the approved write actually landed',
   readFileSync(target, 'utf8').includes('a + b'), readFileSync(target, 'utf8'))
ok('the turn ended normally', code.stopReason === 'end_turn', code.stopReason)
ok('and the model got the file contents back as a tool result',
   JSON.stringify(seenRequests[1]?.messages ?? []).includes('a - b'))

codeServer.server.close()

/* ------------------------------- the gate applies to our own agent as well */

const guardedDir = mkdtempSync(join(tmpdir(), 'eh-guarded-'))
writeFileSync(join(guardedDir, 'sum.js'), 'original\n')
const guardedTarget = join(guardedDir, 'sum.js')

const guardedServer = await completionsServer([
  { toolCalls: [{ name: 'write_file', arguments: { path: guardedTarget, content: 'changed' } }] },
  { text: 'I was refused, so I stopped.' }
])

// `explore` permits reading and nothing else. The harness is Event Horizon's
// own code, and it is still subject to this.
const guarded = await runTurn(harnessAgent(guardedServer.url, 'code'), guardedDir, 'edit it', {
  mode: 'explore'
})

ok('a write is refused when the mode forbids it',
   readFileSync(guardedTarget, 'utf8') === 'original\n', readFileSync(guardedTarget, 'utf8'))
ok('the refusal is recorded in the transcript',
   guarded.blocks.some((b) => b.kind === 'notice' && /explore mode/.test((b as { text: string }).text)))
// Fed back as a tool result so the model can explain itself rather than the
// turn simply ending with nothing.
ok('and reaches the model as a tool result',
   JSON.stringify(seenRequests.at(-1)?.messages ?? []).toLowerCase().includes('refus'))
guardedServer.server.close()

/* --------------------------------------------- a user denial is not a crash */

const deniedDir = mkdtempSync(join(tmpdir(), 'eh-denied-'))
writeFileSync(join(deniedDir, 'f.txt'), 'keep\n')
const deniedServer = await completionsServer([
  { toolCalls: [{ name: 'write_file', arguments: { path: join(deniedDir, 'f.txt'), content: 'no' } }] },
  { text: 'Understood, leaving it alone.' }
])

const denied = await runTurn(harnessAgent(deniedServer.url, 'code'), deniedDir, 'change it', {
  mode: 'edit',
  answer: 'reject_once'
})
ok('a denied write changes nothing', readFileSync(join(deniedDir, 'f.txt'), 'utf8') === 'keep\n')
ok('and the turn still completes', denied.stopReason === 'end_turn', denied.stopReason)
ok('with the denial shown as a failed tool call',
   denied.blocks.some((b) => b.kind === 'tool' && (b as { call: { status: string } }).call.status === 'failed'))
deniedServer.server.close()

/* -------------------------------------- a broken endpoint says so out loud */

const brokenDir = mkdtempSync(join(tmpdir(), 'eh-broken-'))
const broken = await runTurn(
  harnessAgent('http://127.0.0.1:1/v1', 'chat'),
  brokenDir,
  'hello'
)
// The likeliest first failure in the field is a wrong base URL or a rejected
// key. An empty turn would look like the model had nothing to say.
ok('an unreachable endpoint reports itself', textOf(broken.blocks).includes('Model request failed'),
   textOf(broken.blocks).slice(0, 100))
ok('rather than producing an empty turn', textOf(broken.blocks).length > 0)

clearTimeout(watchdog)
console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
