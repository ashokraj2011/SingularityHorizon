import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'

import type { ContentBlock } from '../shared/acp'
import type { AttachmentRef, AttachmentSummary } from '../shared/ipc'
import { isOutlineSupported, outlineFile, renderOutline } from './ast/outline'

/**
 * Turns attached files and folders into ACP prompt content.
 *
 * Verified against Copilot 1.0.75: an embedded `resource` block IS honoured —
 * the agent materializes it to a temp file and reads it with its view tool, so
 * the content genuinely reaches the model even for a URI that exists nowhere on
 * disk. Attaching therefore works without needing the agent to have read access
 * to the original path.
 *
 * Caps exist because the prompt is one JSON-RPC frame and the context window is
 * finite: a stray 40 MB log would either blow the frame or evict the entire
 * conversation. Truncation is always reported back to the UI rather than done
 * silently.
 */

/** Per-file embed cap. Generous enough for source files, small enough to be safe. */
const MAX_FILE_BYTES = 256 * 1024
/**
 * Above this, a parseable file is outlined rather than sent whole unless the
 * user says otherwise. Chosen because outlining a small file saves little and
 * costs the agent the implementation it probably wanted; on a large one the
 * saving is 75-90%. Unlike restricting tools this is not a capability loss —
 * the agent can still read the body with its own tools whenever it needs it.
 */
const OUTLINE_DEFAULT_BYTES = 12 * 1024
/** Total across all attachments in one prompt. */
const MAX_TOTAL_BYTES = 1024 * 1024
/** Directory listing bounds. */
const MAX_DIR_ENTRIES = 300
const MAX_DIR_DEPTH = 3

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'venv',
  '.venv',
  '__pycache__',
  '.cache'
])

const MIME_BY_EXT: Record<string, string> = {
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.css': 'text/css',
  '.html': 'text/html',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.sh': 'text/x-shellscript',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.toml': 'text/toml',
  '.sql': 'text/x-sql',
  '.txt': 'text/plain'
}

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'text/plain'
}

function fileUri(path: string): string {
  return `file://${path}`
}

/**
 * A NUL byte in the first block is the standard heuristic for "not text".
 * Embedding binary as text would send mojibake into the context window, so
 * those are referenced by path instead and left for the agent to handle.
 */
function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8000))
  return window.includes(0)
}

export interface BuiltAttachments {
  blocks: ContentBlock[]
  summaries: AttachmentSummary[]
}

export async function buildAttachments(
  refs: AttachmentRef[],
  cwd: string
): Promise<BuiltAttachments> {
  const blocks: ContentBlock[] = []
  const summaries: AttachmentSummary[] = []
  let budget = MAX_TOTAL_BYTES

  for (const ref of refs) {
    try {
      if (ref.kind === 'folder') {
        const built = await buildFolder(ref.path, cwd)
        blocks.push(...built.blocks)
        summaries.push(built.summary)
        continue
      }

      const info = await stat(ref.path)
      if (!info.isFile()) {
        summaries.push({
          path: ref.path,
          name: basename(ref.path),
          kind: 'file',
          error: 'Not a regular file'
        })
        continue
      }

      if (budget <= 0) {
        summaries.push({
          path: ref.path,
          name: basename(ref.path),
          kind: 'file',
          bytes: info.size,
          error: 'Skipped — total attachment budget exhausted'
        })
        continue
      }

      // Outline mode: send the structure instead of the implementation.
      // Only attempted for languages the parser covers; anything else falls
      // through to the normal path rather than silently sending nothing useful.
      let outlineUnavailable = false
      if (ref.mode === 'outline') {
        if (!isOutlineSupported(ref.path)) {
          // Fall through and send the file in full, but record why so the chip
          // can say so instead of quietly behaving as though nothing was asked.
          outlineUnavailable = true
        } else {
          const outline = await outlineFile(ref.path)
          if (outline) {
            const text = renderOutline(outline)
            budget -= text.length
            blocks.push({
              type: 'resource',
              resource: { uri: fileUri(ref.path), mimeType: mimeFor(ref.path), text }
            })
            summaries.push({
              path: ref.path,
              name: basename(ref.path),
              kind: 'file',
              bytes: info.size,
              mode: 'outline',
              savedChars: Math.max(0, info.size - text.length)
            })
            continue
          }
        }
      }

      const raw = await readFile(ref.path)
      if (looksBinary(raw)) {
        // Reference it rather than embedding bytes as text.
        blocks.push({
          type: 'resource_link',
          uri: fileUri(ref.path),
          name: basename(ref.path),
          mimeType: 'application/octet-stream'
        })
        summaries.push({
          path: ref.path,
          name: basename(ref.path),
          kind: 'file',
          bytes: info.size,
          binary: true
        })
        continue
      }

      const cap = Math.min(MAX_FILE_BYTES, budget)
      const truncated = raw.length > cap
      const slice = truncated ? raw.subarray(0, cap) : raw
      budget -= slice.length

      const text = truncated
        ? `${slice.toString('utf8')}\n\n[truncated: showing first ${slice.length} of ${raw.length} bytes]`
        : slice.toString('utf8')

      blocks.push({
        type: 'resource',
        resource: { uri: fileUri(ref.path), mimeType: mimeFor(ref.path), text }
      })
      summaries.push({
        path: ref.path,
        name: basename(ref.path),
        kind: 'file',
        bytes: info.size,
        truncated: truncated || undefined,
        mode: 'full',
        outlineUnavailable: outlineUnavailable || undefined
      })
    } catch (err) {
      summaries.push({
        path: ref.path,
        name: basename(ref.path),
        kind: ref.kind,
        error: (err as Error).message
      })
    }
  }

  return { blocks, summaries }
}

