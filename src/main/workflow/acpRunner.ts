import { AgentSession } from '../acp/session'
import { matchGlob } from './constraints'
import { resolveAgent } from '../agents'
import type { MainEvent } from '../../shared/ipc'
import type { AgentNode } from './ir'
import type { AgentRunner } from './runtime'

/**
 * The production AgentRunner: one ACP session per agent node.
 *
 * Session-per-step is how context routing is answered. A long-lived session
 * accumulates everything every step ever said, which is the thing that makes
 * later steps both expensive and confused; a step that opens its own session
 * gets exactly its contextSlice and nothing else, and the session is disposed
 * the moment the step ends.
 *
 * Each step also pins its own capability mode and tool profile. An analyst runs
 * lean and `explore` — it cannot write, whatever it decides it would like to do
 * — while an implementer runs full and `edit`. That is the IR's per-step policy
 * becoming an actual constraint rather than a description.
 */
export function acpAgentRunner(opts?: {
  /** Per-(thread, step) virtual key, so gateway spend attributes correctly. */
  virtualKeyFor?: (node: AgentNode) => string | undefined
  onEvent?: (nodeId: string, event: MainEvent) => void
}): AgentRunner {
  return {
    async run(node, ctx) {
      const agent = await resolveAgent(node.agentId, node.toolProfile, opts?.virtualKeyFor?.(node))
      const session = new AgentSession(agent, ctx.cwd)

      // Pinned before start, so nothing the agent does on connect escapes it —
      // including the constraint, which is a property of the session rather
      // than a sentence in the prompt.
      session.setMode(node.mode, {
        autoGrant: true,
        forbiddenWrites: ctx.forbiddenWrites,
        matchPath: matchGlob
      })

      let text = ''
      session.on('event', (event: MainEvent) => {
        opts?.onEvent?.(node.id, event)
        if (event.type !== 'session:blocks') return
        // The step's output is what the agent said, assembled from the
        // transcript rather than from a field the agent controls.
        text = event.blocks
          .filter((b) => b.kind === 'assistant')
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim()
      })

      // The step's own timeout, enforced here as well as by the runtime: a
      // hung agent process should not hold the whole run open.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`step ${node.id} exceeded ${ctx.timeoutSec}s`)),
          ctx.timeoutSec * 1000
        )
      )

      try {
        await Promise.race([session.start(), timeout])
        // The constraint goes in the prompt as well as the policy. Not because
        // the prompt enforces anything, but because a step that is refused
        // without being told why will keep trying and burn its budget on it.
        const constraintText = ctx.constraints.length
          ? '\n\nConstraints on this run (enforced by the client — attempts will be refused):\n' +
            ctx.constraints.map((c) => `- ${c.text}`).join('\n')
          : ''
        const prompt = [
          node.prompt,
          constraintText,
          ...Object.entries(ctx.inputs)
            .filter(([, v]) => v)
            .map(([name, value]) => `\n\n--- ${name} ---\n${value}`)
        ].join('')
        await Promise.race([session.prompt({ text: prompt }), timeout])
        return { output: text }
      } finally {
        session.dispose()
      }
    }
  }
}
