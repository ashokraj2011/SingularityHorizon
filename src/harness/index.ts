import { createInterface } from 'node:readline'

import { configFromEnv, streamChat, type ChatMessage, type ToolSchema } from './llm'

/**
 * Event Horizon's own coding harness — and its plain chat surface.
 *
 * It is written as a real ACP agent rather than as a special case inside the
 * app, and that is the whole design. Everything downstream already works
 * against ACP: the transcript, tool cards, the client-side permission gate, the
 * workflow runtime, persistence, the audit export. Making the built-in harness
 * speak the same protocol means none of that needs a second code path, and it
 * means the gate applies to our own agent exactly as it applies to a third
 * party's — which is the only honest way to ship one.
 *
 * The consequence worth stating plainly: this process never touches the
 * filesystem or spawns a shell. Every tool is a call back to the client —
 * `fs/read_text_file`, `fs/write_text_file`, `terminal/*` — so workspace
 * containment, the capability lattice, and any injected constraint all hold.
 * A harness that read files directly would be faster and would quietly opt
 * itself out of every guarantee the client makes.
 *
 * Two modes, one loop:
 *   code — the tools below are offered, and the model can work
 *   chat — no tools are offered at all, so it is a plain LLM chat window that
 *          cannot reach the machine even if it decides it would like to
 */

/**
 * Coding or plain chat, switchable mid-session.
 *
 * Advertised as an ACP config option rather than baked into which agent you
 * picked, so the composer renders the toggle from what the agent declares and
 * no UI knows this harness exists. Switching takes effect on the next prompt —
 * it changes what is offered to the model, not anything already in flight.
 */
let mode: 'code' | 'chat' = (process.env.EH_HARNESS_MODE ?? 'code') as 'code' | 'chat'
const MAX_STEPS = Number(process.env.EH_HARNESS_MAX_STEPS ?? 12)

const MODE_OPTION = {
  type: 'select',
  id: 'harness_mode',
  name: 'Mode',
  description: 'Coding gives the model tools. Chat gives it none at all.',
  category: 'behaviour',
  options: [
    { optionId: 'code', name: 'Coding' },
    { optionId: 'chat', name: 'Chat' }
  ]
}

const send = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

let nextId = 1
const pending = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>()

/** Call the client and wait for its answer. */
function call<T = unknown>(method: string, params: unknown): Promise<T> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if (msg.error) reject(new Error(msg.error.message ?? 'client refused'))
      else resolve(msg.result as T)
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } })
}

/* -------------------------------------------------------------------- tools */

const TOOLS: ToolSchema[] = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file. Absolute path inside the workspace. Prefer reading before editing.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description:
      'Write a UTF-8 text file, replacing its contents. Absolute path inside the workspace. ' +
      'Requires the user to approve.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path' },
        content: { type: 'string', description: 'Full new contents of the file' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the workspace and return its exit code and output. ' +
      'Requires the user to approve.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to run' } },
      required: ['command']
    }
  }
]

/** Which tools change something, and therefore need an answer before running. */
const CONSEQUENTIAL = new Set(['write_file', 'bash'])

const KIND: Record<string, string> = { read_file: 'read', write_file: 'edit', bash: 'execute' }

function describe(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
      return `Read ${String(args.path ?? '')}`
    case 'write_file':
      return `Write ${String(args.path ?? '')}`
    case 'bash':
      return String(args.command ?? 'Run a command')
    default:
      return name
  }
}

/**
 * Ask before doing anything consequential.
 *
 * The client gate would stop an unapproved call anyway — that is what M1 is
 * for — but being refused without having asked wastes a turn and reads to the
 * user as the harness misbehaving. Asking is also what makes the transcript
 * show an approval rather than a denial.
 */
async function permitted(
  sessionId: string,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const outcome = await call<{ outcome?: { outcome?: string; optionId?: string } }>(
    'session/request_permission',
    {
      sessionId,
      toolCall: {
        toolCallId,
        title: describe(name, args),
        kind: KIND[name] ?? 'other',
        status: 'pending',
        rawInput: args
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
      ]
    }
  ).catch(() => null)

  const chosen = outcome?.outcome
  return chosen?.outcome === 'selected' && chosen.optionId !== 'reject_once'
}

