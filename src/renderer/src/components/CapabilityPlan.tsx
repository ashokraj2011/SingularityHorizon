import { useEffect, useState } from 'react'

import type { CapabilityView } from '@shared/ipc'
import { getApi } from '../api'
import { KindIcon, LeadIcon, LedgerIcon, RepoIcon } from './CapabilityIcons'

type Plan = Awaited<ReturnType<ReturnType<typeof getApi>['planCapability']>>
type Sgh = Awaited<ReturnType<ReturnType<typeof getApi>['sghStatus']>>
type Run = Awaited<ReturnType<ReturnType<typeof getApi>['applyCapability']>>

/**
 * The create form — a diff preview, not a settings save.
 *
 * §7.3's review step is explicitly a preview of the commit that materialization
 * would land, and that is all this does: it computes the plan and shows the files,
 * branches and PRs verbatim. Nothing is written.
 *
 * The submit button reflects what `sgh` can actually do, probed rather than
 * assumed. On sgh 0.2.1 the capability subcommand does not exist, so the button
 * is disabled and says so — a button that appeared to work and then did nothing
 * is worse than an honest absence, and this is the one place a governance UI
 * cannot afford to be vague.
 *
 * Each step also carries whether the capability exists without it. Materialization
 * is several writes across repos and is never atomic, so "required" and
 * "best-effort" are the difference between a failure that leaves nothing and one
 * that leaves a chip.
 */
