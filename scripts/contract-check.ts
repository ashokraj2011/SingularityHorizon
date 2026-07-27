/**
 * Verifies the embedding contract describes code that actually exists.
 *
 * The contract's whole value is that a host can assert against it instead of
 * against this repo's source. That only holds if the declaration cannot drift —
 * so every name it promises is checked against the real module here, and a
 * rename that forgets to update the contract fails this repo's build rather
 * than some downstream host's.
 *
 * Run with: npm run contract:check
 */
import {
  CONTRACT_API,
  CONTRACT_CAPABILITIES,
  CONTRACT_EVENTS,
  EVENT_HORIZON_CONTRACT,
  EVENT_HORIZON_CONTRACT_VERSION,
  requireContract
} from '../src/main/contract'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => { checks.push([n, p, d]) }

/* ------------------------------------------------ the API really exists */

// Imported lazily: app.ts pulls in electron, which cannot load outside an
// Electron runtime. Reading the source for exported names is the honest
// alternative here — this is the one place source inspection is correct,
// because verifying the source matches the contract is the entire job.
const appSource = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../src/main/app.ts', import.meta.url), 'utf8')
)
const contractSource = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../src/main/contract.ts', import.meta.url), 'utf8')
)
const registrySource = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../src/main/providers/registry.ts', import.meta.url), 'utf8')
)

for (const name of CONTRACT_API) {
  const exported =
    new RegExp(`export (async )?function ${name}\\b`).test(appSource) ||
    new RegExp(`export (async )?function ${name}\\b`).test(registrySource) ||
    new RegExp(`export (async )?function ${name}\\b`).test(contractSource)
  ok(`contract API "${name}" is exported`, exported)
}

/* --------------------------------------------- events are real variants */

const ipcSource = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../src/shared/ipc.ts', import.meta.url), 'utf8')
)
const storeSource = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
)

for (const evt of CONTRACT_EVENTS) {
  ok(`event "${evt}" is declared in MainEvent`, ipcSource.includes(`'${evt}'`))
}
// Every promised event must also be something the renderer acts on, otherwise
// we are advertising a delivery that silently goes nowhere.
for (const evt of CONTRACT_EVENTS) {
  if (evt === 'session:created' || evt === 'session:blocks' || evt === 'session:patch') continue
  ok(`event "${evt}" is handled by the store`, storeSource.includes(`case '${evt}'`))
}

/* ------------------------------------------------------- version rules */

ok('version is a positive integer', Number.isInteger(EVENT_HORIZON_CONTRACT_VERSION) && EVENT_HORIZON_CONTRACT_VERSION > 0)
ok('exported contract matches the constants', EVENT_HORIZON_CONTRACT.version === EVENT_HORIZON_CONTRACT_VERSION)
ok('api list is non-empty', EVENT_HORIZON_CONTRACT.api.length > 0)
ok('no duplicate api entries', new Set(CONTRACT_API).size === CONTRACT_API.length)
ok('no duplicate events', new Set(CONTRACT_EVENTS).size === CONTRACT_EVENTS.length)
ok('every capability is enabled', Object.values(CONTRACT_CAPABILITIES).every(Boolean))

/* ------------------------------------------- requireContract behaviour */

ok(
  'matching requirement passes',
  requireContract({ version: EVENT_HORIZON_CONTRACT_VERSION }).ok
)
const wrongVersion = requireContract({ version: EVENT_HORIZON_CONTRACT_VERSION + 1 })
ok('version mismatch is rejected', !wrongVersion.ok)
ok(
  'rejection names the versions',
  !wrongVersion.ok && /contract v\d+ is installed/.test(wrongVersion.reason),
  !wrongVersion.ok ? wrongVersion.reason : undefined
)

const missingCap = requireContract({
  version: EVENT_HORIZON_CONTRACT_VERSION,
  capabilities: ['timeTravel']
})
ok('unknown capability is rejected', !missingCap.ok)
ok(
  'rejection names the capability',
  !missingCap.ok && missingCap.reason.includes('timeTravel'),
  !missingCap.ok ? missingCap.reason : undefined
)

const missingEvent = requireContract({
  version: EVENT_HORIZON_CONTRACT_VERSION,
  events: ['session:teleported']
})
ok('unknown event is rejected', !missingEvent.ok)

ok(
  'a real host requirement is satisfiable',
  requireContract({
    version: 1,
    capabilities: ['hostContext', 'uiSlots', 'workspaceProviders', 'sessionReuse'],
    events: ['host:context', 'session:activate']
  }).ok
)

console.log('--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (${detail})` : ''}`)
  if (!pass) failed++
}
console.log(
  failed === 0
    ? `\ncontract v${EVENT_HORIZON_CONTRACT_VERSION}: ${CONTRACT_API.length} api, ${CONTRACT_EVENTS.length} events, ${Object.keys(CONTRACT_CAPABILITIES).length} capabilities — all ${checks.length} passed`
    : `\n${failed} FAILED`
)
process.exit(failed === 0 ? 0 : 1)
