import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Implements the client half of ACP's `terminal/*` methods.
 *
 * Output is capped per terminal so a runaway `yes` or a chatty build can't grow
 * the main process heap without bound; ACP has an explicit `truncated` flag for
 * exactly this case.
 */

const DEFAULT_OUTPUT_LIMIT = 1024 * 512 // 512 KiB

interface TerminalRecord {
  id: string
  child: ChildProcess
  output: string
  truncated: boolean
  byteLimit: number
  exitStatus: { exitCode: number | null; signal: string | null } | null
  exitWaiters: Array<(status: { exitCode: number | null; signal: string | null }) => void>
}

export interface CreateTerminalParams {
  sessionId: string
  command: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
  cwd?: string
  outputByteLimit?: number
}

export class TerminalManager {
  private terminals = new Map<string, TerminalRecord>()

  create(params: CreateTerminalParams, fallbackCwd: string): { terminalId: string } {
    const id = randomUUID()
    const env = { ...process.env }
    for (const e of params.env ?? []) env[e.name] = e.value

    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? fallbackCwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const rec: TerminalRecord = {
      id,
      child,
      output: '',
      truncated: false,
      byteLimit: params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      exitStatus: null,
      exitWaiters: []
    }

    const append = (chunk: Buffer): void => {
      rec.output += chunk.toString('utf8')
      if (rec.output.length > rec.byteLimit) {
        // Keep the tail: the end of a failing build is what matters.
        rec.output = rec.output.slice(rec.output.length - rec.byteLimit)
        rec.truncated = true
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const settle = (exitCode: number | null, signal: string | null): void => {
      if (rec.exitStatus) return
      rec.exitStatus = { exitCode, signal }
      for (const w of rec.exitWaiters) w(rec.exitStatus)
      rec.exitWaiters = []
    }
    child.on('exit', (code, signal) => settle(code, signal))
    child.on('error', (err) => {
      rec.output += `\n[failed to spawn: ${err.message}]\n`
      settle(null, null)
    })

    this.terminals.set(id, rec)
    return { terminalId: id }
  }

  output(terminalId: string): {
    output: string
    truncated: boolean
    exitStatus: { exitCode: number | null; signal: string | null } | null
  } {
    const rec = this.require(terminalId)
    return { output: rec.output, truncated: rec.truncated, exitStatus: rec.exitStatus }
  }

  waitForExit(
    terminalId: string
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const rec = this.require(terminalId)
    if (rec.exitStatus) return Promise.resolve(rec.exitStatus)
    return new Promise((resolve) => rec.exitWaiters.push(resolve))
  }

  kill(terminalId: string): void {
    const rec = this.require(terminalId)
    if (!rec.exitStatus) rec.child.kill('SIGTERM')
  }

  release(terminalId: string): void {
    const rec = this.terminals.get(terminalId)
    if (!rec) return
    if (!rec.exitStatus) rec.child.kill('SIGKILL')
    this.terminals.delete(terminalId)
  }

  /** Kill everything — used when a session closes or the app quits. */
  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id)
  }

  private require(terminalId: string): TerminalRecord {
    const rec = this.terminals.get(terminalId)
    if (!rec) {
      const err = new Error(`Unknown terminalId: ${terminalId}`) as Error & { code?: number }
      err.code = -32602
      throw err
    }
    return rec
  }
}
