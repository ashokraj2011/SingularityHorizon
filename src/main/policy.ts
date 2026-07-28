import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Policy } from '../shared/ipc'

/**
 * Administrative policy.
 *
 * Read from, in increasing precedence:
 *   1. `~/.event-horizon/policy.json`      — the user's own defaults
 *   2. `.event-horizon/policy.json` found by walking up from the working
 *      directory, outermost applied first so the nearest one wins
 *   3. `EVENT_HORIZON_POLICY` (a path)     — how an org pushes one out
 *
 * The walk is deliberately independent of git. Tying policy lookup to repo
 * discovery would mean a directory that is not a repository could never carry
 * one — and a policy that silently fails to load is worse than no policy,
 * because the UI reports it as enforced.
 *
 * Enforcement lives in the main process, never the renderer. A policy the UI
 * merely hides is not a policy: anything reachable over IPC has to refuse on
 * its own, because the renderer is the part an end user can most easily talk
 * around. The UI still reads policy, but only so it can explain *why* a control
 * is unavailable rather than presenting a dead button.
 *
 * Absent or unreadable means unrestricted. Failing closed on a malformed file
 * would let a typo lock someone out of their own tool.
 */

export const EMPTY_POLICY: Policy = {}

function merge(base: Policy, next: Policy): Policy {
  return {
    ...base,
    ...next,
    // A narrower list always wins, so a repo cannot widen what the org allowed.
    allowedAgents: intersect(base.allowedAgents, next.allowedAgents),
    allowedModels: intersect(base.allowedModels, next.allowedModels)
  }
}

function intersect(a?: string[], b?: string[]): string[] | undefined {
  if (!a) return b
  if (!b) return a
  return a.filter((x) => b.includes(x))
}

async function readPolicyFile(path: string): Promise<Policy | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Policy
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Every `.event-horizon/policy.json` from `dir` up to the root, outermost first. */
function policyChain(dir: string): string[] {
  const home = homedir()
  const found: string[] = []
  let current = resolve(dir)
  for (;;) {
    // The home policy is loaded separately as the base; including it here too
    // would let it intersect with itself and needlessly narrow the result.
    if (current !== home) found.push(join(current, '.event-horizon', 'policy.json'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return found.reverse()
}

let cached: { key: string; policy: Policy } | null = null

export async function loadPolicy(workingDir?: string): Promise<Policy> {
  const key = workingDir ?? ''
  if (cached?.key === key) return cached.policy

  let policy: Policy = { ...EMPTY_POLICY }

  const user = await readPolicyFile(join(homedir(), '.event-horizon', 'policy.json'))
  if (user) policy = merge(policy, user)

  if (workingDir) {
    for (const path of policyChain(workingDir)) {
      const found = await readPolicyFile(path)
      if (found) policy = merge(policy, found)
    }
  }

  const orgPath = process.env.EVENT_HORIZON_POLICY
  if (orgPath) {
    const org = await readPolicyFile(orgPath)
    if (org) policy = merge(policy, org)
  }

  cached = { key, policy }
  return policy
}

/** Forget the cache so an edited policy takes effect without a restart. */
export function invalidatePolicy(): void {
  cached = null
}

/* ------------------------------------------------------------ enforcement */

export function enforceToolProfile(policy: Policy, requested?: string): string | undefined {
  return policy.pinToolProfile ?? requested
}

export function agentAllowed(policy: Policy, agentId: string): boolean {
  return !policy.allowedAgents || policy.allowedAgents.includes(agentId)
}

export function modelAllowed(policy: Policy, modelId: string): boolean {
  return !policy.allowedModels || policy.allowedModels.includes(modelId)
}

/**
 * Whether a session config change may proceed.
 *
 * Returns a reason rather than a boolean so a refusal can say what stopped it —
 * a control that silently does nothing reads as a bug, and users work around
 * bugs.
 */
export function configChangeRefusal(
  policy: Policy,
  optionId: string,
  value: string
): string | null {
  if (optionId === 'allow_all' && value === 'on' && policy.disableAllowAll) {
    return 'Blanket approval is disabled by policy — each action must be approved individually.'
  }
  if (optionId === 'model' && !modelAllowed(policy, value)) {
    return `Model "${value}" is not permitted by policy.`
  }
  if (optionId === 'mode' && policy.disableAutopilot && /autopilot/i.test(value)) {
    return 'Autopilot is disabled by policy — it approves every action without asking.'
  }
  return null
}
