import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type {
  ActionResult,
  ContextDocument,
  ProviderStatus,
  WorkThread,
  WorkThreadAction
} from '../../shared/ipc'
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

  /**
   * Parse `--json` output, tolerating a CLI that does not always produce it.
   *
   * Flow's JSON surface is wide but not uniform — some commands print nothing
   * on `--json`, and a command run in a repo with no active work item exits 0
   * with an empty stdout. Treating that as an error would make the whole
   * integration look broken on a perfectly healthy repository, so it is treated
   * as "nothing to say".
   */
  const runJson = async <T>(root: string, args: string[]): Promise<T | null> => {
    const raw = await run(root, [...args, '--json'])
    if (!raw?.trim()) return null
    try {
      // Some commands print a human line before the JSON body.
      const start = raw.search(/[{[]/)
      return start === -1 ? null : (JSON.parse(raw.slice(start)) as T)
    } catch {
      return null
    }
  }

  /**
   * Flow's shapes, named here and nowhere else.
   *
   * Everything below maps them into Event Horizon's vocabulary. Core never
   * learns what a "generation" or a "publication-pending" is, which is what
   * keeps a second provider from having to look like this one.
   */
  type FlowStatus = {
    workItemId?: string
    id?: string
    title?: string
    summary?: string
    phase?: string
    state?: string
    status?: string
    artifacts?: Array<{ path?: string; sha256?: string; hash?: string; phase?: string }>
    approvals?: Array<{ decision?: string; phase?: string; at?: string; by?: string; actor?: string }>
  }

  const toThread = (root: string, raw: FlowStatus): WorkThread | null => {
    const id = raw.workItemId ?? raw.id
    if (!id) return null
    const state = (raw.state ?? raw.status ?? '').toLowerCase()
    return {
      id,
      title: raw.title ?? raw.summary ?? id,
      phase: raw.phase,
      status: state.includes('await') || state.includes('submit')
        ? 'awaiting-approval'
        : state.includes('block')
          ? 'blocked'
          : state.includes('complete') || state.includes('done')
            ? 'done'
            : 'active',
      cwd: root,
      artifacts: (raw.artifacts ?? [])
        .filter((a) => a.path)
        .map((a) => ({ path: a.path!, sha256: a.sha256 ?? a.hash, phase: a.phase })),
      decisions: (raw.approvals ?? []).map((a) => ({
        text: `${a.decision ?? 'decision'}${a.phase ? ` · ${a.phase}` : ''}`,
        at: a.at ? Date.parse(a.at) || undefined : undefined,
        by: a.by ?? a.actor
      })),
      actions: actionsFor(raw),
      detail: { phase: raw.phase, state }
    }
  }

  /**
   * What Flow offers next, declared with its blast radius.
   *
   * The effect labels are the point. `submit` rewrites committed state and
   * `pr` reaches GitHub; a host that treats those the same as reading status
   * will eventually open a pull request because somebody clicked the wrong row.
   */
  const actionsFor = (raw: FlowStatus): WorkThreadAction[] => {
    const state = (raw.state ?? raw.status ?? '').toLowerCase()
    const awaiting = state.includes('await') || state.includes('submit')
    return [
      { id: 'status', label: 'Refresh status', effect: 'read-only' },
      { id: 'inputs', label: 'Show approved inputs', effect: 'read-only' },
      {
        id: 'submit',
        label: 'Submit for approval',
        effect: 'mutates-repo',
        unavailable: awaiting ? 'already awaiting approval' : undefined
      },
      {
        id: 'approve',
        label: 'Approve current phase',
        effect: 'mutates-repo',
        unavailable: awaiting ? undefined : 'nothing is awaiting approval'
      },
      { id: 'pr', label: 'Preview pull request', effect: 'read-only' }
    ]
  }

  return {
    id: 'singularity-flow',
    name: 'Singularity Flow',
    capabilities: ['contextDocuments', 'workThreads', 'actions'],

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
    },

    async workThread(root: string): Promise<WorkThread | null> {
      const raw = await runJson<FlowStatus>(root, ['status'])
      if (raw) return toThread(root, raw)

      // No JSON: fall back to what is on disk. A work item is a directory of
      // committed files, so an integration that only works when the CLI is
      // feeling talkative is weaker than it needs to be.
      const active = await activeFlowWork(
        join(root, 'singularity', 'work-items'),
        join(root, 'singularity', 'initiatives')
      )
      return active
        ? { id: active.id, title: active.id, phase: active.phase, status: 'active', cwd: root }
        : null
    },

    async listWorkThreads(root: string): Promise<WorkThread[]> {
      // `inbox --offline` is the queue without touching the network. Anything
      // that would reach a remote belongs behind an explicit action, not behind
      // a list the UI refreshes on its own.
      const rows = await runJson<FlowStatus[]>(root, ['inbox', '--offline'])
      if (Array.isArray(rows)) {
        return rows.map((r) => toThread(root, r)).filter((t): t is WorkThread => t !== null)
      }
      const one = await this.workThread?.(root)
      return one ? [one] : []
    },

    /**
     * Run one of the actions this provider offered.
     *
     * Confirmation is the host's job, not this file's — but the mapping stops
     * at commands whose blast radius was declared. An action id that was never
     * offered is refused rather than passed through to the CLI, so this can
     * never become a general shell.
     */
    async runAction(root: string, actionId: string, threadId?: string): Promise<ActionResult> {
      const argv: Record<string, string[]> = {
        status: ['status'],
        inputs: ['inputs'],
        submit: ['submit'],
        approve: ['approve'],
        // Preview only. Opening a PR needs --create and the work id typed out,
        // which is a decision for a person in front of Flow, not a click here.
        pr: ['pr', ...(threadId ? [threadId] : [])]
      }
      const args = argv[actionId]
      if (!args) return { ok: false, message: `Unknown action: ${actionId}` }

      const out = await run(root, args)
      return out === null
        ? { ok: false, message: `singularity-flow ${args.join(' ')} failed` }
        : { ok: true, message: out.trim() || `${args.join(' ')} completed`, detail: { actionId } }
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
