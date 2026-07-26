/**
 * Parsers for Copilot's `/context` and `/usage` output.
 *
 * ACP defines a `usage_update` session notification, but Copilot CLI 1.0.75
 * never sends one — verified by probing every notification it emits across a
 * full prompt turn. The numbers exist only in the rendered text of the
 * `/context` and `/usage` slash commands, so the client runs those and parses
 * them. That makes these parsers load-bearing for the context meter, hence
 * they live in shared/ and are covered by `npm run context:check`.
 *
 * Both formats are human-facing output that GitHub can change without notice,
 * so every parser returns null rather than throwing, and a null result must
 * degrade to "no meter" rather than an error.
 */

export interface ContextSlice {
  label: string
  tokens: number
  /** Percent of the total window. Copilot prints "<1%" which becomes 0.5. */
  percent: number
}

export interface ContextInfo {
  model?: string
  usedTokens: number
  totalTokens: number
  percent: number
  slices: ContextSlice[]
}

export interface UsageInfo {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  requests?: number
  linesAdded?: number
  linesRemoved?: number
}

/**
 * "7.4k" -> 7400, "426" -> 426, "171.3k" -> 171300, "1.2M" -> 1200000.
 * Returns null for anything that isn't a number so callers can skip the row.
 */
export function parseTokenCount(raw: string): number | null {
  const m = /^([\d.]+)\s*([kKmM])?$/.exec(raw.trim())
  if (!m) return null
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const suffix = m[2]?.toLowerCase()
  if (suffix === 'k') return Math.round(n * 1_000)
  if (suffix === 'm') return Math.round(n * 1_000_000)
  return Math.round(n)
}

function parsePercent(raw: string): number {
  // "<1" means "some but under one percent" — 0 would render as an empty bar
  // and imply nothing is used at all, so use a visible sliver instead.
  if (raw.trim().startsWith('<')) return 0.5
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parses the `/context` block. Expected shape:
 *
 *   Context Usage
 *
 *   ○ ○ ◌ ◌ ● ◉ · · ·   claude-sonnet-5 · 19k/264k tokens (7%)
 *   · · · · · · · · ·   ○ System Prompt           7.4k   (3%)
 *   ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎ ◎   ◎ Buffer                 74.0k  (28%)
 *
 * The leading glyph columns are decorative and deliberately ignored; only the
 * "label   tokens   (pct)" tail of each line is read.
 */
export function parseContext(text: string): ContextInfo | null {
  if (!text) return null

  const header =
    /(?:([A-Za-z0-9._-]+)\s*·\s*)?([\d.]+\s*[kKmM]?)\s*\/\s*([\d.]+\s*[kKmM]?)\s*tokens\s*\((<?[\d.]+)%\)/.exec(
      text
    )
  if (!header) return null

  const usedTokens = parseTokenCount(header[2])
  const totalTokens = parseTokenCount(header[3])
  if (usedTokens === null || totalTokens === null || totalTokens <= 0) return null

  const slices: ContextSlice[] = []
  for (const line of text.split('\n')) {
    // Skip the header line itself; it also matches the row shape loosely.
    if (line.includes('tokens')) continue
    const row = /([A-Za-z][A-Za-z ]*[A-Za-z])\s{2,}([\d.]+\s*[kKmM]?)\s+\((<?[\d.]+)%\)/.exec(
      line
    )
    if (!row) continue
    const tokens = parseTokenCount(row[2])
    if (tokens === null) continue
    slices.push({
      label: row[1].trim(),
      tokens,
      percent: parsePercent(row[3])
    })
  }

  return {
    model: header[1],
    usedTokens,
    totalTokens,
    percent: parsePercent(header[4]),
    slices
  }
}

/**
 * Parses the `/usage` block. Expected shape:
 *
 *   Session Usage
 *
 *   Changes: +12 -3
 *   Requests: 2 AI Units (13s)
 *   Tokens: input 73.8k, output 148, cached 65.5k, reasoning 18
 */
export function parseUsage(text: string): UsageInfo | null {
  if (!text) return null
  const info: UsageInfo = {}

  const changes = /Changes:\s*\+(\d+)\s*-(\d+)/.exec(text)
  if (changes) {
    info.linesAdded = Number.parseInt(changes[1], 10)
    info.linesRemoved = Number.parseInt(changes[2], 10)
  }

  const requests = /Requests:\s*([\d.]+)/.exec(text)
  if (requests) info.requests = Number.parseFloat(requests[1])

  const field = (name: string): number | undefined => {
    const m = new RegExp(`${name}\\s+([\\d.]+\\s*[kKmM]?)`).exec(text)
    if (!m) return undefined
    return parseTokenCount(m[1]) ?? undefined
  }
  info.inputTokens = field('input')
  info.outputTokens = field('output')
  info.cachedTokens = field('cached')
  info.reasoningTokens = field('reasoning')

  const hasAny = Object.values(info).some((v) => v !== undefined)
  return hasAny ? info : null
}

/** 19_000 -> "19k", 426 -> "426", 1_200_000 -> "1.2M" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
