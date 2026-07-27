import { registerProvider } from './registry'

/**
 * Opt-in provider loading, so an embedding host can activate an integration
 * without editing a line of Event Horizon.
 *
 * This matters for the consume-upstream-verbatim case: if a host had to modify
 * `main/index.ts` to register its provider, that modification is a fork, and
 * the fork drifts. Instead the host sets:
 *
 *     EVENT_HORIZON_PROVIDERS=singularity-flow
 *
 * Standalone sets nothing and loads nothing. The import is dynamic and by name,
 * so core still never references a concrete provider — an unknown or broken id
 * is a warning, never a failed startup.
 */

type Loader = () => Promise<{ register: () => void }>

/**
 * Known ids mapped to lazy loaders. Adding an entry here does not couple core
 * to the provider: nothing is imported until the id is explicitly requested.
 */
const KNOWN: Record<string, Loader> = {
  'singularity-flow': async () => {
    const mod = await import('./singularityFlow')
    return { register: () => registerProvider(mod.singularityFlowProvider()) }
  }
}

export function availableProviderIds(): string[] {
  return Object.keys(KNOWN)
}

/**
 * Registers every provider named in `EVENT_HORIZON_PROVIDERS` (comma-separated).
 * Returns the ids that actually registered.
 */
export async function loadProvidersFromEnv(
  value = process.env.EVENT_HORIZON_PROVIDERS
): Promise<string[]> {
  const ids = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!ids.length) return []

  const loaded: string[] = []
  for (const id of ids) {
    const loader = KNOWN[id]
    if (!loader) {
      console.warn(
        `[providers] unknown id "${id}" — known: ${availableProviderIds().join(', ') || '(none)'}`
      )
      continue
    }
    try {
      const { register } = await loader()
      register()
      loaded.push(id)
    } catch (err) {
      // A broken integration must not stop the app from opening a folder.
      console.warn(`[providers] failed to load "${id}":`, (err as Error).message)
    }
  }
  return loaded
}
