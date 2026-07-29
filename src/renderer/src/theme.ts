/**
 * Theme selection.
 *
 * Three preferences, two themes. "System" is a preference, not a theme, so the
 * resolution happens here and the CSS only ever sees `data-theme="dark"` or
 * `data-theme="light"`. The alternative — a `prefers-color-scheme` media query
 * plus override selectors — means two places decide, and when they disagree the
 * UI comes out half-light.
 *
 * Applied before React mounts. A theme applied in an effect paints one frame of
 * the wrong colour, which on a light setting is a full-window flash of black.
 */

export type ThemePreference = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

const KEY = 'event-horizon.theme'

/** Read the stored preference. Anything unrecognised means follow the system. */
export function storedPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'dark' || raw === 'light' ? raw : 'system'
  } catch {
    // A host that blocks storage should still get a working app.
    return 'system'
  }
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference)
  document.documentElement.dataset.theme = resolved
  return resolved
}

export function storePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, preference)
  } catch {
    /* not fatal — the theme still applies for this run */
  }
}

/**
 * Follow the OS while the preference is "system".
 *
 * Returns an unsubscribe. Watching unconditionally and checking the preference
 * inside the handler would keep an explicit choice from sticking the moment the
 * OS changed underneath it.
 */
export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const query = matchMedia('(prefers-color-scheme: light)')
  const handler = (): void => {
    if (storedPreference() !== 'system') return
    onChange(applyTheme('system'))
  }
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}

/** Called from the entry point, before the first paint. */
export function initTheme(): ResolvedTheme {
  return applyTheme(storedPreference())
}
