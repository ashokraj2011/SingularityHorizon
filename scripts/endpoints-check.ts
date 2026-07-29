/**
 * LLM gateway configuration.
 *
 * Most of this is ordinary CRUD; two assertions are not, and they are the
 * reason the file exists. A key must never appear in what the renderer
 * receives, and a key must never be written to disk in cleartext — including
 * when the keychain is unavailable, which is exactly the moment a convenient
 * implementation would fall back to writing it.
 *
 * Run with: npm run endpoints:check
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configureEndpoints,
  copilotProviderEnv,
  deleteEndpoint,
  endpointEnv,
  listEndpoints,
  saveEndpoint,
  setDefaultEndpoint,
  NO_CIPHER,
  type Cipher
} from '../src/main/llmEndpoints'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => {
  checks.push([n, p, d])
}

const SECRET = 'sk-test-do-not-write-me-anywhere'

/** Stands in for the OS keychain. Reversible, and obviously not the plaintext. */
const fakeCipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain).toString('base64'),
  decrypt: (cipherText) => Buffer.from(cipherText, 'base64').toString('utf8')
}

const dir = mkdtempSync(join(tmpdir(), 'eh-endpoints-'))
configureEndpoints(dir, fakeCipher)

const saved = await saveEndpoint({
  name: 'Internal gateway',
  provider: 'openai',
  baseUrl: 'https://gateway.corp/v1/',
  models: ['claude-sonnet-5', 'gpt-5.4'],
  apiKey: SECRET
})

ok('an endpoint saves', !!saved.endpoint.id)
ok('a trailing slash is normalised off', saved.endpoint.baseUrl === 'https://gateway.corp/v1',
   saved.endpoint.baseUrl)
ok('the first endpoint becomes the default', saved.endpoint.isDefault)
ok('it reports that a key is stored', saved.endpoint.hasKey)

// The renderer is given a shape with no key on it at all, so there is nothing
// to leak through a devtools panel or a state dump.
ok('what the renderer receives has no key field',
   !JSON.stringify(saved.endpoint).includes('apiKey'))
ok('and does not contain the key by any other name',
   !JSON.stringify(saved.endpoint).includes(SECRET))

const onDisk = readFileSync(join(dir, 'endpoints.json'), 'utf8')
ok('the file on disk does not contain the key', !onDisk.includes(SECRET))
ok('it contains a ciphertext instead', onDisk.includes(Buffer.from(SECRET).toString('base64')))

// Decryption happens in the main process and the plaintext goes straight into
// the child environment.
const env = await endpointEnv()
ok('the spawn environment carries the base URL', env.EH_HARNESS_BASE_URL === 'https://gateway.corp/v1')
ok('and the wire format', env.EH_HARNESS_PROVIDER === 'openai')
ok('and every model, so the picker can offer them',
   env.EH_HARNESS_MODELS === 'claude-sonnet-5,gpt-5.4', env.EH_HARNESS_MODELS)
ok('and the decrypted key', env.EH_HARNESS_API_KEY === SECRET)

/* ------------------------------------------------ editing keeps the key */

const edited = await saveEndpoint({
  id: saved.endpoint.id,
  name: 'Internal gateway (renamed)',
  provider: 'openai',
  baseUrl: 'https://gateway.corp/v1',
  models: ['claude-sonnet-5']
  // apiKey omitted entirely — the stored one must survive.
})
ok('editing without touching the key keeps it', edited.endpoint.hasKey)
ok('and applies the other changes', edited.endpoint.name.includes('renamed'))
ok('the key still decrypts after an edit', (await endpointEnv()).EH_HARNESS_API_KEY === SECRET)

const cleared = await saveEndpoint({
  id: saved.endpoint.id,
  name: 'Internal gateway',
  provider: 'openai',
  baseUrl: 'https://gateway.corp/v1',
  models: ['claude-sonnet-5'],
  apiKey: ''
})
ok('an empty key clears the stored one', !cleared.endpoint.hasKey)
ok('and the environment then carries none',
   (await endpointEnv()).EH_HARNESS_API_KEY === undefined)

/* ------------------------------- no keychain means no key, not a plaintext one */

const plainDir = mkdtempSync(join(tmpdir(), 'eh-nokeychain-'))
configureEndpoints(plainDir, NO_CIPHER)

const unencrypted = await saveEndpoint({
  name: 'No keychain here',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  models: ['claude-sonnet-5'],
  apiKey: SECRET
})

// The assertion this file exists for.
ok('with no keychain the endpoint still saves', !!unencrypted.endpoint.id)
ok('but the key is not stored', !unencrypted.endpoint.hasKey)
ok('and it says so rather than failing silently', !!unencrypted.warning, unencrypted.warning)
ok('the warning explains where to put the key instead',
   (unencrypted.warning ?? '').includes('environment'))
ok('nothing on disk contains the key',
   !readFileSync(join(plainDir, 'endpoints.json'), 'utf8').includes(SECRET))

/* ------------------------------------------------- driving Copilot instead */

// Copilot CLI can be pointed at any provider through COPILOT_PROVIDER_*, so the
// same gateway can drive its harness and the built-in one. Verified against
// `copilot help providers` at 1.0.75, which is also where the shape of these
// names comes from — they are not namespaced per provider.
configureEndpoints(mkdtempSync(join(tmpdir(), 'eh-copilot-')), fakeCipher)

