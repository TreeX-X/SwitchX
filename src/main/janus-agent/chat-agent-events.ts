import type { AgentStreamEvent } from './stream'
import type { ChatAgentEvent } from '../../shared/ipc/llm'

const SENSITIVE_ARGUMENT_KEY = /authorization|password|secret|token|api[-_]?key/i
const MAX_ARGUMENT_KEYS = 8

function safeArgumentKeys(argumentsValue: unknown): string[] {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return []
  return Object.keys(argumentsValue as Record<string, unknown>)
    .slice(0, MAX_ARGUMENT_KEYS)
    .map((key) => SENSITIVE_ARGUMENT_KEY.test(key) ? 'redacted' : key)
}

/** Converts internal Agent events into the redacted IPC contract consumed by Chat. */
export function toChatAgentEvent(event: AgentStreamEvent): ChatAgentEvent {
  switch (event.type) {
    case 'stream_start':
      return { type: 'agent_start', requestId: event.requestId }
    case 'text_delta':
      return { type: 'text_delta', requestId: event.requestId, delta: event.delta }
    case 'reasoning_delta':
      return { type: 'reasoning_delta', requestId: event.requestId, delta: event.delta }
    case 'tool_call_start':
      return { type: 'tool_call_start', requestId: event.requestId, callId: event.callId, toolName: event.name }
    case 'tool_call_delta':
      return {
        type: 'tool_call_delta',
        requestId: event.requestId,
        callId: event.callId,
        argumentDeltaLength: event.argumentsDelta.length,
      }
    case 'tool_call_ready':
      return {
        type: 'tool_call_ready',
        requestId: event.requestId,
        callId: event.call.id,
        toolName: event.call.name,
        argumentKeys: safeArgumentKeys(event.call.arguments),
      }
    case 'tool_execution_start':
      return { type: 'tool_execution_start', requestId: event.requestId, callId: event.call.id, toolName: event.call.name }
    case 'tool_execution_update':
      return { type: 'tool_execution_update', requestId: event.requestId, callId: event.call.id, toolName: event.call.name }
    case 'tool_execution_end':
      return {
        type: 'tool_execution_end',
        requestId: event.requestId,
        callId: event.call.id,
        toolName: event.call.name,
        status: event.isError ? 'failed' : 'completed',
      }
    case 'finish':
      return { type: 'model_finish', requestId: event.requestId, reason: event.reason }
    case 'error':
      return { type: 'model_error', requestId: event.requestId, code: event.error.code, retryable: event.error.retryable }
    case 'steering_consumed':
      return { type: 'steering_consumed', requestId: event.requestId, keys: event.keys }
  }
}