/** Run one tool through the client. Never touches the machine directly. */
async function runTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case 'read_file': {
      const res = await call<{ content?: string }>('fs/read_text_file', {
        sessionId,
        path: String(args.path ?? '')
      })
      return res?.content ?? ''
    }

    case 'write_file': {
      await call('fs/write_text_file', {
        sessionId,
        path: String(args.path ?? ''),
        content: String(args.content ?? '')
      })
      return `Wrote ${String(args.path ?? '')}`
    }

    case 'bash': {
      const created = await call<{ terminalId: string }>('terminal/create', {
        sessionId,
        command: 'sh',
        args: ['-c', String(args.command ?? '')]
      })
      const exit = await call<{ exitStatus?: { exitCode?: number } }>('terminal/wait_for_exit', {
        sessionId,
        terminalId: created.terminalId
      })
      const out = await call<{ output?: string }>('terminal/output', {
        sessionId,
        terminalId: created.terminalId
      })
      await call('terminal/release', { sessionId, terminalId: created.terminalId }).catch(() => {})
      const code = exit?.exitStatus?.exitCode ?? 0
      // Bounded: a command that prints a hundred megabytes must not become a
      // hundred megabytes of context on the next request.
      const body = (out?.output ?? '').slice(-8000)
      return `exit code ${code}\n${body}`
    }

    default:
      return `Unknown tool: ${name}`
  }
}

/* --------------------------------------------------------------- the loop */

const SYSTEM_CODE =
  'You are a coding agent working in the user\'s repository. Use the tools to read before you ' +
  'edit, make the smallest change that solves the problem, and say what you did. Every write ' +
  'and every command is approved by the user first and may be refused — if one is, say so and ' +
  'stop rather than trying another way around it.'

const SYSTEM_CHAT =
  'You are a helpful assistant. You have no tools and no access to the user\'s machine.'

const history = new Map<string, ChatMessage[]>()

async function handlePrompt(sessionId: string, promptText: string): Promise<string> {
  const cfg = configFromEnv()
  const messages = history.get(sessionId) ?? []
  // The system message tracks the mode rather than being fixed at session
  // start: a session switched to chat should stop being told it has tools.
  const system = mode === 'chat' ? SYSTEM_CHAT : SYSTEM_CODE
  if (messages[0]?.role === 'system') messages[0] = { role: 'system', content: system }
  else messages.unshift({ role: 'system', content: system })
  messages.push({ role: 'user', content: promptText })
  history.set(sessionId, messages)

  for (let step = 0; step < MAX_STEPS; step++) {
    let text = ''
    const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
    let stop: string | undefined

    for await (const event of streamChat(cfg, {
      model: cfg.model,
      messages,
      tools: mode === 'chat' ? undefined : TOOLS
    })) {
      if (event.text) {
        text += event.text
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.text }
        })
      }
      if (event.toolCall) calls.push(event.toolCall)
      if (event.stopReason) stop = event.stopReason
    }

    messages.push({ role: 'assistant', content: text, toolCalls: calls.length ? calls : undefined })

    // Nothing to run: the model has said its piece.
    if (!calls.length) return stop === 'length' ? 'max_tokens' : 'end_turn'

    for (const invocation of calls) {
      const title = describe(invocation.name, invocation.arguments)
      // Namespaced by step. Providers number tool calls from zero within a
      // response, so two steps both produce `call_0` and the transcript would
      // fold two different actions into one card. The provider's own id is
      // still what goes back in the tool result.
      const cardId = `s${step}-${invocation.id}`
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: cardId,
        title,
        kind: KIND[invocation.name] ?? 'other',
        status: 'pending',
        rawInput: invocation.arguments
      })

      let result: string
      let failed = false

      if (CONSEQUENTIAL.has(invocation.name)) {
        const allowed = await permitted(sessionId, cardId, invocation.name, invocation.arguments)
        if (!allowed) {
          result = 'The user declined this action.'
          failed = true
        } else {
          try {
            result = await runTool(sessionId, invocation.name, invocation.arguments)
          } catch (error) {
            // A refusal from the client gate arrives here. Feeding it back as a
            // tool result rather than throwing lets the model explain itself
            // and stop, instead of the turn ending with no account of why.
            result = `Refused: ${(error as Error).message}`
            failed = true
          }
        }
      } else {
        try {
          result = await runTool(sessionId, invocation.name, invocation.arguments)
        } catch (error) {
          result = `Failed: ${(error as Error).message}`
          failed = true
        }
      }

      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: cardId,
        status: failed ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: result.slice(0, 4000) } }]
      })

      messages.push({
        role: 'tool',
        toolCallId: invocation.id,
        name: invocation.name,
        content: result
      })
    }
  }

  // Out of steps. Said out loud rather than returned as a normal ending: a loop
  // that quietly gives up looks exactly like one that finished.
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: `\n\n_Stopped after ${MAX_STEPS} tool steps without finishing._`
    }
  })
  return 'max_turn_requests'
}

