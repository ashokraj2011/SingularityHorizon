
import type { ContentBlock, ToolCall, ToolCallContent } from '@shared/acp'
import { useStore } from '../store'
import { DiffView } from './DiffView'

const KIND_ICON: Record<string, string> = {
  read: '◎',
  edit: '✎',
  delete: '⌫',
  move: '⇄',
  search: '⌕',
  execute: '›_',
  think: '◇',
  fetch: '⤓',
  switch_mode: '⇌',
  other: '•'
}

export function ToolCard({ call }: { call: ToolCall }): React.JSX.Element {
  const status = call.status ?? 'pending'
  const toggleTool = useStore((s) => s.toggleTool)
  const explicit = useStore((s) => s.expandedTools[call.toolCallId])
  // Failures start open — that's the case you always want to read. An explicit
  // choice overrides it, and lives in the store so scrolling a card out of
  // view (which unmounts it) does not quietly discard the choice.
  const open = explicit ?? status === 'failed'
  const setOpen = (next: boolean): void => toggleTool(call.toolCallId, next)

  const command = typeof call.rawInput?.command === 'string' ? call.rawInput.command : null
  const contents = call.content ?? []
  const hasBody = contents.length > 0 || command !== null

  return (
    <div className="tool">
      <button className="tool-head" onClick={() => hasBody && setOpen(!open)}>
        <span className="tool-icon">{KIND_ICON[call.kind ?? 'other'] ?? '•'}</span>
        <span className="tool-title">{call.title || call.kind || 'Tool call'}</span>
        <span className={`tool-status ${status}`}>{status.replace('_', ' ')}</span>
        {hasBody && (
          <span className="tool-icon" style={{ width: 10 }}>
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>

      {open && hasBody && (
        <div className="tool-body">
          {command && (
            <div className="cmd" style={{ marginBottom: contents.length ? 10 : 0 }}>
              $ {command}
            </div>
          )}
          {contents.map((c, i) => (
            <ToolContent key={i} content={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolContent({ content }: { content: ToolCallContent }): React.JSX.Element | null {
  if (content.type === 'diff') {
    return (
      <div style={{ margin: '0 -12px' }}>
        <DiffView path={content.path} oldText={content.oldText} newText={content.newText} />
      </div>
    )
  }
  if (content.type === 'terminal') {
    return <pre>[terminal {content.terminalId}]</pre>
  }
  const text = renderBlock(content.content)
  return text ? <pre>{text}</pre> : null
}

function renderBlock(block: ContentBlock | undefined): string {
  if (!block) return ''
  switch (block.type) {
    case 'text':
      return block.text
    case 'resource':
      return 'text' in block.resource ? block.resource.text : `[binary ${block.resource.uri}]`
    case 'resource_link':
      return `→ ${block.name} (${block.uri})`
    case 'image':
      return `[image ${block.mimeType}]`
    case 'audio':
      return `[audio ${block.mimeType}]`
    default:
      return ''
  }
}
