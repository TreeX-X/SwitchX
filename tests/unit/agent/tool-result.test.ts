import { describe, expect, it } from 'vitest'
import type { ToolResult } from '../../../src/shared/ipc/agent-runtime'
import { toolResultToModelValue } from '../../../src/main/janus-agent/runtime/tool-result'

function completed(toolName: string, output: unknown): ToolResult {
  return {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    correlationId: 'call-1',
    toolName,
    status: 'completed',
    startedAt: '2026-09-06T00:00:00.000Z',
    completedAt: '2026-09-06T00:00:00.001Z',
    durationMs: 1,
    summary: 'completed',
    output,
  }
}

describe('toolResultToModelValue P4 preview-only', () => {
  it('orders command.run paging refs before the preview blobs with a logPath guidance', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      cwd: '',
      program: 'npm',
      args: ['run', 'build'],
      ok: false,
      exitCode: 1,
      stdout: 'tail-preview',
      stderr: 'err-preview',
      timedOut: false,
      outputTruncated: true,
      executionMode: 'direct',
      totalBytes: 70000,
      wallTimeMs: 1200,
      logTruncated: false,
      logPath: '.janusX/logs/cmd-1.log',
    })) as Record<string, unknown>
    const keys = Object.keys(value)
    // compactToolMessage cuts at 4k chars: refs must survive the cut.
    expect(keys.indexOf('logPath')).toBeLessThan(keys.indexOf('stdout'))
    expect(keys.indexOf('guidance')).toBeLessThan(keys.indexOf('stdout'))
    expect(value.logPath).toBe('.janusX/logs/cmd-1.log')
    expect(value.totalBytes).toBe(70000)
    expect(value.guidance).toContain('.janusX/logs/cmd-1.log')
    expect(value.guidance).toContain('workspace_read')
    expect(value.stdout).toBe('tail-preview')
  })

  it('keeps background projectId/logPath and drops absent stdout/exitCode', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      cwd: '',
      program: 'npm',
      args: ['run', 'build'],
      background: true,
      projectId: 'pid-1',
      pid: 1234,
      name: 'npm run build',
      logPath: '.janusX/logs/bg-1.log',
    })) as Record<string, unknown>
    expect(value.projectId).toBe('pid-1')
    expect(value.logPath).toBe('.janusX/logs/bg-1.log')
    expect(value.guidance).toContain('.janusX/logs/bg-1.log')
    expect('stdout' in value).toBe(false)
    expect('exitCode' in value).toBe(false)
  })

  it('R4: keeps non-empty env refs ahead of the preview blobs', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      cwd: '',
      program: 'npm',
      args: ['run', 'build'],
      background: true,
      projectId: 'pid-1',
      pid: 1234,
      name: 'npm run build',
      env: { NODE_ENV: 'production' },
      logPath: '.janusX/logs/bg-1.log',
      stdout: 'tail-preview',
    })) as Record<string, unknown>
    expect(value.env).toEqual({ NODE_ENV: 'production' })
    const keys = Object.keys(value)
    expect(keys.indexOf('env')).toBeLessThan(keys.indexOf('stdout'))
  })

  it('points background jobs without a log file at project_process_output', () => {
    const value = toolResultToModelValue(completed('command.run', {
      workspaceId: 'workspace-1',
      program: 'npm',
      args: ['run', 'build'],
      background: true,
      projectId: 'pid-1',
      pid: 1234,
      name: 'npm run build',
    })) as Record<string, unknown>
    expect(value.guidance).toContain('project_process_output')
  })

  it('keeps exited output refs for finished background jobs', () => {
    const value = toolResultToModelValue(completed('project.process-output', {
      workspaceId: 'workspace-1',
      projectId: 'pid',
      output: 'done',
      totalLines: 3,
      offsetLines: 0,
      truncated: false,
      exited: true,
      exitCode: 0,
      signal: null,
      logPath: '.janusX/logs/bg-1.log',
    })) as Record<string, unknown>
    expect(value.exited).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.logPath).toBe('.janusX/logs/bg-1.log')
    expect(value.guidance).toContain('.janusX/logs/bg-1.log')
  })

  it('orders process-output paging refs before the page blob with a hint when truncated', () => {
    const value = toolResultToModelValue(completed('project.process-output', {
      workspaceId: 'workspace-1',
      projectId: 'pid',
      output: 'page-text',
      totalLines: 900,
      offsetLines: 0,
      truncated: true,
    })) as Record<string, unknown>
    const keys = Object.keys(value)
    expect(keys.indexOf('totalLines')).toBeLessThan(keys.indexOf('output'))
    expect(keys.indexOf('truncated')).toBeLessThan(keys.indexOf('output'))
    expect(value.guidance).toContain('offsetLines')
  })

  it('passes other tools through unchanged', () => {
    expect(toolResultToModelValue(completed('workspace.read', { content: 'hello' })))
      .toEqual({ content: 'hello' })
  })
})
