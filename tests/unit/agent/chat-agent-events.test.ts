import { describe, expect, it } from 'vitest'
import { toChatAgentEvent } from '@janus-agent/chat-core'
import { EMPTY_JANUS_RUNTIME_STATE, reduceChatAgentEvent, reduceJanusRuntimeState } from '../../../src/renderer/src/components/janus/janusRuntimeState'

describe('Chat Agent events', () => {
  it('redacts argument values before a tool call reaches Chat IPC', () => {
    const event = toChatAgentEvent({
      type: 'tool_call_ready',
      requestId: 'request-1',
      call: {
        id: 'call-1',
        name: 'workspace_read',
        arguments: { path: 'src/secret.ts', apiKey: 'super-secret-value' },
      },
    })

    expect(event).toEqual({
      type: 'tool_call_ready',
      requestId: 'request-1',
      callId: 'call-1',
      toolName: 'workspace_read',
      argumentKeys: ['path', 'redacted'],
    })
    expect(JSON.stringify(event)).not.toContain('super-secret-value')
    expect(JSON.stringify(event)).not.toContain('src/secret.ts')
  })

  it('keeps one tool card through construction and Runtime execution', () => {
    let state = reduceChatAgentEvent(EMPTY_JANUS_RUNTIME_STATE, {
      type: 'tool_call_start', requestId: 'request-1', callId: 'call-1', toolName: 'workspace_read',
    })
    state = reduceChatAgentEvent(state, {
      type: 'tool_call_delta', requestId: 'request-1', callId: 'call-1', argumentDeltaLength: 12,
    })
    state = reduceChatAgentEvent(state, {
      type: 'tool_call_ready', requestId: 'request-1', callId: 'call-1', toolName: 'workspace_read', argumentKeys: ['path'],
    })
    state = reduceJanusRuntimeState(state, {
      type: 'tool-started', sessionId: 'session-1', correlationId: 'call-1', toolName: 'workspace_read', startedAt: '2026-08-27T00:00:00.000Z',
    })

    expect(state.activities).toEqual([{
      correlationId: 'call-1',
      toolName: 'workspace_read',
      status: 'running',
      summary: 'Input keys: path',
      argsDigest: 'path',
      argumentChars: 12,
    }])
  })
})
