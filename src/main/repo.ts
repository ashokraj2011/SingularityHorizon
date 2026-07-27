import { execFile } from 'node:child_process'
import { access, appendFile, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { RepoInfo } from '../shared/ipc'
import { resolvedPath } from './agents'
import { detectAll } from './providers/registry'

const execFileAsync = promisify(execFile)

/**
 * A repo is the unit that owns durable, cross-session state: the AST index, and
 * whatever a registered workflow provider contributes. A session's working
 * directory is where the agent runs, which is often a subdirectory — in a
 * monorepo you work in `apps/api` while the index spans the whole repository.
 *
 * Keeping these separate matters: scoping the index to the working directory
 * would make cross-package search silently incomplete, and a search that
 * quietly misses results is worse than one that refuses to run.
 */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: { ...process.env, PATH: await resolvedPath() },
      timeout: 5000
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function discoverRepo(workingDir: string): Promise<RepoInfo> {
  // Canonicalize before any path arithmetic. `git rev-parse --show-toplevel`
  // resolves symlinks, so on macOS a session opened under /tmp or /var gets a
  // root of /private/... while the cwd stays /... — and `relative()` between
  // them yields a nonsense ../../.. path. Same trap for any symlinked project
  // directory, so resolve both sides rather than special-casing macOS.
  const cwd = await canonical(resolve(workingDir))
  const root = await canonical((await gitRoot(cwd)) ?? cwd)

  return {
    root,
    workingDir: cwd,
    relativeWorkingDir: relative(root, cwd) || '.',
    isGit: root !== cwd || (await exists(join(root, '.git'))),
    // Empty unless a host registered something. The core has no opinion about
    // what a workflow looks like, and must not acquire one.
    providers: await detectAll(root)
  }
}

/**
 * Keeps the index out of git without touching a tracked file.
 *
 * `.git/info/exclude` is local-only and never committed, so adding the entry
 * there ignores `.ast/` without producing a diff in the user's `.gitignore` —
 * a repo they did not ask us to modify. Falls back to doing nothing outside a
 * git repo, where there is nothing to ignore it from.
 */
export async function ensureAstIgnored(root: string): Promise<'added' | 'present' | 'skipped'> {
  const excludePath = join(root, '.git', 'info', 'exclude')
  if (!(await exists(join(root, '.git')))) return 'skipped'

  let current = ''
  try {
    current = await readFile(excludePath, 'utf8')
  } catch {
    // .git/info/exclude may not exist in a fresh clone; appending creates it.
  }
  if (/^\.ast\/?\s*$/m.test(current)) return 'present'

  // Also respect an existing .gitignore entry rather than adding a duplicate.
  try {
    const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
    if (/^\.ast\/?\s*$/m.test(gitignore)) return 'present'
  } catch {
    /* no .gitignore */
  }

  try {
    await appendFile(
      excludePath,
      `${current && !current.endsWith('\n') ? '\n' : ''}# Event Horizon AST index (local only)\n.ast/\n`
    )
    return 'added'
  } catch {
    return 'skipped'
  }
}
