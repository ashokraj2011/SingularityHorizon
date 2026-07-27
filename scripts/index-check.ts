/**
 * Verifies the persistent AST index: it builds, persists, reuses unchanged
 * files, re-parses only what changed, drops deletions, survives a reload, and
 * stays out of git.
 *
 * Run with: npm run index:check
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AstIndex, indexFor } from '../src/main/ast/astIndex'
import { discoverRepo, ensureAstIgnored } from '../src/main/repo'

const checks: Array<[string, boolean, string?]> = []
const ok = (n: string, p: boolean, d?: string): void => { checks.push([n, p, d]) }

const repo = mkdtempSync(join(tmpdir(), 'eh-index-'))
execFileSync('git', ['init', '-q'], { cwd: repo })
mkdirSync(join(repo, 'src'), { recursive: true })
mkdirSync(join(repo, 'node_modules', 'junk'), { recursive: true })

writeFileSync(join(repo, 'src', 'alpha.ts'), `
export function alphaOne(a: number): string { return '' }
export class AlphaBox { open(): void {} }
`)
writeFileSync(join(repo, 'src', 'beta.ts'), `export const betaThing = (x: string): number => 1\n`)
writeFileSync(join(repo, 'node_modules', 'junk', 'nope.ts'), `export function shouldNotBeIndexed(): void {}\n`)
writeFileSync(join(repo, 'readme.md'), '# not code\n')

/* ------------------------------------------------------------- build */

const idx = new AstIndex(repo)
const first = await idx.refresh()

ok('indexed the source files', first.files === 2, `${first.files}`)
ok('parsed everything on a cold build', first.parsed === 2 && first.reused === 0,
   `parsed ${first.parsed} reused ${first.reused}`)
ok('found symbols', first.symbols >= 4, `${first.symbols}`)
ok('index persisted to .ast/', existsSync(join(repo, '.ast', 'index.json')))
ok('node_modules excluded', idx.search('shouldNotBeIndexed').length === 0)
ok('non-code files excluded', first.files === 2)

/* ------------------------------------------------------------ search */

const hit = idx.search('alphaOne')[0]
ok('search finds a function', hit?.name === 'alphaOne', hit?.name)
ok('hit carries a path', hit?.path === 'src/alpha.ts', hit?.path)
ok('hit carries a line', typeof hit?.line === 'number' && hit.line > 0, String(hit?.line))
ok('hit carries the signature', (hit?.signature ?? '').includes('a: number'), hit?.signature)
ok('exact match outranks substring',
   idx.search('open')[0]?.name === 'open', idx.search('open')[0]?.name)
ok('class members are attributed', idx.search('open')[0]?.container === 'AlphaBox')
ok('empty query returns nothing', idx.search('  ').length === 0)

/* --------------------------------------------- incremental invalidation */

// Nothing changed: everything should be reused, nothing re-parsed.
const noop = await idx.refresh()
ok('unchanged refresh re-parses nothing', noop.parsed === 0 && noop.reused === 2,
   `parsed ${noop.parsed} reused ${noop.reused}`)

// Change one file. Only that one may be re-parsed.
await new Promise((r) => setTimeout(r, 12))  // ensure a distinct mtime
writeFileSync(join(repo, 'src', 'beta.ts'),
  `export const betaThing = (x: string): number => 1\nexport function betaAdded(): void {}\n`)

const afterEdit = await idx.refresh()
ok('an edit re-parses exactly one file', afterEdit.parsed === 1, `${afterEdit.parsed}`)
ok('the untouched file is reused, not re-parsed', afterEdit.reused === 1, `${afterEdit.reused}`)
ok('the new symbol is searchable', idx.search('betaAdded').length === 1)

// Add a file.
writeFileSync(join(repo, 'src', 'gamma.ts'), `export function gammaFn(): void {}\n`)
const afterAdd = await idx.refresh()
ok('a new file is picked up', afterAdd.files === 3 && afterAdd.parsed === 1,
   `files ${afterAdd.files} parsed ${afterAdd.parsed}`)

// Delete a file.
rmSync(join(repo, 'src', 'gamma.ts'))
const afterDelete = await idx.refresh()
ok('a deleted file is dropped', afterDelete.files === 2 && afterDelete.removed === 1,
   `files ${afterDelete.files} removed ${afterDelete.removed}`)
ok('deleted symbols stop matching', idx.search('gammaFn').length === 0)

/* ------------------------------------------------------ persistence */

const reloaded = new AstIndex(repo)
await reloaded.load()
ok('index survives a reload without re-parsing', reloaded.search('alphaOne').length === 1)
const warm = await reloaded.refresh()
ok('a warm start re-parses nothing', warm.parsed === 0 && warm.reused === 2,
   `parsed ${warm.parsed} reused ${warm.reused}`)

/* -------------------------------------------------------- explicit rebuild */

const rebuilt = await reloaded.rebuild()
ok('rebuild re-parses everything', rebuilt.parsed === 2 && rebuilt.reused === 0,
   `parsed ${rebuilt.parsed} reused ${rebuilt.reused}`)

/* ------------------------------------------------------------- git */

const ignoreResult = await ensureAstIgnored(repo)
ok('added .ast to git exclude', ignoreResult === 'added' || ignoreResult === 'present', ignoreResult)
const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
ok('exclude entry written', /^\.ast\/?$/m.test(exclude))
ok('did NOT touch a tracked .gitignore', !existsSync(join(repo, '.gitignore')))
const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()
ok('.ast/ is invisible to git status', !status.includes('.ast'), status.trim().split('\n')[0])
ok('second call is idempotent', (await ensureAstIgnored(repo)) === 'present')

/* -------------------------------------------------------------- repo */

const sub = join(repo, 'src')
const info = await discoverRepo(sub)
// Compare against canonical paths: discoverRepo resolves symlinks so that
// root and workingDir are always in the same namespace, which is exactly what
// macOS's /var -> /private/var indirection requires.
const canonicalRepo = realpathSync(repo)
const canonicalSub = realpathSync(sub)
ok('repo root resolved from a subdirectory', info.root === canonicalRepo, info.root)
ok('working directory canonicalized', info.workingDir === canonicalSub, info.workingDir)
ok('relative working dir computed', info.relativeWorkingDir === 'src', info.relativeWorkingDir)
ok('detected as git', info.isGit === true)
ok('no providers registered by default', info.providers.length === 0)

/* -------------------------------------------------------- shared instance */

ok('indexFor returns one instance per root', indexFor(repo) === indexFor(repo))

console.log('\n--- results ---')
let failed = 0
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? `  (got: ${detail})` : ''}`)
  if (!pass) failed++
}
console.log(`\nindex: ${first.files} files, ${first.symbols} symbols, cold build ${first.durationMs}ms`)
console.log(failed === 0 ? `all ${checks.length} passed` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
