import { describe, expect, it, vi } from 'vitest'
import { AgentSteeringPort, runJanusAgentLoop, type JanusAgentEvent, type JanusAgentMessage, type JanusAgentTool } from '../../../src/main/janus-agent/loop/janus-agent-loop'

const userMessage: JanusAgentMessage = { role: 'user', content: 'start' }

describe('JanusAgentLoop', () => {
  it('runs tool calls, emits lifecycle events, and finishes on a plain response', async () => {
    const events: string[] = []
    let calls = 0
    const tool: JanusAgentTool = {
      name: 'workspace.read',
      execute: async () => ({ content: 'file contents' }),
    }
    const messages = await runJanusAgentLoop([userMessage], {
      tools: [tool],
      stream: async (context) => {
        calls += 1
        if (calls === 1) {
          expect(context.at(-1)?.role).toBe('user')
          return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: '1', name: tool.name, arguments: { path: 'a.ts' } }] }
        }
        expect(context.at(-1)?.role).toBe('tool')
        return { message: { role: 'assistant', content: 'done' } }
      },
      onEvent: (event) => events.push(event.type),
    })
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
    expect(events).toEqual(expect.arrayContaining(['agent_start', 'tool_execution_start', 'tool_execution_end', 'turn_end', 'agent_end']))
  })

  it('lets hooks block calls and replace results without knowing policy details', async () => {
    const after = vi.fn(async () => ({ content: 'redacted', isError: false }))
    const messages = await runJanusAgentLoop([userMessage], {
      tools: [{ name: 'workspace.edit', execute: async () => ({ content: 'should not run' }) }],
      stream: async () => ({ message: { role: 'assistant', content: '' }, toolCalls: [{ id: '1', name: 'workspace.edit', arguments: {} }] }),
      beforeToolCall: async () => ({ block: true, reason: 'approval required' }),
      afterToolCall: after,
      maxTurns: 1,
    })
    expect(after).not.toHaveBeenCalled()
    expect(messages.at(-1)).toMatchObject({ role: 'tool', content: 'approval required' })
  })

  it('continues on mixed terminate batches and stops only when every result terminates', async () => {
    const tools: JanusAgentTool[] = [
      { name: 'a', execute: async () => ({ content: 'a', terminate: true }) },
      { name: 'b', execute: async () => ({ content: 'b' }) },
    ]
    let turn = 0
    const messages = await runJanusAgentLoop([userMessage], {
      tools,
      maxTurns: 3,
      stream: async () => {
        turn += 1
        return turn === 1
          ? { message: { role: 'assistant', content: '' }, toolCalls: tools.map((tool) => ({ id: tool.name, name: tool.name, arguments: {} })) }
          : { message: { role: 'assistant', content: 'done' } }
      },
    })
    // Mixed batch (a terminates, b does not) must continue to turn 2.
    expect(turn).toBe(2)
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
  })

  it('stops gracefully via shouldStopAfterTurn before the next LLM call', async () => {
    let calls = 0
    const messages = await runJanusAgentLoop([userMessage], {
      tools: [{ name: 'a', execute: async () => ({ content: 'a' }) }],
      maxTurns: 5,
      stream: async () => {
        calls += 1
        return calls === 1
          ? { message: { role: 'assistant', content: '' }, toolCalls: [{ id: '1', name: 'a', arguments: {} }] }
          : { message: { role: 'assistant', content: 'done' } }
      },
      shouldStopAfterTurn: async () => true,
    })
    expect(calls).toBe(1)
    expect(messages.some((message) => message.content === 'done')).toBe(false)
  })

  it('executes parallel tools together and preserves steering messages', async () => {
    const order: string[] = []
    const tools = ['a', 'b'].map((name): JanusAgentTool => ({
      name,
      executionMode: 'parallel',
      execute: async () => {
        order.push(name)
        return { content: name }
      },
    }))
    let turn = 0
    const messages = await runJanusAgentLoop([userMessage], {
      tools,
      maxTurns: 2,
      stream: async () => {
        turn += 1
        return turn === 1
          ? { message: { role: 'assistant', content: '' }, toolCalls: tools.map((tool) => ({ id: tool.name, name: tool.name, arguments: {} })) }
          : { message: { role: 'assistant', content: 'done' } }
      },
      getSteeringMessages: async () => [{ role: 'user', content: 'continue' }],
    })
    expect(order).toHaveLength(2)
    expect(messages.some((message) => message.content === 'continue')).toBe(true)
  })

  it('R6-full: preempts an in-flight stream, keeps partial text, and strips partial tool calls', async () => {
    const port = new AgentSteeringPort()
    const executed: string[] = []
    const events: JanusAgentEvent[] = []
    let calls = 0
    const messages = await runJanusAgentLoop([userMessage], {
      tools: [{ name: 'a', execute: async () => { executed.push('a'); return { content: 'a' } } }],
      maxTurns: 3,
      steeringPort: port,
      stream: async (_context, signal) => {
        calls += 1
        if (calls === 1) {
          // 生产者驱动打断：push 即 abort 本轮 attempt，mock 感知 signal 后返回半截结果。
          port.push('s1', { role: 'user', content: 'steer now' })
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
          expect(signal.aborted).toBe(true)
          return { message: { role: 'assistant', content: 'partial' }, toolCalls: [{ id: 'c1', name: 'a', arguments: {} }] }
        }
        return { message: { role: 'assistant', content: 'done' } }
      },
      onEvent: (event) => events.push(event),
    })
    expect(calls).toBe(2)
    // 半截正文保留但剥离 toolCalls（配对约束），steering 注入，工具永不执行。
    const partial = messages.find((message) => message.content === 'partial')
    expect(partial?.role).toBe('assistant')
    expect('toolCalls' in (partial ?? {})).toBe(false)
    expect(messages.some((message) => message.content === 'steer now')).toBe(true)
    expect(executed).toHaveLength(0)
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
    const consumed = events.filter((event) => event.type === 'steering_consumed')
    expect(consumed).toEqual([{ type: 'steering_consumed', keys: ['s1'] }])
  })

  it('R6-full: applies steering between sequential tools and skips unexecuted calls', async () => {
    const port = new AgentSteeringPort()
    const executed: string[] = []
    const events: JanusAgentEvent[] = []
    let turn = 0
    const messages = await runJanusAgentLoop([userMessage], {
      tools: ['a', 'b'].map((name): JanusAgentTool => ({
        name,
        execute: async () => { executed.push(name); return { content: `${name}-result` } },
      })),
      maxTurns: 3,
      steeringPort: port,
      afterToolCall: async ({ call }) => {
        if (call.name === 'a') port.push('s1', { role: 'user', content: 'steer after a' })
        return undefined
      },
      stream: async () => {
        turn += 1
        return turn === 1
          ? {
              message: { role: 'assistant', content: '' },
              toolCalls: [{ id: 'a', name: 'a', arguments: {} }, { id: 'b', name: 'b', arguments: {} }],
            }
          : { message: { role: 'assistant', content: 'done' } }
      },
      onEvent: (event) => events.push(event),
    })
    // a 已完成结果保留，b 永不执行，steering 紧跟 a 结果之后。
    expect(executed).toEqual(['a'])
    const contents = messages.map((message) => message.content)
    expect(contents).toContain('a-result')
    expect(contents).toContain('steer after a')
    expect(contents.indexOf('steer after a')).toBeGreaterThan(contents.indexOf('a-result'))
    expect(events.some((event) => event.type === 'steering_consumed')).toBe(true)
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'done' })
  })

  it('R6-full: steering port supports cancel-before-consume with exactly-once take', () => {
    const port = new AgentSteeringPort()
    expect(port.size).toBe(0)
    port.push('k1', { role: 'user', content: 'one' })
    port.push('k2', { role: 'user', content: 'two' })
    expect(port.size).toBe(2)
    expect(port.remove('missing')).toBe(false)
    expect(port.remove('k1')).toBe(true)
    expect(port.size).toBe(1)
    const taken = port.take()
    expect(taken.map((entry) => entry.key)).toEqual(['k2'])
    expect(port.size).toBe(0)
    expect(port.take()).toEqual([])
  })
})
