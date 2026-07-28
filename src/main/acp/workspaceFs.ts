import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path'

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

/**
 * Roots are realpath'd once and cached.
 *
 * Both sides of the comparison have to be real paths or containment is
 * meaningless: on macOS a root under /tmp is really /private/tmp, and comparing
 * a resolved target against an unresolved root rejects paths that are genuinely
 * inside the workspace.
 */
const rootCache = new Map<string, string>()

async function realRoot(root: string): Promise<string> {
  const key = resolve(root)
  const cached = rootCache.get(key)
  if (cached) return cached
  const real = await realpath(key).catch(() => key)
  rootCache.set(key, real)
  return real
}

/**
 * realpath as much of `target` as exists, keeping the rest verbatim.
 *
 * A write target usually does not exist yet, so plain realpath would throw and
 * leave nothing to check. Resolving the deepest existing ancestor is what makes
 * `<root>/link/new-file.txt` checkable when `link` escapes the workspace: the
 * ancestor resolves outside, and the containment test fails on that.
 */
async function realpathDeepest(target: string): Promise<string> {
  const trailing: string[] = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return trailing.length ? join(real, ...trailing.reverse()) : real
    } catch {
      const parent = dirname(current)
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return target
      trailing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Containment check.
 *
 * `resolve()` alone only collapses `..` lexically, which a symlink walks
 * straight past: a link inside the workspace pointing at /etc reads as
 * contained, and the read then follows it out. The check has to run against
 * real paths on both sides.
 */
export async function assertAllowed(roots: string[], path: string): Promise<string> {
  if (!isAbsolute(path)) throw new PathNotAllowedError(path)
  const target = await realpathDeepest(resolve(path))
  const resolvedRoots = await Promise.all(roots.map(realRoot))
  if (!resolvedRoots.some((root) => isContained(root, target))) {
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
  const target = await assertAllowed(roots, params.path)
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
  const target = await assertAllowed(roots, params.path)
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
