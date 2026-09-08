import { describe, it, expect, beforeEach } from 'vitest'

describe('OpenCodeParser', () => {
  let OpenCodeParser: new () => { parseLine(json: Record<string, unknown>): import('../../../src/main/janus-runner/types').AgentEvent[]; reset(): void }

  beforeEach(async () => {
    const mod = await import('../../../src/main/janus-runner/parsers/opencode-parser')
    OpenCodeParser = mod.OpenCodeParser
  })

  // --- text events ---

  describe('text events', () => {
    it('should emit text-delta for first text event', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({ type: 'text', text: 'Hello' })
      expect(events).toEqual([{ type: 'text-delta', delta: 'Hello', fullText: 'Hello' }])
    })

    it('should emit text-delta with correct delta on subsequent text', () => {
      const parser = new OpenCodeParser()
      parser.parseLine({ type: 'text', text: 'Hello' })
      const events = parser.parseLine({ type: 'text', text: 'Hello world' })
      expect(events).toEqual([{ type: 'text-delta', delta: ' world', fullText: 'Hello world' }])
    })

    it('should not emit event when text is unchanged', () => {
      const parser = new OpenCodeParser()
      parser.parseLine({ type: 'text', text: 'Hello' })
      const events = parser.parseLine({ type: 'text', text: 'Hello' })
      expect(events).toEqual([])
    })

    it('should not emit event when text is missing', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({ type: 'text' })
      expect(events).toEqual([])
    })

    it('should compute delta from lastText across multiple updates', () => {
      const parser = new OpenCodeParser()
      parser.parseLine({ type: 'text', text: 'A' })
      parser.parseLine({ type: 'text', text: 'AB' })
      const events = parser.parseLine({ type: 'text', text: 'ABC' })
      expect(events).toEqual([{ type: 'text-delta', delta: 'C', fullText: 'ABC' }])
    })
  })

  // --- tool events ---

  describe('tool events', () => {
    it.each([
      ['running', 'read', 'Read'],
      ['started', 'bash', 'Bash'],
    ] as const)('should emit tool-start for tool_use with state=%s', (state, tool, expectedName) => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        tool,
        state,
      })
      expect(events).toEqual([
        { type: 'tool-start', id: 't1', name: expectedName, arg: '', filePath: undefined },
      ])
    })

    it('should map lowercase tool names to capitalized', () => {
      const parser = new OpenCodeParser()
      const mappings = [
        ['read', 'Read'],
        ['bash', 'Bash'],
        ['edit', 'Edit'],
        ['write', 'Write'],
        ['grep', 'Grep'],
        ['glob', 'Glob'],
        ['list', 'List'],
      ]
      for (const [input, expected] of mappings) {
        const fresh = new OpenCodeParser()
        const events = fresh.parseLine({
          type: 'tool_use',
          tool_id: `t-${input}`,
          tool: input,
          state: 'running',
        })
        expect(events[0]).toMatchObject({ name: expected })
      }
    })

    it('should keep original name when not in mapping', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        tool: 'custom_tool',
        state: 'running',
      })
      expect(events[0]).toMatchObject({ name: 'custom_tool' })
    })

    it('should use id field as fallback when tool_id is missing', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({
        type: 'tool_use',
        id: 'fallback-id',
        tool: 'read',
        state: 'running',
      })
      expect(events[0]).toMatchObject({ id: 'fallback-id' })
    })

    it('should use name field as fallback when tool is missing', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        name: 'read',
        state: 'running',
      })
      expect(events[0]).toMatchObject({ name: 'Read' })
    })

    it('should emit tool-end for tool_use with state=completed', () => {
      const parser = new OpenCodeParser()
      // First start the tool
      parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        tool: 'read',
        state: 'running',
      })
      // Then complete it
      const events = parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        tool: 'read',
        state: 'completed',
      })
      expect(events).toEqual([{ type: 'tool-end', id: 't1' }])
    })

    it('should not emit tool-end for unknown tool_id', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({
        type: 'tool_use',
        tool_id: 'unknown',
        tool: 'read',
        state: 'completed',
      })
      expect(events).toEqual([])
    })

    it('should deduplicate tool-start for same tool_id', () => {
      const parser = new OpenCodeParser()
      const input = {
        type: 'tool_use',
        tool_id: 't1',
        tool: 'read',
        state: 'running',
      }
      parser.parseLine(input)
      const events = parser.parseLine(input)
      expect(events.filter((e) => e.type === 'tool-start')).toEqual([])
    })
  })

  // --- error events ---

  describe('error events', () => {
    it('should emit error event with message', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({ type: 'error', message: 'something failed' })
      expect(events).toEqual([{ type: 'error', message: 'something failed' }])
    })

    it('should emit error with empty string when message is missing', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({ type: 'error' })
      expect(events).toEqual([{ type: 'error', message: '' }])
    })
  })

  // --- done events ---

  describe('done events', () => {
    it('should emit done event for done type', () => {
      const parser = new OpenCodeParser()
      const events = parser.parseLine({ type: 'done' })
      expect(events).toEqual([{ type: 'done', exitCode: 0 }])
    })
  })

  // --- unknown types ---

  describe('unknown types', () => {
    it('should return empty array for unknown type', () => {
      const parser = new OpenCodeParser()
      expect(parser.parseLine({ type: 'status', status: 'idle' })).toEqual([])
    })

    it('should return empty array when type is missing', () => {
      const parser = new OpenCodeParser()
      expect(parser.parseLine({ foo: 'bar' })).toEqual([])
    })
  })

  // --- reset ---

  describe('reset', () => {
    it('should clear lastText so next text emits full delta', () => {
      const parser = new OpenCodeParser()
      parser.parseLine({ type: 'text', text: 'Hello' })
      parser.reset()
      const events = parser.parseLine({ type: 'text', text: 'Hello world' })
      expect(events).toEqual([{ type: 'text-delta', delta: 'Hello world', fullText: 'Hello world' }])
    })

    it('should clear startedTools so tool-start can fire again', () => {
      const parser = new OpenCodeParser()
      parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        tool: 'read',
        state: 'running',
      })
      parser.reset()
      const events = parser.parseLine({
        type: 'tool_use',
        tool_id: 't1',
        tool: 'read',
        state: 'running',
      })
      expect(events).toEqual([
        { type: 'tool-start', id: 't1', name: 'Read', arg: '', filePath: undefined },
      ])
    })
  })
})
