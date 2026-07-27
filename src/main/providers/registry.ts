import type { ContextDocument, ProviderStatus } from '../../shared/ipc'
import { safely, type WorkspaceProvider } from './types'

/**
 * Holds whatever providers the host chose to register.
 *
 * Deliberately empty by default. The standalone app ships with nothing in here
 * and is a complete tool; an embedding host adds its own. Nothing in
 * `src/main/` outside this directory imports a concrete provider, which is what
 * keeps the core free of any particular workflow system — and is enforced by
 * `npm run guard` rather than left to discipline.
 */
const providers: WorkspaceProvider[] = []

export function registerProvider(provider: WorkspaceProvider): () => void {
  if (providers.some((p) => p.id === provider.id)) {
    throw new Error(`Provider already registered: ${provider.id}`)
  }
  providers.push(provider)
  return () => {
    const i = providers.findIndex((p) => p.id === provider.id)
    if (i >= 0) providers.splice(i, 1)
  }
}

export function registeredProviders(): readonly WorkspaceProvider[] {
  return providers
}

export function clearProviders(): void {
  providers.length = 0
}

/** Runs every provider's detect() concurrently; failures are dropped. */
export async function detectAll(root: string): Promise<ProviderStatus[]> {
  const results = await Promise.all(
    providers.map((p) =>
      safely(`${p.id}.detect`, () => p.detect(root), null as ProviderStatus | null)
    )
  )
  return results.filter((r): r is ProviderStatus => r !== null)
}

export async function collectContextDocuments(
  root: string,
  opts?: { phase?: string; hostContext?: unknown }
): Promise<ContextDocument[]> {
  const results = await Promise.all(
    providers.map((p) =>
      p.contextDocuments
        ? safely(`${p.id}.contextDocuments`, () => p.contextDocuments!(root, opts), [])
        : Promise.resolve([] as ContextDocument[])
    )
  )
  return results.flat()
}

export async function notifyPhaseEnter(root: string, phase: string): Promise<void> {
  await Promise.all(
    providers.map((p) =>
      p.onPhaseEnter
        ? safely(`${p.id}.onPhaseEnter`, () => p.onPhaseEnter!(root, phase), undefined)
        : Promise.resolve()
    )
  )
}
