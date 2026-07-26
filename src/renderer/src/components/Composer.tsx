import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { SessionSnapshot, SkillInfo } from '@shared/ipc'
import { useStore } from '../store'
import { buildSlashItems, type SlashItem } from '../slashMenu'

/** Stable reference — a fresh [] each render would loop the selector. */
const EMPTY_SKILLS: SkillInfo[] = []

type MenuItem = SlashItem

export function Composer({ session }: { session: SessionSnapshot }): React.JSX.Element {
  const [text, setText] = useState('')
  const [fileMatches, setFileMatches] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const send = useStore((s) => s.send)
  const cancel = useStore((s) => s.cancel)
  const skills = useStore((s) => s.skills[session.id] ?? EMPTY_SKILLS)

  const busy = session.status === 'busy'
  const disabled = session.status === 'starting' || session.status === 'error' ||
    session.status === 'exited'

  /* --------------------------------------------------------- autocomplete */

  const token = useMemo(() => activeToken(text), [text])

  useEffect(() => {
    if (token?.kind !== 'file') {
      setFileMatches([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      window.acp
        .searchFiles(session.cwd, token.query)
        .then((files) => !cancelled && setFileMatches(files))
        .catch(() => !cancelled && setFileMatches([]))
    }, 90)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [token?.kind, token?.query, session.cwd])

  const items: MenuItem[] = useMemo(() => {
    if (!token) return []
    if (token.kind === 'slash') {
      return buildSlashItems(session.commands, skills, token.query)
    }
    return fileMatches.slice(0, 40).map((path) => {
      const rel = path.startsWith(session.cwd + '/')
        ? path.slice(session.cwd.length + 1)
        : path
      return {
        key: path,
        label: rel.split('/').pop() ?? rel,
        description: rel,
        insert: `@${rel} `,
        local: false
      }
    })
  }, [token, session.commands, skills, fileMatches, session.cwd])

  useEffect(() => setSelected(0), [items.length, token?.kind])

  const menuOpen = items.length > 0 && token !== null

  const accept = (item: MenuItem): void => {
    if (!token) return
    setText(text.slice(0, token.start) + item.insert + text.slice(token.end))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /* ------------------------------------------------------------- textarea */

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const submit = (): void => {
    const value = text.trim()
    if (!value || busy || disabled) return
    setText('')
    void send(value)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => (i + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        accept(items[selected])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setFileMatches([])
        setText(text + ' ')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        {menuOpen && (
          <div className="menu">
            {items.map((item, i) => (
              <button
                key={item.key}
                className={`menu-item ${i === selected ? 'sel' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => accept(item)}
              >
                <span className="k">{item.label}</span>
                {item.description && <span className="d">{item.description}</span>}
                {item.badge && <span className="badge">{item.badge}</span>}
              </button>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={
            disabled
              ? 'Session is not running'
              : 'Ask anything.  /  for commands,  @  for files'
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="composer-bar">
          <span className="hint">
            {busy ? 'Running — Esc to interrupt' : 'Enter to send · Shift+Enter for newline'}
          </span>
          <span className="spacer" />
          {busy ? (
            <button className="btn" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={!text.trim() || disabled}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Finds the token the caret is sitting in, if it's an autocomplete trigger.
 * `/` only counts at the very start of the message — matching CLI behaviour,
 * and avoiding a menu every time someone types a file path mid-sentence.
 */
function activeToken(
  text: string
): { kind: 'slash' | 'file'; query: string; start: number; end: number } | null {
  const slash = /^\/(\S*)$/.exec(text)
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: text.length }

  const at = /(^|\s)@(\S*)$/.exec(text)
  if (at) {
    const start = at.index + at[1].length
    return { kind: 'file', query: at[2], start, end: text.length }
  }
  return null
}
