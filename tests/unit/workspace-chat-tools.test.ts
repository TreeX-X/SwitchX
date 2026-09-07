import { describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '../../src/shared/ipc/agent-runtime'
import { createWorkspaceChatTools } from '../../src/main/janus-agent/workspace-chat-tools'
import type { ToolManifest } from '../../src/main/janus-agent/runtime/tool-manifest'

function result(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    correlationId: 'call-1',
    toolName: 'workspace.read',
    status: 'completed',
    startedAt: '2026-07-26T00:00:00.000Z',
    completedAt: '2026-07-26T00:00:00.001Z',
    durationMs: 1,
    summary: 'completed',
    output: { content: 'hello' },
    ...overrides,
  }
}

const resources = new Map([
  ['workspace-1', { sessionId: 'session-1', workspaceRoot: 'C:/one', workspaceName: 'One' }],
  ['workspace-2', { sessionId: 'session-2', workspaceRoot: 'C:/two', workspaceName: 'Two' }],
])

describe('workspace chat tools', () => {
  it('uses active manifest descriptions for Provider-visible tools', () => {
    const toolManifests: ToolManifest[] = [{
      canonicalName: 'workspace.read', providerName: 'workspace_read', version: 1,
      description: 'Read bounded workspace evidence from the Runtime manifest.', actionRisk: 'read',
      inputSchema: { type: 'object' },
    }]
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: vi.fn() },
      resources,
      callerId: 'renderer:7',
      toolManifests,
    })

    expect(tools.workspace_read.description).toBe(toolManifests[0].description)
    expect(tools.workspace_edit.description).toContain('exact, unambiguous replacements')
  })

  it('routes each call through the explicitly requested trusted workspace session', async () => {
    const executeFunctionCall = vi.fn().mockResolvedValue(result())
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall },
      resources,
      callerId: 'renderer:7',
    })

    await expect(tools.workspace_read.execute({ workspaceId: 'workspace-2', path: 'src/main.ts', maxBytes: 4096 })).resolves.toEqual({ content: 'hello' })
    expect(executeFunctionCall).toHaveBeenCalledWith({
      sessionId: 'session-2',
      call: {
        toolName: 'workspace.read',
        input: { workspaceId: 'workspace-2', path: 'src/main.ts', maxBytes: 4096 },
        evidenceConfidence: 'medium',
      },
    }, 'renderer:7')
  })

  it('returns failed runtime results as structured data instead of throwing', async () => {
    // Throwing here would abort the whole streamText call and cut the reply off.
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: vi.fn().mockResolvedValue(result({ status: 'failed', error: 'Sensitive path denied' })) },
      resources,
      callerId: 'renderer:7',
    })

    await expect(tools.workspace_read.execute({ workspaceId: 'workspace-1', path: '.env', maxBytes: 4096 }))
      .resolves.toMatchObject({ ok: false, status: 'failed', error: 'Sensitive path denied' })
  })

  it('identifies a changed target as retryable instead of a locked workspace', async () => {
    const tools = createWorkspaceChatTools({
      runtime: {
        executeFunctionCall: vi.fn().mockResolvedValue(result({
          status: 'failed',
          reasonCode: 'TARGET_CHANGED',
          error: 'Workspace target changed during authorization',
        })),
      },
      resources,
      callerId: 'renderer:7',
    })

    await expect(tools.workspace_read.execute({ workspaceId: 'workspace-1', path: 'README.md', maxBytes: 4096 }))
      .resolves.toMatchObject({
        ok: false,
        retryable: true,
        reasonCode: 'TARGET_CHANGED',
        guidance: expect.stringContaining('workspace is not locked'),
      })
  })

  it('turns a user denial into guidance the model can continue from', async () => {
    const tools = createWorkspaceChatTools({
      runtime: {
        executeFunctionCall: vi.fn().mockResolvedValue(result({
          toolName: 'workspace.edit', status: 'cancelled', reasonCode: 'APPROVAL_DENIED', output: undefined,
        })),
      },
      resources,
      callerId: 'renderer:7',
    })

    const denied = await tools.workspace_edit.execute({
      workspaceId: 'workspace-1',
      path: 'README.md',
      expectedHash: 'a'.repeat(64),
      replacements: [{ oldText: 'before', newText: 'after' }],
    })
    expect(denied).toMatchObject({ ok: false, userDenied: true, reasonCode: 'APPROVAL_DENIED' })
    expect((denied as { guidance: string }).guidance).toContain('Do not retry')
  })

  it('rejects a workspace identity that was not validated for this Chat', async () => {
    const executeFunctionCall = vi.fn()
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall },
      resources,
      callerId: 'renderer:7',
    })

    await expect(tools.workspace_read.execute({
      workspaceId: 'workspace-3',
      path: 'README.md',
      maxBytes: 4096,
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('is not attached') })
    expect(executeFunctionCall).not.toHaveBeenCalled()
  })

  it('reports every executed call through onToolResult for the turn trace', async () => {
    const seen: string[] = []
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: vi.fn().mockResolvedValue(result()) },
      resources,
      callerId: 'renderer:7',
      onToolResult: (toolResult) => seen.push(toolResult.toolName),
    })

    await tools.workspace_read.execute({ workspaceId: 'workspace-1', path: 'a.ts', maxBytes: 4096 })
    await tools.workspace_search.execute({ workspaceId: 'workspace-1', query: 'needle', path: '', maxResults: 10 })
    expect(seen).toEqual(['workspace.read', 'workspace.read'])
  })

  it('routes workspace file creation with a bounded content preview', async () => {
    const executeFunctionCall = vi.fn().mockResolvedValue(result({
      toolName: 'workspace.create',
      output: { path: 'notes/test.md', checkpointId: 'checkpoint-2' },
    }))
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall },
      resources,
      callerId: 'renderer:7',
    })

    await tools.workspace_create.execute({ workspaceId: 'workspace-1', path: 'notes/test.md', content: 'hello' })

    expect(executeFunctionCall).toHaveBeenCalledWith({
      sessionId: 'session-1',
      call: expect.objectContaining({
        toolName: 'workspace.create',
        input: expect.objectContaining({ path: 'notes/test.md', content: 'hello' }),
        preview: {
          summary: 'Create notes/test.md (5 bytes)',
          paths: ['notes/test.md'],
          detail: 'hello',
          truncated: false,
        },
      }),
    }, 'renderer:7')
  })

  it('routes workspace edits with a bounded custom approval preview', async () => {
    const executeFunctionCall = vi.fn().mockResolvedValue(result({
      toolName: 'workspace.edit',
      output: { path: 'README.md', checkpointId: 'checkpoint-1' },
    }))
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall },
      resources,
      callerId: 'renderer:7',
    })

    await tools.workspace_edit.execute({
      workspaceId: 'workspace-1',
      path: 'README.md',
      expectedHash: 'a'.repeat(64),
      replacements: [{ oldText: 'before', newText: 'after' }],
    })

    expect(executeFunctionCall).toHaveBeenCalledWith({
      sessionId: 'session-1',
      call: expect.objectContaining({
        toolName: 'workspace.edit',
        input: expect.objectContaining({ path: 'README.md', expectedHash: 'a'.repeat(64) }),
        preview: {
          summary: 'Edit README.md with 1 exact replacement',
          paths: ['README.md'],
          detail: 'Replacement 1\n- before\n+ after',
          truncated: false,
        },
      }),
    }, 'renderer:7')
  })

  it('routes a unified diff edit with its own bounded approval preview', async () => {
    const executeFunctionCall = vi.fn().mockResolvedValue(result({ toolName: 'workspace.edit' }))
    const tools = createWorkspaceChatTools({ runtime: { executeFunctionCall }, resources, callerId: 'renderer:7' })
    const unifiedDiff = ['--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-before', '+after', ''].join('\n')

    await tools.workspace_edit.execute({
      workspaceId: 'workspace-1', path: 'README.md', expectedHash: 'a'.repeat(64), unifiedDiff,
    })

    expect(executeFunctionCall).toHaveBeenCalledWith({
      sessionId: 'session-1',
      call: expect.objectContaining({
        toolName: 'workspace.edit',
        preview: { summary: 'Edit README.md with a unified diff', paths: ['README.md'], detail: unifiedDiff, truncated: false },
      }),
    }, 'renderer:7')
  })

  it('exposes shared launch configuration and process tools with approval previews', async () => {
    const executeFunctionCall = vi.fn().mockResolvedValue(result({ output: { ok: true } }))
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall },
      resources,
      callerId: 'renderer:7',
    })
    const config = {
      version: '0.1.0',
      projectType: 'custom',
      projectName: 'demo',
      configurations: [],
    }

    await tools.project_apply_config.execute({ workspaceId: 'workspace-1', path: 'app', config })
    await tools.project_list_processes.execute({ workspaceId: 'workspace-1' })
    await tools.project_start_process.execute({ workspaceId: 'workspace-1', path: 'app', configName: 'external-script' })
    await tools.project_stop_process.execute({ workspaceId: 'workspace-1', projectId: 'C:/one/app::external-script::1' })

    expect(executeFunctionCall.mock.calls.map(([input]) => input.call.toolName)).toEqual([
      'project.apply-config',
      'project.list-processes',
      'project.start-process',
      'project.stop-process',
    ])
    expect(executeFunctionCall.mock.calls[0][0].call.preview).toMatchObject({
      summary: expect.stringContaining('launch configuration'),
      paths: ['app/.janusX/janusX.launch.json'],
    })
    expect(executeFunctionCall.mock.calls[2][0].call.preview).toMatchObject({
      summary: expect.stringContaining('Start'),
      detail: 'Configuration: external-script',
    })
  })

  it('routes Git and command tools with explicit approval previews', async () => {
    const executeFunctionCall = vi.fn().mockResolvedValue(result({ output: { ok: true } }))
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall },
      resources,
      callerId: 'renderer:7',
    })

    await tools.git_status.execute({ workspaceId: 'workspace-1', path: '' })
    await tools.git_diff.execute({ workspaceId: 'workspace-1', path: '', staged: false, maxBytes: 4096 })
    await tools.git_stage.execute({ workspaceId: 'workspace-1', path: '', paths: ['src/app.ts'] })
    await tools.git_commit.execute({ workspaceId: 'workspace-1', path: '', message: 'fix: update app' })
    await tools.git_push.execute({ workspaceId: 'workspace-1', path: '' })
    await tools.command_run.execute({
      workspaceId: 'workspace-1', cwd: '', program: 'npm', args: ['test'], timeoutMs: 30_000,
    })

    expect(executeFunctionCall.mock.calls.map(([input]) => input.call.toolName)).toEqual([
      'git.status', 'git.diff', 'git.stage', 'git.commit', 'git.push', 'command.run',
    ])
    expect(executeFunctionCall.mock.calls[2][0].call.preview).toMatchObject({
      summary: expect.stringContaining('Stage'),
      detail: '["src/app.ts"]',
    })
    expect(executeFunctionCall.mock.calls[3][0].call.preview).toMatchObject({ detail: 'fix: update app' })
    expect(executeFunctionCall.mock.calls[5][0].call.preview).toMatchObject({
      summary: 'Run npm',
      detail: expect.stringContaining('"test"'),
    })
  })

})