export function CapabilityPlan({
  root,
  view,
  onBack
}: {
  root: string
  view: CapabilityView
  onBack: () => void
}): React.JSX.Element {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'business' | 'delivery'>('delivery')
  const [parent, setParent] = useState('')
  const [reposText, setReposText] = useState('')
  const [approver, setApprover] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [sgh, setSgh] = useState<Sgh | null>(null)
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  // Applying for real takes a second, deliberate click. The first only arms it.
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    void getApi().sghStatus().then(setSgh).catch(() => setSgh(null))
  }, [])

  const draftOf = (): Parameters<ReturnType<typeof getApi>['planCapability']>[1] => {
    // "repoId url" per line — paste-friendly, and the lead is the first one
    // unless a line says otherwise.
    const repos = reposText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, i) => {
        const [repoId, url = ''] = line.split(/\s+/)
        return { repoId, url, role: (i === 0 ? 'lead' : 'member') as 'lead' | 'member' }
      })
    return {
      id: id.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      kind,
      ...(parent ? { parent } : {}),
      ...(kind === 'delivery' && repos.length ? { repos } : {}),
      ...(approver.trim() ? { approvers: [{ role: 'architect', actorId: approver.trim() }] } : {})
    }
  }

  const preview = async (): Promise<void> => {
    setBusy(true)
    setRun(null)
    setArmed(false)
    try {
      setPlan(await getApi().planCapability(root, draftOf()))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Compile the plan to API calls and either show them or send them.
   *
   * `live` is false everywhere it is not explicitly true — here, across IPC, and
   * in the applier itself. Three layers default the same way because this is the
   * one action in the app that changes somebody else's repository.
   */
  const apply = async (live: boolean): Promise<void> => {
    setBusy(true)
    try {
      setRun(await getApi().applyCapability(root, draftOf(), live))
      setArmed(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cap-plan">
      <div className="cap-plan-head">
        <button className="btn" onClick={onBack}>
          ← Back to the tree
        </button>
        {sgh && (
          <span className="cap-sgh" title={sgh.commands.join(', ')}>
            {sgh.installed ? `sgh ${sgh.version ?? ''}` : 'sgh not installed'}
            {sgh.installed && !sgh.hasCapabilityCommand && ' · no capability command'}
          </span>
        )}
      </div>

      <div className="endpoint-form">
        <label>
          Capability id
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="digital.pzn.selector" />
        </label>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Treatment Selector" />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as 'business' | 'delivery')}>
            <option value="delivery">delivery — owns repos and does work</option>
            <option value="business">business — governance and rollup only</option>
          </select>
        </label>
        <label>
          Parent
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(root)</option>
            {view.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.path}
              </option>
            ))}
          </select>
        </label>
        {kind === 'delivery' && (
          <label>
            Repos — one per line, <code>repoId url</code>. The first is the lead.
            <textarea
              className="cap-textarea"
              rows={3}
              value={reposText}
              onChange={(e) => setReposText(e.target.value)}
              placeholder={'sel-svc github.com/org/sel-svc\nsel-web github.com/org/sel-web'}
            />
          </label>
        )}
        <label>
          Architect approver (CODEOWNERS)
          <input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="ashok" />
        </label>
        <div className="endpoint-actions">
          <button className="btn primary" onClick={() => void preview()} disabled={busy || !id.trim()}>
            {busy ? 'Planning…' : 'Preview the commit'}
          </button>
        </div>
      </div>

      {plan && (
        <>
          {plan.errors.map((e, i) => (
            <div key={i} className="cap-note error">
              {e}
            </div>
          ))}
          {plan.questions.map((q, i) => (
            <div key={i} className="cap-note warn">
              {q}
            </div>
          ))}

          <div className="cap-section">
            <div className="cap-section-head">
              <span className="cap-section-title">
                <LedgerIcon />
                What this would land
              </span>
              <span className="cap-source">
                {plan.ledgerKind === 'sidecar'
                  ? `sidecar in ${plan.leadRepoId}`
                  : 'standalone ledger repo'}
              </span>
            </div>
            <div className="cap-rows">
              {plan.steps.map((s, i) => (
                <div key={i} className="cap-kv">
                  <span className="cap-k">
                    {s.kind === 'pointer-pr' ? <RepoIcon /> : <KindIcon kind="delivery" />}
                    <span className="cap-k-label">{s.summary}</span>
                    <span className="cap-k-detail">{s.target}</span>
                  </span>
                  {/* Required means the node does not exist without it; a failure
                      there leaves nothing rather than something half-real. */}
                  <span className="cap-v">
                    <span className={`cap-badge ${s.required ? 'lead' : ''}`}>
                      {s.required ? <LeadIcon /> : null}
                      {s.required ? 'required' : 'best-effort'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {plan.steps
            .filter((s) => s.file)
            .map((s, i) => (
              <div key={i} className="cap-section">
                <div className="cap-section-head">
                  <span className="cap-section-title">{s.file!.path}</span>
                  <span className="cap-source">{s.target}</span>
                </div>
                <pre className="cap-file">{s.file!.contents}</pre>
              </div>
            ))}

          <div className="cap-section">
            <div className="cap-section-head">
              <span className="cap-section-title">To apply</span>
              <span className="cap-source">
                {plan.runnable ? 'via sgh, or directly' : 'directly — sgh has no capability command'}
              </span>
            </div>

            {/* The CLI route. It stays visible even while unavailable, because
                the guard runs in CI regardless of what writes the ledger. */}
            <pre className="cap-file">{plan.command}</pre>
            <div className="endpoint-actions">
              <button
                className="btn"
                disabled={!plan.runnable}
                title={
                  plan.runnable
                    ? 'Runs the command above'
                    : `The installed sgh (${sgh?.version ?? 'unknown'}) ships ${
                        sgh?.commands.join(', ') || 'nothing'
                      } — no capability command yet`
                }
              >
                Materialize via sgh
              </button>
              <button
                className="btn"
                onClick={() => void apply(false)}
                disabled={busy || plan.errors.length > 0}
              >
                {busy ? 'Compiling…' : 'Dry run against GitHub'}
              </button>
              {/* Armed only after a dry run, so nobody reaches the live path
                  without having seen the requests it will send. */}
              {run?.dryRun && run.ok && (
                <button
                  className={armed ? 'btn danger' : 'btn primary'}
                  onClick={() => (armed ? void apply(true) : setArmed(true))}
                  disabled={busy}
                >
                  {armed
                    ? `Confirm — write to ${new Set(run.outcomes.map((o) => o.path.split('/').slice(1, 3).join('/'))).size} repositories`
                    : 'Apply for real'}
                </button>
              )}
            </div>
          </div>

          {run && (
            <div className="cap-section">
              <div className="cap-section-head">
                <span className="cap-section-title">
                  {run.dryRun ? 'Dry run — no requests were made' : 'Applied'}
                </span>
                <span className="cap-source">
                  {run.dryRun
                    ? `${run.outcomes.length} requests would be sent`
                    : run.ok
                      ? 'every required step landed'
                      : `stopped at: ${run.stoppedAt}`}
                </span>
              </div>
              <div className="cap-rows">
                {run.outcomes.map((o, i) => (
                  <div key={i} className="cap-kv">
                    <span className="cap-k">
                      <span className="cap-k-label">
                        {o.method} {o.path}
                      </span>
                      <span className="cap-k-detail">
                        {o.summary}
                        {o.detail ? ` — ${o.detail}` : ''}
                      </span>
                    </span>
                    <span className="cap-v">
                      <span className={`cap-badge ${o.status === 'failed' ? 'error' : ''}`}>
                        {o.status}
                        {o.code ? ` ${o.code}` : ''}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              {/* Blocked steps are the ones the compiler could not express at all.
                  Carried through so a required step never goes missing quietly. */}
              {run.blocked.map((b, i) => (
                <div key={i} className="cap-note warn">
                  <strong>{b.step}</strong> — {b.reason}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
