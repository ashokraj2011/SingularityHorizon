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
