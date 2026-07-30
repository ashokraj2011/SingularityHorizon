/**
 * Icons for the Capability Navigator.
 *
 * Inline SVG rather than a font or a package: there are eleven of them, they are
 * all one path or two, and an icon dependency in an Electron renderer costs more
 * than it saves. Everything strokes `currentColor` so a chip, a tree row and a
 * status pill each colour their own icon without a variant per context.
 *
 * The set is deliberately small and typed to the model. A component kind that is
 * not in `ComponentIcon` falls back to a neutral glyph rather than nothing, so
 * adding a kind to the schema degrades instead of rendering a hole.
 */

const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

/** Business capability — governance and rollup: a node with children under it. */
export function BusinessIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <rect x="6" y="1.5" width="4" height="3.5" rx="1" />
      <rect x="1.5" y="11" width="4" height="3.5" rx="1" />
      <rect x="10.5" y="11" width="4" height="3.5" rx="1" />
      <path d="M8 5v3M3.5 11V8h9v3" />
    </svg>
  )
}

/** Delivery capability — owns repos and does work. */
export function DeliveryIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M8 1.6 14 4.8v6.4L8 14.4 2 11.2V4.8z" />
      <path d="M2 4.8 8 8l6-3.2M8 8v6.4" />
    </svg>
  )
}

/** A repo. Source control, so: a branch. */
export function RepoIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <circle cx="4" cy="3.5" r="1.8" />
      <circle cx="4" cy="12.5" r="1.8" />
      <circle cx="12" cy="8" r="1.8" />
      <path d="M4 5.3v5.4M5.8 3.5h2.4a2 2 0 0 1 2 2V6" />
    </svg>
  )
}

/** The lead repo — the one whose sidecar branch hosts the ledger. */
export function LeadIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .74 4.28L8 11.6l-3.83 2 .74-4.29-3.1-3 4.3-.6z" />
    </svg>
  )
}

export function LedgerIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M2.5 3.2A1.7 1.7 0 0 1 4.2 1.5H13v13H4.2a1.7 1.7 0 0 1-1.7-1.7z" />
      <path d="M2.5 11.3h10.5M5.6 1.5v9.8" />
    </svg>
  )
}

export function ConsumesIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M1.8 8h8.4M7.6 4.6 11 8l-3.4 3.4" />
      <path d="M12.8 3.2v9.6" />
    </svg>
  )
}

export function PolicyIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M8 1.6 13.4 3.4v4.3c0 3.1-2.2 5.6-5.4 6.7-3.2-1.1-5.4-3.6-5.4-6.7V3.4z" />
      <path d="M5.7 8l1.7 1.7 3-3.4" />
    </svg>
  )
}

export function KnowledgeIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M2.6 2.4h4.1c.7 0 1.3.6 1.3 1.3v9.9c0-.6-.6-1.1-1.3-1.1H2.6z" />
      <path d="M13.4 2.4H9.3C8.6 2.4 8 3 8 3.7v9.9c0-.6.6-1.1 1.3-1.1h4.1z" />
    </svg>
  )
}

export function OwnersIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <circle cx="6" cy="5.4" r="2.4" />
      <path d="M1.8 13.6c0-2.3 1.9-4.2 4.2-4.2s4.2 1.9 4.2 4.2" />
      <path d="M11 3.4a2.4 2.4 0 0 1 0 4.4M12.4 13.6c0-1.6-.5-2.6-1.2-3.4" />
    </svg>
  )
}

export function PointerIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M3.2 3.2l9.6 3.4-4.1 1.6-1.6 4.1z" />
    </svg>
  )
}

/* ------------------------------------------------------- component kinds */

function ApiIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M5.8 3.2 2.4 8l3.4 4.8M10.2 3.2 13.6 8l-3.4 4.8" />
      <path d="M9.2 4.6 6.8 11.4" />
    </svg>
  )
}

function DatabaseIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <ellipse cx="8" cy="3.6" rx="5.2" ry="2.1" />
      <path d="M2.8 3.6v8.8c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1V3.6" />
      <path d="M2.8 8c0 1.2 2.3 2.1 5.2 2.1s5.2-.9 5.2-2.1" />
    </svg>
  )
}

function QueueIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <rect x="1.6" y="5" width="3.2" height="6" rx="0.8" />
      <rect x="6.4" y="5" width="3.2" height="6" rx="0.8" />
      <rect x="11.2" y="5" width="3.2" height="6" rx="0.8" />
    </svg>
  )
}

function StorageIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <path d="M1.8 5.4 3.2 2.4h9.6l1.4 3z" />
      <path d="M1.8 5.4v7.2c0 .6.5 1 1 1h10.4c.6 0 1-.4 1-1V5.4" />
      <path d="M6 8.6h4" />
    </svg>
  )
}

function ServiceIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <rect x="1.8" y="2.4" width="12.4" height="4.4" rx="1.1" />
      <rect x="1.8" y="9.2" width="12.4" height="4.4" rx="1.1" />
      <path d="M4.4 4.6h.01M4.4 11.4h.01" />
    </svg>
  )
}

function JobIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4V8l2.6 1.6" />
    </svg>
  )
}

function UnknownIcon(): React.JSX.Element {
  return (
    <svg {...base} className="cap-icon">
      <circle cx="8" cy="8" r="6.2" />
    </svg>
  )
}

const COMPONENT_ICONS: Record<string, () => React.JSX.Element> = {
  api: ApiIcon,
  database: DatabaseIcon,
  queue: QueueIcon,
  storage: StorageIcon,
  service: ServiceIcon,
  job: JobIcon
}

/** Falls back rather than rendering a hole when the schema gains a kind. */
export function ComponentIcon({ kind }: { kind: string }): React.JSX.Element {
  const Icon = COMPONENT_ICONS[kind] ?? UnknownIcon
  return <Icon />
}

export function KindIcon({ kind }: { kind: 'business' | 'delivery' }): React.JSX.Element {
  return kind === 'business' ? <BusinessIcon /> : <DeliveryIcon />
}
