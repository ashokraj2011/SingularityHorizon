import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path'

/**
 * Client-side `fs/read_text_file` and `fs/write_text_file`.
 *
 * Every path is checked against the session's allowed roots. ACP mandates
 * absolute paths, which makes containment checkable: an agent that asks for
 * `/etc/passwd` while rooted at a project directory gets a clean JSON-RPC error
 * rather than a successful read.
 */

export class PathNotAllowedError extends Error {
  code = -32602
  constructor(path: string) {
    super(`Path is outside the allowed workspace roots: ${path}`)
  }
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

export function assertAllowed(roots: string[], path: string): string {
  if (!isAbsolute(path)) throw new PathNotAllowedError(path)
  const target = resolve(path)
  if (!roots.some((root) => isContained(resolve(root), target))) {
    throw new PathNotAllowedError(path)
  }
  return target
}

export interface ReadTextFileParams {
  path: string
  line?: number | null
  limit?: number | null
}

export async function readTextFile(
  roots: string[],
  params: ReadTextFileParams
): Promise<{ content: string }> {
  const target = assertAllowed(roots, params.path)
  const raw = await readFile(target, 'utf8')
  if (params.line == null && params.limit == null) return { content: raw }

  // ACP line numbers are 1-based.
  const lines = raw.split('\n')
  const start = Math.max(0, (params.line ?? 1) - 1)
  const end = params.limit == null ? lines.length : start + params.limit
  return { content: lines.slice(start, end).join('\n') }
}

export async function writeTextFile(
  roots: string[],
  params: { path: string; content: string }
): Promise<{ oldText: string | null }> {
  const target = assertAllowed(roots, params.path)
  let oldText: string | null = null
  try {
    oldText = await readFile(target, 'utf8')
  } catch {
    oldText = null // new file
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, params.content, 'utf8')
  return { oldText }
}
