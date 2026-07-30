import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import type { CapabilityForest } from './model'
import { parseManifests, type CapabilityPointer, type ParseIssue } from './parse'

/**
 * The only file in this directory that touches disk.
 *
 * §9.1 is specified as pure functions with no IO, and the parser, validator and
 * resolver stay that way — the whole correctness surface of the increment is
 * testable without a filesystem, which is most of why the spec puts it first.
 * Reading files is a separate concern and lives here alone, so that property is
 * visible rather than asserted.
 *
 * Discovery is a walk for `capability.yaml`, because a materialized node keeps
 * its manifest in its own ledger repo and there is no index to consult. Only
 * once every manifest is in hand can single ownership be checked at all.
 */

export interface LoadResult {
  forest: CapabilityForest
  issues: ParseIssue[]
  /**
   * Manifests found, relative to the root that was scanned. Pointers are
   * counted separately — folding them in here would make the CLI's "N manifests"
   * line a lie, since a pointer declares no capability.
   */
  sources: string[]
  pointerSources: string[]
  /** Member-repo back-references, for reconcilePointers. */
  pointers: CapabilityPointer[]
}

const MANIFEST_NAME = 'capability.yaml'

/**
 * The one dot-directory worth descending into.
 *
 * Member repos keep their pointer at `.singularity/capability.yaml`, and the
 * walk skipped every dot-directory — so pointer support would have worked
 * perfectly and found nothing, with no error anywhere. An allowlist rather than
 * dropping the dot-skip: not descending into `.git`, `.venv` and `.next` is what
 * keeps the walk cheap, and `SKIP` still wins.
 */
const POINTER_DIR = '.singularity'

/** Directories never worth walking into, and expensive when they are. */
const SKIP = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'release',
  '.ast',
  'coverage',
  '.next',
  'target'
])

async function findManifests(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null)
  // An unreadable directory is not a reason to fail the whole scan.
  if (!entries) return []

  const found: string[] = []
  const nested: Promise<string[]>[] = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name === MANIFEST_NAME) {
      found.push(join(root, entry.name))
      continue
    }
    if (
      !entry.isDirectory() ||
      SKIP.has(entry.name) ||
      (entry.name.startsWith('.') && entry.name !== POINTER_DIR)
    ) {
      continue
    }
    nested.push(findManifests(join(root, entry.name), depth - 1))
  }

  for (const batch of await Promise.all(nested)) found.push(...batch)
  return found
}

/**
 * Read every manifest under a root into one forest.
 *
 * `maxDepth` bounds the walk. A capability tree is a handful of materialized
 * nodes, not a deep filesystem, and an unbounded walk from a home directory is
 * a way to make a validation command feel broken.
 */
export async function loadForest(root: string, maxDepth = 6): Promise<LoadResult> {
  const info = await stat(root).catch(() => null)
  if (!info) {
    return {
      forest: { byId: new Map() },
      issues: [{ at: root, problem: 'no such directory' }],
      sources: [],
      pointerSources: [],
      pointers: []
    }
  }

  // A single manifest may be named directly, which is what a caller pointing at
  // one ledger repo usually means.
  const paths = info.isFile() ? [root] : await findManifests(root, maxDepth)

  const documents = await Promise.all(
    paths.map(async (path) => ({
      text: await readFile(path, 'utf8').catch(() => ''),
      source: info.isFile() ? path : relative(root, path)
    }))
  )

  const readable = documents.filter((d) => d.text.trim())
  const unreadable = documents
    .filter((d) => !d.text.trim())
    .map((d) => ({ source: d.source, at: '', problem: 'empty or unreadable' }))

  const parsed = parseManifests(readable)
  const pointerSources = new Set(parsed.pointers.map((p) => p.source ?? ''))
  return {
    forest: parsed.forest,
    issues: [...unreadable, ...parsed.issues],
    // Split by what the file turned out to be, which is only known after
    // parsing — classification is by content, not by path.
    sources: readable.map((d) => d.source ?? '').filter((s) => !pointerSources.has(s)),
    pointerSources: [...pointerSources],
    pointers: parsed.pointers
  }
}