/**
 * Folders are attached as a listing, not as their contents — inlining a whole
 * tree would swamp the context. The agent gets the paths and reads what it
 * needs with its own tools.
 */
async function buildFolder(
  dir: string,
  cwd: string
): Promise<{ blocks: ContentBlock[]; summary: AttachmentSummary }> {
  const entries: string[] = []
  let truncated = false

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_DIR_DEPTH || entries.length >= MAX_DIR_ENTRIES) return
    let items: Dirent[]
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (entries.length >= MAX_DIR_ENTRIES) {
        truncated = true
        return
      }
      if (item.name.startsWith('.') || IGNORED_DIRS.has(item.name)) continue
      const full = join(current, item.name)
      if (item.isDirectory()) {
        entries.push(`${relative(dir, full)}/`)
        await walk(full, depth + 1)
      } else {
        entries.push(relative(dir, full))
      }
    }
  }
  await walk(dir, 1)

  const label = relative(cwd, dir) || dir
  const listing = [
    `Attached folder: ${dir}`,
    `(${entries.length} entries${truncated ? `, truncated at ${MAX_DIR_ENTRIES}` : ''}; ` +
      `hidden files and ${[...IGNORED_DIRS].slice(0, 4).join('/')}/… omitted)`,
    '',
    ...entries.map((e) => `  ${e}`)
  ].join('\n')

  return {
    blocks: [
      { type: 'resource_link', uri: fileUri(dir), name: label, mimeType: 'inode/directory' },
      { type: 'text', text: listing }
    ],
    summary: {
      path: dir,
      name: basename(dir) || dir,
      kind: 'folder',
      entryCount: entries.length,
      truncated: truncated || undefined
    }
  }
}

/**
 * Whether a freshly-attached file should default to outline mode.
 * Exported so the UI and the sender agree on one rule.
 */
export function shouldDefaultToOutline(path: string, bytes: number | undefined): boolean {
  return isOutlineSupported(path) && (bytes ?? 0) >= OUTLINE_DEFAULT_BYTES
}

/** Cheap metadata for the attachment chips, before anything is sent. */
export async function statPaths(paths: string[]): Promise<AttachmentSummary[]> {
  return Promise.all(
    paths.map(async (path): Promise<AttachmentSummary> => {
      try {
        const info = await stat(path)
        return {
          path,
          name: basename(path) || path,
          kind: info.isDirectory() ? 'folder' : 'file',
          bytes: info.isDirectory() ? undefined : info.size
        }
      } catch (err) {
        return {
          path,
          name: basename(path) || path,
          kind: 'file',
          error: (err as Error).message
        }
      }
    })
  )
}
