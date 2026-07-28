/**
 * Verifies the AST outline pipeline: structure preserved, bodies dropped,
 * unsupported languages degrade to full content, and the whole thing survives
 * a round trip through buildAttachments.
 *
 * Run with: npm run outline:check
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAttachments, shouldDefaultToOutline } from '../src/main/attachments'
import { extractSymbol, outlineSource, renderOutline } from '../src/main/ast/outline'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => { checks.push([n, p, d]) }

const SAMPLE = `
import { readFile } from 'node:fs/promises'

export interface Config { host: string; port: number }

export type Mode = 'fast' | 'slow'

export const SECRET_IMPLEMENTATION_MARKER = 'zzz'

export function connect(cfg: Config, mode: Mode): Promise<void> {
  const marker = 'IMPLEMENTATION_BODY_MARKER'
  console.log(marker, cfg.host, cfg.port, mode)
  return Promise.resolve()
}

export class Pool {
  private items: string[] = ['IMPLEMENTATION_BODY_MARKER']
  size(): number { return this.items.length }
  async drain(force: boolean): Promise<number> {
    const n = this.items.length
    this.items = []
    return n
  }
}

const helper = (a: number, b: number): number => {
  return a + b + 0
}
`

const o = outlineSource('/tmp/sample.ts', SAMPLE)
const rendered = renderOutline(o)

const has = (n: string): boolean => o.symbols.some((s) => s.name === n)
ok('found exported function', has('connect'))
ok('found class', has('Pool'))
ok('found interface', has('Config'))
ok('found type alias', has('Mode'))
ok('found const', has('SECRET_IMPLEMENTATION_MARKER'))
ok('found arrow function', has('helper'))
ok('found class members', has('size') && has('drain'))
ok('members attributed to their class', o.symbols.find((s) => s.name === 'drain')?.container === 'Pool')
ok('export flag detected', o.symbols.find((s) => s.name === 'connect')?.exported === true)
ok('non-export detected', o.symbols.find((s) => s.name === 'helper')?.exported === false)
ok('captured imports', o.imports.length === 1)

// The whole point: signatures without implementations.
ok('signature retains parameters and return type',
  (o.symbols.find((s) => s.name === 'drain')?.signature ?? '').includes('force: boolean') &&
  (o.symbols.find((s) => s.name === 'drain')?.signature ?? '').includes('Promise<number>'))
ok('IMPLEMENTATION BODIES ARE DROPPED', !rendered.includes('IMPLEMENTATION_BODY_MARKER'), 
   rendered.includes('IMPLEMENTATION_BODY_MARKER') ? 'body leaked!' : undefined)
ok('outline is smaller than the source', rendered.length < SAMPLE.length,
   `${rendered.length} vs ${SAMPLE.length}`)
ok('class body not duplicated into its own signature',
  !(o.symbols.find((s) => s.name === 'Pool')?.signature ?? '').includes('drain'))

// Symbol extraction keeps the body — that is its job.
const sym = await extractSymbol('/dev/null', 'connect')
ok('extractSymbol returns null for unreadable path', sym === null)

/* ------------------------------------------ through buildAttachments */

const dir = mkdtempSync(join(tmpdir(), 'eh-outline-'))
const tsFile = join(dir, 'svc.ts')
writeFileSync(tsFile, SAMPLE)
const pyFile = join(dir, 'thing.py')
writeFileSync(pyFile, 'def go():\n    return "PY_BODY_MARKER"\n')

const built = await buildAttachments(
  [{ path: tsFile, kind: 'file', mode: 'outline' }, { path: pyFile, kind: 'file', mode: 'outline' }],
  dir
)

const tsBlock = built.blocks.find((b) => b.type === 'resource' && 'text' in b.resource && b.resource.text.includes('connect'))
ok('outline attached as a resource block', !!tsBlock)
ok('attached outline has no body', tsBlock && tsBlock.type === 'resource' && 'text' in tsBlock.resource
  ? !tsBlock.resource.text.includes('IMPLEMENTATION_BODY_MARKER') : false)

const tsSummary = built.summaries.find((s) => s.name === 'svc.ts')
ok('summary reports outline mode', tsSummary?.mode === 'outline')
ok('summary reports a saving', (tsSummary?.savedChars ?? 0) > 0, String(tsSummary?.savedChars))

const pySummary = built.summaries.find((s) => s.name === 'thing.py')
ok('unsupported language falls back to full', pySummary?.mode === 'full')
ok('fallback is disclosed, not silent', pySummary?.outlineUnavailable === true)
ok('exactly one summary per attachment', built.summaries.length === 2, String(built.summaries.length))
const pyBlock = built.blocks.find((b) => b.type === 'resource' && 'text' in b.resource && b.resource.text.includes('PY_BODY_MARKER'))
ok('unsupported file still sent in full', !!pyBlock)

/* ------------------------- outline-by-default threshold agreement */

const bigTs = join(dir, 'big-service.ts')
writeFileSync(bigTs, SAMPLE + '\n'.padEnd(13 * 1024, '// filler\n'))
const smallTs = join(dir, 'tiny.ts')
writeFileSync(smallTs, 'export const a = 1\n')
const bigMd = join(dir, 'notes.md')
writeFileSync(bigMd, '#'.padEnd(20 * 1024, 'x'))

ok('large parseable file defaults to outline', shouldDefaultToOutline(bigTs, statSync(bigTs).size))
ok('small parseable file stays full', !shouldDefaultToOutline(smallTs, statSync(smallTs).size))
ok('large unparseable file stays full', !shouldDefaultToOutline(bigMd, statSync(bigMd).size))
ok('missing size never defaults to outline', !shouldDefaultToOutline(bigTs, undefined))

// The renderer keeps its own copy of this rule so the chip can show the mode
// before anything is sent. If the two drift, the UI promises one thing and the
// sender does another.
const storeSource = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../src/main/attachments.ts', import.meta.url), 'utf8')
const rendererBytes = /OUTLINE_DEFAULT_BYTES = (\d+) \* 1024/.exec(storeSource)?.[1]
const mainBytes = /OUTLINE_DEFAULT_BYTES = (\d+) \* 1024/.exec(mainSource)?.[1]
ok('renderer and main agree on the threshold', !!mainBytes && rendererBytes === mainBytes,
   `renderer ${rendererBytes} vs main ${mainBytes}`)

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!pass) failed++
}
console.log(failed === 0 ? `\nall ${checks.length} passed` : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
