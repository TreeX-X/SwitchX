import type { JanusAgentEvent } from '../loop/janus-agent-loop'
import type { AgentStreamEvent } from './types'

/** Maps lifecycle events that have a direct equivalent in the provider-neutral stream contract. */
export function toAgentStreamEvent(requestId: string, event: JanusAgentEvent): AgentStreamEvent | undefined {
  switch (event.type) {
    case 'agent_start':
      return { type: 'stream_start', requestId }
    case 'message_update':
      return { type: 'text_delta', requestId, delta: event.delta }
    case 'reasoning_update':
      return { type: 'reasoning_delta', requestId, delta: event.delta }
    case 'tool_call_start':
      return { type: 'tool_call_start', requestId, callId: event.callId, name: event.name }
    case 'tool_call_update':
      return {
        type: 'tool_call_delta',
        requestId,
        callId: event.callId,
        argumentsDelta: event.argumentsDelta,
      }
    case 'tool_call_ready':
      return { type: 'tool_call_ready', requestId, call: event.call }
    case 'model_finish':
      return { type: 'finish', requestId, reason: event.reason, usage: event.usage }
    case 'model_error':
      return { type: 'error', requestId, error: event.error }
    case 'steering_consumed':
      return { type: 'steering_consumed', requestId, keys: event.keys }
    case 'tool_execution_start':
      return { type: 'tool_execution_start', requestId, call: event.call }
    case 'tool_execution_update':
      return { type: 'tool_execution_update', requestId, call: event.call, partialResult: event.partialResult }
    case 'tool_execution_end':
      return { type: 'tool_execution_end', requestId, call: event.call, result: event.result, isError: event.isError }
    default:
      return undefined
  }
}
