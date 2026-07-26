import { useMemo } from 'react'
import { diffLines } from 'diff'

interface Row {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  oldNo?: number
  newNo?: number
  text: string
}

const CONTEXT = 3

/**
 * Unified diff with collapsed context. Long unchanged runs become a single
 * "⋯ N unchanged lines" row so a two-line edit in a 2000-line file stays
 * readable.
 */
export function DiffView({
  path,
  oldText,
  newText
}: {
  path: string
  oldText: string | null | undefined
  newText: string
}): React.JSX.Element {
  const rows = useMemo(() => buildRows(oldText ?? '', newText), [oldText, newText])
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'del').length

  return (
    <div>
      <div className="diff-path">
        {path}
        {(added > 0 || removed > 0) && (
          <span style={{ marginLeft: 10 }}>
            <span style={{ color: 'var(--green)' }}>+{added}</span>{' '}
            <span style={{ color: 'var(--red)' }}>-{removed}</span>
          </span>
        )}
      </div>
      <div className="diff">
        {rows.map((row, i) =>
          row.kind === 'gap' ? (
            <div className="diff-row gap" key={i}>
              <span className="ln" />
              <span className="txt">{row.text}</span>
            </div>
          ) : (
            <div className={`diff-row ${row.kind}`} key={i}>
              <span className="ln">
                {row.kind === 'add' ? row.newNo : row.kind === 'del' ? row.oldNo : row.newNo}
              </span>
              <span className="txt">
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                {row.text}
              </span>
            </div>
          )
        )}
      </div>
    </div>
  )
}

function buildRows(oldText: string, newText: string): Row[] {
  const parts = diffLines(oldText, newText)
  const all: Row[] = []
  let oldNo = 1
  let newNo = 1

  for (const part of parts) {
    // `diff` keeps the trailing newline on each chunk; drop the empty tail.
    const lines = part.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    for (const line of lines) {
      if (part.added) all.push({ kind: 'add', newNo: newNo++, text: line })
      else if (part.removed) all.push({ kind: 'del', oldNo: oldNo++, text: line })
      else all.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line })
    }
  }

  // Collapse unchanged runs longer than 2*CONTEXT.
  const keep = new Set<number>()
  all.forEach((row, i) => {
    if (row.kind === 'ctx') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(all.length - 1, i + CONTEXT); j++) {
      keep.add(j)
    }
  })

  const out: Row[] = []
  let skipped = 0
  all.forEach((row, i) => {
    if (keep.has(i)) {
      if (skipped > 0) {
        out.push({ kind: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
        skipped = 0
      }
      out.push(row)
    } else {
      skipped++
    }
  })
  if (skipped > 0) {
    out.push({ kind: 'gap', text: `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}` })
  }
  return out
}
