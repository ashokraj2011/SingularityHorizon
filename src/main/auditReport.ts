import type { AuditRecord } from '../shared/ipc'

/**
 * Renders an audit record for a human reader.
 *
 * Markdown rather than only JSON because the audience for this is usually
 * someone answering "what did the agent do in our repo?" — a reviewer, a lead,
 * an auditor — and handing them a JSON blob makes them do the reading work
 * twice. JSON stays available for anything that consumes it programmatically.
 */
export function renderAuditMarkdown(record: AuditRecord): string {
  const s = record.session
  const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

  const lines: string[] = [
    `# Agent session audit`,
    '',
    `- **Session**: ${s?.title ?? 'unknown'}`,
    `- **Directory**: ${s?.cwd ?? 'unknown'}`,
    `- **Agent**: ${s?.agentId ?? 'unknown'}${s?.toolProfile ? ` (${s.toolProfile} tools)` : ''}`,
    `- **Started**: ${s ? when(s.createdAt) : 'unknown'}`,
    `- **Last activity**: ${s ? when(s.updatedAt) : 'unknown'}`,
    `- **Turns**: ${s?.turns ?? 0}`,
    `- **Transcript blocks**: ${record.blocks}`,
    ''
  ]

  const denied = record.approvals.filter((a) => /den|reject|cancel/i.test(a.decision))
  const blanket = record.approvals.filter((a) => /always/i.test(a.decision))

  lines.push(
    `## Summary`,
    '',
    `- Permission requests: **${record.approvals.length}**`,
    `- Denied or cancelled: **${denied.length}**`,
    `- Granted for the rest of the session: **${blanket.length}**`,
    `- Tool invocations: **${record.commands.length}**`,
    ''
  )

  lines.push(`## Permission decisions`, '')
  if (!record.approvals.length) {
    lines.push('_No permission was requested in this session._', '')
  } else {
    lines.push('| Time | Decision | Request | Command |', '| --- | --- | --- | --- |')
    for (const a of record.approvals) {
      lines.push(
        `| ${when(a.at)} | ${a.decision} | ${escapeCell(a.title)} | ${a.command ? '`' + escapeCell(a.command) + '`' : '—'} |`
      )
    }
    lines.push('')
  }

  lines.push(`## Tool invocations`, '')
  if (!record.commands.length) {
    lines.push('_No tools were invoked._', '')
  } else {
    lines.push('| Time | Status | Command |', '| --- | --- | --- |')
    for (const c of record.commands) {
      lines.push(
        `| ${when(c.at)} | ${c.status ?? 'unknown'} | \`${escapeCell(c.command)}\` |`
      )
    }
    lines.push('')
  }

  lines.push(
    '---',
    '',
    '_Derived from the session transcript by Event Horizon. Every entry above is',
    'something the agent asked for and a person answered; nothing ran without',
    'passing through that gate unless "allow all" was enabled, which appears',
    'above as a blanket grant._'
  )

  return lines.join('\n')
}

/** Pipes and newlines would break the table this sits in. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function suggestedFilename(record: AuditRecord, format: 'json' | 'markdown'): string {
  const title = (record.session?.title ?? 'session').replace(/[^A-Za-z0-9._-]+/g, '-')
  const stamp = new Date(record.session?.updatedAt ?? Date.now())
    .toISOString()
    .slice(0, 10)
  return `audit-${title}-${stamp}.${format === 'json' ? 'json' : 'md'}`
}
