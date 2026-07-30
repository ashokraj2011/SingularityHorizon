import type { Budget } from './ir'
import type { SessionMode } from '../../shared/ipc'

/**
 * Org conventions, versioned.
 *
 * The compiler's job is to ask about what a conversation genuinely left open,
 * not about what the organisation decided years ago. Whether an analyst runs
 * lean or full is not a question worth a user's attention; which claim classes
 * end a repair loop is. Everything in here is a hole the compiler closes on its
 * own, and every closure records this version so a run's choices can be
 * explained later — "why did this step run in edit mode" has to be answerable
 * after the playbook has moved on.
 *
 * Keyed by role rather than by node id, so it says something general about how
 * this organisation works rather than restating one workflow.
 */

export interface RoleDefaults {
  agentId: string
  toolProfile: 'full' | 'no-mcp' | 'lean' | 'minimal'
  /** The M1 mode ceiling. A role that only reads should not be able to write. */
  mode: SessionMode
  workspace: 'readonly' | 'isolatedWorktree'
  budget: Budget
}

export interface Playbook {
  version: string
  roles: Record<string, RoleDefaults>
  /** Applied to any node the roles do not cover — tool steps, conditions. */
  defaultBudget: Budget
  /** How long a repair loop may run in total before handing back. */
  loopBudget: Budget
  /** Evidence tier and threshold conventions for claim classes. */
  claimDefaults: { evidenceTier: 'PRODUCTION' | 'STAGING' | 'EXPERIMENT' | 'SYNTHETIC'; acceptThreshold: number }
}

export const DEFAULT_PLAYBOOK: Playbook = {
  version: 'org-playbook/2026.07',
  roles: {
    // Reads and reasons. Cheap agent, minimal tool surface, and no ability
    // to write whatever it decides it would like to.
    analyst: {
      agentId: 'opencode',
      toolProfile: 'lean',
      mode: 'explore',
      workspace: 'readonly',
      budget: { timeoutSec: 120, maxTokens: 40_000 }
    },
    // Builds. Full surface, its own worktree, and it still cannot run commands.
    implementer: {
      agentId: 'copilot',
      toolProfile: 'full',
      mode: 'edit',
      workspace: 'isolatedWorktree',
      budget: { timeoutSec: 900, maxTokens: 200_000 }
    },
    // Fixes one thing. Narrower than the implementer on purpose: a repair step
    // with full surface tends to rewrite rather than repair.
    repair: {
      agentId: 'copilot',
      toolProfile: 'lean',
      mode: 'edit',
      workspace: 'isolatedWorktree',
      budget: { timeoutSec: 600, maxTokens: 100_000 }
    },
    reviewer: {
      agentId: 'copilot',
      toolProfile: 'lean',
      mode: 'explore',
      workspace: 'readonly',
      budget: { timeoutSec: 300, maxTokens: 60_000 }
    }
  },
  defaultBudget: { timeoutSec: 600 },
  loopBudget: { timeoutSec: 1800 },
  claimDefaults: { evidenceTier: 'PRODUCTION', acceptThreshold: 0.5 }
}

/** Gates get a long clock: a human is not a timeout. */
export const GATE_BUDGET: Budget = { timeoutSec: 86_400 }
