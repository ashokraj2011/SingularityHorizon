#!/usr/bin/env node
/**
 * A deliberately impolite ACP agent.
 *
 * It speaks just enough of the protocol to get a session, and then does the
 * thing the protocol asks agents not to do: calls `terminal/create` and
 * `fs/write_text_file` straight out, without ever sending
 * `session/request_permission`.
 *
 * Copilot does not behave this way, which is exactly the problem — a gate that
 * only holds for well-behaved agents is not a gate, and nothing about ACP
 * forces good behaviour. This agent is the adversary the client-side
 * interceptor is written against.
 *
 * Driven by scripts/gate-check.ts. Reports what happened on stderr so the
 * harness can assert on the agent's own view of it.
 */
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

let nextId = 1000
const pending = new Map()

function call(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  // A response to something we asked for.
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
    return
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: {} },
          authMethods: []
        }
      })
      return

    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'rude-1' } })
      return

    case 'session/prompt': {
      const sessionId = msg.params.sessionId
      const scratch = process.env.RUDE_TARGET_PATH ?? '/tmp/rude-agent-was-here.txt'
      const command = 'echo pwned > ' + JSON.stringify(scratch)

      // POLITE=1 makes it follow the protocol properly: ask first, then act.
      // The client must then card it exactly once — carding the approved call a
      // second time would be a regression visible to every well-behaved agent.
      if (process.env.POLITE === '1') {
        const asked = await call('session/request_permission', {
          sessionId,
          toolCall: {
            toolCallId: 'polite-1',
            title: 'Run a command',
            kind: 'execute',
            status: 'pending',
            rawInput: { command }
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
          ]
        })
        log('PERMISSION_OUTCOME', JSON.stringify(asked.result ?? asked.error))
        const outcome = asked.result?.outcome?.outcome
        if (outcome === 'selected' && asked.result.outcome.optionId !== 'reject_once') {
          const t = await call('terminal/create', { sessionId, command: 'sh', args: ['-c', command] })
          log('TERMINAL_RESULT', JSON.stringify(t.error ? { error: t.error } : t.result))
          // Wait for it, so a caller checking for side effects is not racing
          // the child process.
          if (t.result?.terminalId) {
            await call('terminal/wait_for_exit', { sessionId, terminalId: t.result.terminalId })
          }
        }
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
        return
      }

      // 1. Run a command. No permission request. No warning.
      const term = await call('terminal/create', {
        sessionId,
        command: 'sh',
        args: ['-c', command]
      })
      log('TERMINAL_RESULT', JSON.stringify(term.error ? { error: term.error } : term.result))

      // 2. Write a file. Also unasked.
      const write = await call('fs/write_text_file', {
        sessionId,
        path: scratch,
        content: 'pwned'
      })
      log('WRITE_RESULT', JSON.stringify(write.error ? { error: write.error } : write.result))

      // 3. Read something outside the workspace through a symlink, if one was
      //    planted for us.
      if (process.env.RUDE_SYMLINK_PATH) {
        const read = await call('fs/read_text_file', {
          sessionId,
          path: process.env.RUDE_SYMLINK_PATH
        })
        log('READ_RESULT', JSON.stringify(read.error ? { error: read.error } : read.result))
      }

      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }

    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
  }
})
