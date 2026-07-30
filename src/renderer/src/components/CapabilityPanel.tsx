import { useEffect, useState } from 'react'

import type { CapabilityView, CapabilityViewNode } from '@shared/ipc'
import { getApi } from '../api'
import {
  ComponentIcon,
  ConsumesIcon,
  KindIcon,
  KnowledgeIcon,
  LeadIcon,
  LedgerIcon,
  OwnersIcon,
  PointerIcon,
  PolicyIcon,
  RepoIcon
} from './CapabilityIcons'
import { CapabilityPlan } from './CapabilityPlan'

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
  const [creating, setCreating] = useState(false)

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

          {view && creating && (
            <CapabilityPlan root={view.root} view={view} onBack={() => setCreating(false)} />
          )}

          {view && !creating && view.nodes.length > 0 && (
            <div className="cap-split">
              <div className="cap-tree">
                <div className="cap-source-line">
                  {view.sources.length} manifest{view.sources.length === 1 ? '' : 's'}
                  {view.pointerSources.length > 0 &&
                    ` · ${view.pointerSources.length} pointer${view.pointerSources.length === 1 ? '' : 's'}`}
                </div>
                {view.nodes.map((n) => {
                  const hasChildren = view.nodes.some((c) => c.parent === n.id)
                  return (
                    <button
                      key={n.id}
                      className={`cap-row ${selected === n.id ? 'on' : ''} ${n.kind}`}
                      style={{ paddingLeft: 8 + n.depth * 15 }}
                      onClick={() => setSelected(n.id)}
                      title={n.id}
                    >
                      {/* A chevron only where there is something under it. */}
                      {/* Always rendered so every row has identical structure. */}
                      <span className={`cap-chev ${hasChildren ? '' : 'empty'}`}>⌄</span>
                      <span className={`cap-row-icon ${n.kind}`}>
                        <KindIcon kind={n.kind} />
                      </span>
                      <span className="cap-row-name">{n.name ?? n.id}</span>
                      {/* Materialization is visible, not explained (§7.1). */}
                      {n.ledger && <span className="cap-dot" title={n.ledger.label} />}
                      {n.errors.length > 0 && <span className="cap-flag error">!</span>}
                      {n.errors.length === 0 && n.questions.length > 0 && (
                        <span className="cap-flag warn">?</span>
                      )}
                    </button>
                  )
                })}

                {/* Present because the spec's navigator has it, disabled because
                    creating a capability is an sgh command, not a form post. */}
                <button className="cap-add live" onClick={() => setCreating(true)}>
                  Add capability ↗
                </button>
              </div>

              <div className="cap-detail">
                {node ? <Detail node={node} nodes={view.nodes} /> : null}
              </div>
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
          Forms in, commits out. Nothing is written from here — creating and materializing produce a
          previewed plan that <code>sgh</code> applies as one stamped commit.
        </div>
      </div>
    </div>
  )
}

/** A titled group. Every section names where its rows came from (§7.1). */
function Section({
  title,
  source,
  icon,
  children
}: {
  title: string
  source: string
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="cap-section">
      <div className="cap-section-head">
        <span className="cap-section-title">
          {icon}
          {title}
        </span>
        <span className="cap-source">{source}</span>
      </div>
      <div className="cap-rows">{children}</div>
    </div>
  )
}

/**
 * One key/value row.
 *
 * Key on the left, value on the right, in its own bordered row. Uniform because
 * every section is answering the same question — what is this, and where did it
 * come from — and a different layout per section makes that harder to scan, not
 * easier.
 */
function Row({
  icon,
  label,
  detail,
  value,
  tone
}: {
  icon?: React.ReactNode
  label: React.ReactNode
  detail?: React.ReactNode
  value?: React.ReactNode
  tone?: 'error' | 'warn'
}): React.JSX.Element {
  return (
    <div className={`cap-kv ${tone ?? ''}`}>
      <span className="cap-k">
        {icon}
        <span className="cap-k-label">{label}</span>
        {detail && <span className="cap-k-detail">{detail}</span>}
      </span>
      {value !== undefined && <span className="cap-v">{value}</span>}
    </div>
  )
}

