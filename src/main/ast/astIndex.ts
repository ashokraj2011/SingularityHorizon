import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import type { AstIndexStats, SymbolHit } from '../../shared/ipc'
import { isOutlineSupported, outlineSource, type SymbolEntry } from './outline'

/**
 * A persisted, incrementally-maintained symbol index for a repo.
 *
 * Stored under `<repoRoot>/.ast/` so it survives restarts and is shared by
 * every session on that repo. It is deliberately a *cache*, never a source of
 * truth: every read validates each file's mtime and size against what was
 * indexed, so a file edited by the agent, by the user's editor, or by a git
 * checkout is re-parsed on the next query.
 *
 * That validation is why "an edit invalidates the index" does not mean a full
 * rebuild. Rebuilding thousands of files because one changed would make the
 * index useless during active editing — which is exactly when it is wanted.
 * Only the files that actually changed are re-parsed; the rest are reused.
 *
 * Correctness note: mtime+size can theoretically miss an edit that preserves
 * both. That is vanishingly rare for real edits, and the alternative (hashing
 * every file on every query) costs far more than it saves. `rebuild()` exists
 * for the case where someone needs to be certain.
 */

const INDEX_DIR = '.ast'
const INDEX_FILE = 'index.json'
/** Bump when the on-disk shape or the parser's output changes meaningfully. */
const INDEX_VERSION = 1

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.ast',
  'dist',
  'build',
  'out',
  'lib',
  '.next',
  'target',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
  '.cache',
  'release'
])

/** Guards against indexing a generated bundle or a vendored blob. */
const MAX_FILE_BYTES = 1024 * 1024

interface IndexedFile {
  mtimeMs: number
  size: number
  symbols: SymbolEntry[]
}

interface IndexData {
  version: number
  builtAt: number
  files: Record<string, IndexedFile>
}

export class AstIndex {
  private data: IndexData = { version: INDEX_VERSION, builtAt: 0, files: {} }
  private loaded = false

  constructor(private readonly root: string) {}

  private get dir(): string {
    return join(this.root, INDEX_DIR)
  }

  private get file(): string {
    return join(this.dir, INDEX_FILE)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as IndexData
      // A version mismatch means the cached symbols may not match what the
      // current parser would produce, so discard rather than trust them.
      this.data = parsed.version === INDEX_VERSION ? parsed : freshIndex()
    } catch {
      this.data = freshIndex()
    }
    this.loaded = true
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file, JSON.stringify(this.data), 'utf8')
  }

  /** Drops one file's entry — used when we know an edit just happened. */
  invalidate(path: string): void {
    delete this.data.files[this.rel(path)]
  }

  /** Throws the whole cache away; the next refresh reparses everything. */
  async rebuild(): Promise<AstIndexStats> {
    this.data = freshIndex()
    this.loaded = true
    return this.refresh()
  }

  /**
   * Brings the index up to date, parsing only what changed. Returns what it
   * did, so the UI can be honest about whether a search ran against a warm
   * cache or a fresh crawl.
   */
  async refresh(): Promise<AstIndexStats> {
    await this.load()
    const started = Date.now()
    const found = await this.crawl()

    let parsed = 0
    let reused = 0
    const next: Record<string, IndexedFile> = {}

    for (const [rel, info] of found) {
      const prev = this.data.files[rel]
      if (prev && prev.mtimeMs === info.mtimeMs && prev.size === info.size) {
        next[rel] = prev
        reused++
        continue
      }
      try {
        const source = await readFile(join(this.root, rel), 'utf8')
        next[rel] = {
          mtimeMs: info.mtimeMs,
          size: info.size,
          symbols: outlineSource(rel, source).symbols
        }
        parsed++
      } catch {
        // Unreadable file: leave it out rather than keeping a stale entry that
        // would report symbols from a file that no longer parses.
      }
    }

    const removed = Object.keys(this.data.files).filter((k) => !(k in next)).length
    this.data = { version: INDEX_VERSION, builtAt: Date.now(), files: next }
    await this.save()

    return {
      files: Object.keys(next).length,
      symbols: Object.values(next).reduce((n, f) => n + f.symbols.length, 0),
      parsed,
      reused,
      removed,
      durationMs: Date.now() - started
    }
  }

  /**
   * Symbol search across the repo. Exact matches, then exported top-level
   * declarations, then everything else — the ranking someone typing a symbol
   * name almost always wants.
   */
  search(query: string, limit = 50): SymbolHit[] {
    const needle = query.toLowerCase().trim()
    if (!needle) return []
    const hits: SymbolHit[] = []

    for (const [rel, file] of Object.entries(this.data.files)) {
      for (const s of file.symbols) {
        const name = s.name.toLowerCase()
        if (!name.includes(needle)) continue
        hits.push({
          name: s.name,
          kind: s.kind,
          path: rel,
          line: s.line,
          endLine: s.endLine,
          exported: s.exported,
          container: s.container,
          signature: s.signature
        })
      }
    }

    const score = (h: SymbolHit): number => {
      let n = 0
      if (h.name.toLowerCase() === needle) n -= 100
      else if (h.name.toLowerCase().startsWith(needle)) n -= 40
      if (!h.exported) n += 10
      if (h.container) n += 5
      return n + h.name.length * 0.1
    }
    return hits.sort((a, b) => score(a) - score(b)).slice(0, limit)
  }

  stats(): AstIndexStats {
    return {
      files: Object.keys(this.data.files).length,
      symbols: Object.values(this.data.files).reduce((n, f) => n + f.symbols.length, 0),
      parsed: 0,
      reused: 0,
      removed: 0,
      durationMs: 0,
      builtAt: this.data.builtAt
    }
  }

  private rel(path: string): string {
    return relative(this.root, resolve(path))
  }

  private async crawl(): Promise<Map<string, { mtimeMs: number; size: number }>> {
    const out = new Map<string, { mtimeMs: number; size: number }>()
    const queue: string[] = [this.root]

    while (queue.length) {
      const dir = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.github') continue
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          queue.push(full)
          continue
        }
        if (!isOutlineSupported(full)) continue
        try {
          const info = await stat(full)
          if (info.size > MAX_FILE_BYTES) continue
          out.set(relative(this.root, full), { mtimeMs: info.mtimeMs, size: info.size })
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
    return out
  }
}

function freshIndex(): IndexData {
  return { version: INDEX_VERSION, builtAt: 0, files: {} }
}

/** One index per repo root, shared across sessions on that repo. */
const indexes = new Map<string, AstIndex>()

export function indexFor(root: string): AstIndex {
  const key = resolve(root)
  let idx = indexes.get(key)
  if (!idx) {
    idx = new AstIndex(key)
    indexes.set(key, idx)
  }
  return idx
}
