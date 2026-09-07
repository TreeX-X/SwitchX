import { describe, expect, it } from 'vitest'
import { ChatSessionRuntime } from '../../../src/main/janus-agent/chat-session-runtime'
import { buildChatSystemPrompt } from '../../../src/main/janus-agent/system-prompt-builder'
import type { ToolManifest } from '../../../src/main/janus-agent/runtime/tool-manifest'
import type { ToolResult } from '../../../src/shared/ipc/agent-runtime'

function toolResult(overrides: Partial<ToolResult>): ToolResult {
  return {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    correlationId: 'call-1',
    toolName: 'workspace.read',
    status: 'completed',
    startedAt: '2026-08-27T00:00:00.000Z',
    completedAt: '2026-08-27T00:00:00.000Z',
    durationMs: 0,
    summary: 'completed',
    ...overrides,
  }
}

describe('ChatSessionRuntime', () => {
  it('keeps the newest complete context suffix when the history exceeds its budget', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'old request '.repeat(160) },
      { role: 'assistant', content: 'old answer '.repeat(80) },
      { role: 'user', content: 'current request '.repeat(40) },
    ], { model: { contextWindow: 800, maxOutputTokens: 100 } })

    expect(context.map((message) => message.role)).toEqual(['system', 'user'])
    expect(context.at(-1)?.content).toContain('current request')
    expect(context.some((message) => message.content.includes('old request'))).toBe(false)
  })

  it('preserves chronological order after selecting the newest context suffix', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'old request '.repeat(160) },
      { role: 'assistant', content: 'old answer '.repeat(80) },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
      { role: 'user', content: 'current request' },
    ], { model: { contextWindow: 800, maxOutputTokens: 100 } })

    expect(context.map((message) => message.content)).toEqual([
      'policy',
      'new request',
      'new answer',
      'current request',
    ])
  })

  it('keeps a tool call and its result together while bounding large output', () => {
    const runtime = new ChatSessionRuntime()
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'workspace_read', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'call-1', toolName: 'workspace_read', content: JSON.stringify({ content: 'x'.repeat(8_000), path: 'a.ts' }) },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })

    const assistant = context.find((message) => message.role === 'assistant')
    const tool = context.find((message) => message.role === 'tool')
    expect(assistant?.toolCalls?.[0]?.id).toBe('call-1')
    expect(tool?.toolCallId).toBe('call-1')
    expect(tool?.content).toContain('[truncated]')
    expect(tool?.content).not.toContain('x'.repeat(7_000))
  })

  it('injects only read evidence and invalidates it after a file mutation', () => {
    const runtime = new ChatSessionRuntime()
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', sha256: 'abc', size: 20, content: 'const value = 1' },
    }))
    const beforeEdit = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'change a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    expect(beforeEdit.some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(true)

    runtime.recordToolResult(toolResult({
      toolName: 'workspace.edit',
      output: { workspaceId: 'workspace-1', changedPaths: ['a.ts'] },
    }))
    const afterEdit = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'change a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    expect(afterEdit.some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(false)
  })

  it('keeps separately loaded file ranges and invalidates all ranges after an edit', () => {
    const runtime = new ChatSessionRuntime()
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', offset: 0, bytes: 5, sha256: 'abc', size: 20, truncated: true, content: 'first' },
    }))
    runtime.recordToolResult(toolResult({
      output: { workspaceId: 'workspace-1', path: 'a.ts', offset: 10, bytes: 5, sha256: 'abc', size: 20, truncated: true, content: 'second' },
    }))

    const beforeEdit = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'inspect a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
    const evidence = beforeEdit.filter((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))
    expect(evidence).toHaveLength(1)
    expect(evidence[0].content).toContain('range=10-15')

    runtime.recordToolResult(toolResult({
      toolName: 'workspace.edit',
      output: { workspaceId: 'workspace-1', changedPaths: ['a.ts'] },
    }))
    expect(runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'inspect a.ts' },
    ], { model: { contextWindow: 4_000, maxOutputTokens: 100 } })
      .some((message) => message.content.includes('Loaded workspace evidence: workspace-1/a.ts'))).toBe(false)
  })

  it('keeps a deterministic handoff with exact digests when old tool turns are pruned', () => {
    const runtime = new ChatSessionRuntime()
    const matches = Array.from({ length: 30 }, (_, index) => ({ path: `src/file${index}.tsx`, line: index + 1, text: 'flip effect '.repeat(6) }))
    const searchResult = JSON.stringify({
      workspaceId: 'workspace-1', query: 'flip', path: '',
      matches, truncated: true,
    })
    const context = runtime.buildContext([
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'old exploration' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-old', name: 'workspace_search', arguments: { query: 'flip' } }] },
      { role: 'tool', toolCallId: 'call-old', toolName: 'workspace_search', content: searchResult },
      { role: 'user', content: 'current request '.repeat(40) },
    ], { model: { contextWindow: 1000, maxOutputTokens: 100 } })

    const handoff = context.find((message) => message.role === 'system' && message.content.includes('was pruned'))
    expect(handoff?.content).toContain('"flip"')
    expect(handoff?.content).toContain('src/file0.tsx#L1')
    expect(context.at(-1)?.content).toContain('current request')
  })
})

describe('SystemPromptBuilder', () => {
  it('derives the minimal contract from active tool manifests without exposing workspace roots', () => {
    const toolManifests: ToolManifest[] = [
      {
        canonicalName: 'workspace.read', providerName: 'workspace_read', version: 1,
        description: 'Read a UTF-8 text file inside the current workspace', actionRisk: 'read',
        inputSchema: { type: 'object' },
      },
      {
        canonicalName: 'workspace.edit', providerName: 'workspace_edit', version: 1,
        description: 'Apply bounded exact replacements or one unified diff', actionRisk: 'write',
        inputSchema: { type: 'object' },
      },
    ]
    const prompt = buildChatSystemPrompt({
      resources: new Map([['workspace-1', { workspaceName: 'Project', workspaceRoot: 'C:/project' }]]),
      toolManifests,
    })

    expect(prompt).toContain('You are JanusX, a workspace agent')
    expect(prompt).toContain('not the filesystem, shell, or approval system')
    expect(prompt).not.toContain('System Contract v2')
    expect(prompt).toContain('workspace_read [read]: Read a UTF-8 text file')
    expect(prompt).toContain('workspace_edit [write]: Apply bounded exact replacements')
    expect(prompt).not.toContain('command_run')
    expect(prompt).toContain('workspaceId=workspace-1')
    expect(prompt).not.toContain('C:/project')
    expect(prompt).toContain('Do not preload or vectorize the workspace')
    expect(prompt).toContain('Do not retry a denied action')
  })

  it('does not claim tool access when a workspace has no active manifest', () => {
    const prompt = buildChatSystemPrompt({
      resources: new Map([['workspace-1', { workspaceName: 'Project' }]]),
      toolManifests: [],
    })

    expect(prompt).toContain('No workspace tools are enabled for this request.')
    expect(prompt).not.toContain('Enabled tools:')
  })
})
