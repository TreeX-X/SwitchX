import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Blueprint } from '../../src/shared/janus/types'

// Under full-suite CPU contention the async task pipeline can exceed the
// defaults; generous timeouts keep this file deterministic, and the afterEach
// cancelAll prevents one timeout from poisoning the shared per-blueprint lock.
vi.setConfig({ testTimeout: 30_000 })
const waitFor = <T,>(assertion: () => T) => vi.waitFor(assertion, { timeout: 15_000, interval: 50 })

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  streamText: vi.fn(),
  getDefaultModel: vi.fn(),
  getLanguageModel: vi.fn(),
  loadBlueprint: vi.fn(),
  applyMaintenanceOperations: vi.fn(),
  workspacesDir: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  cancelSession: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../../src/main/llm/ai-runtime', () => ({
  generateObject: mocks.generateObject,
  streamText: mocks.streamText,
}))
vi.mock('../../src/main/agent/runtime/shell-runtime', () => ({
  workspaceAgentRuntime: {
    registry: { list: () => [] },
    createSession: mocks.createSession,
    getSession: mocks.getSession,
    cancelSession: mocks.cancelSession,
    executeFunctionCall: vi.fn(),
  },
}))
vi.mock('../../src/main/llm/LlmService', () => ({
  llmService: {
    getDefaultModel: mocks.getDefaultModel,
    getLanguageModel: mocks.getLanguageModel,
  },
}))
vi.mock('../../src/main/janus/blueprint-store', () => ({
  blueprintStore: {
    loadBlueprint: mocks.loadBlueprint,
    applyMaintenanceOperations: mocks.applyMaintenanceOperations,
  },
}))
vi.mock('../../src/main/janus/blueprint-paths', () => ({ workspacesDir: mocks.workspacesDir }))

function fixture(): Blueprint {
  return {
    schemaVersion: 2,
    contentRevision: 3,
    id: 'bp-1',
    name: 'Blueprint',
    description: '',
    rootNodeId: 'root',
    nodeIds: ['root'],
    nodes: {
      root: {
        id: 'root', title: 'Root', type: 'epic', status: 'not-started', progress: 0,
        statusSource: 'manual', positioning: '', description: '', features: [], completedItems: [],
        techSolution: '', notes: '', todos: [], issues: [], activities: [], analyses: [], workspaceId: null,
        workspaceSnapshot: null, boundTerminalId: null, terminalHistory: [], lastAnalyzedCommitSha: null,
        children: [], parentId: null, tags: [], createdAt: '', updatedAt: '',
      },
    },
    requirementCandidates: [], mountedTo: null, canvasLayout: {}, createdAt: '', updatedAt: '',
  }
}

