import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ContextDocument, ProviderStatus } from '../../shared/ipc'
import type { WorkspaceProvider } from './types'

const execFileAsync = promisify(execFile)

/**
 * Singularity Flow integration — OPTIONAL, and imported by nobody in core.
 *
 * This file exists in the Event Horizon repo as a reference implementation and
 * a convenience, but nothing loads it automatically. A host opts in:
 *
 *     import { registerProvider } from 'event-horizon/core'
 *     import { singularityFlowProvider } from 'event-horizon/providers/singularity-flow'
 *     registerProvider(singularityFlowProvider())
 *
 * Standalone Event Horizon never calls that, never shells out to
 * `singularity-flow`, and works identically on a repo that has never heard of
 * it. `npm run guard` fails the build if core ever imports this directory.
 *
 * Everything here is detection, not assumption: `wm check` decides whether the
 * world model is usable rather than us guessing at its on-disk layout, and a
 * missing CLI yields "not applicable" rather than an error.
 */

export interface SingularityFlowOptions {
  /** Override the binary, e.g. a workspace-local build. */
  command?: string
  /** Extra PATH entries, for a GUI host that lacks the login shell's PATH. */
  path?: string
  timeoutMs?: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function singularityFlowProvider(
  opts: SingularityFlowOptions = {}
): WorkspaceProvider {
  const command = opts.command ?? 'singularity-flow'
  const timeout = opts.timeoutMs ?? 15_000
  const env = opts.path ? { ...process.env, PATH: opts.path } : process.env

  const run = async (root: string, args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(command, args, { cwd: root, env, timeout })
      return stdout
    } catch {
      return null
    }
  }

  return {
    id: 'singularity-flow',
    name: 'Singularity Flow',

    async detect(root: string): Promise<ProviderStatus | null> {
      const version = (await run(root, ['--version']))?.trim().split('\n').pop()?.trim()
      const workItemsDir = join(root, 'singularity', 'work-items')
      const hasWorkItems = await exists(workItemsDir)

      // Neither the CLI nor the directory: this repo simply isn't a Flow repo.
      if (!version && !hasWorkItems) return null

      // `wm check` exits non-zero when the model is missing or stale — a more
      // honest readiness signal than looking for files we would have to guess.
      const worldModelReady = version ? (await run(root, ['wm', 'check'])) !== null : false

      const active = hasWorkItems ? await activeWorkItem(workItemsDir) : null

      return {
        id: 'singularity-flow',
        name: 'Singularity Flow',
        ready: !!version,
        version,
        phase: active?.phase,
        summary: active
          ? `${active.id}${active.phase ? ` · ${active.phase}` : ''}`
          : version
            ? 'no active work item'
            : 'CLI not found',
        detail: { hasWorkItems, worldModelReady, workItemId: active?.id }
      }
    },

    /**
     * Phase handoff material. `wm compose` needs a persona and only runs once
     * the model is initialised, so this returns nothing rather than failing
     * when either is missing — the session still opens, just ungrounded.
     */
    async contextDocuments(root, o): Promise<ContextDocument[]> {
      const docs: ContextDocument[] = []
      const workItemsDir = join(root, 'singularity', 'work-items')
      const active = (await exists(workItemsDir)) ? await activeWorkItem(workItemsDir) : null
      const phase = o?.phase ?? active?.phase
      if (!phase) return docs

      const composed = await run(root, ['wm', 'compose', '--phase', phase])
      if (composed?.trim()) {
        docs.push({
          providerId: 'singularity-flow',
          title: `World model · ${phase}`,
          text: composed.trim(),
          reason: `Grounding for the ${phase} phase`
        })
      }

      // Documents registered against the work item for this phase.
      if (active) {
        const dir = join(workItemsDir, active.id)
        for (const name of await safeReaddir(dir)) {
          if (!/handoff|summary|spec/i.test(name)) continue
          if (!/\.(md|markdown|txt)$/i.test(name)) continue
          try {
            const text = await readFile(join(dir, name), 'utf8')
            if (text.trim()) {
              docs.push({
                providerId: 'singularity-flow',
                title: `${active.id} · ${name}`,
                path: join(dir, name),
                text,
                reason: 'Phase handoff document'
              })
            }
          } catch {
            /* unreadable — skip */
          }
        }
      }
      return docs
    }
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * `singularity/work-items/<WORK-ID>/workflow.json` is the lifecycle state.
 * The most recently modified one is treated as active, which matches how the
 * CLI is used in practice.
 */
async function activeWorkItem(
  workItemsDir: string
): Promise<{ id: string; phase?: string } | null> {
  const ids = await safeReaddir(workItemsDir)
  let best: { id: string; phase?: string; mtime: number } | null = null

  for (const id of ids) {
    const file = join(workItemsDir, id, 'workflow.json')
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const phase =
        typeof parsed.currentPhase === 'string'
          ? parsed.currentPhase
          : typeof parsed.phase === 'string'
            ? parsed.phase
            : undefined
      const { mtimeMs } = await import('node:fs/promises').then((m) => m.stat(file))
      if (!best || mtimeMs > best.mtime) best = { id, phase, mtime: mtimeMs }
    } catch {
      /* not a work item */
    }
  }
  return best ? { id: best.id, phase: best.phase } : null
}
