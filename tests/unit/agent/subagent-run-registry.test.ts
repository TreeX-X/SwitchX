import { describe, expect, it } from 'vitest'
import { SubAgentRunRegistry } from '../../../src/main/janus-runner/subagent-run-registry'

describe('SubAgentRunRegistry', () => {
  it('creates, updates, finishes, lists, and removes runs', () => {
    const registry = new SubAgentRunRegistry()

    const created = registry.createRun({
      id: 'run-1',
      source: 'headless',
      engine: 'codex',
      role: 'coder',
      status: 'queued',
      title: 'coder task',
      lastEvent: 'Queued',
    })

    expect(created.startedAt).toBeTruthy()
    expect(created.updatedAt).toBeTruthy()
    expect(registry.listRuns()).toHaveLength(1)

    const updated = registry.updateRun('run-1', {
      status: 'running',
      terminalId: 'terminal-1',
      meta: { attempt: 1 },
    })

    expect(updated?.status).toBe('running')
    expect(updated?.terminalId).toBe('terminal-1')
    expect(updated?.rootRunId).toBe('run-1')
    expect(updated?.rootTerminalId).toBe('terminal-1')
    expect(updated?.missionId).toBe('run-1')
    expect(updated?.meta).toEqual({ attempt: 1 })
    expect(registry.getRunByTerminalId('terminal-1')?.id).toBe('run-1')

    const finished = registry.finishRun('run-1', 'done', 'Completed')
    expect(finished?.status).toBe('done')
    expect(finished?.lastEvent).toBe('Completed')

    registry.removeRun('run-1')
    expect(registry.listRuns()).toEqual([])
  })

  it('merges metadata on update', () => {
    const registry = new SubAgentRunRegistry()
    registry.createRun({
      id: 'run-1',
      source: 'terminal',
      role: 'main',
      status: 'running',
      title: 'Claude terminal',
      meta: { first: true },
    })

    const updated = registry.updateRun('run-1', { meta: { second: true } })
    expect(updated?.meta).toEqual({ first: true, second: true })
  })
  it('inherits mission attribution from parent runs', () => {
    const registry = new SubAgentRunRegistry()
    registry.createRun({
      id: 'terminal:terminal-1',
      rootRunId: 'terminal:terminal-1',
      terminalId: 'terminal-1',
      rootTerminalId: 'terminal-1',
      missionId: 'terminal-1',
      source: 'terminal',
      role: 'main',
      status: 'running',
      title: 'Codex terminal',
    })

    const child = registry.createRun({
      id: 'child-1',
      parentRunId: 'terminal:terminal-1',
      source: 'headless',
      role: 'subagent',
      status: 'queued',
      title: 'Headless helper',
    })

    expect(child.rootRunId).toBe('terminal:terminal-1')
    expect(child.rootTerminalId).toBe('terminal-1')
    expect(child.missionId).toBe('terminal-1')
  })
})
