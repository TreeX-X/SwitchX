import { describe, expect, it } from 'vitest'
import { toAgentStreamEvent } from '../../../src/main/janus-agent/stream/event-mapper'
import { ToolCallAccumulator } from '../../../src/main/janus-agent/stream/tool-call-accumulator'

describe('ToolCallAccumulator', () => {
  it('emits one ready call after collecting fragmented JSON arguments', () => {
    const accumulator = new ToolCallAccumulator()

    expect(accumulator.start('call-1', 'read_file')).toBe(true)
    expect(accumulator.append('call-1', '{"path":"src/')).toBe(true)
    expect(accumulator.append('call-1', 'index.ts"}')).toBe(true)
    expect(accumulator.complete({ callId: 'call-1' })).toEqual({
      status: 'ready',
      call: { id: 'call-1', name: 'read_file', arguments: { path: 'src/index.ts' } },
    })
    expect(accumulator.complete({ callId: 'call-1' })).toEqual({ status: 'duplicate' })
  })

  it('keeps concurrent calls isolated', () => {
    const accumulator = new ToolCallAccumulator()

    accumulator.append('call-a', '{"path":"a.ts"}', 'read_file')
    accumulator.append('call-b', '{"query":"TODO"}', 'search_files')

    expect(accumulator.complete({ callId: 'call-b' })).toMatchObject({
      status: 'ready',
      call: { id: 'call-b', name: 'search_files', arguments: { query: 'TODO' } },
    })
    expect(accumulator.complete({ callId: 'call-a' })).toMatchObject({
      status: 'ready',
      call: { id: 'call-a', name: 'read_file', arguments: { path: 'a.ts' } },
    })
  })

  it('accepts a complete provider argument object without prior deltas', () => {
    const accumulator = new ToolCallAccumulator()

    expect(accumulator.complete({
      callId: 'call-1',
      name: 'read_file',
      arguments: { path: 'src/index.ts', startLine: 1, endLine: 20 },
    })).toEqual({
      status: 'ready',
      call: {
        id: 'call-1',
        name: 'read_file',
        arguments: { path: 'src/index.ts', startLine: 1, endLine: 20 },
      },
    })
  })

  it('rejects malformed or disallowed tool calls before they become ready', () => {
    const accumulator = new ToolCallAccumulator({
      validate: (call) => call.name === 'read_file' && typeof call.arguments === 'object'
        ? undefined
        : 'Unknown tool or invalid arguments',
    })

    accumulator.append('bad-json', '{"path":', 'read_file')
    expect(accumulator.complete({ callId: 'bad-json' })).toEqual({
      status: 'invalid',
      error: 'Tool call arguments are not valid JSON',
    })

    expect(accumulator.complete({ callId: 'unknown', name: 'shell', arguments: {} })).toEqual({
      status: 'invalid',
      error: 'Unknown tool or invalid arguments',
    })
  })

  it('does not revive a tool call after cancellation', () => {
    const accumulator = new ToolCallAccumulator()
    accumulator.append('call-1', '{"path":"a.ts"}', 'read_file')
    accumulator.abort('call-1')

    expect(accumulator.complete({ callId: 'call-1' })).toEqual({ status: 'aborted' })
    expect(accumulator.pendingCount).toBe(0)
  })
})

describe('toAgentStreamEvent', () => {
  it('adds request identity to directly mappable loop events', () => {
    expect(toAgentStreamEvent('request-1', { type: 'message_update', delta: 'working' })).toEqual({
      type: 'text_delta', requestId: 'request-1', delta: 'working',
    })
    expect(toAgentStreamEvent('request-1', {
      type: 'tool_execution_start',
      call: { id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } },
    })).toEqual({
      type: 'tool_execution_start',
      requestId: 'request-1',
      call: { id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } },
    })
    expect(toAgentStreamEvent('request-1', { type: 'agent_end', messages: [] })).toBeUndefined()
  })
})
