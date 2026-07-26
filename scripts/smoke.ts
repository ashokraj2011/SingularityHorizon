/**
 * Headless end-to-end smoke test of the ACP layer.
 *
 * Spawns the real agent, runs one prompt that forces a tool call, auto-approves
 * the permission request, and asserts that every stage of the pipeline produced
 * what the UI depends on. Run with: npm run smoke
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentSession } from '../src/main/acp/session'
import { resolveAgent } from '../src/main/agents'
import type { MainEvent, SessionSnapshot } from '../src/shared/ipc'

const AGENT_ID = process.env.SMOKE_AGENT ?? 'copilot'
const TIMEOUT_MS = 180_000

function log(...args: unknown[]): void {
  console.log('·', ...args)
}

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-smoke-'))
  writeFileSync(join(cwd, 'greeting.txt'), 'hello world\n')
  log('workspace', cwd)

  const agent = await resolveAgent(AGENT_ID)
  log('agent binary', agent.command)

  const session = new AgentSession(agent, cwd)
  let snapshot: SessionSnapshot = session.getSnapshot()

  let sawThought = false
  let sawToolCall = false
  let sawCompletedTool = false
  let sawPermission = false
  let stopReason = ''

  session.on('event', (event: MainEvent) => {
    if (event.type === 'session:blocks') {
      snapshot = { ...snapshot, blocks: event.blocks }
      for (const block of event.blocks) {
        if (block.kind === 'thought') sawThought = true
        if (block.kind === 'tool') {
          sawToolCall = true
          if (block.call.status === 'completed') sawCompletedTool = true
        }
        if (block.kind === 'permission' && !block.request.resolvedOptionId && !block.request.cancelled) {
          sawPermission = true
          const allow =
            block.request.options.find((o) => o.kind === 'allow_always') ??
            block.request.options.find((o) => o.kind === 'allow_once') ??
            block.request.options[0]
          log('approving:', block.request.toolCall.title, '->', allow?.name)
          session.resolvePermission(block.request.requestId, allow?.optionId ?? null)
        }
      }
    }
    if (event.type === 'session:patch') snapshot = { ...snapshot, ...event.patch }
    if (event.type === 'session:turnEnded') stopReason = event.stopReason
  })

  const timer = setTimeout(() => {
    console.error('✗ timed out')
    session.dispose()
    process.exit(1)
  }, TIMEOUT_MS)

  await session.start()
  log('handshake ok —', snapshot.agentName, snapshot.agentVersion)
  log('acp session', snapshot.acpSessionId)
  log('models', snapshot.models.length, '| config options', snapshot.configOptions.length)
  log('commands advertised', snapshot.commands.length)

  await session.prompt({
    text: 'Use a shell command to append a line reading "goodbye" to greeting.txt in the current directory. Then tell me the final contents.'
  })

  clearTimeout(timer)

  const finalFile = readFileSync(join(cwd, 'greeting.txt'), 'utf8')
  const assistantText = snapshot.blocks
    .filter((b) => b.kind === 'assistant')
    .map((b) => (b as { text: string }).text)
    .join('\n')

  const checks: Array<[string, boolean]> = [
    ['handshake produced an ACP sessionId', !!snapshot.acpSessionId],
    ['agent advertised models', snapshot.models.length > 0],
    ['agent advertised config options', snapshot.configOptions.length > 0],
    ['agent advertised slash commands', snapshot.commands.length > 0],
    ['streamed assistant text', assistantText.trim().length > 0],
    ['emitted a tool call', sawToolCall],
    ['tool call reached completed', sawCompletedTool],
    ['requested permission', sawPermission],
    ['turn ended with end_turn', stopReason === 'end_turn'],
    ['the file was actually modified on disk', finalFile.includes('goodbye')],
    ['session returned to idle', snapshot.status === 'idle']
  ]

  console.log('\n--- results ---')
  let failed = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`)
    if (!ok) failed++
  }
  console.log(`\nthought chunks streamed: ${sawThought}`)
  console.log(`blocks in thread: ${snapshot.blocks.length}`)
  console.log(`greeting.txt now:\n${finalFile}`)

  session.dispose()
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300)
}

main().catch((err) => {
  console.error('✗ smoke failed:', err)
  process.exit(1)
})
