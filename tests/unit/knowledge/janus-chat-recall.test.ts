import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeContextResult } from '../../../src/shared/knowledge'

const { handle, on, search, capture, streamText, getSession, executeFunctionCall, scheduleImmediate } = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  search: vi.fn(),
  capture: vi.fn(),
  streamText: vi.fn(),
  getSession: vi.fn(),
  executeFunctionCall: vi.fn(),
  scheduleImmediate: vi.fn(),
}))

vi.mock('electron', () => ({ ipcMain: { handle, on }, app: { getPath: () => '/tmp/janusx-test' } }))
vi.mock('../../../src/main/knowledge/context-service', () => ({
  knowledgeContextService: { search },
}))
vi.mock('../../../src/main/knowledge/observation-service', () => ({
  knowledgeObservationService: { capture },
}))
vi.mock('../../../src/main/knowledge/processing-queue', () => ({
  knowledgeProcessingQueue: { scheduleImmediate },
}))
vi.mock('../../../src/main/llm/ModelCatalogService', () => ({
  getModelCatalogService: () => ({ getCatalog: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('../../../src/main/llm/LlmService', () => ({
  llmService: {
    getProviderSettings: vi.fn(async () => ({ modelId: 'test-model' })),
    getLanguageModel: vi.fn(async () => ({})),
  },
}))
vi.mock('../../../src/main/llm/ai-runtime', () => ({
  generateText: vi.fn(),
  streamText,
}))
vi.mock('../../../src/main/agent/runtime/shell-runtime', () => ({
  workspaceAgentRuntime: {
    getSession,
    executeFunctionCall,
    registry: {
      list: () => [
        'workspace.list', 'workspace.search', 'workspace.read', 'workspace.edit', 'workspace.create',
        'project.detect', 'project.generate-config', 'project.apply-config', 'project.list-processes',
        'project.process-output', 'project.start-process', 'project.stop-process',
        'git.status', 'git.log', 'git.diff', 'git.stage', 'git.unstage', 'git.commit', 'git.pull', 'git.push',
        'command.run',
      ].map((name) => ({
        name,
        description: name,
        inputSchema: { type: 'object', additionalProperties: true },
        actionRisk: name === 'workspace.edit' ? 'write' : 'read',
      })),
    },
  },
}))

import { registerLlmHandlers } from '../../../src/main/ipc/llm-handlers'
import { hasExplicitWorkspaceMutationIntent, prepareJanusChatRecall, toolTraceEntryFromResult } from '../../../src/main/llm/chat-orchestrator'

const emptyResult: KnowledgeContextResult = {
  items: [],
  compactContext: '',
  truncated: false,
  eligibleCount: 0,
  maxItems: 5,
  maxChars: 3_000,
}

const messages = [
  { role: 'system' as const, content: 'Janus persona' },
  { role: 'system' as const, content: 'Workspace policy' },
  { role: 'user' as const, content: 'older question' },
  { role: 'assistant' as const, content: 'older answer' },
  { role: 'user' as const, content: 'latest workspace question' },
]

function registerAndFindHandler(channel: string) {
  registerLlmHandlers()
  return on.mock.calls.find(([c]) => c === channel)
}

function fakeStream(text: string) {
  streamText.mockResolvedValue({
    textStream: (async function* () {
      yield text
    })(),
  })
}

describe('Janus Chat knowledge recall', () => {
  beforeEach(() => {
    handle.mockReset()
    on.mockReset()
    search.mockReset()
    capture.mockReset().mockResolvedValue(undefined)
    streamText.mockReset()
    getSession.mockReset()
    executeFunctionCall.mockReset()
  })

  it('uses the latest user message, bounded workspace scope, and injects after the persona', async () => {
    const contextResult: KnowledgeContextResult = {
      items: [{
        id: 'fact-1',
        kind: 'fact',
        title: 'A'.repeat(200),
        content: 'accepted truth',
        score: 4.2,
        workspaceId: 'workspace-a',
        provenance: {
          observationIds: ['obs-1', 'obs-2', 'obs-3', 'obs-4'],
          factIds: ['fact-1'],
          fileRefs: ['src/a.ts'],
          createdAt: '2026-07-12T00:00:00.000Z',
        },
      }],
      compactContext: '[fact] accepted truth',
      truncated: true,
      eligibleCount: 2,
      maxItems: 5,
      maxChars: 3_000,
    }
    const recallSearch = vi.fn(async () => contextResult)

    const result = await prepareJanusChatRecall(
      'request-1',
      messages,
      'workspace-a',
      'C:/workspace-a',
      recallSearch,
    )

    expect(recallSearch).toHaveBeenCalledWith({
      query: 'latest workspace question',
      workspaceId: 'workspace-a',
      workspacePath: 'C:/workspace-a',
      maxItems: 5,
      maxChars: 3_000,
    })
    expect(result.messages.slice(0, 2)).toEqual(messages.slice(0, 2))
    expect(result.messages[2]).toEqual(expect.objectContaining({ role: 'system' }))
    expect(result.messages[2]?.content).toContain('trust="untrusted"')
    expect(result.messages[2]?.content).toContain('reference-only')
    expect(result.messages.filter((message) => message.content.includes('janus-knowledge-context'))).toHaveLength(1)
    expect(result.messages.slice(3)).toEqual(messages.slice(2))
    expect(messages).toEqual([
      { role: 'system', content: 'Janus persona' },
      { role: 'system', content: 'Workspace policy' },
      { role: 'user', content: 'older question' },
      { role: 'assistant', content: 'older answer' },
      { role: 'user', content: 'latest workspace question' },
    ])
    expect(result.trace).toEqual(expect.objectContaining({
      requestId: 'request-1',
      status: 'recalled',
      query: 'latest workspace question',
      recalledCount: 1,
      eligibleCount: 2,
      truncated: true,
    }))
    expect(result.trace.topHit?.title).toHaveLength(160)
    expect(result.trace.topHit?.provenance.observationIds).toEqual(['obs-1', 'obs-2', 'obs-3'])
  })

  it('fails open for empty, degraded, and thrown recall', async () => {
    const empty = await prepareJanusChatRecall('empty', messages, 'workspace-a', undefined, async () => emptyResult)
    expect(empty.messages).toBe(messages)
    expect(empty.trace.status).toBe('empty')

    const degraded = await prepareJanusChatRecall('degraded', messages, undefined, undefined, async () => ({
      ...emptyResult,
      degraded: { reason: 'missing-workspace' },
    }))
    expect(degraded.messages).toBe(messages)
    expect(degraded.trace).toEqual(expect.objectContaining({ status: 'degraded', reason: 'missing-workspace' }))

    const failed = await prepareJanusChatRecall('failed', messages, 'workspace-a', undefined, async () => {
      throw new Error('recall unavailable')
    })
    expect(failed.messages).toBe(messages)
    expect(failed.trace).toEqual(expect.objectContaining({ status: 'error', reason: 'recall unavailable' }))
  })

  it('emits exactly one correlated trace before stream completion and preserves observations', async () => {
    search.mockResolvedValue(emptyResult)
    fakeStream('answer')
    const registration = registerAndFindHandler('llm:chat-stream')
    const reply = vi.fn()

    await registration?.[1]({ reply }, {
      requestId: 'stream-1',
      messages,
      providerId: 'provider-a',
      sourceTag: 'janus-chat',
      workspaceId: 'workspace-a',
      workspacePath: 'C:/workspace-a',
    })

    const channels = reply.mock.calls.map(([channel]) => channel)
    expect(channels.filter((channel) => channel === 'llm:chat:recall-trace')).toHaveLength(1)
    expect(channels.indexOf('llm:chat:recall-trace')).toBeLessThan(channels.indexOf('llm:chat:done'))
    expect(reply).toHaveBeenCalledWith('llm:chat:recall-trace', expect.objectContaining({
      requestId: 'stream-1',
      status: 'empty',
    }))
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('keeps an unbound Janus conversation global and skips workspace observations', async () => {
    search.mockResolvedValue(emptyResult)
    fakeStream('global answer')
    const registration = registerAndFindHandler('llm:chat-stream')
    const reply = vi.fn()

    await registration?.[1]({ reply }, {
      requestId: 'stream-global',
      messages,
      providerId: 'provider-a',
      sourceTag: 'janus-chat',
    })

    expect(search).toHaveBeenCalledWith({
      query: 'latest workspace question',
      workspaceId: undefined,
      workspacePath: undefined,
      maxItems: 5,
      maxChars: 3_000,
    })
    expect(capture).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith('llm:chat:done', { requestId: 'stream-global' })
  })

  it('adds trusted Runtime tools for every validated attached workspace session', async () => {
    search.mockResolvedValue(emptyResult)
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      status: 'running',
      workspace: sessionId === 'session-1'
        ? { workspaceId: 'workspace-a', workspaceRoot: 'C:/workspace-a' }
        : { workspaceId: 'workspace-b', workspaceRoot: 'C:/workspace-b' },
    }))
    fakeStream('workspace answer')
    const registration = registerAndFindHandler('llm:chat-stream')

    await registration?.[1]({ reply: vi.fn(), sender: { id: 9 } }, {
      requestId: 'stream-tools',
      messages,
      providerId: 'provider-a',
      sourceTag: 'janus-chat',
      workspaceResources: [
        { workspaceId: 'workspace-a', workspacePath: 'C:/workspace-a', workspaceName: 'Workspace A', agentSessionId: 'session-1' },
        { workspaceId: 'workspace-b', workspacePath: 'C:/workspace-b', workspaceName: 'Workspace B', agentSessionId: 'session-2' },
      ],
    })

    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({
      maxSteps: 1,
      tools: expect.objectContaining({
        workspace_list: expect.any(Object),
        workspace_read: expect.any(Object),
        project_detect: expect.any(Object),
        project_generate_config: expect.any(Object),
        project_process_output: expect.any(Object),
        git_status: expect.any(Object),
        command_run: expect.any(Object),
      }),
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('workspaceId=workspace-a') }),
        expect.objectContaining({ role: 'system', content: expect.stringContaining('workspaceId=workspace-b') }),
      ]),
    }))
    expect((streamText.mock.calls[0][0] as any).tools.workspace_read.execute).toBeUndefined()
    expect(capture).toHaveBeenCalledTimes(4)
  })

  it('keeps streaming when recall throws and reports degradation only through the trace', async () => {
    search.mockRejectedValue(new Error('knowledge offline'))
    fakeStream('ordinary answer')
    const registration = registerAndFindHandler('llm:chat-stream')
    const reply = vi.fn()

    await registration?.[1]({ reply }, {
      requestId: 'stream-fail-open',
      messages,
      providerId: 'provider-a',
      sourceTag: 'janus-chat',
      workspaceId: 'workspace-a',
      workspacePath: 'C:/workspace-a',
    })

    expect(reply).toHaveBeenCalledWith('llm:chat:recall-trace', expect.objectContaining({
      requestId: 'stream-fail-open',
      status: 'error',
      reason: 'knowledge offline',
    }))
    expect(reply).toHaveBeenCalledWith('llm:chat:delta', expect.objectContaining({
      requestId: 'stream-fail-open',
      delta: 'ordinary answer',
    }))
    expect(reply.mock.calls.some(([channel]) => channel === 'llm:chat:error')).toBe(false)
    expect(reply).toHaveBeenCalledWith('llm:chat:done', { requestId: 'stream-fail-open' })
  })

  it('distinguishes direct workspace changes from read-only analysis', () => {
    expect(hasExplicitWorkspaceMutationIntent('请你直接修改工作区即可')).toBe(true)
    expect(hasExplicitWorkspaceMutationIntent('修复一下这个文件的问题')).toBe(true)
    expect(hasExplicitWorkspaceMutationIntent('只分析如何修改，不要修改代码')).toBe(false)
  })

  it('turns an empty model completion into visible feedback', async () => {
    search.mockResolvedValue(emptyResult)
    streamText.mockResolvedValue({
      textStream: (async function* () {})(),
      responseMessages: Promise.resolve([]),
    })
    const registration = registerAndFindHandler('llm:chat-stream')
    const reply = vi.fn()

    await registration?.[1]({ reply }, {
      requestId: 'stream-empty',
      messages,
      providerId: 'provider-a',
      sourceTag: 'janus-chat',
    })

    expect(reply).toHaveBeenCalledWith('llm:chat:delta', expect.objectContaining({
      requestId: 'stream-empty',
      delta: expect.stringContaining('模型没有返回可显示内容'),
    }))
    expect(reply).toHaveBeenCalledWith('llm:chat:done', { requestId: 'stream-empty' })
  })

  it('retries a changed workspace read and continues an explicitly requested edit', async () => {
    search.mockResolvedValue(emptyResult)
    getSession.mockReturnValue({
      id: 'session-1',
      status: 'running',
      workspace: { workspaceId: 'workspace-a', workspaceRoot: 'C:/workspace-a' },
    })
    executeFunctionCall.mockImplementation(async (input: any) => {
      const firstRead = input.call.toolName === 'workspace.read' && executeFunctionCall.mock.calls.length === 1
      return {
        workspaceId: 'workspace-a',
        sessionId: 'session-1',
        correlationId: `call-${executeFunctionCall.mock.calls.length}`,
        toolName: input.call.toolName,
        status: firstRead ? 'failed' : 'completed',
        startedAt: '2026-08-05T00:00:00.000Z',
        completedAt: '2026-08-05T00:00:00.001Z',
        durationMs: 1,
        summary: firstRead ? 'workspace.read failed' : `${input.call.toolName} completed`,
        ...(firstRead
          ? { reasonCode: 'TARGET_CHANGED', error: 'Workspace target changed during authorization' }
          : {
              output: input.call.toolName === 'workspace.read'
                ? { path: 'src/main.ts', content: 'before', sha256: 'a'.repeat(64) }
                : { path: 'src/main.ts', sha256: 'b'.repeat(64), checkpointId: 'checkpoint-1' },
            }),
      }
    })
    streamText
      .mockImplementationOnce(async () => ({
        textStream: (async function* () {})(),
        fullStream: (async function* () {
          yield { type: 'tool-call-streaming-start', toolCallId: 'read-1', toolName: 'workspace_read' }
          yield { type: 'tool-call-delta', toolCallId: 'read-1', toolName: 'workspace_read', argsTextDelta: '{"workspaceId":"workspace-a",' }
          yield { type: 'tool-call-delta', toolCallId: 'read-1', toolName: 'workspace_read', argsTextDelta: '"path":"src/main.ts","maxBytes":4096}' }
          yield {
            type: 'tool-call', toolCallId: 'read-1', toolName: 'workspace_read',
            args: { workspaceId: 'workspace-a', path: 'src/main.ts', maxBytes: 4096 },
          }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(),
      }))
      .mockImplementationOnce(async (options: any) => {
        expect(options.messages.at(-1).content[0].result).toMatchObject({ retryable: true, reasonCode: 'TARGET_CHANGED' })
        return {
          textStream: (async function* () {})(),
          fullStream: (async function* () {
            yield {
              type: 'tool-call', toolCallId: 'read-2', toolName: 'workspace_read',
              args: { workspaceId: 'workspace-a', path: 'src/main.ts', maxBytes: 4096 },
            }
            yield { type: 'finish', finishReason: 'tool-calls' }
          })(),
        }
      })
      .mockImplementationOnce(async () => ({
        textStream: (async function* () {})(),
        fullStream: (async function* () {
          yield {
            type: 'tool-call', toolCallId: 'edit-1', toolName: 'workspace_edit',
            args: {
              workspaceId: 'workspace-a', path: 'src/main.ts', expectedHash: 'a'.repeat(64),
              replacements: [{ oldText: 'before', newText: 'after' }],
            },
          }
          yield { type: 'finish', finishReason: 'tool-calls' }
        })(),
      }))
      .mockImplementationOnce(async () => ({
        textStream: (async function* () { yield '修改完成。' })(),
        toolCalls: Promise.resolve([]),
      }))
    const registration = registerAndFindHandler('llm:chat-stream')
    const reply = vi.fn()

    await registration?.[1]({ reply, sender: { id: 9 } }, {
      requestId: 'stream-edit-recovery',
      messages: [{ role: 'user', content: '请你直接修改工作区即可' }],
      providerId: 'provider-a',
      sourceTag: 'janus-chat',
      workspaceResources: [{
        workspaceId: 'workspace-a',
        workspacePath: 'C:/workspace-a',
        workspaceName: 'Workspace A',
        agentSessionId: 'session-1',
      }],
    })

    expect(streamText).toHaveBeenCalledTimes(4)
    expect(executeFunctionCall.mock.calls.map(([input]) => input.call.toolName)).toEqual([
      'workspace.read',
      'workspace.read',
      'workspace.edit',
    ])
    const agentEvents = reply.mock.calls
      .filter(([channel]) => channel === 'llm:chat:agent-event')
      .map(([, payload]) => payload)
    expect(agentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_call_start', callId: 'read-1', toolName: 'workspace_read' }),
      expect.objectContaining({ type: 'tool_call_delta', callId: 'read-1', argumentDeltaLength: expect.any(Number) }),
      expect.objectContaining({ type: 'tool_call_ready', callId: 'read-1', toolName: 'workspace_read', argumentKeys: ['workspaceId', 'path', 'maxBytes'] }),
      expect.objectContaining({ type: 'tool_execution_start', callId: 'read-1', toolName: 'workspace_read' }),
      expect.objectContaining({ type: 'tool_execution_end', callId: 'edit-1', toolName: 'workspace_edit', status: 'completed' }),
      expect.objectContaining({ type: 'stream_end', cancelled: false }),
    ]))
    expect(reply).toHaveBeenCalledWith('llm:chat:delta', expect.objectContaining({
      requestId: 'stream-edit-recovery',
      delta: '修改完成。',
    }))
  })
})