const notOptedIn = await saveEndpoint({
  name: 'Gateway',
  provider: 'openai',
  baseUrl: 'https://gateway.corp/v1',
  models: ['gpt-5.4'],
  apiKey: SECRET
})
// The default has to be "leave Copilot alone". Silently redirecting it away
// from GitHub's routing would look like Copilot being broken.
ok('an endpoint does not drive Copilot unless asked',
   Object.keys(await copilotProviderEnv()).length === 0)

await saveEndpoint({
  id: notOptedIn.endpoint.id,
  name: 'Gateway',
  provider: 'openai',
  baseUrl: 'https://gateway.corp/v1',
  models: ['gpt-5.4'],
  useForCopilot: true,
  wireApi: 'responses'
})
const byok = await copilotProviderEnv()

ok('opting in produces a BYOK environment', Object.keys(byok).length > 0)
// One base URL and a separate type — not COPILOT_PROVIDER_OPENAI_BASE_URL.
ok('the base URL uses the un-namespaced variable',
   byok.COPILOT_PROVIDER_BASE_URL === 'https://gateway.corp/v1', JSON.stringify(byok.COPILOT_PROVIDER_BASE_URL))
ok('the provider type is a separate variable', byok.COPILOT_PROVIDER_TYPE === 'openai')
ok('the key is carried', byok.COPILOT_PROVIDER_API_KEY === SECRET)
// BYOK will not start without one, so an endpoint that cannot supply a model
// must not half-configure Copilot.
ok('a model is always set, because BYOK refuses to start without one',
   byok.COPILOT_MODEL === 'gpt-5.4', byok.COPILOT_MODEL)
ok('the wire API is passed when set', byok.COPILOT_PROVIDER_WIRE_API === 'responses')

const anthropicEndpoint = await saveEndpoint({
  name: 'Anthropic',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  models: ['claude-sonnet-5'],
  useForCopilot: true
})
ok('the anthropic type maps through',
   (await copilotProviderEnv(anthropicEndpoint.endpoint.id)).COPILOT_PROVIDER_TYPE === 'anthropic')
ok('and an endpoint with no key sends none',
   (await copilotProviderEnv(anthropicEndpoint.endpoint.id)).COPILOT_PROVIDER_API_KEY === undefined)
ok('the default wire API is left unset rather than guessed',
   (await copilotProviderEnv(anthropicEndpoint.endpoint.id)).COPILOT_PROVIDER_WIRE_API === undefined)

// Naming an endpoint explicitly must not opt it in — the flag is the opt-in,
// not the fact that somebody referred to it.
const neverOptedIn = await saveEndpoint({
  name: 'Plain endpoint',
  provider: 'openai',
  baseUrl: 'https://plain.corp/v1',
  models: ['gpt-5.4']
})
ok('naming an endpoint that never opted in yields nothing',
   Object.keys(await copilotProviderEnv(neverOptedIn.endpoint.id)).length === 0,
   JSON.stringify(await copilotProviderEnv(neverOptedIn.endpoint.id)))

// An opted-in endpoint with no model would half-configure Copilot, which BYOK
// refuses to start with — worse than leaving it alone.
ok('an opted-in endpoint always carries a model',
   !!(await copilotProviderEnv()).COPILOT_MODEL)

configureEndpoints(dir, fakeCipher)

/* ------------------------------------------------------------ validation */

configureEndpoints(dir, fakeCipher)
const rejects = async (input: Parameters<typeof saveEndpoint>[0]): Promise<string | null> => {
  try {
    await saveEndpoint(input)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

ok('a base URL without a scheme is refused',
   !!(await rejects({ name: 'x', provider: 'openai', baseUrl: 'gateway.corp', models: ['m'] })))
ok('an endpoint with no name is refused',
   !!(await rejects({ name: '  ', provider: 'openai', baseUrl: 'https://x/v1', models: ['m'] })))
ok('an endpoint with no models is refused',
   !!(await rejects({ name: 'x', provider: 'openai', baseUrl: 'https://x/v1', models: [] })))
ok('and the refusal is readable',
   ((await rejects({ name: 'x', provider: 'openai', baseUrl: 'nope', models: ['m'] })) ?? '')
     .includes('http'))

/* -------------------------------------------------------- defaults and removal */

const second = await saveEndpoint({
  name: 'Anthropic direct',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  models: ['claude-opus-5']
})
ok('a second endpoint does not steal the default', !second.endpoint.isDefault)

await setDefaultEndpoint(second.endpoint.id)
const afterDefault = await listEndpoints()
ok('the default can be moved',
   afterDefault.find((e) => e.id === second.endpoint.id)?.isDefault === true)
ok('and only one is default at a time',
   afterDefault.filter((e) => e.isDefault).length === 1)
ok('the environment follows the default',
   (await endpointEnv()).EH_HARNESS_PROVIDER === 'anthropic')

// Naming one explicitly beats the default — this is how a workflow step pins
// a cheap model for analysis and a strong one for implementation.
ok('an explicitly named endpoint overrides the default',
   (await endpointEnv(saved.endpoint.id)).EH_HARNESS_PROVIDER === 'openai')

await deleteEndpoint(second.endpoint.id)
const afterDelete = await listEndpoints()
ok('an endpoint can be removed', afterDelete.length === 1)
// Otherwise the app is configured with endpoints and none of them selected.
ok('removing the default promotes another', afterDelete[0].isDefault)

configureEndpoints(mkdtempSync(join(tmpdir(), 'eh-empty-')), fakeCipher)
ok('no endpoints configured yields an empty environment',
   Object.keys(await endpointEnv()).length === 0)
ok('and an empty list rather than an error', (await listEndpoints()).length === 0)

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
