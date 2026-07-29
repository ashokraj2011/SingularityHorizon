import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Small persisted preferences.
 *
 * Deliberately tiny and best-effort: a corrupt or unreadable file must not stop
 * the app from opening a folder, so every read falls back to defaults and every
 * write swallows its error. Nothing here is load-bearing — it only stops the
 * user re-making the same choice every session.
 */

export interface Prefs {
  /** Last tool profile chosen, used as the default for the next session. */
  lastToolProfile?: string
  /** Per-repo overrides, keyed by resolved repo root. */
  toolProfileByRepo?: Record<string, string>
  /**
   * The theme actually in effect when the window last closed.
   *
   * Stored so the next launch can fill the window with the right colour before
   * anything renders. The OS setting is not a substitute: someone on a dark
   * system who chose the light theme would get a black flash on every launch,
   * which is precisely the thing the initial fill exists to prevent.
   */
  resolvedTheme?: 'dark' | 'light'
}

let cache: Prefs | null = null

function file(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

export async function loadPrefs(): Promise<Prefs> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(file(), 'utf8')) as Prefs
  } catch {
    cache = {}
  }
  return cache
}

async function save(next: Prefs): Promise<void> {
  cache = next
  try {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* preferences are a convenience, never a requirement */
  }
}

/** The profile to preselect: repo-specific choice, else the last one used. */
export async function preferredToolProfile(repoRoot?: string): Promise<string | undefined> {
  const prefs = await loadPrefs()
  if (repoRoot) {
    const byRepo = prefs.toolProfileByRepo?.[resolve(repoRoot)]
    if (byRepo) return byRepo
  }
  return prefs.lastToolProfile
}

export async function rememberToolProfile(profile: string, repoRoot?: string): Promise<void> {
  const prefs = await loadPrefs()
  const next: Prefs = { ...prefs, lastToolProfile: profile }
  if (repoRoot) {
    next.toolProfileByRepo = { ...prefs.toolProfileByRepo, [resolve(repoRoot)]: profile }
  }
  await save(next)
}

export async function rememberTheme(theme: 'dark' | 'light'): Promise<void> {
  const prefs = await loadPrefs()
  if (prefs.resolvedTheme === theme) return
  await save({ ...prefs, resolvedTheme: theme })
}

/**
 * Read the last theme synchronously, for the window's initial fill.
 *
 * Synchronous on purpose: the window is created before an await can resolve,
 * and a promise here would be read after the frame it was needed for.
 */
export function lastThemeSync(): 'dark' | 'light' | null {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'prefs.json'), 'utf8')
    const parsed = JSON.parse(raw) as Prefs
    return parsed.resolvedTheme === 'light' || parsed.resolvedTheme === 'dark'
      ? parsed.resolvedTheme
      : null
  } catch {
    return null
  }
}
