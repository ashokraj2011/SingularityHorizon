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
- **Composer** — `/` completes the agent's real advertised slash commands, `@` completes workspace files.
- **Multiple sessions** — each is its own agent process, scoped to its own directory. One crashing doesn't affect the others.

## Architecture

The renderer never touches Node. Everything crosses a typed `contextBridge` surface.

```
renderer (React)  ←IPC→  main process  ←NDJSON/JSON-RPC over stdio→  agent
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

## Verifying

```bash
npm run smoke
```

Spawns the real agent, runs a prompt that forces a tool call, auto-approves the permission
request, and asserts the whole pipeline — handshake, model/config advertisement, streamed
text, tool call reaching `completed`, `end_turn`, and an actual file mutation on disk.

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
