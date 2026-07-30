import type { GitHubCall } from './capability/calls'
import { demoteToStub } from './capability/calls'

/**
 * Executing a compiled call plan against the GitHub API.
 *
 * Everything interesting — ordering, which steps are required, the
 * compare-and-swap, what the parent stanza becomes — is decided in
 * `capability/calls.ts` and tested without a network. This file resolves
 * placeholders, sends requests and reports. It stays boring on purpose.
 *
 * Dry run is the default, and not as a courtesy: this writes to real
 * repositories, so the safe mode is the one you get by forgetting to pass
 * anything.
 *
 * The `Applier` seam is where the signed-commit question gets answered. GitHub
 * signs API-created commits with its own web-flow key, so a ladder that requires
 * commits signed by a person needs a local-git applier — same compiled plan,
 * different implementation of this interface, no change to the pure layer.
 */

export interface StepOutcome {
  step: GitHubCall['step']
  summary: string
  method: string
  path: string
  status: 'ok' | 'failed' | 'skipped' | 'planned'
  detail?: string
  /** HTTP status, when a request was actually made. */
  code?: number
}

export interface ApplyResult {
  /** False if a required step failed; best-effort failures leave this true. */
  ok: boolean
  dryRun: boolean
  outcomes: StepOutcome[]
  /** Set when a required step failed — everything after it was abandoned. */
  stoppedAt?: string
  /** Steps the compiler could not express, carried through so they stay visible. */
  blocked: Array<{ step: string; reason: string }>
}

export interface Applier {
  apply(calls: GitHubCall[], blocked: ApplyResult['blocked']): Promise<ApplyResult>
}

export interface GitHubApplierOptions {
  token: string
  /** GHE: `https://ghe.example.com/api/v3`. */
  baseUrl?: string
  dryRun?: boolean
  fetchImpl?: typeof fetch
}

/** `object.sha` → the nested value, so a call can name any response field. */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, value)
}

/** Substitutes `{key}` occurrences anywhere in a JSON body. */
function resolve(value: unknown, bag: Map<string, string>): unknown {
  if (typeof value === 'string') {
    const match = /^\{(.+)\}$/.exec(value)
    if (match) return bag.get(match[1]) ?? value
    return value
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, bag))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolve(v, bag)])
    )
  }
  return value
}

const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const decode = (b64: string): string => Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8')

export class GitHubApplier implements Applier {
  private readonly token: string
  private readonly baseUrl: string
  private readonly dryRun: boolean
  private readonly doFetch: typeof fetch

  constructor(opts: GitHubApplierOptions) {
    this.token = opts.token
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '')
    // Defaults to the mode that cannot damage anything.
    this.dryRun = opts.dryRun !== false
    this.doFetch = opts.fetchImpl ?? fetch
  }

  async apply(calls: GitHubCall[], blocked: ApplyResult['blocked'] = []): Promise<ApplyResult> {
    const outcomes: StepOutcome[] = []
    const bag = new Map<string, string>()
    let stoppedAt: string | undefined

    for (const call of calls) {
      const base: Omit<StepOutcome, 'status'> = {
        step: call.step,
        summary: call.summary,
        method: call.method,
        path: call.path
      }

      if (stoppedAt) {
        outcomes.push({ ...base, status: 'skipped', detail: 'a required step failed earlier' })
        continue
      }

      // Placeholders resolve from earlier responses, so in a dry run they are
      // genuinely unknown. Reporting them unresolved is the honest rendering —
      // inventing shas would make the preview a different plan than the run.
      const missing = (call.needs ?? []).filter((key) => !bag.has(key))

      if (this.dryRun) {
        outcomes.push({
          ...base,
          status: 'planned',
          detail: missing.length ? `awaits ${missing.join(', ')}` : undefined
        })
        continue
      }

      if (missing.length) {
        const detail = `missing ${missing.join(', ')} from an earlier response`
        outcomes.push({ ...base, status: call.required ? 'failed' : 'skipped', detail })
        if (call.required) stoppedAt = call.summary
        continue
      }

      let body = call.body ? (resolve(call.body, bag) as Record<string, unknown>) : undefined

      if (call.transform) {
        const source = bag.get(call.transform.source)
        const rewritten =
          source === undefined
            ? null
            : demoteToStub(decode(source), call.transform.parentId, call.transform.stub)
        if (rewritten === null) {
          outcomes.push({
            ...base,
            status: 'failed',
            detail: "the parent manifest could not be rewritten safely (multi-document or unparseable)"
          })
          stoppedAt = call.summary
          continue
        }
        body = { ...(body ?? {}), [call.contentField ?? 'content']: encode(rewritten) }
      } else if (call.contentText !== undefined && call.contentField) {
        body = { ...(body ?? {}), [call.contentField]: encode(call.contentText) }
      }

      // Compare-and-swap: the update carries the head it expects to replace, so a
      // concurrent write loses here instead of being silently overwritten.
      if (call.expect && bag.has(call.expect)) {
        body = { ...(body ?? {}), sha: bag.get(call.expect) }
      }

      let response: Response
      try {
        response = await this.doFetch(`${this.baseUrl}${call.path}`, {
          method: call.method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        outcomes.push({ ...base, status: call.required ? 'failed' : 'skipped', detail })
        if (call.required) stoppedAt = call.summary
        continue
      }

      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : {}
      } catch {
        parsed = {}
      }

      if (!response.ok) {
        const message =
          (parsed as { message?: string })?.message ?? text.slice(0, 200) ?? response.statusText
        outcomes.push({
          ...base,
          status: call.required ? 'failed' : 'skipped',
          code: response.status,
          // A 403 on branch protection is the expected shape of an App without
          // admin, not a bug — the plan already marked it best-effort.
          detail: message
        })
        if (call.required) stoppedAt = call.summary
        continue
      }

      for (const { key, from } of call.provides ?? []) {
        const value = readPath(parsed, from)
        if (typeof value === 'string') bag.set(key, value)
      }

      outcomes.push({ ...base, status: 'ok', code: response.status })
    }

    return {
      ok: !stoppedAt,
      dryRun: this.dryRun,
      outcomes,
      ...(stoppedAt ? { stoppedAt } : {}),
      blocked
    }
  }
}
