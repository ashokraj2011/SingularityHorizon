import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import type { LlmEndpoint, LlmEndpointInput } from '../shared/ipc'

/**
 * Configured LLM gateways and APIs.
 *
 * The built-in harness can point at anything that speaks one of two wire
 * formats, so the interesting question is not which vendors are supported but
 * where the credentials live. Three rules, and the third is the one that costs
 * something:
 *
 *   The renderer never sees a key. It receives `hasKey: boolean` and nothing
 *   else, so a key cannot leak through a devtools panel, an error boundary, or
 *   a state dump.
 *
 *   Keys are encrypted at rest by the OS keychain, injected here rather than
 *   imported, so this module stays runnable headlessly.
 *
 *   If encryption is unavailable, the key is **not persisted**. Writing a
 *   secret in cleartext because the keychain was locked is the kind of
 *   convenience that ends up in a support ticket years later. The endpoint is
 *   saved without it and the UI says the key must come from the environment.
 */

export interface Cipher {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/** Refuses everything. The default until a real one is injected. */
export const NO_CIPHER: Cipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('no cipher configured')
  },
  decrypt: () => {
    throw new Error('no cipher configured')
  }
}

interface StoredEndpoint {
  id: string
  name: string
  provider: 'openai' | 'anthropic'
  baseUrl: string
  models: string[]
  defaultModel?: string
  wireApi?: 'completions' | 'responses'
  useForCopilot?: boolean
  /** Ciphertext, base64. Absent when the keychain was unavailable at save. */
  keyCipher?: string
  createdAt: number
}

interface StoreFile {
  version: 1
  endpoints: StoredEndpoint[]
  defaultId?: string
}

let rootDir = ''
let cipher: Cipher = NO_CIPHER
let cache: StoreFile | null = null

export function configureEndpoints(dir: string, injected: Cipher = NO_CIPHER): void {
  rootDir = dir
  cipher = injected
  cache = null
}

function file(): string {
  return join(rootDir, 'endpoints.json')
}

async function load(): Promise<StoreFile> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as StoreFile
    cache = parsed?.endpoints ? parsed : { version: 1, endpoints: [] }
  } catch {
    cache = { version: 1, endpoints: [] }
  }
  return cache
}

async function save(next: StoreFile): Promise<void> {
  cache = next
  await mkdir(dirname(file()), { recursive: true })
  await writeFile(file(), JSON.stringify(next, null, 2), 'utf8')
  // Even encrypted, this file is nobody else's business.
  await chmod(file(), 0o600).catch(() => {})
}

/** What the renderer is allowed to know. Never the key. */
function redact(e: StoredEndpoint, defaultId?: string): LlmEndpoint {
  return {
    id: e.id,
    name: e.name,
    provider: e.provider,
    baseUrl: e.baseUrl,
    models: e.models,
    defaultModel: e.defaultModel,
    hasKey: !!e.keyCipher,
    isDefault: e.id === defaultId,
    wireApi: e.wireApi,
    useForCopilot: e.useForCopilot
  }
}

export async function listEndpoints(): Promise<LlmEndpoint[]> {
  const store = await load()
  return store.endpoints.map((e) => redact(e, store.defaultId))
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export interface SaveOutcome {
  endpoint: LlmEndpoint
  /** Set when the endpoint saved but the key did not. */
  warning?: string
}

export async function saveEndpoint(input: LlmEndpointInput): Promise<SaveOutcome> {
  const store = await load()
  const baseUrl = normalizeUrl(input.baseUrl)

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('The base URL must start with http:// or https://')
  }
  if (!input.name.trim()) throw new Error('Give the endpoint a name')
  if (!input.models.length) throw new Error('List at least one model')

  const existing = input.id ? store.endpoints.find((e) => e.id === input.id) : undefined
  let warning: string | undefined
  let keyCipher = existing?.keyCipher

  if (input.apiKey !== undefined) {
    if (!input.apiKey) {
      keyCipher = undefined
    } else if (cipher.available()) {
      keyCipher = cipher.encrypt(input.apiKey)
    } else {
      // Deliberately not written in cleartext.
      keyCipher = undefined
      warning =
        'The system keychain is unavailable, so the key was not saved. ' +
        'Set it in the environment instead — it is never written unencrypted.'
    }
  }

  const endpoint: StoredEndpoint = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim(),
    provider: input.provider,
    baseUrl,
    models: input.models.map((m) => m.trim()).filter(Boolean),
    defaultModel: input.defaultModel ?? input.models[0],
    wireApi: input.wireApi,
    useForCopilot: input.useForCopilot,
    keyCipher,
    createdAt: existing?.createdAt ?? Date.now()
  }

  const endpoints = existing
    ? store.endpoints.map((e) => (e.id === endpoint.id ? endpoint : e))
    : [...store.endpoints, endpoint]

  // The first endpoint added is the default, because a list of one with nothing
  // selected is a configuration screen that looks finished and does nothing.
  const defaultId = store.defaultId ?? endpoint.id
  await save({ version: 1, endpoints, defaultId })
  return { endpoint: redact(endpoint, defaultId), warning }
}

