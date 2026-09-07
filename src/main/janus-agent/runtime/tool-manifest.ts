import type { ActionRisk, ToolDefinition, ToolInputSchema } from '../../../shared/ipc/agent-runtime'

export interface ToolManifest {
  canonicalName: string
  providerName: string
  version: 1
  description: string
  inputSchema: ToolInputSchema
  actionRisk: ActionRisk
}

const PROVIDER_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export function providerToolName(canonicalName: string): string {
  const providerName = canonicalName.replace(/[.-]/g, '_')
  if (!PROVIDER_TOOL_NAME.test(providerName)) {
    throw new Error(`Invalid canonical tool name: ${canonicalName}`)
  }
  return providerName
}

export function createToolManifest(definition: ToolDefinition): ToolManifest {
  return {
    canonicalName: definition.name,
    providerName: providerToolName(definition.name),
    version: 1,
    description: definition.description,
    inputSchema: definition.inputSchema,
    actionRisk: definition.actionRisk,
  }
}

export function createToolManifests(definitions: ToolDefinition[]): ToolManifest[] {
  const providerNames = new Set<string>()
  return definitions.map((definition) => {
    const manifest = createToolManifest(definition)
    if (providerNames.has(manifest.providerName)) {
      throw new Error(`Provider tool name collision: ${manifest.providerName}`)
    }
    providerNames.add(manifest.providerName)
    return manifest
  })
}
