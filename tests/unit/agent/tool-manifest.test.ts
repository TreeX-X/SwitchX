import { describe, expect, it } from 'vitest'
import { createToolManifests, providerToolName } from '../../../src/main/janus-agent/runtime/tool-manifest'

describe('tool manifest', () => {
  it('maps canonical Runtime names to provider-safe names', () => {
    expect(providerToolName('workspace.read')).toBe('workspace_read')
    expect(providerToolName('project.generate-config')).toBe('project_generate_config')
  })

  it('rejects provider name collisions', () => {
    expect(() => createToolManifests([
      { name: 'workspace.read', description: 'Read', actionRisk: 'read', inputSchema: { type: 'object' } },
      { name: 'workspace-read', description: 'Read', actionRisk: 'read', inputSchema: { type: 'object' } },
    ])).toThrow('Provider tool name collision: workspace_read')
  })
})
