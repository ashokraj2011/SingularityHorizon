import { useEffect, useState } from 'react'

import type { LlmEndpoint, LlmEndpointInput } from '@shared/ipc'
import { getApi } from '../api'

/**
 * LLM gateways and APIs.
 *
 * This panel never holds a key it has read back. Keys go one way — typed here,
 * encrypted in the main process by the OS keychain, and from then on the only
 * thing the UI knows is whether one exists. Editing an endpoint leaves the
 * stored key alone unless the field is touched, which is why the placeholder
 * says "unchanged" rather than showing dots that imply a value is loaded.
 */

const BLANK: LlmEndpointInput = {
  name: '',
  provider: 'openai',
  baseUrl: '',
  models: [],
  apiKey: ''
}

export function EndpointsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [endpoints, setEndpoints] = useState<LlmEndpoint[]>([])
  const [draft, setDraft] = useState<LlmEndpointInput | null>(null)
  const [modelsText, setModelsText] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setEndpoints(await getApi().listEndpoints())
  }

  useEffect(() => {
    void refresh()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const edit = (endpoint: LlmEndpoint): void => {
    setDraft({
      id: endpoint.id,
      name: endpoint.name,
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      models: endpoint.models,
      defaultModel: endpoint.defaultModel,
      wireApi: endpoint.wireApi,
      useForCopilot: endpoint.useForCopilot
      // apiKey deliberately absent: undefined means "leave what is stored".
    })
    setModelsText(endpoint.models.join(', '))
    setNotice(null)
  }

  const submit = async (): Promise<void> => {
    if (!draft) return
    try {
      const models = modelsText
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
      const result = await getApi().saveEndpoint({ ...draft, models })
      setNotice(
        result.warning
          ? { kind: 'error', text: result.warning }
          : { kind: 'ok', text: `Saved ${result.endpoint.name}` }
      )
      setDraft(null)
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message.replace(/^Error:\s*/, '') })
    }
  }

  const test = async (id: string): Promise<void> => {
    setTesting(id)
    const result = await getApi().testEndpoint(id)
    setTesting(null)
    setNotice({ kind: result.ok ? 'ok' : 'error', text: result.message })
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>LLM gateways and APIs</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <div className="sheet-body">
          {notice && <div className={`notice ${notice.kind === 'error' ? 'error' : ''}`}>{notice.text}</div>}

          {!endpoints.length && !draft && (
            <div className="sheet-empty">
              Nothing configured. Add a gateway — a LiteLLM proxy, an internal endpoint, or a
              vendor API — and the built-in agent can use every model behind it.
            </div>
          )}

          {endpoints.map((e) => (
            <div key={e.id} className="endpoint-row">
              <div className="endpoint-main">
                <div className="endpoint-name">
                  {e.name}
                  {e.isDefault && <span className="endpoint-tag">default</span>}
                  {!e.hasKey && (
                    <span className="endpoint-tag warn" title="Falls back to the environment">
                      no stored key
                    </span>
                  )}
                </div>
                <div className="endpoint-url">{e.baseUrl}</div>
                <div className="endpoint-models">
                  {e.provider} · {e.models.join(', ')}
                  {e.useForCopilot && ' · also drives Copilot CLI'}
                </div>
              </div>
              <div className="endpoint-actions">
                <button className="btn" onClick={() => void test(e.id)} disabled={testing === e.id}>
                  {testing === e.id ? 'Testing…' : 'Test'}
                </button>
                {!e.isDefault && (
                  <button
                    className="btn"
                    onClick={async () => {
                      await getApi().setDefaultEndpoint(e.id)
                      await refresh()
                    }}
                  >
                    Make default
                  </button>
                )}
                <button className="btn" onClick={() => edit(e)}>
                  Edit
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    await getApi().deleteEndpoint(e.id)
                    await refresh()
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          {draft ? (
            <>
              <div className="sheet-sep" />
              <div className="sheet-row-head">{draft.id ? 'Edit endpoint' : 'New endpoint'}</div>
              <div className="endpoint-form">
                <label>
                  Name
                  <input
                    value={draft.name}
                    placeholder="Internal gateway"
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <label>
                  Wire format
                  <select
                    value={draft.provider}
                    onChange={(e) =>
                      setDraft({ ...draft, provider: e.target.value as 'openai' | 'anthropic' })
                    }
                  >
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic Messages</option>
                  </select>
                </label>
                <label>
                  Base URL
                  <input
                    value={draft.baseUrl}
                    placeholder="https://gateway.corp/v1"
                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  />
                </label>
                <label>
                  Models
                  <input
                    value={modelsText}
                    placeholder="claude-sonnet-5, gpt-5.4"
                    onChange={(e) => setModelsText(e.target.value)}
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={draft.apiKey ?? ''}
                    placeholder={draft.id ? 'unchanged' : 'stored in your keychain'}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                </label>
                <label className="endpoint-check">
                  <input
                    type="checkbox"
                    checked={draft.useForCopilot ?? false}
                    onChange={(e) => setDraft({ ...draft, useForCopilot: e.target.checked })}
                  />
                  <span>
                    Also route GitHub Copilot CLI here (BYOK). Copilot then uses this endpoint
                    instead of GitHub&rsquo;s model routing, and needs no GitHub sign-in.
                  </span>
                </label>
                {draft.useForCopilot && (
                  <label>
                    Copilot wire API
                    <select
                      value={draft.wireApi ?? 'completions'}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          wireApi: e.target.value as 'completions' | 'responses'
                        })
                      }
                    >
                      <option value="completions">completions (default)</option>
                      <option value="responses">responses (GPT-5 series)</option>
                    </select>
                  </label>
                )}
                <div className="endpoint-hint">
                  Encrypted by the system keychain. If the keychain is unavailable the key is not
                  written at all — set <code>EH_HARNESS_API_KEY</code> in the environment instead.
                </div>
                <div className="endpoint-actions">
                  <button className="btn primary" onClick={() => void submit()}>
                    Save
                  </button>
                  <button className="btn" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="sheet-sep" />
              <button
                className="btn primary"
                onClick={() => {
                  setDraft({ ...BLANK })
                  setModelsText('')
                  setNotice(null)
                }}
              >
                Add an endpoint
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
