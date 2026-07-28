import { forwardRef, useCallback, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import type { SessionSnapshot, ThreadBlock } from '@shared/ipc'
import { Markdown } from './Markdown'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { ToolCard } from './ToolCard'

/**
 * The transcript, virtualized.
 *
 * Rendering every block was the app's known ceiling: 2,000 blocks measured at
 * ~10,700 DOM nodes with plain content, and far worse in practice because
 * syntax-highlighted code turns one block into hundreds of spans. Persistence
 * made that likelier by encouraging sessions long enough to reach it.
 *
 * Virtuoso rather than a hand-rolled window because block heights are unknown
 * and variable — prose, diffs, tool cards that expand — and because
 * "stick to the bottom while streaming unless the user has scrolled away" is
 * exactly the behaviour it implements and exactly the behaviour that is fiddly
 * to get right by hand.
 */

/**
 * Each item is its own flex column so `align-self` still positions user
 * messages to the right; the virtualizer gives every item its own wrapper, so
 * the old `gap` on a single shared parent no longer applies.
 */
function Item({ block }: { block: ThreadBlock }): React.JSX.Element {
  return (
    <div className="thread-item">
      <Block block={block} />
    </div>
  )
}

/** Keeps the centred, max-width column the non-virtualized layout had. */
const List = forwardRef<HTMLDivElement, { style?: React.CSSProperties; children?: React.ReactNode }>(
  function List({ style, children, ...rest }, ref) {
    return (
      <div ref={ref} {...rest} style={style} className="thread-inner">
        {children}
      </div>
    )
  }
)

export function Thread({ session }: { session: SessionSnapshot }): React.JSX.Element {
  const ref = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)

  const Footer = useCallback(
    () => (
      <div className="thread-footer">
        {session.status === 'busy' && !hasStreamingTail(session.blocks) && (
          <div className="hint">Working…</div>
        )}
        {session.lastError && <div className="notice error">{session.lastError}</div>}
      </div>
    ),
    [session.status, session.blocks, session.lastError]
  )

  return (
    <div className="thread-wrap">
      <Virtuoso
        ref={ref}
        className="thread"
        data={session.blocks}
        computeItemKey={(_, block) => block.id}
        itemContent={(_, block) => <Item block={block} />}
        components={{ List, Footer }}
        // "auto" follows the tail only while the user is already at the bottom,
        // so streaming never yanks the view away from something being read.
        followOutput="auto"
        atBottomStateChange={setAtBottom}
        atBottomThreshold={80}
        initialTopMostItemIndex={Math.max(0, session.blocks.length - 1)}
        increaseViewportBy={{ top: 600, bottom: 600 }}
      />

      {!atBottom && (
        <button
          className="jump-latest"
          onClick={() =>
            ref.current?.scrollToIndex({
              index: session.blocks.length - 1,
              align: 'end',
              behavior: 'smooth'
            })
          }
        >
          Jump to latest ↓
        </button>
      )}
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
                            : a.mode === 'outline'
                              ? 'outline'
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
