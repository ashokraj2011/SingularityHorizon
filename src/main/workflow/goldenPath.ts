import type { Workflow } from './ir'

/**
 * The golden path, hand-written in the IR.
 *
 * Story → analysis → approved design → implementation → verified → PR. Written
 * before the compiler that will emit it, for two reasons: it proves the IR can
 * express the one workflow that matters before any effort goes into generating
 * IR, and it becomes M4's acceptance test — the compiler is judged by how
 * closely its output diffs against this.
 *
 * Worth reading for what varies per step rather than what the steps are. The
 * analyst runs on a cheap agent with a lean tool profile in `explore` mode, so
 * it cannot write anything and costs a fraction of a request. The implementer
 * runs full and `edit`, in an isolated worktree. Verification runs commands but
 * cannot edit. That per-step variation is the whole point of the IR: token
 * profile, capability, and model become workflow policy rather than a global
 * setting someone has to remember to change.
 */
export function goldenPath(): Workflow {
  return {
    id: 'golden-path-v1',
    objective: 'Take a story to a reviewed pull request',

    claims: {
      'unit-tests': {
        claimClass: 'unit-tests',
        // The exit code of a process this client spawned — not a report from
        // the agent that wrote the code.
        predicate: { select: 'unit.exitCode', op: 'eq', value: 0 },
        evidenceTier: 'PRODUCTION',
        acceptThreshold: 0.5
      },
      'no-lint-errors': {
        claimClass: 'no-lint-errors',
        predicate: { select: 'lint.exitCode', op: 'eq', value: 0 },
        evidenceTier: 'PRODUCTION',
        acceptThreshold: 0.5
      }
    },

    nodes: [
      {
        id: 'analyse',
        type: 'agent',
        role: 'analyst',
        agentId: 'opencode',
        toolProfile: 'lean',
        workspace: 'readonly',
        // Cannot write, by capability rather than by instruction.
        mode: 'explore',
        prompt:
          'Read the story and the code it refers to. Describe what needs to ' +
          'change and why. Your reply is the design note.',
        inputs: [],
        output: 'design',
        // Written by the runtime, so the analyst never needs write capability.
        artifactPath: 'design.md',
        effects: {
          reads: [{ kind: 'repo', path: '**' }],
          writes: [{ kind: 'repo', path: 'design.md' }],
          emits: ['design']
        },
        budget: { timeoutSec: 120, maxTokens: 40_000 },
        contextSlice: [
          { kind: 'document', ref: 'story' },
          { kind: 'repo', ref: '**' }
        ],
        maturity: 'SPEC_BOUND'
      },

      {
        id: 'approve-design',
        type: 'humanGate',
        artifact: 'design',
        // Bound when the artifact exists, never authored ahead of it.
        artifactSha256: 'BIND_AT_RUNTIME',
        requiredRole: 'tech-lead',
        effects: { reads: [], writes: [], emits: [] },
        budget: { timeoutSec: 86_400 },
        contextSlice: [{ kind: 'artifact', ref: 'design' }],
        maturity: 'SPEC_BOUND'
      },

      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        agentId: 'copilot',
        toolProfile: 'full',
        workspace: 'isolatedWorktree',
        mode: 'edit',
        prompt: 'Implement the approved design. Do not run commands; verification is a later step.',
        inputs: ['design'],
        output: 'implementation',
        effects: {
          reads: [{ kind: 'repo', path: '**' }],
          writes: [{ kind: 'repo', path: 'src/**' }],
          emits: ['implementation']
        },
        budget: { timeoutSec: 900, maxTokens: 200_000 },
        contextSlice: [
          { kind: 'artifact', ref: 'design' },
          { kind: 'repo', ref: 'src/**' }
        ],
        maturity: 'SPEC_BOUND'
      },

      {
        id: 'verify',
        type: 'loop',
        maxIterations: 3,
        until: [{ claimId: 'unit-tests' }, { claimId: 'no-lint-errors' }],
        effects: {
          reads: [{ kind: 'repo', path: '**' }],
          writes: [{ kind: 'repo', path: 'src/**' }],
          emits: ['unit', 'lint']
        },
        budget: { timeoutSec: 1800 },
        contextSlice: [{ kind: 'repo', ref: 'src/**' }],
        maturity: 'SPEC_BOUND',
        body: [
          {
            id: 'run-tests',
            type: 'tool',
            command: 'npm test',
            output: 'unit',
            effects: { reads: [{ kind: 'repo', path: '**' }], writes: [], emits: ['unit'] },
            budget: { timeoutSec: 600 },
            contextSlice: [],
            maturity: 'SPEC_BOUND'
          },
          {
            id: 'run-lint',
            type: 'tool',
            command: 'npm run lint',
            output: 'lint',
            effects: { reads: [{ kind: 'repo', path: '**' }], writes: [], emits: ['lint'] },
            budget: { timeoutSec: 300 },
            contextSlice: [],
            maturity: 'SPEC_BOUND'
          },
          {
            id: 'repair',
            type: 'agent',
            role: 'repair',
            agentId: 'copilot',
            toolProfile: 'lean',
            workspace: 'isolatedWorktree',
            mode: 'edit',
            prompt: 'The verification step failed. Fix the cause. Change nothing else.',
            inputs: ['implementation'],
            output: 'repair-attempt',
            effects: {
              reads: [{ kind: 'repo', path: '**' }],
              writes: [{ kind: 'repo', path: 'src/**' }],
              emits: ['repair-attempt']
            },
            budget: { timeoutSec: 600, maxTokens: 100_000 },
            contextSlice: [{ kind: 'repo', ref: 'src/**' }],
            maturity: 'SPEC_BOUND'
          }
        ]
      },

      {
        id: 'open-pr',
        type: 'tool',
        // Stubbed in v1; M6 wires this through the capability router to GitHub.
        command: 'echo "PR would open here"',
        output: 'pr',
        effects: { reads: [{ kind: 'repo', path: '**' }], writes: [{ kind: 'external' }], emits: ['pr'] },
        budget: { timeoutSec: 120 },
        contextSlice: [],
        maturity: 'SPEC_BOUND'
      }
    ]
  }
}
