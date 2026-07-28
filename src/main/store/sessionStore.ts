import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import type { PersistedSession, ThreadBlock } from '../../shared/ipc'

/**
 * Durable session storage.
 *
 * Two files per session: an index entry describing it, and an append-only
 * JSONL transcript. Append matters — rewriting the whole transcript on every
 * flush is quadratic over a long conversation, which is exactly the session
 * this feature exists to support. It also makes a crash lose at most the last
 * line rather than the file.
 *
 * This is what turns three separate problems into one solution: sessions
 * survive a restart, the approval record stops being discarded when the window
 * closes, and the in-memory block list finally has somewhere to spill to.
 *
 * Everything here is best-effort. A failed write must never break a live
 * conversation — losing history is bad, losing the turn you are in the middle
 * of is worse.
 */

const INDEX = 'index.json'

/**
 * Where transcripts live. Injected rather than resolved from electron's
 * userData path, because this module is imported by AgentSession, which must
 * stay runnable outside an Electron runtime — the headless test harnesses drive
 * a real agent in plain Node, and an electron import there fails at load.
 *
 * Unconfigured means "do not persist" rather than an error, so a harness that
 * never calls configureStore simply runs without history.
 */
let rootDir: string | null = null

export function configureStore(dir: string): void {
  rootDir = dir
}

export function isConfigured(): boolean {
  return rootDir !== null
}

function root(): string {
  if (!rootDir) throw new Error('session store is not configured')
  return rootDir
}

function transcriptPath(id: string): string {
  return join(root(), `${id}.jsonl`)
}

function indexPath(): string {
  return join(root(), INDEX)
}

let indexCache: PersistedSession[] | null = null
/** Serializes index writes; concurrent sessions would otherwise clobber it. */
let writeChain: Promise<unknown> = Promise.resolve()

async function ensureDir(): Promise<void> {
  await mkdir(root(), { recursive: true })
}

export async function listSessions(): Promise<PersistedSession[]> {
  if (!rootDir) return []
  if (indexCache) return indexCache
  try {
    indexCache = JSON.parse(await readFile(indexPath(), 'utf8')) as PersistedSession[]
  } catch {
    indexCache = []
  }
  return indexCache
}

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn)
  writeChain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/** Creates or updates a session's index entry. */
export async function upsertSession(entry: PersistedSession): Promise<void> {
  if (!rootDir) return
  await queue(async () => {
    const all = await listSessions()
    const i = all.findIndex((s) => s.id === entry.id)
    if (i === -1) all.unshift(entry)
    else all[i] = { ...all[i], ...entry }
    indexCache = all
    try {
      await ensureDir()
      await writeFile(indexPath(), JSON.stringify(all, null, 2), 'utf8')
    } catch {
      /* history is a convenience; never fail the session over it */
    }
  })
}

/**
 * Appends blocks to a transcript.
 *
 * Blocks are re-emitted wholesale on every flush (the renderer is idempotent by
 * design), so the caller passes only what is new — see `appendedSince`.
 */
export async function appendBlocks(id: string, blocks: ThreadBlock[]): Promise<void> {
  if (!rootDir) return
  if (!blocks.length) return
  try {
    await ensureDir()
    await appendFile(
      transcriptPath(id),
      blocks.map((b) => JSON.stringify(b)).join('\n') + '\n',
      'utf8'
    )
  } catch {
    /* ignore */
  }
}

/**
 * Rewrites a transcript. Used when a block already written has changed — a
 * tool call completing, or a permission being answered — which append alone
 * cannot express.
 */
export async function rewriteBlocks(id: string, blocks: ThreadBlock[]): Promise<void> {
  if (!rootDir) return
  try {
    await ensureDir()
    await writeFile(
      transcriptPath(id),
      blocks.map((b) => JSON.stringify(b)).join('\n') + (blocks.length ? '\n' : ''),
      'utf8'
    )
  } catch {
    /* ignore */
  }
}

/**
 * Reads a transcript back. Streams line by line so a very long history does not
 * have to be held twice — once as text and once as objects.
 */
export async function readBlocks(id: string, limit?: number): Promise<ThreadBlock[]> {
  if (!rootDir) return []
  const blocks: ThreadBlock[] = []
  try {
    const stream = createReadStream(transcriptPath(id), { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      try {
        blocks.push(JSON.parse(line) as ThreadBlock)
      } catch {
        // A torn final line from a crash mid-write: skip it rather than
        // failing the whole restore for one bad record.
      }
    }
  } catch {
    return []
  }
  return limit && blocks.length > limit ? blocks.slice(-limit) : blocks
}

export async function deleteSession(id: string): Promise<void> {
  if (!rootDir) return
  await queue(async () => {
    const all = (await listSessions()).filter((s) => s.id !== id)
    indexCache = all
    try {
      await writeFile(indexPath(), JSON.stringify(all, null, 2), 'utf8')
      await rm(transcriptPath(id), { force: true })
    } catch {
      /* ignore */
    }
  })
}

/**
 * The audit record for a session: what was asked, what the agent tried, what
 * was approved or denied, and what it cost.
 *
 * Derived rather than stored separately, so it cannot drift from the
 * transcript the user actually saw.
 */
export async function exportAudit(id: string): Promise<{
  session: PersistedSession | null
  approvals: Array<{
    at: number
    title: string
    command?: string
    decision: string
  }>
  commands: Array<{ at: number; command: string; status?: string }>
  blocks: number
}> {
  const session = (await listSessions()).find((s) => s.id === id) ?? null
  const blocks = await readBlocks(id)

  const approvals = blocks
    .filter((b): b is Extract<ThreadBlock, { kind: 'permission' }> => b.kind === 'permission')
    .map((b) => {
      const chosen = b.request.options.find((o) => o.optionId === b.request.resolvedOptionId)
      return {
        at: b.at,
        title: b.request.toolCall.title ?? b.request.toolCall.kind ?? 'tool call',
        command:
          typeof b.request.toolCall.rawInput?.command === 'string'
            ? b.request.toolCall.rawInput.command
            : undefined,
        decision: b.request.cancelled ? 'cancelled' : (chosen?.name ?? 'unanswered')
      }
    })

  const commands = blocks
    .filter((b): b is Extract<ThreadBlock, { kind: 'tool' }> => b.kind === 'tool')
    .map((b) => ({
      at: b.at,
      command:
        typeof b.call.rawInput?.command === 'string'
          ? b.call.rawInput.command
          : (b.call.title ?? b.call.kind ?? 'tool'),
      status: b.call.status
    }))

  return { session, approvals, commands, blocks: blocks.length }
}
