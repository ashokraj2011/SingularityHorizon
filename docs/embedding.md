# Embedding Event Horizon

Event Horizon is a UI and an agent engine that were built to come apart. The interface imports
no Electron and no Node; it reaches its host through exactly one typed object, `AcpStudioApi`.
The desktop app is not a special case — it is just the first host, and its entry point is about
twenty lines.

```tsx
// src/renderer/src/main.tsx — the whole of the desktop "adapter"
const api = electronApi()          // window.acp, from the preload bridge
createRoot(el).render(<EventHorizon api={api} />)
```

Any other host does the same thing with a different `api`.

---

## 1. Decide which shape you need

This is the only decision that materially changes the work. Everything else is wiring.

**In-process** — your host can run a child process (Electron app, VS Code / JetBrains
extension, CLI, Node server). You reuse the engine as-is and write a thin adapter. Small job.

**Out-of-process** — your host is a browser tab. A browser cannot spawn `copilot` or answer the
agent's `fs/read_text_file` calls, so something with filesystem access must, and your adapter
talks to it over the network. Bigger job, and a real security boundary — see §6.

```
  In-process                          Out-of-process
  ┌───────────────────┐               ┌──────────────┐      ┌────────────────────┐
  │ host process      │               │ browser      │      │ local daemon       │
  │  ┌─────────────┐  │               │ ┌──────────┐ │  ws  │  ┌──────────────┐  │
  │  │ EventHorizon│  │               │ │EventHoriz│─┼──────┼─▶│ SessionManager│ │
  │  └──────┬──────┘  │               │ └──────────┘ │      │  └──────┬───────┘  │
  │  ┌──────▼──────┐  │               └──────────────┘      │     ┌───▼────┐     │
  │  │SessionManager│─┼──▶ agent                            │     │ agent  │     │
  │  └─────────────┘  │                                     │     └────────┘     │
  └───────────────────┘                                     └────────────────────┘
```

---

## 2. Entry points

The package is consumed **as source** — your bundler compiles the TS/TSX. Types resolve
natively and there is no build artifact to keep in sync. This works today as a workspace,
path, or git dependency.

```jsonc
// your package.json
{ "dependencies": { "event-horizon": "workspace:*" } }   // or "file:../event-horizon"
```

| Import | Runtime | What it is |
| --- | --- | --- |
| `event-horizon/renderer` | browser | `<EventHorizon>`, the individual components, the store |
| `event-horizon/renderer/style.css` | browser | all styling (see §5) |
| `event-horizon/core` | node | `SessionManager`, `AgentSession`, skills, attachments — no Electron |
| `event-horizon/shared` | either | `AcpStudioApi`, `SessionSnapshot`, `ThreadBlock`, … |
| `event-horizon/shared/context` | either | `/context` + `/usage` parsers |

React 18+ is a peer dependency. Publishing to npm instead of consuming as source would need a
lib build emitting JS and `.d.ts`; nothing else about the design changes.

---

## 3. Recipe: another Electron app

The engine is already Electron-free, so you host it the same way this app does.

**Main process:**

```ts
import { SessionManager } from 'event-horizon/core'
import { ipcMain, BrowserWindow } from 'electron'

const manager = new SessionManager()

manager.on('event', (event) => win.webContents.send('eh:event', event))

ipcMain.handle('eh:createSession', (_e, opts) => manager.create(opts.cwd, opts.agentId))
ipcMain.handle('eh:prompt', (_e, id, req) => manager.prompt(id, req))
ipcMain.handle('eh:respondPermission', (_e, rid, oid) => manager.respondPermission(rid, oid))
// …one line per method in §4

app.on('before-quit', () => manager.disposeAll())   // don't orphan agent processes
```

**Preload** — expose the same shape, then render `<EventHorizon api={window.myBridge} />`.
`src/preload/index.ts` in this repo is a complete working example to copy.

---

## 4. Recipe: VS Code (or any webview host)

The webview gets `postMessage`, so the adapter is a request/response shim over it. Every method
in `AcpStudioApi` is either a call that returns a promise, or the one event subscription.

```ts
// inside the webview
import type { AcpStudioApi, MainEvent } from 'event-horizon/shared'

const pending = new Map<number, (v: unknown) => void>()
let seq = 0
const listeners = new Set<(e: MainEvent) => void>()

window.addEventListener('message', (e) => {
  const msg = e.data
  if (msg.kind === 'event') listeners.forEach((l) => l(msg.event))
  else pending.get(msg.id)?.(msg.result), pending.delete(msg.id)
})

const call = (method: string, ...args: unknown[]) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve as (v: unknown) => void)
    vscode.postMessage({ id, method, args })
  })

export const api: AcpStudioApi = {
  listAgents: () => call('listAgents') as Promise<never>,
  createSession: (o) => call('createSession', o) as Promise<never>,
  prompt: (id, req) => call('prompt', id, req) as Promise<void>,
  // …the rest, all identical one-liners
  onEvent: (l) => (listeners.add(l), () => listeners.delete(l))
}
```

In the extension host, unpack `{id, method, args}`, call the matching `SessionManager` method
from `event-horizon/core`, and post the result back. Forward `manager.on('event')` as
`{kind:'event', event}`.

Note that `pickDirectory` / `pickFiles` are *host* concerns — in VS Code they map to
`vscode.window.showOpenDialog`, not to an Electron dialog.

---

## 5. What you must implement

All of `AcpStudioApi`. Grouped by concern, with the ones that carry real weight called out.

**Sessions** — `listAgents`, `listSessions`, `createSession`, `closeSession`, `restartSession`

