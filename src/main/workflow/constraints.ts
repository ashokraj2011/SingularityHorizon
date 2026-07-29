import type { ResourceSelector, Workflow, WorkflowNode } from './ir'
import { allNodes } from './ir'

/**
 * Constraints injected while a run is in flight.
 *
 * "Do not modify the database schema", said halfway through, has to become
 * something the machine can act on. Three things follow from that, and each is
 * a rule rather than a preference:
 *
 *   A constraint is parsed to a typed form or it is not accepted. An
 *   instruction the parser only half-understands is returned for elicitation,
 *   never narrowed to the reading it happened to match first. Silently
 *   narrowing "don't touch the database" to "don't touch the schema" produces a
 *   run that obeyed something nobody asked for.
 *
 *   The set of work it invalidates is a graph query over declared effects, not
 *   a guess. This is what `effects` being mandatory in the IR was for.
 *
 *   It is enforced, not communicated. A constrained step gets the constraint in
 *   its context so it knows, and in its session policy so it cannot proceed
 *   anyway.
 */

export interface Constraint {
  id: string
  forbids: 'writes' | 'reads'
  selector: ResourceSelector
  /** What the person actually said. Kept verbatim for the receipt. */
  text: string
  at: number
}

export type ParseOutcome =
  | { ok: true; constraint: Omit<Constraint, 'id' | 'at'> }
  | { ok: false; reason: string; question: string; candidates?: ResourceSelector[] }

const NEGATIONS = /\b(do not|don't|dont|never|avoid|no longer|stop|must not|mustn't)\b/i
const WRITE_VERBS = /\b(modify|change|write|touch|edit|alter|migrate|update|delete|drop|create)\b/i
const READ_VERBS = /\b(read|access|open|look at|inspect|load)\b/i

/**
 * Resource kinds a constraint can name.
 *
 * `rank` is specificity, and it is load-bearing. "The database schema" matches
 * both the schema pattern and the bare database one; without a specificity
 * order those two readings look like a disagreement and an unambiguous
 * instruction comes back as a question. Only matches at the highest rank count.
 *
 * The bare `database` entry deliberately carries *two* selectors rather than
 * guessing. "Don't touch the database" genuinely could mean the schema or the
 * data, and resolving that by pattern order is the silent narrowing this whole
 * function exists to avoid.
 */
const TARGETS: Array<{ rank: number; pattern: RegExp; selectors: ResourceSelector[] }> = [
  {
    rank: 2,
    pattern: /\b(database|db)\s+schema\b|\bschema\b|\bmigrations?\b/i,
    selectors: [{ kind: 'db.schema' }]
  },
  {
    rank: 2,
    pattern: /\b(database|db)\s+(data|rows|records)\b|\bseed(s|ing)?\b|\bfixtures?\b/i,
    selectors: [{ kind: 'db.data' }]
  },
  {
    rank: 2,
    pattern: /\bconfig(uration)?\b|\benv(ironment)?\b|\bsettings\b/i,
    selectors: [{ kind: 'config' }]
  },
  {
    rank: 2,
    pattern: /\bexternal\b|\bnetwork\b|\bapi\b|\bthird[- ]party\b/i,
    selectors: [{ kind: 'external' }]
  },
  {
    rank: 1,
    pattern: /\b(database|db)\b/i,
    selectors: [{ kind: 'db.schema' }, { kind: 'db.data' }]
  }
]

/**
 * Turn an instruction into a constraint, or say why it cannot.
 *
 * Deliberately conservative and deliberately dumb. A parser that tries hard
 * produces confident wrong answers, and a wrong constraint is worse than none:
 * it stops work that was fine while permitting work that was not.
 */
