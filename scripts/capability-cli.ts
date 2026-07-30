/**
 * `npm run capability` — inspect and validate a capability forest.
 *
 * The thin edge of §9.1: the parser, validator and resolver are pure and have no
 * idea a filesystem exists, so this is what makes them usable. It reads every
 * `capability.yaml` under a root, reports what is wrong, and can show the
 * effective policy at a node with provenance for each rule.
 *
 * Deliberately read-only. Writing manifests, materializing ledgers and stamping
 * the creation commit are §9.2 and belong to `sgh`, where the approval machinery
 * already lives — a second tool that also writes ledgers is how two sources of
 * truth start.
 *
 *   npm run capability -- <dir>                 validate the forest
 *   npm run capability -- <dir> --tree          show the ownership tree
 *   npm run capability -- <dir> --resolve <id>  effective policy at a node
 *   npm run capability -- <dir> --cost a,b,c    coordination cost of a change
 */
import { loadForest } from '../src/main/capability/load'
import {
  childrenOf,
  depthOf,
  lowestCommonAncestor,
  pathOf,
  rootsOf,
  type Capability,
  type CapabilityForest
} from '../src/main/capability/model'
import {
  emptyNodes,
  pendingMaterialization,
  reconcilePointers,
  validateForest
} from '../src/main/capability/validate'
import { explainGate, resolvePolicy } from '../src/main/capability/resolve'

/**
 * Arguments, parsed in one pass.
 *
 * The value-taking flags are declared, so a positional path is whatever is left
 * over. Working it out by looking at neighbours instead breaks the moment a path
 * follows a boolean flag, and it breaks by silently treating the path as a flag
 * value — which reads as "no capability.yaml found".
 */
const VALUE_FLAGS = new Set(['resolve', 'cost', 'depth'])

const argv = process.argv.slice(2)
const flags = new Map<string, string | true>()
const positionals: string[] = []

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    positionals.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (VALUE_FLAGS.has(name)) {
    flags.set(name, argv[i + 1] ?? true)
    i++
  } else {
    flags.set(name, true)
  }
}

const flag = (name: string): string | undefined => {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}
const has = (name: string): boolean => flags.has(name)

const root = positionals[0] ?? process.cwd()

const { forest, issues, sources, pointerSources, pointers } = await loadForest(root)

console.log(`capability forest · ${root}`)
console.log(
  sources.length
    ? `  ${sources.length} manifest${sources.length === 1 ? '' : 's'}: ${sources.join(', ')}`
    : '  no capability.yaml found'
)
if (pointerSources.length) {
  console.log(`  ${pointerSources.length} pointer file(s): ${pointerSources.join(', ')}`)
}
console.log(`  ${forest.byId.size} capabilit${forest.byId.size === 1 ? 'y' : 'ies'}`)

/* ------------------------------------------------------------- parse issues */

if (issues.length) {
  console.log('\nmanifest problems')
  for (const issue of issues) {
    console.log(`  ✗ ${issue.source ? `${issue.source} ` : ''}${issue.at}: ${issue.problem}`)
  }
}

/* --------------------------------------------------------------- validation */

const result = validateForest(forest)

if (result.errors.length) {
  console.log('\nvalidation errors')
  for (const error of result.errors) console.log(`  ✗ ${error.capabilityId}: ${error.problem}`)
}

// Questions, not failures. A proposed component referenced by governance needs a
// person, and treating that as an error teaches people to confirm components
// just to quiet the tool.
if (result.elicitations.length) {
  console.log('\nneeds an answer')
  for (const item of result.elicitations) {
    console.log(`  ? ${item.capabilityId}: ${item.question}`)
  }
}

const pending = pendingMaterialization(forest)
if (pending.length) {
  console.log('\nawaiting materialization (owns governance, still inline in a parent)')
  for (const id of pending) console.log(`  · ${id}`)
}

/* ------------------------------------------------------- pointer findings */

// Severity is decided here, not in the validator: this is the only layer that
// knows how much of the org was actually scanned. An unknown capability is
// almost always a partial scan; two pointers claiming one repo is not.
const pointerFindings = reconcilePointers(forest, pointers)
const pointerErrors = pointerFindings.filter((f) => f.kind === 'repo-claimed-elsewhere')

if (pointerFindings.length) {
  console.log('\npointer files')
  for (const finding of pointerFindings) {
    const mark = finding.kind === 'repo-claimed-elsewhere' ? '✗' : '·'
    console.log(`  ${mark} ${finding.pointer.repoId}: ${finding.detail}`)
  }
}