**Conversation** — `prompt`, `cancel`, `runCommandSilent`, `refreshContext`

> `prompt` takes a `PromptRequest`, not a string: `{ text, attachments?, displayText?, skill? }`.
> `displayText` is what the transcript shows when it differs from what was sent — that is how a
> skill invocation stays readable instead of pasting a whole SKILL.md into the thread. If you
> drop it, the UI still works but the transcript starts lying about what was sent.

**Permissions** — `respondPermission(requestId, optionId | null)`. `null` means cancelled.
Nothing runs until this resolves, so a host that never answers will hang the turn.

**Config** — `setConfigOption(sessionId, optionId, value)`. Model, mode, effort, allow-all are
all this one method; the UI renders whatever the agent declares.

**Skills** — `listSkills`, `expandSkill`. Return `[]` if you don't want client-side skills.

**Files** — `pickDirectory`, `pickFiles`, `statPaths`, `readDir`, `readFile`, `searchFiles`,
`homeDir`

**Events** — `onEvent(listener) => unsubscribe`. Push `session:created`, `session:blocks`,
`session:patch`, `session:removed`, `session:turnEnded`.

> `session:blocks` carries the **whole** block array, not a delta. That is deliberate — it makes
> the renderer idempotent and lets a dropped message self-heal on the next flush. If you proxy
> events across a network, do not try to diff them.

---

## 6. Recipe: browser + daemon, and the security boundary

A browser host needs a local process that runs the agent and serves the client half of ACP.
Sketch:

```ts
import { SessionManager } from 'event-horizon/core'
import { WebSocketServer } from 'ws'

const manager = new SessionManager()
const wss = new WebSocketServer({ host: '127.0.0.1', port: 7717 })   // loopback only

wss.on('connection', (ws, req) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return ws.close(1008)
  const off = manager.on('event', (event) => ws.send(JSON.stringify({ kind: 'event', event })))
  ws.on('message', async (raw) => {
    const { id, method, args } = JSON.parse(String(raw))
    const result = await (manager as any)[method](...args)
    ws.send(JSON.stringify({ id, result }))
  })
  ws.on('close', off)
})
```

**Read this before shipping that.** The daemon executes shell commands and reads and writes
files on behalf of whoever can reach it. It is not a normal API server:

- Bind to `127.0.0.1` only. Never `0.0.0.0`, never a public interface.
- Require a token, and check `Origin` — a WebSocket from any page the user visits will otherwise
  reach a port bound to localhost.
- Scope every session to a directory and keep the `fs/*` containment checks. `workspaceFs.ts`
  already rejects paths outside the session root; do not route around it.
- Permission prompts are the safety model. Auto-approving them server-side turns the daemon into
  a remote shell.

None of this exists in the repo today. It is the one piece of embedding that deserves a design
pass rather than a copy-paste.

---

## 6b. Workflow integrations (phases, work items, handoffs)

Event Horizon's core knows about repos, sessions, and context. It knows nothing about any SDLC
system, and must not learn — otherwise the standalone tool starts depending on a CLI it has no
business requiring. Anything lifecycle-shaped arrives through a provider the **host** registers:

```ts
import { registerProvider } from 'event-horizon/core'
import { singularityFlowProvider } from 'event-horizon/providers/singularity-flow'

registerProvider(singularityFlowProvider())
```

Standalone registers nothing and behaves as a plain agent client. The dependency only ever
points one way: the workflow tool knows about Event Horizon, never the reverse.

```ts
interface WorkspaceProvider {
  id: string
  name: string
  detect(root): Promise<ProviderStatus | null>          // null = not applicable, not an error
  contextDocuments?(root, { phase }): Promise<ContextDocument[]>
  onPhaseEnter?(root, phase): Promise<void>
}
```

A provider decides *what* is relevant; the host decides *when* to inject it. That split is what
lets phase-aware context cleaning work: on a phase change, start a fresh session (only a new
`sessionId` truly resets agent context — `/compact` summarizes, it does not reset) and seed it
with the handoff documents the provider returned.

**Providers cannot break the app.** Every call is wrapped: a throw, a rejection, or a hang is
contained and treated as "contributed nothing". This is verified by `provider:check`, which
registers a provider that throws and one that never resolves, and asserts session setup still
completes. An agent client that refuses to open a folder because an unrelated CLI is missing
would be worse than one with no workflow integration at all.

`npm run guard` fails the build if anything under `src/main/` outside `providers/` imports a
concrete provider or references a workflow CLI or its on-disk conventions.

## 7. Verify your adapter

The suite that proves the UI is host-agnostic is also the template for testing yours:

```bash
npm run embed:check   # drives the real store against a fake API — no Electron, no agent, no fs
npm run guard         # fails if the renderer reaches for window.acp / electron / node:
```

`scripts/embed-check.ts` implements a complete `AcpStudioApi` in about 100 lines. Copy it,
point it at your transport, and you have an integration test for your host.

Run `npm run guard` in your own CI too if you fork the UI. The regression it catches — a stray
`window.acp` creeping back in — keeps working perfectly in Electron and breaks every other host
silently, which is exactly the kind of thing that survives code review.

---

## 8. What ships vs. what you write

| | Status |
| --- | --- |
| UI, transport-agnostic | ships |
| ACP engine (`core`), Electron-free | ships |
| Electron adapter | ships |
| Adapter for your host | **you write it** — §3 / §4 |
| Daemon for a browser host | **you write it** — §6 |

The UI being host-agnostic is verified (`embed:check`, 19 assertions). Embedding into a
*specific* host still means writing that host's adapter — the hard part is done, but it is not
zero.
