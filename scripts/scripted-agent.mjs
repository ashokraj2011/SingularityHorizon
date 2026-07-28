#!/usr/bin/env node
/**
 * An ACP agent with no model behind it.
 *
 * It speaks the protocol properly — asks permission, writes through
 * `fs/write_text_file`, streams its reply as `agent_message_chunk` — but decides
 * what to do from the state of the working directory rather than from a model.
 * That makes a workflow run deterministic and free, which is what lets the
 * runtime's checkpoint, resume, loop and gate behaviour be asserted rather than
 * demonstrated once by hand.
 *
 * Behaviour, by what it finds in the workspace:
 *   design.md missing        → reply with a design note (the runtime writes it)
 *   src/sum.js missing       → write a deliberately broken implementation
 *   src/sum.js still broken  → repair it
 *   otherwise                → say there is nothing to do
 *
 * Keying off the workspace rather than a call counter matters: a resumed run
 * starts a fresh process, and a counter would restart with it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

let nextId = 5000
let cwd = process.cwd()
const pending = new Map()

function call(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function update(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}

const BROKEN = 'module.exports = (a, b) => a - b // BROKEN: should add\n'
const FIXED = 'module.exports = (a, b) => a + b\n'

async function act(sessionId) {
  const design = join(cwd, 'design.md')
  const impl = join(cwd, 'src', 'sum.js')

  if (!existsSync(design)) {
    const note =
      '# Design\n\nsum(a, b) must return a + b. Add src/sum.js and cover it with a test.'
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: note }
    })
    log('ACTED analyse')
    return
  }

  const current = existsSync(impl) ? readFileSync(impl, 'utf8') : null
  if (current === null || current.includes('BROKEN')) {
    const content = current === null ? BROKEN : FIXED
    const what = current === null ? 'implement (deliberately wrong)' : 'repair'

    // Ask first — this agent follows the protocol. Under a governed workflow
    // step the client answers from the standing grant rather than a card.
    const asked = await call('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: `write-${nextId}`,
        title: `Write src/sum.js (${what})`,
        kind: 'edit',
        status: 'pending',
        rawInput: { path: impl }
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
      ]
    })
    if (asked.result?.outcome?.outcome !== 'selected') {
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Refused permission to write.' }
      })
      return
    }

    const wrote = await call('fs/write_text_file', { sessionId, path: impl, content })
    log('WRITE', what, JSON.stringify(wrote.error ?? 'ok'))
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: wrote.error ? `Failed: ${wrote.error.message}` : `Done: ${what}` }
    })
    return
  }

  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Nothing to do.' }
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
        result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} }, authMethods: [] }
      })
      return
    case 'session/new':
      cwd = msg.params?.cwd ?? cwd
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'scripted-1' } })
      return
    case 'session/prompt':
      await act(msg.params.sessionId)
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