const empty = emptyNodes(forest)
if (empty.length) {
  // Expected right after an import, and not a problem. Shown so a tree that
  // never grows past the import is visible as such.
  console.log(`\n${empty.length} node${empty.length === 1 ? '' : 's'} declare nothing yet`)
}

/* ---------------------------------------------------------------- the tree */

function printTree(node: Capability, indent: string, f: CapabilityForest): void {
  const marks: string[] = []
  if (node.kind === 'delivery') marks.push(`${node.repos?.length ?? 0} repo${node.repos?.length === 1 ? '' : 's'}`)
  if (node.ledger) {
    marks.push(
      node.ledger.kind === 'sidecar' ? `sidecar in ${node.ledger.repo}` : 'standalone ledger repo'
    )
  }
  const lead = node.kind === 'delivery' ? node.repos?.find((r) => r.role === 'lead') : undefined
  if (lead) marks.push(`lead: ${lead.repoId}`)
  if (node.policy?.budgets?.maxCostUsdPerThread !== undefined) {
    marks.push(`$${node.policy.budgets.maxCostUsdPerThread}`)
  }
  if (node.policy?.requiredGates?.length) marks.push(`${node.policy.requiredGates.length} gate(s)`)
  if (node.components?.length) marks.push(`${node.components.length} component(s)`)

  console.log(`${indent}${node.id}  [${node.kind}]${marks.length ? `  ${marks.join(' · ')}` : ''}`)
  for (const child of childrenOf(f, node.id)) printTree(child, `${indent}  `, f)
}

if (has('tree')) {
  console.log('\nownership')
  for (const node of rootsOf(forest)) printTree(node, '  ', forest)
}

/* ----------------------------------------------------- effective policy */

const target = flag('resolve')
if (target) {
  const resolved = resolvePolicy(forest, target)
  if (!resolved) {
    console.log(`\n✗ cannot resolve "${target}" — unknown, or its parent chain is broken`)
    process.exit(1)
  }
  console.log(`\neffective policy · ${resolved.capabilityPath}`)
  console.log(`  path: ${resolved.ancestry.join(' -> ')}`)

  // Provenance matters: someone hitting a gate they did not add needs somewhere
  // to look, and the fold knows the answer.
  console.log(
    resolved.requiredGates.length ? '  gates:' : '  gates: none'
  )
  for (const gate of resolved.requiredGates) {
    const from = explainGate(forest, target, gate)
    console.log(`    - on ${gate.on} by ${gate.role}${gate.scope ? ` (${gate.scope})` : ''}  ← ${from}`)
  }

  const budgets = Object.entries(resolved.budgets)
  console.log(budgets.length ? '  budgets (elementwise minimum along the path):' : '  budgets: none')
  for (const [key, value] of budgets) console.log(`    - ${key}: ${value}`)

  console.log(
    resolved.terminalAllowList
      ? `  terminal allow-list (intersection): ${resolved.terminalAllowList.join(', ') || '(empty — nothing permitted)'}`
      : '  terminal allow-list: none declared anywhere on the path (unrestricted)'
  )

  console.log(resolved.constraints.length ? '  constraints:' : '  constraints: none')
  for (const constraint of resolved.constraints) {
    console.log(`    - ${constraint.forbids} ${constraint.selector.kind}${constraint.selector.path ? ` ${constraint.selector.path}` : ''}  (${constraint.id})`)
  }
}

/* ------------------------------------------------- coordination cost (§4) */

const cost = flag('cost')
if (cost) {
  const ids = cost.split(',').map((s) => s.trim()).filter(Boolean)
  const { id, depth } = lowestCommonAncestor(forest, ids)
  console.log(`\ncoordination cost · ${ids.join(', ')}`)
  if (!id) {
    console.log('  no common ancestor — these capabilities are in different forests')
  } else {
    console.log(`  lowest common ancestor: ${id} (depth ${depth})`)
    const deepest = Math.max(...ids.map((i) => depthOf(forest, i) ?? 0))
    // Shallower ancestor = wider blast radius. What to do with the number is the
    // delivery-set design's call, not this tool's.
    console.log(
      depth === deepest - 1
        ? '  sibling scope — routine'
        : `  crosses ${deepest - (depth ?? 0)} level(s) — the case an architect gate is for`
    )
    for (const i of ids) console.log(`    ${i}: ${pathOf(forest, i)}`)
  }
}

const failed = issues.length + result.errors.length + pointerErrors.length
console.log(
  failed === 0
    ? `\n✓ forest is valid${result.elicitations.length ? ` (${result.elicitations.length} question(s) outstanding)` : ''}`
    : `\n✗ ${failed} problem(s)`
)
process.exit(failed === 0 ? 0 : 1)