export function parseConstraint(text: string): ParseOutcome {
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, reason: 'empty', question: 'What should this run avoid doing?' }
  }

  if (!NEGATIONS.test(trimmed)) {
    return {
      ok: false,
      reason: 'not phrased as a prohibition',
      question:
        `"${trimmed}" does not read as something to avoid. ` +
        'Should the run be prevented from doing something, and if so what?'
    }
  }

  const hits = TARGETS.filter((t) => t.pattern.test(trimmed))
  // Specificity wins outright: a phrase naming the schema is not also a vaguer
  // claim about the database.
  const topRank = Math.max(0, ...hits.map((h) => h.rank))
  const matched = hits.filter((h) => h.rank === topRank).flatMap((h) => h.selectors)
  if (!matched.length) {
    // An explicit path is unambiguous, so it does not need the target table.
    const path = /(^|\s)([\w./*-]*[/*][\w./*-]*)/.exec(trimmed)?.[2]
    if (path) {
      return {
        ok: true,
        constraint: {
          forbids: READ_VERBS.test(trimmed) && !WRITE_VERBS.test(trimmed) ? 'reads' : 'writes',
          selector: { kind: 'repo', path },
          text: trimmed
        }
      }
    }
    return {
      ok: false,
      reason: 'no recognised resource',
      question: `What exactly should not be touched? Name a path, or a resource such as the database schema.`
    }
  }

  // Distinct kinds matched: "don't touch the database" could mean the schema or
  // the data, and choosing one is the silent narrowing this must not do.
  const kinds = new Set(matched.map((m) => m.kind))
  if (kinds.size > 1) {
    return {
      ok: false,
      reason: 'ambiguous target',
      question: `"${trimmed}" could mean more than one thing. Which is it?`,
      candidates: [...new Map(matched.map((m) => [m.kind, m])).values()]
    }
  }

  const forbids = READ_VERBS.test(trimmed) && !WRITE_VERBS.test(trimmed) ? 'reads' : 'writes'
  return { ok: true, constraint: { forbids, selector: matched[0], text: trimmed } }
}

/** Attach an identity once a parsed constraint is accepted. */
export function acceptConstraint(
  parsed: Omit<Constraint, 'id' | 'at'>,
  id: string,
  at: number
): Constraint {
  return { ...parsed, id, at }
}

/* ------------------------------------------------------- paths and matching */

/**
 * Where a resource kind lives on disk.
 *
 * The gate matches paths; a constraint names kinds. Something has to bridge
 * them, and it is better that the bridge is a visible table someone can correct
 * for their repository than a rule buried in the enforcement path.
 */
export const RESOURCE_PATHS: Record<ResourceSelector['kind'], string[]> = {
  'db.schema': ['**/migrations/**', '**/migration/**', '**/schema.prisma', '**/*.sql', '**/schema/**'],
  'db.data': ['**/seeds/**', '**/seed/**', '**/fixtures/**'],
  config: ['**/*.config.*', '**/.env*', '**/config/**'],
  // A repo selector carries its own path; an empty one means the whole tree.
  repo: ['**'],
  // Not a filesystem resource — see the note on enforcement limits below.
  external: []
}

/**
 * Minimal glob matcher: `**` spans separators, `*` does not, `?` is one char.
 *
 * Written as a scan rather than a chain of string replaces. The chain version
 * is shorter and wrong in a way that does not announce itself: each replace can
 * rewrite text an earlier one produced, so the `**` and `*` cases interfere.
 * For a deny rule that means denying the wrong set, quietly.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` matches any number of leading segments, including none.
          rx += '(?:[^/]*/)*'
          i += 2
        } else {
          rx += '.*'
          i += 1
        }
      } else {
        rx += '[^/]*'
      }
    } else if (c === '?') {
      rx += '[^/]'
    } else {
      rx += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c
    }
  }
  return new RegExp('^' + rx + '$').test(normalized)
}

/** Concrete path patterns a selector covers. */
export function selectorPaths(selector: ResourceSelector): string[] {
  if (selector.kind === 'repo') return [selector.path ?? '**']
  const base = RESOURCE_PATHS[selector.kind] ?? []
  return selector.path ? [selector.path] : base
}

export function pathMatchesSelector(selector: ResourceSelector, path: string): boolean {
  return selectorPaths(selector).some((p) => matchGlob(p, path))
}

/**
 * Concrete paths that stand for a resource kind.
 *
 * Cross-kind intersection is decided by asking whether a repository glob would
 * match one of these, rather than by comparing globs against globs. The glob
 * comparison is technically more permissive and practically useless: `src/**`
 * really could contain a migrations directory, so a purely conservative
 * comparison marks every step as colliding with every constraint and the
 * frontier stops distinguishing anything.
 */
const REPRESENTATIVES: Record<ResourceSelector['kind'], string[]> = {
  'db.schema': ['db/migrations/001_init.sql', 'prisma/schema.prisma', 'schema/tables.sql'],
  'db.data': ['db/seeds/users.sql', 'test/fixtures/users.json'],
  config: ['config/app.yml', '.env', 'app.config.ts'],
  repo: [],
  external: []
}

/**
 * Whether two selectors could refer to the same thing.
 *
 * Conservative where it is cheap to be. The two directions of error are not
 * symmetric — an unnecessary intersection costs a re-run, a missed one ships
 * work that violated the constraint — but conservatism has to stop short of
 * "everything intersects everything", which answers nothing.
 */
export function selectorsIntersect(a: ResourceSelector, b: ResourceSelector): boolean {
  // Not a filesystem resource, so no path reasoning applies to it.
  if (a.kind === 'external' || b.kind === 'external') return a.kind === b.kind

  if (a.kind === b.kind) {
    const ap = selectorPaths(a)
    const bp = selectorPaths(b)
    if (!ap.length || !bp.length) return true
    return ap.some((x) => bp.some((y) => globsOverlap(x, y)))
  }

  // One side names a repository path, the other names a kind: does the path
  // cover somewhere that kind actually lives?
  const repoSide = a.kind === 'repo' ? a : b.kind === 'repo' ? b : null
  const other = repoSide === a ? b : a
  if (!repoSide) return false

  return selectorPaths(repoSide).some((pattern) =>
    (REPRESENTATIVES[other.kind] ?? []).some((example) => matchGlob(pattern, example))
  )
}

