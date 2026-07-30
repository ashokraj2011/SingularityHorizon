import { useEffect, useState } from 'react'

import type { CapabilityView, CapabilityViewNode } from '@shared/ipc'
import { getApi } from '../api'

/**
 * The Capability Navigator — §7.1, read side.
 *
 * Tree on the left, detail on the right, every section labelled with where it
 * came from. It renders a projection computed in the main process, so this file
 * holds no authority and does no folding: §7.0's "every pane is a pure function
 * of (projection state, route)".
 *
 * Read-only, and that is the honest shape rather than a limitation to apologise
 * for. Creating a capability, materializing a ledger, and adding a repo are
 * `sgh` commands that land as stamped commits (§8). A UI that wrote manifests
 * directly would be a second source of truth, which §7.0 rules out structurally
 * — so the write half arrives with the command bus, not before it.
 */
export function CapabilityPanel({
  initialRoot,
  onClose
}: {
  initialRoot?: string
  onClose: () => void
}): React.JSX.Element {
  const [view, setView] = useState<CapabilityView | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async (root: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const next = await getApi().loadCapabilities(root)
      setView(next)
      setSelected(next.nodes[0]?.id ?? null)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']*':\s*/, ''))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (initialRoot) void load(initialRoot)
  }, [initialRoot])

  const pick = async (): Promise<void> => {
    const dir = await getApi().pickDirectory()
    if (dir) void load(dir)
  }

  const node = view?.nodes.find((n) => n.id === selected) ?? null

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet capability-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>Capabilities</span>
          <div className="cap-head-actions">
            <button className="btn" onClick={() => void pick()}>
              Choose folder…
            </button>
            {view && (
              <button className="btn" onClick={() => void load(view.root)} disabled={loading}>
                {loading ? 'Reading…' : 'Reload'}
              </button>
            )}
            <button className="icon-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="cap-body">
          {error && <div className="notice error">{error}</div>}

          {!view && !loading && !error && (
            <div className="sheet-empty">
              Point this at a folder containing <code>capability.yaml</code> manifests — a ledger
              repo, or a directory of checkouts.
            </div>
          )}

          {view && !view.nodes.length && (
            <div className="sheet-empty">
              No <code>capability.yaml</code> found under {view.root}.
            </div>
          )}

          {view && view.nodes.length > 0 && (
            <div className="cap-split">
              <div className="cap-tree">
                <div className="cap-source-line">
                  {view.sources.length} manifest{view.sources.length === 1 ? '' : 's'}
                  {view.pointerSources.length > 0 &&
                    ` · ${view.pointerSources.length} pointer${view.pointerSources.length === 1 ? '' : 's'}`}
                </div>
                {view.nodes.map((n) => (
                  <button
                    key={n.id}
                    className={`cap-row ${selected === n.id ? 'on' : ''}`}
                    style={{ paddingLeft: 10 + n.depth * 14 }}
                    onClick={() => setSelected(n.id)}
                  >
                    <span className="cap-row-name">{n.name ?? n.id}</span>
                    {/* Materialization is visible, not explained (§7.1). */}
                    {n.ledger && <span className="cap-dot" title={n.ledger.label} />}
                    {n.errors.length > 0 && <span className="cap-flag error">!</span>}
                    {n.errors.length === 0 && n.questions.length > 0 && (
                      <span className="cap-flag warn">?</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="cap-detail">{node ? <Detail node={node} /> : null}</div>
            </div>
          )}

          {view && view.orphanPointers.length > 0 && (
            <>
              <div className="sheet-sep" />
              <div className="sheet-row-head">Pointers with no capability in this scan</div>
              {view.orphanPointers.map((p, i) => (
                <div key={i} className="cap-note">
                  {p.repoId} — {p.detail}
                </div>
              ))}
            </>
          )}

          {view && view.issues.length > 0 && (
            <>
              <div className="sheet-sep" />
              <div className="sheet-row-head">Manifest problems</div>
              {view.issues.map((issue, i) => (
                <div key={i} className="cap-note error">
                  {issue.source ? `${issue.source} ` : ''}
                  {issue.at}: {issue.problem}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="cap-foot">
          Read-only. Creating, materializing and repo changes are <code>sgh</code> commands that land
          as stamped commits.
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  source,
  children
}: {
  title: string
  source: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="cap-section">
      <div className="cap-section-head">
        {title}
        {/* Every section names its source — §7.1's table, kept honest. */}
        <span className="cap-source">{source}</span>
      </div>
      {children}
    </div>
  )
}

function Detail({ node }: { node: CapabilityViewNode }): React.JSX.Element {
  return (
    <>
      <div className="cap-title">
        {node.name ?? node.id}
        <span className={`cap-kind ${node.kind}`}>{node.kind}</span>
      </div>
      <div className="cap-path">{node.path}</div>

      {node.ledger ? (
        <div className="cap-chip">
          <span className="cap-chip-label">ledger: {node.ledger.label}</span>
          <span className="cap-chip-kind">{node.ledger.kind}</span>
        </div>
      ) : (
        <div className="cap-chip muted">a stanza in its parent — no ledger yet</div>
      )}

      {node.errors.map((problem, i) => (
        <div key={i} className="cap-note error">
          {problem}
        </div>
      ))}
      {node.questions.map((question, i) => (
        <div key={i} className="cap-note warn">
          {question}
        </div>
      ))}
      {node.warnings.map((warning, i) => (
        <div key={i} className="cap-note">
          {warning}
        </div>
      ))}

      {node.repos.length > 0 && (
        <Section title="Repos" source="manifest">
          {node.repos.map((r) => (
            <div key={r.repoId} className="cap-line">
              <span className="cap-mono">{r.repoId}</span>
              {r.role === 'lead' && <span className="cap-badge">lead</span>}
              {r.writePolicy === 'gated' && <span className="cap-badge warn">gated</span>}
              <span className="cap-dim">{r.url}</span>
            </div>
          ))}
        </Section>
      )}

      {node.components.length > 0 && (
        <Section title="Components" source="capability.yaml + reconciler">
          {node.components.map((c) => (
            <div key={c.id} className="cap-line">
              <span className="cap-mono">{c.id}</span>
              <span className={`cap-status ${c.status}`}>{c.status}</span>
              <span className="cap-dim">
                {c.kind}
                {c.tech ? ` · ${c.tech}` : ''}
                {c.observedBy.length ? ` · observed by ${c.observedBy.join(', ')}` : ''}
                {!c.observedBy.length && c.declaredBy ? ` · declared by ${c.declaredBy}` : ''}
              </span>
            </div>
          ))}
        </Section>
      )}

      {node.consumes.length > 0 && (
        <Section title="Consumes" source="consumer edges">
          {node.consumes.map((e, i) => (
            <div key={i} className="cap-line">
              <span className="cap-mono">{e.provider}</span>
              {e.component && <span className="cap-badge">{e.component}</span>}
              {e.contract && <span className="cap-dim">{e.contract}</span>}
            </div>
          ))}
        </Section>
      )}

      {node.policy && (
        <Section title="Effective policy" source="the fold, resolved host-side">
          {node.policy.gates.map((g, i) => (
            <div key={i} className="cap-line">
              <span className="cap-mono">
                {g.on} · {g.role}
              </span>
              {g.scope && <span className="cap-badge">{g.scope}</span>}
              <span className="cap-prov">
                {g.from === node.id ? 'declared here' : `inherited from ${g.from}`}
              </span>
            </div>
          ))}
          {node.policy.budgets.map((b) => (
            <div key={b.field} className="cap-line">
              <span className="cap-mono">
                {b.field}: {b.value}
              </span>
              {/* "min of digital $50, pzn $40" — a surprising number stays explicable. */}
              <span className="cap-prov">
                {b.from.length > 1 ? `min along ${b.from.join(', ')}` : `from ${b.from[0] ?? node.id}`}
              </span>
            </div>
          ))}
          <div className="cap-line">
            <span className="cap-mono">
              terminal:{' '}
              {node.policy.terminalAllowList
                ? node.policy.terminalAllowList.join(', ') || '(nothing permitted)'
                : 'unrestricted'}
            </span>
            <span className="cap-prov">
              {node.policy.allowListFrom.length
                ? `intersection of ${node.policy.allowListFrom.join(', ')}`
                : 'no list declared on the path'}
            </span>
          </div>
          {node.policy.constraints.map((c) => (
            <div key={c.id} className="cap-line">
              <span className="cap-mono">
                {c.forbids} {c.selector}
              </span>
              <span className="cap-prov">{c.id}</span>
            </div>
          ))}
          {!node.policy.gates.length && !node.policy.budgets.length && (
            <div className="cap-dim">Nothing inherited or declared.</div>
          )}
        </Section>
      )}

      {node.knowledge.length > 0 && (
        <Section title="Knowledge" source="manifest (verifiedAt)">
          {node.knowledge.map((k, i) => (
            <div key={i} className="cap-line">
              <span className="cap-badge">{k.kind}</span>
              <a href={k.url} className="cap-link" title={k.url}>
                {k.title}
              </a>
              {k.verifiedAt && (
                // Nags, never garbage-collects (§7.5).
                <span className={`cap-prov ${k.stale ? 'warn' : ''}`}>
                  verified {k.verifiedAt}
                  {k.stale ? ' — worth re-checking' : ''}
                </span>
              )}
            </div>
          ))}
        </Section>
      )}

      {(node.contacts.length > 0 || node.tracker) && (
        <Section title="Owners" source="manifest">
          {node.contacts.map((c, i) => (
            <div key={i} className="cap-line">
              <span className="cap-mono">{c.actorId}</span>
              <span className="cap-badge">{c.role}</span>
            </div>
          ))}
          {node.tracker && (
            <div className="cap-line">
              <span className="cap-mono">
                {node.tracker.system}: {node.tracker.projectKey}
              </span>
            </div>
          )}
        </Section>
      )}

      {node.pointerFindings.length > 0 && (
        <Section title="Pointer files" source="member-repo back-references">
          {node.pointerFindings.map((f, i) => (
            <div key={i} className={`cap-line ${f.kind === 'repo-claimed-elsewhere' ? 'error' : ''}`}>
              <span className="cap-mono">{f.repoId}</span>
              <span className="cap-dim">{f.detail}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  )
}
