import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * What the installed `sgh` can actually do.
 *
 * Probed rather than assumed, because the answer changes what the UI is allowed
 * to offer. sgh 0.2.1 ships gate, approve, stamp and wm; the capability and state
 * surfaces from the command spec are not there yet, and an unknown subcommand
 * falls through to the usage banner rather than failing — so "did it work" has to
 * be decided by looking for the subcommand in the help text, not by an exit code.
 *
 * Lives at the top level of main rather than under capability/, alongside the
 * other binary probing — the capability core is IO-free and the guard enforces
 * it, which is how this file ended up in the right place.
 */
export interface SghStatus {
  installed: boolean
  version?: string
  /** Subcommands the help text actually advertises. */
  commands: string[]
  hasCapabilityCommand: boolean
  hasStateCommand: boolean
}

export async function probeSgh(path?: string): Promise<SghStatus> {
  const command = path ?? 'sgh'
  const env = process.env

  const help = await execFileAsync(command, ['--help'], { env, timeout: 10_000 })
    .then((r) => `${r.stdout}\n${r.stderr}`)
    .catch(() => null)

  if (help === null) return { installed: false, commands: [], hasCapabilityCommand: false, hasStateCommand: false }

  const version = /v?(\d+\.\d+\.\d+)/.exec(help)?.[1]
  // Usage lines look like "  sgh gate    …", so the advertised verb is the word
  // after the program name.
  const commands = [
    ...new Set(
      [...help.matchAll(/^\s+sgh\s+([a-z-]+)/gm)].map((m) => m[1]).filter((c) => c !== 'sgh')
    )
  ]

  return {
    installed: true,
    ...(version ? { version } : {}),
    commands,
    hasCapabilityCommand: commands.includes('capability'),
    hasStateCommand: commands.includes('state')
  }
}