describe('Blueprint maintenance free conversation', () => {
  let root = ''
  let workspace = ''
  let workspace2 = ''
  let registry = ''

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'janusx-maintenance-'))
    workspace = join(root, 'workspace')
    workspace2 = join(root, 'workspace-2')
    registry = join(root, 'registry')
    await fs.mkdir(workspace)
    await fs.mkdir(workspace2)
    await fs.mkdir(registry)
    await fs.writeFile(join(registry, 'workspace.json'), JSON.stringify({ id: 'ws-1', path: workspace }), 'utf8')
    await fs.writeFile(join(registry, 'workspace-2.json'), JSON.stringify({ id: 'ws-2', path: workspace2 }), 'utf8')
    mocks.workspacesDir.mockReturnValue(registry)
    mocks.getDefaultModel.mockResolvedValue({ provider: { id: 'provider' }, modelId: 'model' })
    mocks.getLanguageModel.mockResolvedValue({})
    mocks.loadBlueprint.mockImplementation(async () => fixture())
    mocks.createSession.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({ id: `agent-session-${workspaceId}` }))
    mocks.getSession.mockReturnValue({ status: 'running' })
    mocks.cancelSession.mockResolvedValue({ status: 'cancelled' })
  })

  afterAll(async () => {
    if (root.startsWith(join(tmpdir(), 'janusx-maintenance-'))) {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  afterEach(async () => {
    // One timed-out test must not leave an active task holding the
    // per-blueprint lock and poison every later test in this file.
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    blueprintMaintenanceService.cancelAll()
  })

  it('keeps the current proposal during discussion and replaces it only on explicit revision', async () => {
    mocks.streamText.mockImplementation(() => ({
      textStream: (async function* () { yield '先讨论方案，不修改蓝图。' })(),
      toolCalls: Promise.resolve([]),
    }))
    mocks.generateObject
      .mockResolvedValueOnce({ object: { summary: '首版提案', operations: [{
        operationId: 'update-1', type: 'update-node', nodeId: 'root', after: { notes: 'first' },
        reason: '记录结论', evidenceRefs: [], dependsOn: [], risk: 'low',
      }] } })
      .mockResolvedValueOnce({ object: { summary: '修订提案', operations: [{
        operationId: 'update-2', type: 'update-node', nodeId: 'root', after: { notes: 'second' },
        reason: '纳入补充意见', evidenceRefs: [], dependsOn: [], risk: 'low',
      }] } })

    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: '先讨论维护方向',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list()[0]?.status).toBe('active'))

    await blueprintMaintenanceService.propose({ taskId: started.id })
    await waitFor(() => expect(blueprintMaintenanceService.list()[0]?.status).toBe('proposal-ready'))
    const firstProposal = blueprintMaintenanceService.list()[0].changeSet
    expect(firstProposal?.version).toBe(1)

    await blueprintMaintenanceService.message({ taskId: started.id, content: '再考虑一下边界，不要改当前提案' })
    await waitFor(() => expect(blueprintMaintenanceService.list()[0]?.phase).toBe('对话完成，当前提案仍待审批'))
    expect(blueprintMaintenanceService.list()[0].changeSet?.id).toBe(firstProposal?.id)
    expect(JSON.stringify(mocks.streamText.mock.calls[1]?.[0]?.messages)).toContain('update-1')

    await blueprintMaintenanceService.propose({ taskId: started.id })
    await waitFor(() => expect(blueprintMaintenanceService.list()[0]?.changeSet?.version).toBe(2))
    const revisedTask = blueprintMaintenanceService.list()[0]
    expect(revisedTask.changeSet?.id).not.toBe(firstProposal?.id)
    expect(revisedTask.changeSetHistory).toEqual([firstProposal])
    expect(mocks.streamText).toHaveBeenCalledTimes(2)
    expect(mocks.generateObject).toHaveBeenCalledTimes(2)
    blueprintMaintenanceService.cancel(started.id)
  })

  it('rejects concurrent starts for the same Blueprint before async validation completes', async () => {
    let releaseLoad!: () => void
    mocks.loadBlueprint.mockImplementationOnce(() => new Promise<Blueprint>((resolve) => {
      releaseLoad = () => resolve(fixture())
    }))
    const input = {
      blueprintId: 'bp-race', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' as const }, goal: 'race test',
    }
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const first = blueprintMaintenanceService.start(input)
    await waitFor(() => expect(mocks.loadBlueprint).toHaveBeenCalled())
    await expect(blueprintMaintenanceService.start(input)).rejects.toThrow('已有活动维护任务')
    releaseLoad()
    const started = await first
    blueprintMaintenanceService.cancel(started.id)
  })

  it('authorizes multiple workspaces while keeping a single node scope', async () => {
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      authorizedWorkspaces: [
        { workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace },
        { workspaceId: 'ws-2', workspaceName: 'Workspace 2', workspacePath: workspace2 },
      ],
      nodeScope: { type: 'node', nodeId: 'root' }, goal: 'cross-workspace evidence',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list()[0]?.status).toBe('active'))

    expect(started.authorizedWorkspaces).toHaveLength(2)
    expect(started.nodeScope).toEqual({ type: 'node', nodeId: 'root' })
    expect(mocks.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-1', workspaceRoot: workspace })
    expect(mocks.createSession).toHaveBeenCalledWith({ workspaceId: 'ws-2', workspaceRoot: workspace2 })
    blueprintMaintenanceService.cancel(started.id)
  })

  it('marks a proposal stale when collected workspace evidence changes before apply', async () => {
    await fs.writeFile(join(workspace, 'evidence.md'), 'before')
    mocks.generateObject.mockResolvedValueOnce({ object: { summary: 'Evidence-bound proposal', operations: [{
      operationId: 'evidence-update', type: 'update-node', nodeId: 'root', after: { notes: 'verified' },
      reason: 'Use evidence', evidenceRefs: ['evidence.md'], dependsOn: [], risk: 'low',
    }] } })
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: 'evidence test',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('active'))
    await blueprintMaintenanceService.propose({ taskId: started.id })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('proposal-ready'))
    const proposal = blueprintMaintenanceService.list().find((task) => task.id === started.id)?.changeSet
    expect(proposal?.evidence?.[0]?.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)

    await fs.writeFile(join(workspace, 'evidence.md'), 'after')
    await expect(blueprintMaintenanceService.apply({
      taskId: started.id,
      changeSetId: proposal!.id,
      operationIds: ['evidence-update'],
    })).rejects.toThrow('工程证据已变化')
    expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('stale')
    expect(mocks.applyMaintenanceOperations).not.toHaveBeenCalled()
    blueprintMaintenanceService.cancel(started.id)
  })

  it('retries a failed discussion stage once without creating a second task', async () => {
    mocks.streamText.mockClear()
    mocks.streamText
      .mockRejectedValueOnce(new Error('temporary model failure'))
      .mockImplementationOnce(() => ({
        textStream: (async function* () { yield 'Recovered response' })(),
        toolCalls: Promise.resolve([]),
      }))
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: 'retry discussion',
    })

    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('active'))
    const task = blueprintMaintenanceService.list().find((item) => item.id === started.id)!
    expect(task.messages.at(-1)?.content).toBe('Recovered response')
    expect(mocks.streamText).toHaveBeenCalledTimes(2)
    expect(blueprintMaintenanceService.list().filter((item) => item.blueprintId === started.blueprintId && item.status !== 'cancelled')).toHaveLength(1)
    blueprintMaintenanceService.cancel(started.id)
  })

  it('marks a proposal stale when workspace authorization is removed before apply', async () => {
    mocks.generateObject.mockResolvedValueOnce({ object: { summary: 'Authorization-bound proposal', operations: [{
      operationId: 'authorization-update', type: 'update-node', nodeId: 'root', after: { notes: 'verified' },
      reason: 'Authorized workspace', evidenceRefs: [], dependsOn: [], risk: 'low',
    }] } })
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: 'authorization test',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('active'))
    await blueprintMaintenanceService.propose({ taskId: started.id })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('proposal-ready'))
    const proposal = blueprintMaintenanceService.list().find((task) => task.id === started.id)?.changeSet
    const registration = join(registry, 'workspace.json')
    const disabledRegistration = join(registry, 'workspace.disabled')
    await fs.rename(registration, disabledRegistration)
    try {
      await expect(blueprintMaintenanceService.apply({
        taskId: started.id,
        changeSetId: proposal!.id,
        operationIds: ['authorization-update'],
      })).rejects.toThrow('工程证据已变化')
      expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('stale')
      expect(mocks.applyMaintenanceOperations).not.toHaveBeenCalled()
    } finally {
      await fs.rename(disabledRegistration, registration)
      blueprintMaintenanceService.cancel(started.id)
    }
  })

  it('does not retry or overwrite cancellation when a discussion fails late', async () => {
    let rejectStream!: (error: Error) => void
    mocks.streamText.mockClear()
    mocks.streamText.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectStream = reject
    }))
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: 'cancel retry test',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('analyzing'))
    await waitFor(() => expect(mocks.streamText).toHaveBeenCalledTimes(1))
    blueprintMaintenanceService.cancel(started.id)
    rejectStream(new Error('late model failure'))

    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('cancelled'))
    expect(mocks.streamText).toHaveBeenCalledTimes(1)
  })

  it('persists the approved ChangeSet, evidence, and before/after snapshots', async () => {
    mocks.streamText.mockImplementation(() => ({
      textStream: (async function* () { yield 'Ready' })(),
      toolCalls: Promise.resolve([]),
    }))
    mocks.generateObject.mockResolvedValueOnce({ object: { summary: 'Audited proposal', operations: [{
      operationId: 'audit-update', type: 'update-node', nodeId: 'root', after: { notes: 'audited' },
      reason: 'Audit trail', evidenceRefs: ['evidence.md'], dependsOn: [], risk: 'low',
    }] } })
    const before = fixture()
    const after = { ...fixture(), contentRevision: 4 }
    mocks.applyMaintenanceOperations.mockResolvedValueOnce({ before, after })
    const auditDirectory = join(tmpdir(), 'janusx', 'blueprint-maintenance-audit')
    const existingAudits = new Set(await fs.readdir(auditDirectory).catch(() => []))
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: 'audit test',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('active'))
    await blueprintMaintenanceService.propose({ taskId: started.id })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('proposal-ready'))
    const proposal = blueprintMaintenanceService.list().find((task) => task.id === started.id)?.changeSet
    await blueprintMaintenanceService.apply({
      taskId: started.id,
      changeSetId: proposal!.id,
      operationIds: ['audit-update'],
    })

    const createdAudit = (await fs.readdir(auditDirectory)).find((file) => !existingAudits.has(file))!
    const audit = JSON.parse(await fs.readFile(join(auditDirectory, createdAudit), 'utf8'))
    expect(audit).toMatchObject({
      status: 'applied',
      changeSetSnapshot: { id: proposal!.id, evidence: [{ workspaceId: 'ws-1' }] },
      beforeSnapshot: { contentRevision: 3 },
      afterSnapshot: { contentRevision: 4 },
    })
    expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.changeSetHistory).toEqual([
      expect.objectContaining({ id: proposal!.id, status: 'applied' }),
    ])
    await expect(blueprintMaintenanceService.listAudits({ blueprintId: 'bp-1', taskId: started.id })).resolves.toEqual([
      expect.objectContaining({ id: audit.id, status: 'applied' }),
    ])
    const incompatibleAudit = join(auditDirectory, `legacy-${started.id}.json`)
    await fs.writeFile(incompatibleAudit, JSON.stringify({
      id: 'legacy', blueprintId: 'bp-1', taskId: started.id, selectedOperationIds: [],
    }), 'utf8')
    await expect(blueprintMaintenanceService.listAudits({ blueprintId: 'bp-1', taskId: started.id })).resolves.toEqual([
      expect.objectContaining({ id: audit.id, status: 'applied' }),
    ])
    await expect(blueprintMaintenanceService.listAudits({ blueprintId: 'other' })).resolves.toEqual([])
    await Promise.all([
      fs.rm(join(auditDirectory, createdAudit), { force: true }),
      fs.rm(incompatibleAudit, { force: true }),
    ])
    blueprintMaintenanceService.cancel(started.id)
  })

  it('refuses to apply delete operations without individual high-risk confirmation', async () => {
    const withChild = fixture()
    withChild.nodes.child = {
      ...withChild.nodes.root, id: 'child', title: 'Child', parentId: 'root', children: [],
    }
    withChild.nodes.root.children = ['child']
    withChild.nodeIds = ['root', 'child']
    mocks.loadBlueprint.mockImplementation(async () => structuredClone(withChild))
    mocks.streamText.mockImplementation(() => ({
      textStream: (async function* () { yield 'Ready' })(),
      toolCalls: Promise.resolve([]),
    }))
    mocks.generateObject.mockResolvedValueOnce({ object: { summary: 'Delete proposal', operations: [{
      operationId: 'del-child', type: 'delete-node', nodeId: 'child',
      reason: 'Obsolete node', evidenceRefs: [], dependsOn: [], risk: 'high',
    }] } })
    mocks.applyMaintenanceOperations.mockResolvedValueOnce({
      before: withChild, after: { ...structuredClone(withChild), contentRevision: 4 },
      createdNodeIds: {}, createdRelationIds: {},
    })
    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const started = await blueprintMaintenanceService.start({
      blueprintId: 'bp-1', workspaceId: 'ws-1', workspaceName: 'Workspace', workspacePath: workspace,
      nodeScope: { type: 'blueprint' }, goal: 'delete gate test',
    })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('active'))
    await blueprintMaintenanceService.propose({ taskId: started.id })
    await waitFor(() => expect(blueprintMaintenanceService.list().find((task) => task.id === started.id)?.status).toBe('proposal-ready'))
    const proposal = blueprintMaintenanceService.list().find((task) => task.id === started.id)?.changeSet
    const deleteOperation = proposal?.operations[0]
    expect(deleteOperation?.type).toBe('delete-node')
    expect(deleteOperation?.risk).toBe('high')

    await expect(blueprintMaintenanceService.apply({
      taskId: started.id, changeSetId: proposal!.id, operationIds: ['del-child'],
    })).rejects.toThrow('逐项高风险确认')

    await expect(blueprintMaintenanceService.apply({
      taskId: started.id, changeSetId: proposal!.id, operationIds: ['del-child'],
      confirmedDeleteOperationIds: ['del-child'],
    })).resolves.toMatchObject({ appliedOperationIds: ['del-child'] })
    mocks.loadBlueprint.mockImplementation(async () => fixture())
    blueprintMaintenanceService.cancel(started.id)
  })

  it('prepares and applies a reverse ChangeSet from an applied audit record', async () => {
    const auditDirectory = join(tmpdir(), 'janusx', 'blueprint-maintenance-audit')
    await fs.mkdir(auditDirectory, { recursive: true })
    const before = fixture()
    const applied = fixture()
    applied.contentRevision = 3
    applied.nodes.root.notes = 'audited'
    mocks.loadBlueprint.mockImplementation(async () => structuredClone(applied))
    const auditRecord = {
      id: 'undo-source-audit', taskId: 'task-x', changeSetId: 'cs-x', blueprintId: 'bp-1',
      beforeRevision: 2, afterRevision: 3,
      selectedOperationIds: ['op-notes'], rejectedOperationIds: [],
      status: 'applied',
      changeSetSnapshot: {
        id: 'cs-x', taskId: 'task-x', blueprintId: 'bp-1', baseRevision: 2, version: 1, status: 'applied',
        reason: 'original', operations: [{
          operationId: 'op-notes', type: 'update-node', nodeId: 'root',
          before: { notes: '' }, after: { notes: 'audited' },
          reason: 'note it', evidenceRefs: [], dependsOn: [], risk: 'low',
        }], createdAt: '',
      },
      beforeSnapshot: before, afterSnapshot: applied, createdAt: '', appliedAt: '',
    }
    await fs.writeFile(join(auditDirectory, `${auditRecord.id}.json`), JSON.stringify(auditRecord), 'utf8')
    mocks.applyMaintenanceOperations.mockResolvedValueOnce({
      before: applied, after: { ...structuredClone(before), contentRevision: 4 },
      createdNodeIds: {}, createdRelationIds: {},
    })

    const { blueprintMaintenanceService } = await import('../../src/main/janus/maintenance/service')
    const prepared = await blueprintMaintenanceService.prepareUndo({ blueprintId: 'bp-1', auditId: auditRecord.id })
    expect(prepared.changeSet.undoOfAuditId).toBe(auditRecord.id)
    expect(prepared.changeSet.operations).toEqual([
      expect.objectContaining({ type: 'update-node', after: { notes: '' } }),
    ])

    const result = await blueprintMaintenanceService.applyUndo({
      blueprintId: 'bp-1', undoChangeSetId: prepared.changeSet.id,
      operationIds: prepared.changeSet.operations.map((operation) => operation.operationId),
    })
    expect(result.blueprintRevision).toBe(4)
    const undoAudits = await blueprintMaintenanceService.listAudits({ blueprintId: 'bp-1' })
    expect(undoAudits.some((record) => record.undoOfAuditId === auditRecord.id && record.status === 'applied')).toBe(true)

    // A prepared undo is single-use: the revision moved, so it must be re-prepared.
    await expect(blueprintMaintenanceService.applyUndo({
      blueprintId: 'bp-1', undoChangeSetId: prepared.changeSet.id, operationIds: ['undo-op-notes'],
    })).rejects.toThrow('不存在或已失效')

    mocks.loadBlueprint.mockImplementation(async () => fixture())
    for (const file of await fs.readdir(auditDirectory)) {
      if (file.includes('undo') || file.includes(auditRecord.id)) await fs.rm(join(auditDirectory, file), { force: true })
    }
  })
})
