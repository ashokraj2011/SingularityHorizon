import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
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

interface FlowContextHint {
  id: string
  phase?: string
  persona?: string
  kind: 'work-item' | 'initiative'
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
      const initiativesDir = join(root, 'singularity', 'initiatives')
      const hasWorkItems = await exists(workItemsDir)
      const hasInitiatives = await exists(initiativesDir)

      // Neither the CLI nor the directory: this repo simply isn't a Flow repo.
      if (!version && !hasWorkItems && !hasInitiatives) return null

      // `wm check` exits non-zero when the model is missing or stale — a more
      // honest readiness signal than looking for files we would have to guess.
      const worldModelReady = version ? (await run(root, ['wm', 'check'])) !== null : false

      const active = await activeFlowWork(workItemsDir, initiativesDir)

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
        detail: { hasWorkItems, hasInitiatives, worldModelReady, workItemId: active?.id }
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
      const initiativesDir = join(root, 'singularity', 'initiatives')
      const hint = flowContextHint(o?.hostContext)
      const active = hint
        ? await exactFlowWork(workItemsDir, initiativesDir, hint)
        : await activeFlowWork(workItemsDir, initiativesDir)
      // A host-selected work ID is authoritative. Never silently ground the
      // agent in a different, merely newer item when that exact state is gone.
      if (hint && !active) return docs
      const phase = o?.phase ?? hint?.phase ?? active?.phase
      if (!phase) return docs

      const composed = active?.kind === 'initiative'
        ? await run(root, [
            'initiative', 'context', phase,
            '--initiative', active.id,
            ...(hint?.persona ? ['--persona', hint.persona] : []),
            '--dry-run'
          ])
        : await run(root, [
            'wm', 'compose', '--phase', phase,
            ...(active?.id ? ['--work-id', active.id] : []),
            ...(hint?.persona ? ['--persona', hint.persona] : []),
            '--render-only'
          ])
      if (composed?.trim()) {
        docs.push({
          providerId: 'singularity-flow',
          title: `${active?.id ?? 'Repository'} · ${phase} agent contract`,
          text: composed.trim(),
          kind: 'instructions',
          reason: `Persona, phase contract, and required world-model views for ${phase}`
        })
      }

      // Documents registered against the work item for this phase.
      if (active) {
        const dir = join(
          active.kind === 'initiative' ? initiativesDir : workItemsDir,
          active.id
        )
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
                kind: 'evidence',
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

function flowContextHint(value: unknown): FlowContextHint | null {
  if (!value || typeof value !== 'object') return null
  const work = (value as { work?: unknown }).work
  if (!work || typeof work !== 'object') return null
  const candidate = work as Record<string, unknown>
  if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.id)) {
    return null
  }
  const kind = candidate.kind === 'epic'
    ? 'initiative'
    : candidate.kind === 'story'
      ? 'work-item'
      : null
  if (!kind) return null
  const persona = typeof (value as { persona?: unknown }).persona === 'string'
    ? (value as { persona: string }).persona
    : undefined
  return {
    id: candidate.id,
    kind,
    phase: typeof candidate.phase === 'string' ? candidate.phase : undefined,
    persona
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function exactFlowWork(
  workItemsDir: string,
  initiativesDir: string,
  hint: FlowContextHint
): Promise<{ id: string; phase?: string; kind: 'work-item' | 'initiative' } | null> {
  const base = hint.kind === 'initiative' ? initiativesDir : workItemsDir
  const candidates = hint.kind === 'initiative'
    ? [join(base, hint.id, 'state.json')]
    : [join(base, hint.id, 'state.json'), join(base, hint.id, 'workflow.json')]
  if (!(await Promise.all(candidates.map(exists))).some(Boolean)) return null
  return { id: hint.id, phase: hint.phase, kind: hint.kind }
}

/**
 * The most recently updated Flow state is used only as a fallback hint. The
 * composed CLI context still validates the current phase and selected persona.
 */
async function activeFlowWork(
  workItemsDir: string,
  initiativesDir: string
): Promise<{ id: string; phase?: string; kind: 'work-item' | 'initiative' } | null> {
  let best: {
    id: string
    phase?: string
    kind: 'work-item' | 'initiative'
    mtime: number
  } | null = null
  const candidates = [
    ...(await safeReaddir(workItemsDir)).flatMap((id) => [
      { id, kind: 'work-item' as const, file: join(workItemsDir, id, 'state.json') },
      { id, kind: 'work-item' as const, file: join(workItemsDir, id, 'workflow.json') }
    ]),
    ...(await safeReaddir(initiativesDir)).map((id) => ({
      id,
      kind: 'initiative' as const,
      file: join(initiativesDir, id, 'state.json')
    }))
  ]
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate.file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const nested = (parsed.workflow ?? parsed.initiative) as Record<string, unknown> | undefined
      const phase = typeof parsed.currentPhase === 'string'
        ? parsed.currentPhase
        : typeof nested?.currentPhase === 'string'
          ? nested.currentPhase
          : typeof parsed.phase === 'string'
            ? parsed.phase
            : undefined
      const { mtimeMs } = await stat(candidate.file)
      if (!best || mtimeMs > best.mtime) {
        best = { id: candidate.id, phase, kind: candidate.kind, mtime: mtimeMs }
      }
    } catch {
      /* not active Flow state */
    }
  }
  return best ? { id: best.id, phase: best.phase, kind: best.kind } : null
}
