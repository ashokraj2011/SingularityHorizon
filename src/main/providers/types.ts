import type { ContextDocument, ProviderStatus } from '../../shared/ipc'

/**
 * The extension point for workflow systems.
 *
 * Event Horizon's core knows nothing about any particular SDLC tool. It knows
 * about repos, sessions, and context. Anything that adds a lifecycle on top of
 * that — phases, work items, handoff documents, grounding — arrives through
 * this interface, registered by the host.
 *
 * The standalone app registers nothing and behaves as a plain agent client.
 * A host that embeds Event Horizon inside its own product registers its
 * provider at startup and gets phase awareness without the core ever importing
 * it. That direction of dependency is the whole point: the workflow tool knows
 * about Event Horizon, never the reverse.
 *
 * Every method is allowed to fail. A provider that throws, times out, or is
 * pointed at a repo it does not understand must degrade to "not applicable"
 * rather than breaking session creation — an agent client that will not open a
 * folder because an unrelated CLI is missing is worse than one with no
 * workflow integration at all.
 */
export interface WorkspaceProvider {
  /** Stable identifier, e.g. `singularity-flow`. */
  id: string
  /** Human-readable name for the UI. */
  name: string

  /**
   * Cheap applicability check. Return null when this provider has nothing to
   * say about the repo — that is the normal case, not an error.
   */
  detect(root: string): Promise<ProviderStatus | null>

  /**
   * Documents that should seed a session's context — a phase handoff, a
   * grounding package, a spec. Returning these lets the host decide *when* to
   * inject them; the provider only decides *what* is relevant.
   */
  contextDocuments?(root: string, opts?: { phase?: string }): Promise<ContextDocument[]>

  /**
   * Called when the host is about to start a fresh session because the
   * lifecycle moved on. Purely advisory — the provider can use it to
   * regenerate a handoff before the new session reads it.
   */
  onPhaseEnter?(root: string, phase: string): Promise<void>
}

/** Wraps a provider call so a broken integration cannot take the app down. */
export async function safely<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  timeoutMs = 15_000
): Promise<T> {
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      )
    ])
  } catch (err) {
    console.warn(`[provider] ${label} failed:`, (err as Error).message)
    return fallback
  }
}
