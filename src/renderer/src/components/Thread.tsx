import { useEffect, useRef } from 'react'

import type { SessionSnapshot, ThreadBlock } from '@shared/ipc'
import { Markdown } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { ToolCard } from './ToolCard'

export function Thread({ session }: { session: SessionSnapshot }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the tail while streaming, but stop fighting the user the moment
  // they scroll up to read something.
  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    if (pinned.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [session.blocks])

  return (
    <div className="thread" ref={ref} onScroll={onScroll}>
      <div className="thread-inner">
        {session.contextDocuments && session.contextDocuments.length > 0 && (
          <details className="session-grounding">
            <summary>
              <span>Singularity grounding active</span>
              <span>{session.contextDocuments.length} context source{session.contextDocuments.length === 1 ? '' : 's'}</span>
            </summary>
            <p>The selected phase contract, persona, repository world views, and governed evidence are injected with the first prompt.</p>
            <ul>
              {session.contextDocuments.map((document, index) => (
                <li key={`${document.providerId}:${document.title}:${index}`}>
                  <span className={`grounding-kind ${document.kind ?? 'evidence'}`}>
                    {document.kind === 'instructions' ? 'Instructions' : 'Evidence'}
                  </span>
                  <span>
                    <strong>{document.title}</strong>
                    {document.reason && <small>{document.reason}</small>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {session.blocks.map((block) => (
          <Block key={block.id} block={block} />
        ))}
        {session.status === 'busy' && !hasStreamingTail(session.blocks) && (
          <div className="hint">Working…</div>
        )}
        {session.lastError && (
          <div className="notice error">{session.lastError}</div>
        )}
        <div style={{ height: 8 }} />
      </div>
    </div>
  )
}

function hasStreamingTail(blocks: ThreadBlock[]): boolean {
  const last = blocks[blocks.length - 1]
  return !!last && (last.kind === 'assistant' || last.kind === 'thought') && last.streaming
}

function Block({ block }: { block: ThreadBlock }): React.JSX.Element | null {
  switch (block.kind) {
    case 'user':
      return (
        <div className="block-user">
          {block.attachments && block.attachments.length > 0 && (
            <div className="chips sent">
              {block.attachments.map((a) => (
                <span
                  key={a.path}
                  className={`chip ${a.error ? 'bad' : ''}`}
                  title={a.error ?? a.path}
                >
                  <span className="chip-icon">{a.kind === 'folder' ? '▤' : '◫'}</span>
                  <span className="chip-name">{a.name}</span>
                  <span className="chip-meta">
                    {a.error
                      ? 'failed'
                      : a.kind === 'folder'
                        ? `${a.entryCount ?? 0} entries${a.truncated ? '+' : ''}`
                        : a.binary
                          ? 'by reference'
                          : a.truncated
                            ? 'truncated'
                            : 'embedded'}
                  </span>
                </span>
              ))}
            </div>
          )}
          {block.text}
          {block.skill && (
            <div className="skill-chip" title={`Loaded from ${block.skill.source}`}>
              skill · {block.skill.name} · {block.skill.source} ·{' '}
              {block.skill.expandedChars.toLocaleString()} chars sent
            </div>
          )}
        </div>
      )

    case 'assistant':
      return (
        <div className="block-assistant">
          <Markdown text={block.text} />
          {block.streaming && <span className="caret" />}
        </div>
      )

    case 'thought':
      return (
        <details className="thought" open={block.streaming}>
          <summary>{block.streaming ? 'Thinking…' : 'Thought process'}</summary>
          <div className="body">{block.text}</div>
        </details>
      )

    case 'tool':
      return <ToolCard call={block.call} />

    case 'plan':
      return <PlanCard entries={block.entries} />

    case 'permission':
      return <PermissionCard request={block.request} />

    case 'notice':
      return <div className={`notice ${block.level}`}>{block.text}</div>

    default:
      return null
  }
}
