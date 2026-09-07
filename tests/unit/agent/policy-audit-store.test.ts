import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FilePolicyAuditStore } from '../../../src/main/janus-agent/runtime/policy-audit-store'
import type { PolicyDecisionRecord } from '../../../src/shared/ipc/agent-runtime'

let root: string | undefined
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; delete process.env.JANUSX_KNOWLEDGE_ROOT })

describe('policy audit store', () => {
  it('persists records and filters by workspace, session, and correlation', async () => {
    root = await mkdtemp(join(tmpdir(), 'janusx-policy-audit-'))
    process.env.JANUSX_KNOWLEDGE_ROOT = root
    const record: PolicyDecisionRecord = {
      id: 'decision-1', workspaceId: 'workspace-1', sessionId: 'session-1', correlationId: 'call-1',
      toolName: 'workspace.read', createdAt: new Date().toISOString(), outcome: 'allow', evidenceConfidence: 'unknown',
      actionRisk: 'read', approvalPolicy: 'none', approvalDecision: 'not-required', reasonCode: 'READ_ALLOWED',
    }
    await new FilePolicyAuditStore().record(record)
    await expect(new FilePolicyAuditStore().query({ workspaceId: 'workspace-1', sessionId: 'session-1', correlationId: 'call-1' })).resolves.toEqual([record])
    await expect(new FilePolicyAuditStore().query({ workspaceId: 'other' })).resolves.toEqual([])
  })
})
