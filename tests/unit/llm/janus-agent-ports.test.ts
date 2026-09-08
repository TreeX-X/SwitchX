/**
 * Twin tests for the JanusX shell ports adapter (M3 separation).
 * @description Each case mirrors a pre-separation behavior of
 * `main/llm/chat-orchestrator.handleChatStream`: same errors, same payloads,
 * same fan-out routing. Any intentional deviation must update the case name
 * with the reason. No Electron/singleton imports — all deps are injected.
 */
import { describe, expect, it, vi } from 'vitest'
import { runChatTurn } from '@janus-agent/janus-agent'
import type { KnowledgeContextResult } from '@janus-agent/chat-core'
import {
  buildJanusChatTurnPorts,
  type JanusChatTurnPortsDeps,
} from '../../../src/main/llm/janus-agent-ports'

function baseDeps(overrides: Partial<JanusChatTurnPortsDeps> = {}): JanusChatTurnPortsDeps {
  return {
    callerId: 'renderer:1',
    getProviderSettings: async () => ({ modelId: 'm1' }),
    getLanguageModel: async () => ({ fake: 'model' }),
    listModels: async () => [],
    getMaxTurns: async () => 40,
    getAgentSession: () => null,
    executeFunctionCall: async () => {
      throw new Error('unexpected tool call')
    },
    listRegistryTools: () => [],
    listRegistryManifests: () => undefined,
    knowledgeSearch: async () => {
      throw new Error('unexpected knowledge search')
    },
    captureObservation: async () => ({ workspaceId: 'ws1' }),
    scheduleSettled: () => undefined,
    streamTextFn: (async () => ({
      textStream: (async function* () {})(),
    })) as JanusChatTurnPortsDeps['streamTextFn'],
    ...overrides,
  }
}

describe('model port', () => {
  it('resolves provider settings + language model + catalog flags', async () => {
    const ports = buildJanusChatTurnPorts(baseDeps({
      listModels: async () => [
        { id: 'm1', supportsFunctionCalling: true, contextWindow: 100_000, maxOutputTokens: 8_000 },
      ],
    }))
    const endpoint = await ports.model.resolve('p1')
    expect(endpoint.modelId).toBe('m1')
    expect(endpoint.model).toEqual({ fake: 'model' })
    expect(endpoint.supportsFunctionCalling).toBe(true)
    expect(endpoint.contextWindow).toBe(100_000)
    expect(endpoint.maxOutputTokens).toBe(8_000)
    expect(await ports.model.getMaxTurns()).toBe(40)
  })

  it('throws the pre-separation messages for missing provider/model', async () => {
    const noProvider = buildJanusChatTurnPorts(baseDeps({ getProviderSettings: async () => null }))
    await expect(noProvider.model.resolve('missing')).rejects.toThrow('Provider "missing" 未配置')
    const noModel = buildJanusChatTurnPorts(baseDeps({ getProviderSettings: async () => ({}) }))
    await expect(noModel.model.resolve('p1')).rejects.toThrow('No model ID configured')
  })

  it('passes an explicit function-calling=false through to the gate', async () => {
    const ports = buildJanusChatTurnPorts(baseDeps({
      listModels: async () => [{ id: 'm1', supportsFunctionCalling: false }],
    }))
    const endpoint = await ports.model.resolve('p1', 'm1')
    expect(endpoint.supportsFunctionCalling).toBe(false)
  })

  it('tolerates a failing model catalog like the inline version', async () => {
    const ports = buildJanusChatTurnPorts(baseDeps({
      listModels: async () => {
        throw new Error('catalog down')
      },
    }))
    const endpoint = await ports.model.resolve('p1')
    expect(endpoint.modelId).toBe('m1')
    expect(endpoint.supportsFunctionCalling).toBeUndefined()
  })

  it('skips the gate when the host has no catalog at all', async () => {
    const deps = baseDeps()
    delete deps.listModels
    const ports = buildJanusChatTurnPorts(deps)
    const endpoint = await ports.model.resolve('p1')
    expect(endpoint.modelId).toBe('m1')
    expect(endpoint.supportsFunctionCalling).toBeUndefined()
  })
})

