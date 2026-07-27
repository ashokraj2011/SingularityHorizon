# Event Horizon

**A Singularity tool.**

The boundary where intent crosses into execution. A desktop client for coding agents that speak
the [Agent Client Protocol](https://agentclientprotocol.com), built against
[GitHub Copilot CLI's ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
— but the app talks ACP, not Copilot, so any stdio ACP agent can be plugged in.

The name is the design principle: an agent can propose anything, but nothing crosses into your
working tree without passing through you. Every shell command, every edit, every path read is a
gate you answer, and the record of what you approved stays in the transcript.

```bash
npm install
npm run dev
```

Requires an ACP-capable agent on your PATH. For Copilot: `brew install copilot-cli && copilot login`.

## What it does

- **Streaming chat** — assistant text, collapsible reasoning, and tool calls interleaved in the real order they happened.
- **Tool cards** — each call shows its kind, live status, the exact command, and its output. Failures open expanded.
- **Diffs** — file edits render as a unified diff with line numbers and collapsed context.
- **Inline permissions** — nothing runs until you approve it. `Y` / `A` / `N` for allow-once / always / deny, `Esc` to cancel. Answered prompts stay in the transcript showing what you chose.
- **Plans** — the agent's task list, updating as steps complete.
- **Live config** — model, mode (Agent / Plan / Autopilot), and reasoning effort are read from the agent and switchable mid-session.
- **Composer** — `/` completes the agent's advertised slash commands *and* locally-loaded skills, `@` completes workspace files. Mode, model, reasoning effort, and agent pickers sit in the composer bar, driven entirely by what the agent declares.
- **Attachments** — `+` adds files or folders. Files are embedded as ACP `resource` blocks (binaries referenced by path, oversized files truncated with disclosure); folders attach as a bounded listing. What was sent is recorded on the message.
- **Context meter** — live context-window usage with a full breakdown, plus session token totals.
- **Session actions** — compact the conversation, inspect or toggle agent memory, or start a fresh session on the same folder.
- **Tool profiles** — trade agent breadth for context. Measured: a 71% cut in per-request overhead (see below).
- **AST outlines** — attach a file's structure instead of its text. Measured 75% smaller across a real sample, 83–90% on implementation-heavy files.
- **Skills** — loaded from disk by the client, because Copilot's ACP server doesn't advertise them (see below).
- **Multiple sessions** — each is its own agent process, scoped to its own directory. One crashing doesn't affect the others.

## Standalone, or embedded in your own app

Both, from one codebase — they are not two modes. The UI imports no Electron and no Node, and
reaches its host through exactly one typed object, `AcpStudioApi`. The desktop app is simply the
first host, and its entry point is about twenty lines:

```tsx
const api = electronApi()                    // window.acp, from the preload bridge
createRoot(el).render(<EventHorizon api={api} />)
```

Any other host does the same with a different `api`:

```tsx
import { EventHorizon } from 'event-horizon/renderer'
import 'event-horizon/renderer/style.css'

<EventHorizon api={myHostApi} />
```

| Import | Runtime | What it is |
| --- | --- | --- |
| `event-horizon/renderer` | browser | the interface — transport-agnostic |
| `event-horizon/core` | node | the ACP engine — no Electron import |
| `event-horizon/shared` | either | `AcpStudioApi` and the view-model types |

Consumed as source, so your bundler compiles it and types resolve natively — no build artifact
to keep in sync. React 18+ is a peer dependency.

**→ [docs/embedding.md](docs/embedding.md)** has the full guide: recipes for another Electron
app, a VS Code webview, and a browser + daemon; the complete list of what an adapter must
implement; and the security boundary that a browser host introduces.

Two things worth knowing before you start. The engine (`src/main/`, minus `index.ts`) is plain
Node, so a CLI daemon or server can host it as easily as Electron. And a browser host is the one
genuinely harder case: a tab cannot spawn the agent or answer its `fs/*` calls, so a local
process must — one that executes shell commands on request, and therefore needs loopback
binding, a token, and origin checks. That daemon is not in the repo; it deserves a design pass,
not a copy-paste.

`npm run embed:check` drives the real store through a fake API — create a session, stage and
send attachments, expand a skill, change config, tear down — with no Electron, no agent process,
and no filesystem. `npm run guard` fails the build if the renderer ever reaches for
`window.acp`, `electron`, or a `node:` builtin again, since any of those silently re-welds the
UI to Electron: it keeps working in the desktop build and breaks every other host.

## Architecture

The renderer never touches Node. Everything crosses a typed `contextBridge` surface.

```
renderer (React)  ←AcpStudioApi→  host adapter  ←NDJSON/JSON-RPC over stdio→  agent
```

| Path | Role |
| --- | --- |
| `src/shared/acp.ts` | Protocol types, narrowed to what agents actually emit |
| `src/shared/ipc.ts` | IPC contract + the thread view-model |
| `src/main/acp/jsonrpc.ts` | Bidirectional JSON-RPC peer over newline-delimited JSON |
| `src/main/acp/session.ts` | Handshake, session lifecycle, update folding |
| `src/main/acp/workspaceFs.ts` | `fs/read_text_file`, `fs/write_text_file` + root containment |
| `src/main/acp/terminals.ts` | `terminal/*` with bounded output capture |
| `src/main/agents.ts` | Agent presets + login-shell PATH resolution |
| `src/main/manager.ts` | Owns live sessions, routes permission replies |

### Things worth knowing

**Dispatch on `method`, not `id`.** Agent→client requests use their own id space, so an
incoming `{id: 2, method: "session/request_permission"}` collides with your own outbound
request #2. Checking `id` first will resolve the wrong promise — this is the single easiest
way to break an ACP client, and it fails intermittently rather than loudly.

**GUI apps don't inherit your shell PATH.** A macOS app launched from Finder gets launchd's
minimal PATH, so `copilot` resolves in a terminal and mysteriously vanishes in the packaged
app. `src/main/agents.ts` asks the login shell for its real PATH once and caches it.

**Streaming updates are batched.** Agents emit a `session/update` per token; forwarding each
one over IPC swamps the renderer. Blocks are coalesced on a ~40ms tick, and text chunks fold
into the trailing block of the same kind rather than appending a node per token.

**Unknown update kinds are ignored, not fatal.** ACP is in preview and agents add variants;
an unrecognised `sessionUpdate` should render nothing, not crash the thread.

**Skills are loaded client-side, by necessity.** Copilot CLI 1.0.75's ACP server advertises its
32 built-in slash commands but not skills — `/skills` over ACP reports only the one builtin, and
installed-plugin skills never appear, even inside the plugin's own repo. (The server does load
plugins: their *agents* show up in the agent config option. Just not their skills.) Since a skill
is only a `SKILL.md` with frontmatter, `src/main/skills.ts` reads them directly from repo,
user, and plugin directories and expands an invocation into the prompt — which is what the
agent-side implementation does anyway.

Two rules make that safe. A name the agent advertises always wins, so a local file can never
shadow a real agent command and silently change behaviour. And the transcript shows the short
invocation you typed with a chip recording the skill, its source, and how many characters were
actually sent — the substitution is visible rather than hidden.

**Token accounting is scraped, not pushed.** ACP defines a `usage_update` session notification;
Copilot 1.0.75 never sends one. The numbers exist only in the rendered text of `/context` and
`/usage`, so the client runs those and parses them (`src/shared/contextInfo.ts`). Because that
output is human-facing and GitHub can change it freely, every parser returns null rather than
throwing, and a null degrades to "no meter" instead of a zeroed one — a meter reading 0%
would claim the context is empty when the truth is that we couldn't tell.

Those runs go through `runCommandSilent`, which captures streamed output instead of appending
it to the transcript. Since a silent refresh and a real turn share one agent and one
notification stream, every `session/prompt` is serialized through a queue — overlapping them
would put the refresh's output in your transcript and your turn's output in the capture buffer.

**Attachments really do reach the model.** An embedded `resource` block is honoured even for a
URI that exists nowhere on disk: Copilot materializes it to a temp file and reads it. This is
verified in `attach:check` by attaching a file outside the session's cwd containing a marker
that no tool could otherwise find, and asserting the model reports it back.

**Most of a session's context is spent before you type anything.** Measured on a fresh Copilot
session, via `/context` after one message:

| | System Prompt | System Tools | MCP Tools | Fixed overhead |
| --- | --- | --- | --- | --- |
| Full (default) | 5.8k | 8.1k | 0.9k | **14,739** |
| No MCP | 5.5k | 8.1k | 0 | 13,600 |
| Lean (`bash,view`) | 3.4k | 0.9k | 0 | **4,306** |
| Minimal (`bash`) | 3.5k | 0.6k | 0 | 4,068 |

Tool definitions are re-sent on every request, so this is a per-request cost, not a one-off.
Lean cuts it by **71% — about 10.4k tokens per request**. The system prompt shrinks alongside
the tools because it describes them, so the saving compounds.

This is a real tradeoff, not free money: `bash` alone can do most of what a shell can, but the
agent loses purpose-built editing and search and may burn extra turns reimplementing them. Full
stays the default; the lean profiles are for long sessions where context pressure outweighs
breadth. Because these are spawn flags with no ACP equivalent, the choice is fixed for a
session's lifetime — `restartSession` deliberately carries it over rather than silently
re-inflating to Full.

**Attach structure, not text.** Most questions about a file need its shape, not its
implementation. `src/main/ast/outline.ts` parses TS/JS with the TypeScript compiler — already a
dependency, so no native module or WASM grammar — and emits declarations with bodies stripped.
Measured on this repo:

| file | full | outline | saving |
| --- | --- | --- | --- |
| `renderer/components/Composer.tsx` | 2,449 | 235 | 90% |
| `main/attachments.ts` | 1,849 | 295 | 84% |
| `main/acp/session.ts` | 5,080 | 887 | 83% |
| `main/manager.ts` | 966 | 313 | 68% |
| `shared/ipc.ts` | 1,684 | 1,298 | 23% |
| **total** | **12,028** | **3,028** | **75%** |

(approximate tokens at 4 chars each)

`ipc.ts` saves least because it is nearly all type declarations — those *are* signatures, so
there is nothing to strip. That is the honest shape of the tradeoff, not a defect.

Unlike a grep excerpt, an outline is structurally complete: every declaration is present and
none are half-quoted. Languages the parser doesn't cover fall back to full content and say so on
the chip rather than silently sending something less useful.

**Token size and billing are different things.** Copilot bills premium requests with a
per-model multiplier, not tokens — Haiku 0.33x against Opus 15x is a 45x spread, and it was
already on the wire in `_meta.copilotUsage` while being invisible in the UI. The model picker
now shows it. Tool profiles reduce *context pressure* and latency; the model multiplier is what
moves the bill.

## Verifying

```bash
npm run check              # everything below, in order
npm run smoke              # one real prompt turn, end to end
npm run skills:check [cwd] # skill discovery, precedence, expansion
npm run context:check      # /context and /usage parsers (offline)
npm run attach:check       # attachments reach the model; silent commands stay silent
npm run profile:check      # tool-profile flags reach spawn AND measurably reduce overhead
npm run outline:check      # AST outlines keep structure and drop bodies
npm run embed:check        # the UI runs with no Electron, no agent, no filesystem
npm run guard              # the UI has not re-coupled itself to Electron
```

Spawns the real agent, runs a prompt that forces a tool call, auto-approves the permission
request, and asserts the whole pipeline — handshake, model/config advertisement, streamed
text, tool call reaching `completed`, `end_turn`, and an actual file mutation on disk.

`skills:check` covers the skill pipeline: discovery across all roots, frontmatter parsing,
menu ordering and precedence (including a deliberate agent/skill name clash in both the menu
and the send path), argument capture, and the shape of the expanded prompt.

`context:check` runs offline against captured `/context` and `/usage` fixtures, including the
`<1%` and no-suffix (`426`) cases and four different malformed inputs that must degrade to null.

`attach:check` builds blocks for a text file, a binary, an oversized file, a folder, and a
missing path, then spawns the real agent and asserts it can read a marker that exists only
inside the attachment — plus that a silent `/context` leaves the transcript untouched.

```bash
npm run typecheck
npm run build
npm run dist      # packaged .dmg
```

## Status

Verified end to end against Copilot CLI 1.0.75.

Not yet implemented: session resume via `session/load`, MCP server configuration passthrough
on `session/new`, image/audio attachments in the composer, and a persistent transcript
(sessions live in memory and end with the process).