export async function deleteEndpoint(id: string): Promise<void> {
  const store = await load()
  const endpoints = store.endpoints.filter((e) => e.id !== id)
  const defaultId = store.defaultId === id ? endpoints[0]?.id : store.defaultId
  await save({ version: 1, endpoints, defaultId })
}

export async function setDefaultEndpoint(id: string): Promise<void> {
  const store = await load()
  if (!store.endpoints.some((e) => e.id === id)) throw new Error('No such endpoint')
  await save({ ...store, defaultId: id })
}

/**
 * The environment a harness process should be spawned with.
 *
 * Decryption happens here, in the main process, and the plaintext goes
 * straight into the child's environment — it is never returned to a caller that
 * might render it. An endpoint with no stored key contributes none, leaving
 * whatever the ambient environment already had.
 */
export async function endpointEnv(id?: string): Promise<Record<string, string>> {
  const store = await load()
  const chosen =
    store.endpoints.find((e) => e.id === (id ?? store.defaultId)) ?? store.endpoints[0]
  if (!chosen) return {}

  let key: string | undefined
  if (chosen.keyCipher) {
    try {
      key = cipher.decrypt(chosen.keyCipher)
    } catch {
      // A keychain that will not open is not a reason to spawn with a broken
      // credential; better to fall through to the environment.
      key = undefined
    }
  }

  return {
    EH_HARNESS_BASE_URL: chosen.baseUrl,
    EH_HARNESS_PROVIDER: chosen.provider,
    EH_HARNESS_MODEL: chosen.defaultModel ?? chosen.models[0] ?? '',
    EH_HARNESS_MODELS: chosen.models.join(','),
    ...(key ? { EH_HARNESS_API_KEY: key } : {})
  }
}

export interface EndpointTest {
  ok: boolean
  message: string
}

/**
 * Ask the endpoint whether it is there.
 *
 * A models listing rather than a completion: it costs nothing, needs no model
 * to be valid, and distinguishes the three failures that actually happen —
 * wrong host, wrong path, wrong key — which a failed completion does not.
 */
export async function testEndpoint(id: string): Promise<EndpointTest> {
  const store = await load()
  const chosen = store.endpoints.find((e) => e.id === id)
  if (!chosen) return { ok: false, message: 'No such endpoint' }

  let key: string | undefined
  try {
    key = chosen.keyCipher ? cipher.decrypt(chosen.keyCipher) : process.env.EH_HARNESS_API_KEY
  } catch {
    key = undefined
  }

  const url = `${chosen.baseUrl}/models`
  const headers: Record<string, string> =
    chosen.provider === 'anthropic'
      ? { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' }
      : { ...(key ? { authorization: `Bearer ${key}` } : {}) }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (res.ok) return { ok: true, message: `${chosen.baseUrl} answered` }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Reached ${chosen.baseUrl}, but the key was rejected (${res.status})` }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Reached the host, but ${url} is not there — check the path (a base URL usually ends in /v1)`
      }
    }
    return { ok: false, message: `${res.status} ${res.statusText}` }
  } catch (error) {
    return { ok: false, message: `Could not reach ${chosen.baseUrl}: ${(error as Error).message}` }
  }
}

/**
 * Copilot's BYOK environment, from a configured endpoint.
 *
 * Copilot CLI can be pointed at any provider by setting COPILOT_PROVIDER_*,
 * which means the same gateway can drive Copilot's harness and this app's own
 * one. Two details from `copilot help providers` that are easy to get wrong:
 * the variables are not namespaced per provider — it is COPILOT_PROVIDER_TYPE
 * plus one COPILOT_PROVIDER_BASE_URL, not COPILOT_PROVIDER_OPENAI_BASE_URL —
 * and BYOK will not start without a model, so COPILOT_MODEL is required rather
 * than optional.
 *
 * Returns nothing unless an endpoint explicitly opted in. Rerouting Copilot
 * away from GitHub's own model routing is a large, silent behaviour change if
 * it happens by default, and the failure would look like Copilot being broken.
 */
export async function copilotProviderEnv(id?: string): Promise<Record<string, string>> {
  const store = await load()
  const chosen = id
    ? store.endpoints.find((e) => e.id === id)
    : store.endpoints.find((e) => e.useForCopilot)
  if (!chosen || !chosen.useForCopilot) return {}

  const model = chosen.defaultModel ?? chosen.models[0]
  // Without a model BYOK refuses to start, and an endpoint with none
  // configured would break Copilot rather than redirect it.
  if (!model) return {}

  let key: string | undefined
  if (chosen.keyCipher) {
    try {
      key = cipher.decrypt(chosen.keyCipher)
    } catch {
      key = undefined
    }
  }

  return {
    COPILOT_PROVIDER_BASE_URL: chosen.baseUrl,
    COPILOT_PROVIDER_TYPE: chosen.provider,
    COPILOT_MODEL: model,
    ...(key ? { COPILOT_PROVIDER_API_KEY: key } : {}),
    // Defaults to "completions"; the GPT-5 series needs "responses", which is
    // why this is worth carrying rather than assuming.
    ...(chosen.wireApi ? { COPILOT_PROVIDER_WIRE_API: chosen.wireApi } : {})
  }
}