describe('toolTraceEntryFromResult P6 long-command digests', () => {
  const base = {
    sessionId: 'session-1',
    correlationId: 'call-1',
    startedAt: '2026-09-06T00:00:00.000Z',
    completedAt: '2026-09-06T00:00:00.001Z',
    durationMs: 1,
    summary: 'command.run completed',
  } as const

  it('keeps command.run exit/log refs inside the trace budget', () => {
    const entry = toolTraceEntryFromResult({
      ...base,
      workspaceId: 'workspace-1',
      toolName: 'command.run',
      status: 'completed',
      output: { exitCode: 1, totalBytes: 70000, logPath: '.janusX/logs/cmd-1.log' },
    })
    expect(entry.summary).toContain('exit=1')
    expect(entry.summary).toContain('log=.janusX/logs/cmd-1.log')
    expect(entry.summary.length).toBeLessThanOrEqual(300)
    expect(entry.resultDigest).toBe('.janusX/logs/cmd-1.log')
  })

  it('keeps background job and exited output refs', () => {
    const bg = toolTraceEntryFromResult({
      ...base,
      workspaceId: 'workspace-1',
      toolName: 'command.run',
      status: 'completed',
      output: { background: true, projectId: 'pid-1', logPath: '.janusX/logs/bg-1.log' },
    })
    expect(bg.summary).toContain('job=pid-1')
    const exited = toolTraceEntryFromResult({
      ...base,
      workspaceId: 'workspace-1',
      toolName: 'project.process-output',
      status: 'completed',
      output: { totalLines: 900, exited: true, exitCode: 0, logPath: '.janusX/logs/bg-1.log' },
    })
    expect(exited.summary).toContain('900 lines')
    expect(exited.summary).toContain('exited=0')
  })
})
