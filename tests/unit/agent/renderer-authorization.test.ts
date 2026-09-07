import { beforeEach, describe, expect, it, vi } from 'vitest'

const record = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../src/main/janus-agent/runtime/policy-audit-store', () => ({
  FilePolicyAuditStore: class { record = record },
}))

import { authorizeRendererAction } from '../../../src/main/janus-agent/runtime/renderer-authorization'

const event = { sender: { id: 17 } } as never
const request = {
  workspaceRoot: 'C:\\workspace',
  toolName: 'legacy.workspace.delete',
  actionRisk: 'delete' as const,
  preview: { summary: 'Delete workspace', paths: ['C:\\workspace'], truncated: false },
}

describe('renderer action authorization', () => {
  beforeEach(() => record.mockClear())

  it('accepts explicit JanusX UI actions without a native confirmation', async () => {
    await expect(authorizeRendererAction(event, { ...request, source: 'renderer-user' })).resolves.toBe(true)
    expect(record).toHaveBeenCalledOnce()
  })

  it('fails closed for unmarked mutations instead of prompting outside the app flow', async () => {
    await expect(authorizeRendererAction(event, request)).resolves.toBe(false)
    expect(record).toHaveBeenCalledOnce()
  })
})
