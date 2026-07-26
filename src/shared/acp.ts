/**
 * Agent Client Protocol (ACP) types.
 *
 * These follow the published schema at https://agentclientprotocol.com, narrowed
 * to the subset GitHub Copilot CLI 1.0.x actually emits (verified by probing
 * `copilot --acp --stdio` directly). Unknown fields are tolerated everywhere —
 * the protocol is explicitly versioned and in preview, so we never assume a
 * closed set.
 */

export const ACP_PROTOCOL_VERSION = 1

/* ---------------------------------------------------------------- content */

export interface Annotations {
  audience?: string[]
  priority?: number
}

export type ContentBlock =
  | { type: 'text'; text: string; annotations?: Annotations }
  | { type: 'image'; data: string; mimeType: string; uri?: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; title?: string; mimeType?: string }
  | {
      type: 'resource'
      resource:
        | { uri: string; mimeType?: string; text: string }
        | { uri: string; mimeType?: string; blob: string }
    }

/* ------------------------------------------------------------ tool calls */

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/**
 * Copilot emits `execute` for shell work; the wider ACP spec also defines
 * read/edit/delete/move/search/think/fetch/other. Kept open as a string union
 * with a fallback so a new kind renders instead of crashing.
 */
export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | (string & {})

export interface ToolCallLocation {
  path: string
  line?: number | null
}

export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export interface ToolCall {
  toolCallId: string
  title?: string | null
  kind?: ToolCallKind
  status?: ToolCallStatus
  content?: ToolCallContent[]
  locations?: ToolCallLocation[] | null
  rawInput?: Record<string, unknown> | null
  rawOutput?: Record<string, unknown> | null
}

/* ----------------------------------------------------------------- plans */

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed'
export type PlanEntryPriority = 'high' | 'medium' | 'low'

export interface PlanEntry {
  content: string
  status: PlanEntryStatus
  priority?: PlanEntryPriority
}

/* -------------------------------------------------------- config + modes */

export interface SessionMode {
  id: string
  name: string
  description?: string
}

export interface SessionModeState {
  availableModes: SessionMode[]
  currentModeId: string
}

export interface ConfigOptionChoice {
  value: string
  name: string
  description?: string
  _meta?: Record<string, unknown>
}

export interface SessionConfigOption {
  type: 'select' | (string & {})
  id: string
  name: string
  description?: string
  category?: string
  currentValue?: string
  options?: ConfigOptionChoice[]
}

export interface AvailableCommand {
  name: string
  description?: string
  input?: { hint?: string } | null
}

export interface ModelInfo {
  modelId: string
  name: string
  description?: string
  _meta?: Record<string, unknown>
}

/* -------------------------------------------------------- session update */

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock; messageId?: string }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock; messageId?: string }
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCall)
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'usage_update'; usage?: TokenUsage }
  | { sessionUpdate: string; [k: string]: unknown }

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
  contextWindow?: number
  costUsd?: number
}

export interface SessionNotification {
  sessionId: string
  update: SessionUpdate
}

/* ---------------------------------------------------------- initialize */

export interface AuthMethod {
  id: string
  name: string
  description?: string
  _meta?: Record<string, unknown>
}

export interface InitializeResponse {
  protocolVersion: number
  agentCapabilities?: {
    loadSession?: boolean
    mcpCapabilities?: { http?: boolean; sse?: boolean }
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: Record<string, unknown>
  }
  agentInfo?: { name: string; title?: string; version?: string }
  authMethods?: AuthMethod[]
}

export interface NewSessionResponse {
  sessionId: string
  models?: { availableModels: ModelInfo[]; currentModelId?: string }
  modes?: SessionModeState
  configOptions?: SessionConfigOption[]
}

/* -------------------------------------------------------- permissions */

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | (string & {})

export interface PermissionOption {
  optionId: string
  name: string
  kind?: PermissionOptionKind
}

export interface RequestPermissionRequest {
  sessionId: string
  toolCall: ToolCall
  options: PermissionOption[]
}

export type RequestPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }

/* ------------------------------------------------------------- prompting */

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | (string & {})

export interface PromptResponse {
  stopReason: StopReason
}
