/**
 * A streaming chat-completions client.
 *
 * Plain `fetch`, no SDK. Two shapes are supported because those are the two a
 * gateway actually fronts: OpenAI-compatible, which is what LiteLLM exposes for
 * every model it proxies, and Anthropic Messages, which is what you get when
 * pointing at Anthropic directly. Both carry tool calling, and the differences
 * between them are confined to this file — everything above works in one
 * vocabulary.
 *
 * No dependency is added for this. An SDK would bring a transitive tree into an
 * Electron app to do what amounts to POSTing JSON and reading server-sent
 * events, and the two request shapes here are small enough to read in full.
 */

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
}

export interface ToolInvocation {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolInvocation[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatEvent {
  /** Streamed assistant text. */
  text?: string
  /** A completed tool call. Emitted once its arguments have fully arrived. */
  toolCall?: ToolInvocation
  usage?: { inputTokens?: number; outputTokens?: number }
  /** Why the turn ended, in the provider's own words. */
  stopReason?: string
}

export interface LlmConfig {
  provider: 'openai' | 'anthropic'
  baseUrl: string
  apiKey?: string
  model: string
}

/**
 * Where to talk to, and as what.
 *
 * Reads the same variables the gateway seam sets, so a step already pointed at
 * a proxy needs no separate configuration. `provider` is inferred from the URL
 * when it is not stated — an Anthropic endpoint is recognisable, and everything
 * else is far more likely to be OpenAI-compatible than not.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (
    env.EH_HARNESS_BASE_URL ??
    env.OPENAI_BASE_URL ??
    env.ANTHROPIC_BASE_URL ??
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '')

  const stated = env.EH_HARNESS_PROVIDER as LlmConfig['provider'] | undefined
  const provider = stated ?? (/anthropic/i.test(baseUrl) ? 'anthropic' : 'openai')

  return {
    provider,
    baseUrl,
    apiKey:
      env.EH_HARNESS_API_KEY ??
      (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY),
    model: env.EH_HARNESS_MODEL ?? (provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5.4')
  }
}

/* ------------------------------------------------------------ SSE reading */

/**
 * Server-sent events, as a line reader.
 *
 * Chunk boundaries fall wherever the network puts them, so a naive
 * split-on-newline drops the tail of every partial line. The remainder is
 * carried between reads.
 */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trimEnd()
      buffer = buffer.slice(index + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
  if (buffer.startsWith('data:')) yield buffer.slice(5).trim()
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  }
  return res
}

/* ---------------------------------------------------------------- OpenAI */

async function* streamOpenAI(cfg: LlmConfig, req: ChatRequest): AsyncGenerator<ChatEvent> {
  const messages = req.messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments) }
        }))
      }
    }
    return { role: m.role, content: m.content }
  })

  const res = await post(
    `${cfg.baseUrl}/chat/completions`,
    cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters }
            }))
          }
        : {})
    },
    req.signal
  )

  // Tool-call arguments arrive as a stream of fragments keyed by index, so they
  // are accumulated and only emitted once the turn says they are complete.
  const pending = new Map<number, { id: string; name: string; args: string }>()

  for await (const data of sseLines(res.body!)) {
    if (data === '[DONE]') break
    let parsed: {
      choices?: Array<{
        delta?: {
          content?: string
          tool_calls?: Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }

    if (parsed.usage) {
      yield {
        usage: {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens
        }
      }
    }

    const choice = parsed.choices?.[0]
    if (!choice) continue

    if (choice.delta?.content) yield { text: choice.delta.content }

    for (const call of choice.delta?.tool_calls ?? []) {
      const slot = pending.get(call.index) ?? { id: '', name: '', args: '' }
      if (call.id) slot.id = call.id
      if (call.function?.name) slot.name = call.function.name
      if (call.function?.arguments) slot.args += call.function.arguments
      pending.set(call.index, slot)
    }

    if (choice.finish_reason) {
      for (const slot of pending.values()) {
        if (!slot.name) continue
        yield { toolCall: { id: slot.id || slot.name, name: slot.name, arguments: safeArgs(slot.args) } }
      }
      pending.clear()
      yield { stopReason: choice.finish_reason }
    }
  }
}

/* ------------------------------------------------------------- Anthropic */

async function* streamAnthropic(cfg: LlmConfig, req: ChatRequest): AsyncGenerator<ChatEvent> {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')

  // Anthropic carries tool results as user-role content blocks rather than a
  // distinct role, and consecutive results belong in one message.
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of req.messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = messages.at(-1)
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block)
      else messages.push({ role: 'user', content: [block] })
      continue
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments })
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    messages.push({ role: 'user', content: m.content })
  }

  const res = await post(
    `${cfg.baseUrl}/messages`,
    {
      ...(cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {}),
      'anthropic-version': '2023-06-01'
    },
    {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      ...(system ? { system } : {}),
      messages,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters
            }))
          }
        : {})
    },
    req.signal
  )

  const blocks = new Map<number, { id: string; name: string; json: string }>()

  for await (const data of sseLines(res.body!)) {
    let ev: {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string }
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      usage?: { output_tokens?: number }
    }
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }

    if (ev.type === 'message_start' && ev.message?.usage) {
      yield { usage: { inputTokens: ev.message.usage.input_tokens } }
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      blocks.set(ev.index ?? 0, {
        id: ev.content_block.id ?? '',
        name: ev.content_block.name ?? '',
        json: ''
      })
    }
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta' && ev.delta.text) yield { text: ev.delta.text }
      if (ev.delta?.type === 'input_json_delta') {
        const slot = blocks.get(ev.index ?? 0)
        if (slot) slot.json += ev.delta.partial_json ?? ''
      }
    }
    if (ev.type === 'content_block_stop') {
      const slot = blocks.get(ev.index ?? 0)
      if (slot?.name) {
        yield { toolCall: { id: slot.id || slot.name, name: slot.name, arguments: safeArgs(slot.json) } }
      }
      blocks.delete(ev.index ?? 0)
    }
    if (ev.type === 'message_delta') {
      if (ev.usage?.output_tokens) yield { usage: { outputTokens: ev.usage.output_tokens } }
      if (ev.delta?.stop_reason) yield { stopReason: ev.delta.stop_reason }
    }
  }
}

/**
 * Tool arguments that failed to parse become an empty object.
 *
 * A model can emit malformed JSON, and the useful response is to run the tool
 * with nothing and let it report a missing argument — which the model can then
 * correct. Throwing here would end the turn on a transient formatting slip.
 */
function safeArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function streamChat(cfg: LlmConfig, req: ChatRequest): AsyncGenerator<ChatEvent> {
  return cfg.provider === 'anthropic' ? streamAnthropic(cfg, req) : streamOpenAI(cfg, req)
}