const money = (n: number): string => `$${n.toLocaleString()}`

/** "maxCostUsdPerThread: 40" reads worse than "Budget $40 per thread". */
function budgetLabel(field: string, value: number): string {
  if (field === 'maxCostUsdPerThread') return `Budget ${money(value)} per thread`
  if (field === 'maxTokensPerStep') return `Token cap ${value.toLocaleString()} per step`
  return `${field}: ${value.toLocaleString()}`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function Detail({
  node,
  nodes
}: {
  node: CapabilityViewNode
  nodes: CapabilityViewNode[]
}): React.JSX.Element {
  const parent = nodes.find((n) => n.id === node.parent)

  // The identity line: kind, where it sits, how much it owns, who owns it.
  const identity = [
    node.kind,
    parent ? `under ${parent.name ?? parent.id}` : 'root',
    node.repos.length ? `${node.repos.length} repo${node.repos.length === 1 ? '' : 's'}` : null,
    node.contacts.length ? `owners: ${node.contacts.map((c) => c.actorId).join(', ')}` : null
  ].filter(Boolean)

  return (
    <>
      <div className="cap-head-row">
        <div className="cap-title">{node.name ?? node.id}</div>
        {node.ledger ? (
          <div className="cap-chip" title={`${node.ledger.kind} ledger`}>
            <LedgerIcon />
            <span className="cap-chip-label">{node.ledger.label}</span>
            <span className="cap-chip-kind">{node.ledger.kind}</span>
          </div>
        ) : (
          <div className="cap-chip muted">
            <LedgerIcon />
            <span className="cap-chip-label">a stanza in its parent</span>
          </div>
        )}
      </div>

      <div className="cap-identity">
        {/* The delivery / business flag, carried as an icon so it reads at a
            glance in both the tree and here. */}
        <span className={`cap-flagpill ${node.kind}`}>
          <KindIcon kind={node.kind} />
          {node.kind}
        </span>
        {identity.slice(1).map((part, i) => (
          <span key={i} className="cap-identity-part">
            {part}
          </span>
        ))}
      </div>

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
        <Section title="Repos" source="manifest" icon={<RepoIcon />}>
          {node.repos.map((r) => (
            <Row
              key={r.repoId}
              icon={<RepoIcon />}
              label={r.repoId}
              detail={r.url}
              value={
                <>
                  {r.role === 'lead' && (
                    <span className="cap-badge lead" title="Hosts the sidecar ledger">
                      <LeadIcon />
                      lead
                    </span>
                  )}
                  {r.writePolicy === 'gated' && <span className="cap-badge warn">gated</span>}
                  <span className="cap-mono dim">{r.defaultBase}</span>
                </>
              }
            />
          ))}
        </Section>
      )}

      {node.components.length > 0 && (
        <Section
          title="Components"
          source="capability.yaml + reconciler"
          icon={<ComponentIcon kind="service" />}
        >
          {node.components.map((c) => (
            <Row
              key={c.id}
              icon={<ComponentIcon kind={c.kind} />}
              label={
                <>
                  {c.id}
                  {c.tech && <span className="cap-tech"> · {c.tech}</span>}
                </>
              }
              detail={
                c.observedBy.length
                  ? `observed by ${c.observedBy.join(', ')}`
                  : c.declaredBy
                    ? `declared by ${c.declaredBy}`
                    : undefined
              }
              value={<span className={`cap-status ${c.status}`}>{c.status}</span>}
            />
          ))}
        </Section>
      )}

      {node.consumes.length > 0 && (
        <Section title="Consumes" source="consumer edges" icon={<ConsumesIcon />}>
          {node.consumes.map((e, i) => (
            <Row
              key={i}
              icon={<ConsumesIcon />}
              label={
                e.component ? (
                  <>
                    {e.component} <span className="cap-tech">from {e.provider}</span>
                  </>
                ) : (
                  e.provider
                )
              }
              value={e.contract ? <span className="cap-mono dim">{e.contract}</span> : undefined}
            />
          ))}
        </Section>
      )}

      {node.policy && (
        <Section
          title="Effective policy"
          source="the fold, resolved host-side"
          icon={<PolicyIcon />}
        >
          {node.policy.gates.map((g, i) => (
            <Row
              key={`g${i}`}
              label={`${capitalize(g.role)} gate on ${g.on}`}
              detail={g.scope}
              value={g.from === node.id ? 'own gate' : `inherited from ${g.from}`}
            />
          ))}
          {node.policy.budgets.map((b) => (
            <Row
              key={b.field}
              label={budgetLabel(b.field, b.value)}
              /* "min of digital $50, pzn $40" — a surprising number stays explicable. */
              value={
                b.from.length > 1
                  ? `min along ${b.from.map((f) => f.split('.').pop()).join(', ')}`
                  : `from ${b.from[0]?.split('.').pop() ?? 'here'}`
              }
            />
          ))}
          <Row
            label={
              node.policy.terminalAllowList
                ? `Terminal: ${node.policy.terminalAllowList.join(', ') || 'nothing permitted'}`
                : 'Terminal: unrestricted'
            }
            value={
              node.policy.allowListFrom.length
                ? `intersection of ${node.policy.allowListFrom.map((f) => f.split('.').pop()).join(', ')}`
                : 'no list on the path'
            }
          />
          {node.policy.constraints.map((c) => (
            <Row
              key={c.id}
              label={capitalize(c.text)}
              detail={`${c.forbids} ${c.selector}`}
              value="own constraint"
            />
          ))}
          {!node.policy.gates.length && !node.policy.budgets.length && (
            <Row label="Nothing inherited or declared" />
          )}
        </Section>
      )}

      {node.knowledge.length > 0 && (
        <Section title="Knowledge" source="manifest (verifiedAt)" icon={<KnowledgeIcon />}>
          {node.knowledge.map((k, i) => (
            <Row
              key={i}
              icon={<KnowledgeIcon />}
              label={
                <a href={k.url} className="cap-link" title={k.url}>
                  {k.title}
                </a>
              }
              detail={k.kind}
              /* Nags, never garbage-collects (§7.5). */
              value={
                k.verifiedAt ? (
                  <span className={k.stale ? 'warn' : ''}>
                    verified {k.verifiedAt}
                    {k.stale ? ' — re-check' : ''}
                  </span>
                ) : undefined
              }
            />
          ))}
        </Section>
      )}

      {(node.contacts.length > 0 || node.tracker) && (
        <Section title="Owners" source="manifest" icon={<OwnersIcon />}>
          {node.contacts.map((c, i) => (
            <Row key={i} icon={<OwnersIcon />} label={c.actorId} value={c.role} />
          ))}
          {node.tracker && (
            <Row label={`${node.tracker.system} project`} value={node.tracker.projectKey} />
          )}
        </Section>
      )}

      {node.pointerFindings.length > 0 && (
        <Section title="Pointer files" source="member-repo back-references" icon={<PointerIcon />}>
          {node.pointerFindings.map((f, i) => (
            <Row
              key={i}
              icon={<PointerIcon />}
              label={f.repoId}
              detail={f.detail}
              tone={f.kind === 'repo-claimed-elsewhere' ? 'error' : undefined}
            />
          ))}
        </Section>
      )}

      {/* Named rather than omitted: it is in the spec's navigator, and the reason
          it is empty is a missing reader, not a missing capability. */}
      <Section title="Accepted outcomes" source="git log singularity/ledger" icon={<LedgerIcon />}>
        <Row label="Needs the ledger reader — receipts land with the sgh state lifecycle" />
      </Section>
    </>
  )
}