/**
 * Whether two globs can both match some path.
 *
 * A segment-wise unification rather than a prefix heuristic. The heuristic
 * version compared literal prefixes, and a pattern starting with `**` has an
 * empty prefix — which every other prefix starts with, so everything overlapped
 * everything and the frontier swallowed the whole workflow.
 */
function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  return segmentsOverlap(a.split('/'), b.split('/'))
}

function segmentsOverlap(a: string[], b: string[]): boolean {
  if (!a.length && !b.length) return true
  if (!a.length) return b.every((s) => s === '**')
  if (!b.length) return a.every((s) => s === '**')

  const [ah, ...at] = a
  const [bh, ...bt] = b

  // `**` consumes any number of segments on either side.
  if (ah === '**') return segmentsOverlap(at, b) || segmentsOverlap(a, bt) || segmentsOverlap(at, bt)
  if (bh === '**') return segmentsOverlap(a, bt) || segmentsOverlap(at, b) || segmentsOverlap(at, bt)

  if (!segmentOverlap(ah, bh)) return false
  return segmentsOverlap(at, bt)
}

function segmentOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const aWild = a.includes('*') || a.includes('?')
  const bWild = b.includes('*') || b.includes('?')
  if (!aWild && !bWild) return false
  // Substitute a placeholder for the wildcard and see whether the other side
  // accepts the result. Not exact, but it errs toward overlap.
  if (aWild && matchGlob(a, b.replace(/[*?]+/g, 'x'))) return true
  if (bWild && matchGlob(b, a.replace(/[*?]+/g, 'x'))) return true
  return aWild && bWild
}

/* ---------------------------------------------------------------- frontier */

export interface Frontier {
  /** Nodes whose own effects collide with the constraint. */
  direct: string[]
  /** Nodes that consumed their output, transitively. */
  dependents: string[]
  /** Everything invalidated, in workflow order. */
  all: string[]
}

function selectorsOf(node: WorkflowNode, forbids: Constraint['forbids']): ResourceSelector[] {
  return forbids === 'writes' ? node.effects.writes : node.effects.reads
}

/**
 * What this constraint invalidates.
 *
 * A graph query over declared effects and the dataflow edges between steps —
 * which is the whole reason `effects` is mandatory in the IR. Without it this
 * degenerates to invalidating everything, and a constraint that re-runs the
 * entire workflow is one nobody will use.
 */
export function invalidationFrontier(workflow: Workflow, constraint: Constraint): Frontier {
  const nodes = allNodes(workflow)
  const order = new Map(nodes.map((n, i) => [n.id, i]))

  const direct = nodes
    .filter((n) => selectorsOf(n, constraint.forbids).some((s) => selectorsIntersect(s, constraint.selector)))
    .map((n) => n.id)

  // Who consumes what: an output name to the steps that read it.
  const consumers = new Map<string, string[]>()
  for (const node of nodes) {
    const inputs =
      node.type === 'agent'
        ? node.inputs
        : node.type === 'humanGate'
          ? [node.artifact]
          : node.type === 'condition'
            ? [node.when.output]
            : []
    for (const input of inputs ?? []) {
      consumers.set(input, [...(consumers.get(input) ?? []), node.id])
    }
  }

  const emitsOf = new Map(nodes.map((n) => [n.id, n.effects.emits ?? []]))

  const dependents = new Set<string>()
  const queue = [...direct]
  while (queue.length) {
    const id = queue.shift()!
    for (const emitted of emitsOf.get(id) ?? []) {
      for (const consumer of consumers.get(emitted) ?? []) {
        if (dependents.has(consumer) || direct.includes(consumer)) continue
        dependents.add(consumer)
        queue.push(consumer)
      }
    }
  }

  // A loop is invalidated when anything in its body is: its iterations are not
  // separable from the steps they repeat.
  for (const node of nodes) {
    if (node.type !== 'loop') continue
    const bodyIds = allNodes({ ...workflow, nodes: node.body }).map((n) => n.id)
    if (bodyIds.some((id) => direct.includes(id) || dependents.has(id))) {
      if (!direct.includes(node.id)) dependents.add(node.id)
    }
  }

  const all = [...new Set([...direct, ...dependents])].sort(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)
  )
  return { direct, dependents: [...dependents], all }
}

/**
 * Path patterns a constrained step must not write.
 *
 * Enforcement covers writes the client mediates — `fs/write_text_file` passes
 * through the gate and is refused. A shell command is opaque: the client sees
 * `sh -c ...`, not the files it will touch. That is not a hole in this code so
 * much as a reason the capability lattice matters — a step pinned to `edit` has
 * no terminal at all, so for that step the refusal is total. A step that needs
 * `verify` or `deliver` can still write through a command, and the honest thing
 * is to say so rather than to imply a guarantee this cannot make.
 */
export function forbiddenWritePaths(constraints: Constraint[]): string[] {
  return constraints
    .filter((c) => c.forbids === 'writes')
    .flatMap((c) => selectorPaths(c.selector))
}
