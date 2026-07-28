/**
 * Exit conditions as calibrated claims.
 *
 * A loop that exits on `unitTests.passed` as a flat boolean is brittle in a
 * specific way: the boolean is only as good as whoever set it, and the usual
 * setter is the agent whose work is being checked. So two rules hold here, and
 * both are enforced rather than encouraged.
 *
 *   Ground truth. A claim is evaluated only from signals the client captured
 *   itself — an exit code from a child process it spawned, a report file it
 *   parsed. A signal an agent produced is refused outright, not weighted down.
 *   "The agent says the tests passed" is not evidence of the tests passing; it
 *   is evidence of the agent saying so.
 *
 *   Calibration. Each claim class carries a Beta posterior over how often
 *   accepting it turned out to be right. A class with a poor record needs more
 *   than one green run to clear its threshold, which is what stops a flaky
 *   check from ending a loop early.
 */

export type EvidenceTier = 'PRODUCTION' | 'STAGING' | 'EXPERIMENT' | 'SYNTHETIC'

/**
 * Where a signal came from.
 *
 * `agent` exists so the refusal can be explicit. Leaving it out of the type
 * would make an agent-sourced signal unrepresentable in TypeScript and
 * perfectly representable in the JSON that actually arrives at runtime.
 */
export type SignalSource = 'client-terminal' | 'parsed-report' | 'agent'

export interface Signal {
  /** Named by the step that produced it. */
  name: string
  source: SignalSource
  /** Exit code, count of failures, or whatever the field selector reads. */
  fields: Record<string, number | string | boolean>
  /** Where the raw evidence lives, so a verdict can be re-checked later. */
  rawRef?: string
}

export interface Predicate {
  /** `<signal>.<field>`, e.g. "unit.exitCode" or "unit.failed". */
  select: string
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  value: number | string | boolean
}

export interface BetaParams {
  alpha: number
  beta: number
}

export interface AcceptanceClaim {
  claimClass: string
  predicate: Predicate
  evidenceTier: EvidenceTier
  /** Accumulated across runs. Absent means the uninformative prior. */
  posterior?: BetaParams
  /** Posterior mean the class must clear to be trusted. */
  acceptThreshold: number
}

/** Beta(1,1) — uniform. A new claim class is neither trusted nor distrusted. */
export const UNINFORMATIVE_PRIOR: BetaParams = { alpha: 1, beta: 1 }

export function posteriorMean(p: BetaParams = UNINFORMATIVE_PRIOR): number {
  return p.alpha / (p.alpha + p.beta)
}

/** One more observation. `held` means accepting the claim proved correct. */
export function updatePosterior(prior: BetaParams | undefined, held: boolean): BetaParams {
  const p = prior ?? UNINFORMATIVE_PRIOR
  return held ? { alpha: p.alpha + 1, beta: p.beta } : { alpha: p.alpha, beta: p.beta + 1 }
}

export type VerdictReason =
  | 'accepted'
  | 'predicate-failed'
  | 'no-signal'
  | 'untrusted-source'
  | 'below-threshold'

export interface ClaimVerdict {
  claimClass: string
  accepted: boolean
  reason: VerdictReason
  /** What the predicate actually read, for the receipt. */
  observed?: number | string | boolean
  posteriorMean: number
  rawRef?: string
}

function compare(actual: unknown, op: Predicate['op'], expected: Predicate['value']): boolean {
  switch (op) {
    case 'eq':
      return actual === expected
    case 'ne':
      return actual !== expected
    case 'lt':
      return Number(actual) < Number(expected)
    case 'lte':
      return Number(actual) <= Number(expected)
    case 'gt':
      return Number(actual) > Number(expected)
    case 'gte':
      return Number(actual) >= Number(expected)
  }
}

/**
 * Whether a claim holds, given everything captured this iteration.
 *
 * A missing signal is not a pass. Neither is a signal the agent produced —
 * that is refused with its own reason so the run record says why, rather than
 * looking like an ordinary failure.
 */
export function evaluate(claim: AcceptanceClaim, signals: Signal[]): ClaimVerdict {
  const mean = posteriorMean(claim.posterior)
  const base = { claimClass: claim.claimClass, posteriorMean: mean }

  const [signalName, ...fieldPath] = claim.predicate.select.split('.')
  const field = fieldPath.join('.')
  const signal = signals.find((s) => s.name === signalName)

  if (!signal) return { ...base, accepted: false, reason: 'no-signal' }

  if (signal.source === 'agent') {
    return { ...base, accepted: false, reason: 'untrusted-source', rawRef: signal.rawRef }
  }

  const observed = signal.fields[field]
  if (observed === undefined) return { ...base, accepted: false, reason: 'no-signal' }

  if (!compare(observed, claim.predicate.op, claim.predicate.value)) {
    return { ...base, accepted: false, reason: 'predicate-failed', observed, rawRef: signal.rawRef }
  }

  // The predicate holds. Whether that is enough depends on how often this claim
  // class has been right before.
  if (mean < claim.acceptThreshold) {
    return { ...base, accepted: false, reason: 'below-threshold', observed, rawRef: signal.rawRef }
  }

  return { ...base, accepted: true, reason: 'accepted', observed, rawRef: signal.rawRef }
}

/* ------------------------------------------------------------ report parsing */

/**
 * JUnit XML, reduced to counts.
 *
 * Deliberately attribute-scraping rather than a real XML parse: the only thing
 * a claim needs from a test report is how many tests failed, and pulling in a
 * parser to learn that would be a dependency bought for one number.
 */
export function parseJUnit(xml: string): Signal['fields'] {
  const num = (attr: string): number => {
    let total = 0
    // Only <testsuite>/<testsuites> elements carry these, and summing the
    // outer and inner ones would double-count, so prefer <testsuites> if present.
    const scope = /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? xml
    for (const m of scope.matchAll(new RegExp(`\\b${attr}="(\\d+)"`, 'g'))) {
      total += Number(m[1])
    }
    return total
  }
  return { tests: num('tests'), failures: num('failures'), errors: num('errors') }
}

/** SARIF, reduced to a count of results at or above `error` level. */
export function parseSarif(json: string): Signal['fields'] {
  try {
    const doc = JSON.parse(json) as {
      runs?: Array<{ results?: Array<{ level?: string }> }>
    }
    let errors = 0
    let warnings = 0
    for (const run of doc.runs ?? []) {
      for (const result of run.results ?? []) {
        // SARIF defaults an absent level to "warning".
        if (result.level === 'error') errors++
        else warnings++
      }
    }
    return { errors, warnings }
  } catch {
    // A report that cannot be parsed is a missing signal, never a passing one.
    return {}
  }
}