/* ------------------------------------------------------------------- ACP */

createInterface({ input: process.stdin }).on('line', (line: string) => {
  if (!line.trim()) return
  let msg: {
    id?: number
    method?: string
    params?: Record<string, unknown>
    result?: unknown
    error?: { message?: string }
  }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  // Method first: an answer to something we asked has an id but no method, and
  // the two id spaces are independent.
  if (msg.method === undefined && msg.id !== undefined) {
    const waiter = pending.get(msg.id)
    if (waiter) {
      pending.delete(msg.id)
      waiter(msg)
    }
    return
  }

  const reply = (result: unknown): void => send({ jsonrpc: '2.0', id: msg.id, result })

  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: true } },
        authMethods: []
      })
      return

    case 'session/new': {
      const cfg = configFromEnv()
      // Every model the configured endpoint lists, so the existing model picker
      // works against a gateway exactly as it does against a vendor CLI.
      const listed = (process.env.EH_HARNESS_MODELS ?? cfg.model)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
      const available = listed.length ? listed : [cfg.model]
      reply({
        sessionId: `eh-${Date.now().toString(36)}`,
        models: {
          availableModels: available.map((m) => ({ modelId: m, name: m })),
          currentModelId: cfg.model
        },
        configOptions: [{ ...MODE_OPTION, currentValue: mode }]
      })
      return
    }

    case 'session/set_config_option': {
      const configId = String(msg.params?.configId ?? msg.params?.optionId ?? '')
      const value = String(msg.params?.value ?? '')
      if (configId === 'harness_mode' && (value === 'code' || value === 'chat')) {
        mode = value
        reply({})
        // Broadcast so the picker reflects the change even if it came from
        // somewhere other than the picker.
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: String(msg.params?.sessionId ?? ''),
            update: {
              sessionUpdate: 'config_option_update',
              configOptions: [{ ...MODE_OPTION, currentValue: mode }]
            }
          }
        })
        return
      }
      if (configId === 'model') {
        process.env.EH_HARNESS_MODEL = value
        reply({})
        return
      }
      reply({})
      return
    }

    case 'session/prompt': {
      const sessionId = String(msg.params?.sessionId ?? '')
      const blocks = (msg.params?.prompt ?? []) as Array<{ type?: string; text?: string }>
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')

      void handlePrompt(sessionId, text)
        .then((stopReason) => reply({ stopReason }))
        .catch((error: Error) => {
          // Surfaced in the transcript rather than swallowed: a misconfigured
          // base URL or a rejected key is the most likely first failure, and it
          // has to say so instead of producing an empty turn.
          update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Model request failed: ${error.message}` }
          })
          reply({ stopReason: 'refusal' })
        })
      return
    }

    case 'session/cancel':
      reply({})
      return

    default:
      if (msg.id !== undefined) reply({})
  }
})
