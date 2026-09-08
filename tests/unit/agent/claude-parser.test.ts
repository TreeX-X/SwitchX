import { describe, it, expect, beforeEach } from 'vitest'

describe('ClaudeParser', () => {
  let ClaudeParser: new () => { parseLine(json: Record<string, unknown>): import('../../../src/main/janus-runner/types').AgentEvent[]; reset(): void }

  beforeEach(async () => {
    const mod = await import('../../../src/main/janus-runner/parsers/claude-parser')
    ClaudeParser = mod.ClaudeParser
  })

  // --- text events ---

  describe('text events', () => {
    it('should emit text-chunk on first assistant message', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello' }] },
      })
      expect(events).toEqual([{ type: 'text-chunk', text: 'Hello' }])
    })

    it('should emit text-delta when same message id sends extended text', () => {
      const parser = new ClaudeParser()
      parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello' }] },
      })
      const events = parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello world' }] },
      })
      expect(events).toEqual([{ type: 'text-delta', delta: ' world', fullText: 'Hello world' }])
    })

    it('should concatenate multiple text blocks in content', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({
        type: 'assistant',
        message: {
          id: 'msg1',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      })
      expect(events).toEqual([{ type: 'text-chunk', text: 'Hello world' }])
    })

    it('should not emit text event when text is empty', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [] },
      })
      expect(events).toEqual([])
    })

    it('should not emit text-delta when text has not changed', () => {
      const parser = new ClaudeParser()
      parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello' }] },
      })
      const events = parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello' }] },
      })
      expect(events).toEqual([])
    })
  })

  // --- tool events ---

  describe('tool events', () => {
    it.each([
      ['Read', { file_path: '/foo.ts' }, '/foo.ts'],
      ['Bash', { command: 'ls -la' }, 'ls -la'],
      ['Grep', { pattern: 'foo.*bar' }, 'foo.*bar'],
    ] as const)('should emit tool-start for %s with extracted arg', (name, input, arg) => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({
        type: 'assistant',
        message: {
          id: 'msg1',
          content: [{ type: 'tool_use', id: 'tool1', name, input }],
        },
      })
      expect(events).toEqual([
        { type: 'tool-start', id: 'tool1', name, arg },
      ])
    })

    it('should deduplicate tool-start for same tool id', () => {
      const parser = new ClaudeParser()
      const input = {
        type: 'assistant',
        message: {
          id: 'msg1',
          content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/foo.ts' } }],
        },
      }
      parser.parseLine(input)
      const events = parser.parseLine(input)
      // tool-start should not appear again; only text events if any
      expect(events.filter((e) => e.type === 'tool-start')).toEqual([])
    })

    it('should emit tool-end for tool_result in user message', () => {
      const parser = new ClaudeParser()
      // First, start the tool
      parser.parseLine({
        type: 'assistant',
        message: {
          id: 'msg1',
          content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/foo.ts' } }],
        },
      })
      // Then, end it
      const events = parser.parseLine({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool1' }] },
      })
      expect(events).toEqual([{ type: 'tool-end', id: 'tool1' }])
    })

    it('should not emit tool-end for unknown tool_use_id', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] },
      })
      expect(events).toEqual([])
    })

    it('should emit both text-chunk and tool-start for mixed content', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({
        type: 'assistant',
        message: {
          id: 'msg1',
          content: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/foo.ts' } },
          ],
        },
      })
      expect(events).toEqual([
        { type: 'text-chunk', text: 'Let me read that file.' },
        { type: 'tool-start', id: 'tool1', name: 'Read', arg: '/foo.ts' },
      ])
    })
  })

  // --- result events ---

  describe('result events', () => {
    it('should emit done event for successful result', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({ type: 'result', is_error: false, result: 'done' })
      expect(events).toEqual([{ type: 'done', exitCode: 0 }])
    })

    it('should emit error event for failed result', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({ type: 'result', is_error: true, result: 'something went wrong' })
      expect(events).toEqual([{ type: 'error', message: 'something went wrong' }])
    })

    it('should emit error event with empty string when result is missing', () => {
      const parser = new ClaudeParser()
      const events = parser.parseLine({ type: 'result', is_error: true })
      expect(events).toEqual([{ type: 'error', message: '' }])
    })
  })

  // --- unknown types ---

  describe('unknown types', () => {
    it('should return empty array for unknown type', () => {
      const parser = new ClaudeParser()
      expect(parser.parseLine({ type: 'system', foo: 'bar' })).toEqual([])
    })

    it('should return empty array when type is missing', () => {
      const parser = new ClaudeParser()
      expect(parser.parseLine({ foo: 'bar' })).toEqual([])
    })
  })

  // --- reset ---

  describe('reset', () => {
    it('should clear state so next message emits text-chunk instead of text-delta', () => {
      const parser = new ClaudeParser()
      parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello' }] },
      })
      parser.reset()
      const events = parser.parseLine({
        type: 'assistant',
        message: { id: 'msg1', content: [{ type: 'text', text: 'Hello world' }] },
      })
      // After reset, same id is treated as new → text-chunk
      expect(events).toEqual([{ type: 'text-chunk', text: 'Hello world' }])
    })

    it('should clear startedTools so tool-start can fire again', () => {
      const parser = new ClaudeParser()
      parser.parseLine({
        type: 'assistant',
        message: {
          id: 'msg1',
          content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/foo.ts' } }],
        },
      })
      parser.reset()
      const events = parser.parseLine({
        type: 'assistant',
        message: {
          id: 'msg2',
          content: [
            { type: 'text', text: 'again' },
            { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: '/bar.ts' } },
          ],
        },
      })
      expect(events).toEqual([
        { type: 'text-chunk', text: 'again' },
        { type: 'tool-start', id: 'tool1', name: 'Read', arg: '/bar.ts' },
      ])
    })
  })
})
