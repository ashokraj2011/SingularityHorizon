import { execFile } from 'node:child_process'
import { access, appendFile, readFile, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { RepoInfo } from '../shared/ipc'
import { resolvedPath } from './agents'

const execFileAsync = promisify(execFile)

/**
 * A repo is the unit that owns durable, cross-session state: the AST index and
 * the Singularity world model. A session's working directory is where the agent
 * runs, which is often a subdirectory — in a monorepo you work in `apps/api`
 * while the index and world model span the whole repository.
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

/**
 * Singularity Flow keeps lifecycle state at
 * `singularity/work-items/<WORK-ID>/workflow.json`, and its world model has to
 * be initialised with `wm init` before `wm build`/`wm compose` will run. Both
 * are detected rather than assumed, so a plain repo behaves normally.
 */
async function detectFlow(root: string): Promise<{
  hasWorkItems: boolean
  worldModelReady: boolean
  flowVersion?: string
}> {
  const hasWorkItems = await exists(join(root, 'singularity', 'work-items'))

  let flowVersion: string | undefined
  try {
    const { stdout } = await execFileAsync('singularity-flow', ['--version'], {
      cwd: root,
      env: { ...process.env, PATH: await resolvedPath() },
      timeout: 5000
    })
    flowVersion = stdout.trim().split('\n').pop()?.trim()
  } catch {
    flowVersion = undefined
  }

  // `wm check` exits non-zero when the model is missing or stale, which is
  // exactly the signal we want — no need to guess at its on-disk layout.
  let worldModelReady = false
  if (flowVersion) {
    try {
      await execFileAsync('singularity-flow', ['wm', 'check'], {
        cwd: root,
        env: { ...process.env, PATH: await resolvedPath() },
        timeout: 15000
      })
      worldModelReady = true
    } catch {
      worldModelReady = false
    }
  }

  return { hasWorkItems, worldModelReady, flowVersion }
}

export async function discoverRepo(workingDir: string): Promise<RepoInfo> {
  // Canonicalize before any path arithmetic. `git rev-parse --show-toplevel`
  // resolves symlinks, so on macOS a session opened under /tmp or /var gets a
  // root of /private/... while the cwd stays /... — and `relative()` between
  // them yields a nonsense ../../.. path. Same trap for any symlinked project
  // directory, so resolve both sides rather than special-casing macOS.
  const cwd = await canonical(resolve(workingDir))
  const root = await canonical((await gitRoot(cwd)) ?? cwd)
  const flow = await detectFlow(root)

  return {
    root,
    workingDir: cwd,
    relativeWorkingDir: relative(root, cwd) || '.',
    isGit: root !== cwd || (await exists(join(root, '.git'))),
    ...flow
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