describe('sessions port', () => {
  it('maps a running runtime session to a descriptor', () => {
    const ports = buildJanusChatTurnPorts(baseDeps({
      getAgentSession: (id) => id === 'sess-1' ? {
        id: 'sess-1',
        status: 'running',
        workspace: { workspaceId: 'ws1', workspaceRoot: 'C:/ws' },
      } : null,
    }))
    expect(ports.sessions.getSession('sess-1')).toEqual({
      sessionId: 'sess-1',
      workspaceId: 'ws1',
      workspaceRoot: 'C:/ws',
      status: 'running',
    })
    expect(ports.sessions.getSession('unknown')).toBeNull()
  })

  it('rejects unavailable sessions before any model call (parity)', async () => {
    const streamTextFn = vi.fn()
    const ports = buildJanusChatTurnPorts(baseDeps({
      getAgentSession: () => ({
        id: 'sess-9',
        status: 'stopped',
        workspace: { workspaceId: 'ws1', workspaceRoot: 'C:/ws' },
      }),
      streamTextFn: streamTextFn as JanusChatTurnPortsDeps['streamTextFn'],
    }))
    await expect(runChatTurn(
      {
        requestId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        providerId: 'p1',
        sourceTag: 'janus-chat',
        workspaceResources: [{ workspaceId: 'ws1', agentSessionId: 'sess-9', workspaceName: 'w' }],
      },
      ports,
    )).rejects.toThrow('Attached workspace session is unavailable: ws1')
    expect(streamTextFn).not.toHaveBeenCalled()
  })
})

describe('tools port', () => {
  it('threads callerId through and passes registry listings along', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const tools = [{ name: 'workspace.read' }]
    const ports = buildJanusChatTurnPorts(baseDeps({
      executeFunctionCall: execute as unknown as JanusChatTurnPortsDeps['executeFunctionCall'],
      listRegistryTools: () => tools as unknown as ReturnType<JanusChatTurnPortsDeps['listRegistryTools']>,
      listRegistryManifests: () => [{ providerName: 'workspace' }] as unknown as ReturnType<JanusChatTurnPortsDeps['listRegistryManifests']>,
    }))
    await ports.tools.executeFunctionCall({ tool: 'x' } as never, 'renderer:7')
    expect(execute).toHaveBeenCalledWith({ tool: 'x' }, 'renderer:7')
    expect(ports.tools.registry.list()).toEqual(tools)
    expect(ports.tools.registry.listManifests?.()).toEqual([{ providerName: 'workspace' }])
  })
})

describe('knowledge ports', () => {
  it('delegates search with the facade query shape', async () => {
    const search = vi.fn(async () => ({ items: [] }) as unknown as KnowledgeContextResult)
    const ports = buildJanusChatTurnPorts(baseDeps({
      knowledgeSearch: search as unknown as NonNullable<ReturnType<typeof buildJanusChatTurnPorts>['knowledgeSearch']>,
    }))
    await ports.knowledgeSearch?.({
      query: 'q',
      workspaceId: 'ws1',
      workspacePath: 'C:/ws',
      maxItems: 5,
      maxChars: 3000,
    })
    expect(search).toHaveBeenCalledWith({
      query: 'q',
      workspaceId: 'ws1',
      workspacePath: 'C:/ws',
      maxItems: 5,
      maxChars: 3000,
    })
  })

  it('captures user + assistant turns with shell-identical payloads', async () => {
    const captured: unknown[] = []
    const settled: string[] = []
    const ports = buildJanusChatTurnPorts(baseDeps({
      captureObservation: async (input) => {
        captured.push(input)
        return { workspaceId: input.workspaceId }
      },
      scheduleSettled: (workspaceId) => {
        settled.push(workspaceId)
      },
    }))
    await ports.knowledgeCapture?.captureTurn({
      targets: [{ workspaceId: 'ws1', workspacePath: 'C:/ws', sessionId: 'sess-1' }],
      userText: 'hello',
      assistantText: 'world',
      providerId: 'p1',
      modelId: 'm1',
      correlationId: 'r1',
    })
    expect(captured).toHaveLength(2)
    expect(captured[0]).toMatchObject({
      workspaceId: 'ws1',
      source: 'janus-chat',
      type: 'conversation-turn',
      content: 'hello',
      summary: 'Janus Chat user message',
      tags: ['janus-chat', 'user'],
      actor: 'user',
      correlationId: 'r1',
      sessionId: 'sess-1',
    })
    expect(captured[1]).toMatchObject({
      content: 'world',
      summary: 'Janus Chat assistant response',
      tags: ['janus-chat', 'assistant'],
      actor: 'assistant',
      metadata: { providerId: 'p1', modelId: 'm1' },
    })
    await ports.knowledgeCapture?.notifySettled?.('ws1')
    expect(settled).toEqual(['ws1'])
  })

  it('falls back to the correlation id without a session and skips missing user text', async () => {
    const captured: unknown[] = []
    const ports = buildJanusChatTurnPorts(baseDeps({
      captureObservation: async (input) => {
        captured.push(input)
        return null
      },
    }))
    await ports.knowledgeCapture?.captureTurn({
      targets: [{ workspaceId: 'ws1', workspacePath: 'C:/ws', sessionId: '' }],
      assistantText: 'world',
      providerId: 'p1',
      modelId: 'm1',
      correlationId: 'r9',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ actor: 'assistant', sessionId: 'r9' })
  })
})
