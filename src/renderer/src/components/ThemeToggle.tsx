import { useEffect, useState } from 'react'

import { getApi } from '../api'
import {
  applyTheme,
  storePreference,
  resolveTheme,
  storedPreference,
  watchSystemTheme,
  type ThemePreference
} from '../theme'

const OPTIONS: Array<{ id: ThemePreference; label: string; title: string }> = [
  { id: 'system', label: 'Auto', title: 'Follow the system setting' },
  { id: 'light', label: 'Light', title: 'Always light' },
  { id: 'dark', label: 'Dark', title: 'Always dark' }
]

/**
 * Appearance, always reachable.
 *
 * Lives in the sidebar rather than a session menu: it is a property of the app,
 * and a setting you cannot reach until you have opened a folder is a setting
 * people conclude does not exist.
 */
export function ThemeToggle(): React.JSX.Element {
  const [preference, setPreference] = useState<ThemePreference>(() => storedPreference())

  // Only fires while the preference is "system", so an explicit choice is not
  // undone by the OS changing underneath it.
  useEffect(() => watchSystemTheme((resolved) => {
    setPreference(storedPreference())
    void getApi().rememberTheme(resolved).catch(() => {})
  }), [])

  // Report what is actually in effect, including on first mount — the stored
  // value has to follow an "Auto" preference as the OS changes, not only an
  // explicit switch.
  useEffect(() => {
    void getApi()
      .rememberTheme(resolveTheme(preference))
      .catch(() => {})
  }, [preference])

  const choose = (next: ThemePreference): void => {
    storePreference(next)
    applyTheme(next)
    setPreference(next)
  }

  return (
    <div className="theme-toggle" role="group" aria-label="Appearance">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          className={`theme-btn ${preference === option.id ? 'on' : ''}`}
          title={option.title}
          aria-pressed={preference === option.id}
          onClick={() => choose(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
