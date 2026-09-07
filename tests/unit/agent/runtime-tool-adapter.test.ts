import { describe, expect, it, vi } from 'vitest'
import { createJanusRuntimeReadOnlyTools, createJanusRuntimeTools, createJanusRuntimeToolsForResources } from '../../../src/main/janus-agent/loop/runtime-tool-adapter'
import type { ToolResult } from '../../../src/shared/ipc/agent-runtime'

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    workspaceId: 'ws', sessionId: 'session', correlationId: 'call', toolName: 'workspace.read',
    status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    durationMs: 1, summary: 'ok', output: { path: 'README.md' }, ...overrides,
  }
}

describe('runtime tool adapter', () => {
  it('exposes registry metadata while keeping execution behind executeFunctionCall', async () => {
    const executeFunctionCall = vi.fn(async () => result())
    const host = {
      registry: { list: () => [{ name: 'workspace.read', description: 'Read a file', inputSchema: { type: 'object' as const }, actionRisk: 'read' as const }] },
      executeFunctionCall,
    }
    const preview = vi.fn(() => ({ summary: 'Read', paths: ['README.md'], truncated: false }))
    const [tool] = createJanusRuntimeTools(host, 'session', { callerId: 'renderer', preview })
    const output = await tool.execute({ id: 'call', name: tool.name, arguments: { workspaceId: 'ws', path: 'README.md' } }, new AbortController().signal)
    expect(tool.name).toBe('workspace_read')
    expect(tool.canonicalName).toBe('workspace.read')
    expect(tool.description).toBe('Read a file')
    expect(tool.executionMode).toBe('parallel')
    expect(output).toMatchObject({ isError: false })
    expect(preview).toHaveBeenCalledWith('workspace.read', { workspaceId: 'ws', path: 'README.md' })
    expect(executeFunctionCall).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), 'renderer')
  })

  it('returns structured failures and filters the read-only preset', async () => {
    const host = {
      registry: { list: () => [
        { name: 'workspace.read', description: 'Read', inputSchema: { type: 'object' as const }, actionRisk: 'read' as const },
        { name: 'project.apply-config', description: 'Write', inputSchema: { type: 'object' as const }, actionRisk: 'config-apply' as const },
      ] },
      executeFunctionCall: vi.fn(async () => result({ status: 'failed', error: 'denied', output: undefined })),
    }
    const all = createJanusRuntimeTools(host, 'session')
    const readOnly = createJanusRuntimeReadOnlyTools(host, 'session')
    const output = await all[0].execute({ id: 'call', name: all[0].name, arguments: {} }, new AbortController().signal)
    expect(output).toMatchObject({ isError: true })
    expect(readOnly.map((tool) => tool.name)).toEqual(['workspace_read'])
  })

  it('routes a shared tool surface to the session selected by workspaceId', async () => {
    const executeFunctionCall = vi.fn(async () => result())
    const host = {
      registry: { list: () => [{ name: 'workspace.read', description: 'Read', inputSchema: { type: 'object' as const }, actionRisk: 'read' as const }] },
      executeFunctionCall,
    }
    const [tool] = createJanusRuntimeToolsForResources(host, new Map([['ws-a', { sessionId: 'session-a' }]]))
    await tool.execute({ id: 'call', name: tool.name, arguments: { workspaceId: 'ws-a' } }, new AbortController().signal)
    await tool.execute({ id: 'call-2', name: tool.name, arguments: { workspaceId: 'ws-b' } }, new AbortController().signal)
    expect(executeFunctionCall).toHaveBeenCalledTimes(1)
    expect(executeFunctionCall.mock.calls[0][0].sessionId).toBe('session-a')
  })
})
