/**
 * The embedding contract.
 *
 * This is the promise Event Horizon makes to a host, and the only thing a host
 * should assert against. Everything else — file layout, function bodies, private
 * fields, the exact wording of a UI string — is free to change.
 *
 * Why it exists: a host that tests integration by grepping this repo's source
 * (`assert.match(app, /export async function activateWorkspace/)`) is coupled to
 * our internals. Renaming a private field then breaks the host's build while the
 * integration itself is perfectly healthy, and the only way to develop upstream
 * is to keep the host open in another window. That is the coupling this file
 * removes.
 *
 * The rules:
 *   - `version` is bumped ONLY when something here is removed or changes shape.
 *     Adding a capability or an event is backwards-compatible and does not bump.
 *   - Anything listed here is load-bearing. Removing an entry is a breaking
 *     change and must bump `version`.
 *   - `conformance()` verifies the declaration against the real module at
 *     runtime, so this file cannot drift into describing a version of the code
 *     that no longer exists.
 */

export const EVENT_HORIZON_CONTRACT_VERSION = 1

/** Functions a host may call. Verified to exist by `conformance()`. */
export const CONTRACT_API = [
  'registerEventHorizonHandlers',
  'openEventHorizonWindow',
  'activateWorkspace',
  'eventHorizonStatus',
  'setHostContext',
  'getHostContext',
  'startStandalone',
  'registerProvider'
] as const

/** Events the renderer understands. A host may rely on these being delivered. */
export const CONTRACT_EVENTS = [
  'session:created',
  'session:blocks',
  'session:patch',
  'session:removed',
  'session:turnEnded',
  'session:activate',
  'host:context'
] as const

/**
 * Behaviours a host can depend on. A flag here is a promise that the behaviour
 * exists, not a claim about how it is implemented.
 */
export const CONTRACT_CAPABILITIES = {
  /** Opaque per-directory context, published by the host, rendered by its slot. */
  hostContext: true,
  /** Host-supplied render functions in the top bar and around the composer. */
  uiSlots: true,
  /** WorkspaceProvider registration for workflow systems. */
  workspaceProviders: true,
  /** Provider-supplied documents injected into a session's context. */
  contextDocuments: true,
  /** Nothing runs until the user approves it. */
  permissionGate: true,
  /** Reopening a directory focuses its session rather than starting another. */
  sessionReuse: true,
  /** Spawn-time toolset selection, trading agent breadth for context. */
  toolProfiles: true,
  /** Structural file outlines as a cheaper alternative to full contents. */
  astOutlines: true,
  /** Persistent, incrementally-maintained symbol index under .ast/. */
  astIndex: true
} as const

export type ContractCapability = keyof typeof CONTRACT_CAPABILITIES

export interface EventHorizonContract {
  version: number
  api: readonly string[]
  events: readonly string[]
  capabilities: Readonly<Record<string, boolean>>
}

export const EVENT_HORIZON_CONTRACT: EventHorizonContract = {
  version: EVENT_HORIZON_CONTRACT_VERSION,
  api: CONTRACT_API,
  events: CONTRACT_EVENTS,
  capabilities: CONTRACT_CAPABILITIES
}

export interface ConformanceResult {
  ok: boolean
  missingApi: string[]
  problems: string[]
}

/**
 * Checks the declaration against a module that claims to implement it.
 *
 * Pass the built entry point. A host runs this at startup or in a test; the
 * repo runs it in `contract:check` so the declaration cannot quietly describe
 * code that has since been renamed or deleted.
 */
export function conformance(mod: Record<string, unknown>): ConformanceResult {
  const missingApi = CONTRACT_API.filter((name) => typeof mod[name] !== 'function')
  const problems: string[] = []

  if (typeof mod.EVENT_HORIZON_CONTRACT === 'object' && mod.EVENT_HORIZON_CONTRACT !== null) {
    const declared = mod.EVENT_HORIZON_CONTRACT as EventHorizonContract
    if (declared.version !== EVENT_HORIZON_CONTRACT_VERSION) {
      problems.push(
        `contract version mismatch: module says ${declared.version}, expected ${EVENT_HORIZON_CONTRACT_VERSION}`
      )
    }
  } else {
    problems.push('module does not export EVENT_HORIZON_CONTRACT')
  }

  return { ok: missingApi.length === 0 && problems.length === 0, missingApi, problems }
}

/**
 * A host's compatibility check. Returns a human-readable reason when the
 * installed Event Horizon cannot satisfy what the host needs, so the failure
 * names the missing capability instead of surfacing as a crash later.
 */
export function requireContract(options: {
  version: number
  capabilities?: string[]
  events?: string[]
}): { ok: true } | { ok: false; reason: string } {
  if (options.version !== EVENT_HORIZON_CONTRACT_VERSION) {
    return {
      ok: false,
      reason: `Event Horizon contract v${EVENT_HORIZON_CONTRACT_VERSION} is installed; host requires v${options.version}`
    }
  }
  for (const cap of options.capabilities ?? []) {
    if (!(CONTRACT_CAPABILITIES as Record<string, boolean>)[cap]) {
      return { ok: false, reason: `Event Horizon does not provide capability "${cap}"` }
    }
  }
  for (const evt of options.events ?? []) {
    if (!(CONTRACT_EVENTS as readonly string[]).includes(evt)) {
      return { ok: false, reason: `Event Horizon does not emit event "${evt}"` }
    }
  }
  return { ok: true }
}
