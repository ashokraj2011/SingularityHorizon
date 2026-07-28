import type { PersistedSession, UsageBucket, UsageSummary } from '../shared/ipc'

/**
 * Rolls session usage up into something you can make a decision from.
 *
 * The number that matters is not tokens. Copilot bills premium requests with a
 * per-model multiplier — Haiku at 0.33x against Opus at 15x is a 45x spread —
 * so a weighted request count is the figure that tracks the invoice. Tokens are
 * reported alongside because they drive context pressure, which is a different
 * problem with a different fix.
 *
 * Sessions with no usage reading are counted separately rather than as zero.
 * A total that silently omits them would understate spend, and understating
 * spend is the one failure mode that makes a cost report worse than none.
 */

/** "15x" -> 15, "0.33x" -> 0.33, anything unparseable -> null. */
export function parseMultiplier(raw: string | undefined): number | null {
  if (!raw) return null
  const m = /^([\d.]+)\s*x$/i.exec(raw.trim())
  if (!m) return null
  const n = Number.parseFloat(m[1])
  return Number.isFinite(n) ? n : null
}

function emptyBucket(key: string, label: string): UsageBucket {
  return {
    key,
    label,
    sessions: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    weightedRequests: 0
  }
}

function add(bucket: UsageBucket, s: PersistedSession): void {
  const u = s.usage
  bucket.sessions += 1
  bucket.requests += u?.requests ?? 0
  bucket.inputTokens += u?.inputTokens ?? 0
  bucket.outputTokens += u?.outputTokens ?? 0
  bucket.cachedTokens += u?.cachedTokens ?? 0

  const multiplier = parseMultiplier(s.modelMultiplier)
  // Unknown multiplier counts at 1x rather than 0 — treating it as free would
  // hide exactly the sessions whose cost we are least sure about.
  bucket.weightedRequests += (u?.requests ?? 0) * (multiplier ?? 1)
  if (s.modelMultiplier && !bucket.multiplier) bucket.multiplier = s.modelMultiplier
}

function sortBuckets(map: Map<string, UsageBucket>): UsageBucket[] {
  return [...map.values()].sort((a, b) => b.weightedRequests - a.weightedRequests || b.sessions - a.sessions)
}

export function summarizeUsage(sessions: PersistedSession[]): UsageSummary {
  const byModel = new Map<string, UsageBucket>()
  const byRepo = new Map<string, UsageBucket>()
  const byDay = new Map<string, UsageBucket>()

  let sessionsWithUsage = 0

  for (const s of sessions) {
    if (s.usage) sessionsWithUsage++

    const model = s.model ?? 'unknown'
    if (!byModel.has(model)) byModel.set(model, emptyBucket(model, model))
    add(byModel.get(model)!, s)

    const repo = s.cwd
    if (!byRepo.has(repo)) {
      byRepo.set(repo, emptyBucket(repo, repo.split('/').pop() || repo))
    }
    add(byRepo.get(repo)!, s)

    const day = new Date(s.updatedAt).toISOString().slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, emptyBucket(day, day))
    add(byDay.get(day)!, s)
  }

  const total = (pick: (b: UsageBucket) => number): number =>
    [...byModel.values()].reduce((n, b) => n + pick(b), 0)

  return {
    totalSessions: sessions.length,
    sessionsWithUsage,
    totalRequests: total((b) => b.requests),
    totalWeightedRequests: total((b) => b.weightedRequests),
    totalInputTokens: total((b) => b.inputTokens),
    totalOutputTokens: total((b) => b.outputTokens),
    totalCachedTokens: total((b) => b.cachedTokens),
    byModel: sortBuckets(byModel),
    byRepo: sortBuckets(byRepo),
    // Days read best newest-first regardless of spend.
    byDay: [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key)),
    partial: sessionsWithUsage < sessions.length
  }
}
