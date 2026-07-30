import { useEffect, useState } from 'react'

import type { CapabilityView } from '@shared/ipc'
import { getApi } from '../api'
import { KindIcon, LeadIcon, LedgerIcon, RepoIcon } from './CapabilityIcons'

type Plan = Awaited<ReturnType<ReturnType<typeof getApi>['planCapability']>>
type Sgh = Awaited<ReturnType<ReturnType<typeof getApi>['sghStatus']>>

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

  useEffect(() => {
    void getApi().sghStatus().then(setSgh).catch(() => setSgh(null))
  }, [])

  const preview = async (): Promise<void> => {
    setBusy(true)
    try {
      // "repoId url" per line — paste-friendly, and the lead is the first one
      // unless a line says otherwise.
      const repos = reposText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, i) => {
          const [repoId, url = ''] = line.split(/\s+/)
          return {
            repoId,
            url,
            role: (i === 0 ? 'lead' : 'member') as 'lead' | 'member'
          }
        })
      setPlan(
        await getApi().planCapability(root, {
          id: id.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          kind,
          ...(parent ? { parent } : {}),
          ...(kind === 'delivery' && repos.length ? { repos } : {}),
          ...(approver.trim()
            ? { approvers: [{ role: 'architect', actorId: approver.trim() }] }
            : {})
        })
      )
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
              <span className="cap-source">one stamped commit</span>
            </div>
            <pre className="cap-file">{plan.command}</pre>
            <button
              className="btn primary"
              disabled={!plan.runnable}
              title={
                plan.runnable
                  ? 'Runs the command above'
                  : plan.errors.length
                    ? 'Resolve the errors above first'
                    : `The installed sgh (${sgh?.version ?? 'unknown'}) has no capability command yet`
              }
            >
              Materialize
            </button>
            {!plan.runnable && !plan.errors.length && (
              <div className="cap-note">
                The plan is valid. It cannot be applied from here yet because the installed{' '}
                <code>sgh</code> has no <code>capability</code> command — it ships{' '}
                {sgh?.commands.join(', ') || 'nothing'}. The plan above is exactly what that command
                needs to consume.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
