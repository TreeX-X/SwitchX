export interface AgentStreamToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface AgentStreamToolResult {
  content: string
  details?: unknown
  isError?: boolean
  terminate?: boolean
}

export interface AgentUsage {
  promptTokens: number
  completionTokens: number
}

export interface NormalizedProviderError {
  code: string
  message: string
  retryable: boolean
  provider?: string
  status?: number
}

export type AgentStreamEvent =
  | { type: 'stream_start'; requestId: string }
  | { type: 'text_delta'; requestId: string; delta: string }
  | { type: 'reasoning_delta'; requestId: string; delta: string }
  | { type: 'tool_call_start'; requestId: string; callId: string; name?: string }
  | { type: 'tool_call_delta'; requestId: string; callId: string; argumentsDelta: string }
  | { type: 'tool_call_ready'; requestId: string; call: AgentStreamToolCall }
  | { type: 'tool_execution_start'; requestId: string; call: AgentStreamToolCall }
  | { type: 'tool_execution_update'; requestId: string; call: AgentStreamToolCall; partialResult: unknown }
  | { type: 'tool_execution_end'; requestId: string; call: AgentStreamToolCall; result: AgentStreamToolResult; isError: boolean }
  | { type: 'finish'; requestId: string; reason: 'stop' | 'tool_calls' | 'length' | 'unknown'; usage?: AgentUsage }
  | { type: 'error'; requestId: string; error: NormalizedProviderError }
  | { type: 'steering_consumed'; requestId: string; keys: string[] }
