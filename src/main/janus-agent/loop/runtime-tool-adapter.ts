import type { ApprovalPreview, ActionRisk, ToolDefinition, ToolResult } from '../../../shared/ipc/agent-runtime'
import type { JanusAgentTool, JanusAgentToolResult, JanusToolCall } from './janus-agent-loop'
import { toolResultToModelValue } from '../runtime/tool-result'
import { createToolManifests, type ToolManifest } from '../runtime/tool-manifest'

interface RuntimeToolRegistry {
  list(): ToolDefinition[]
  listManifests?(): ToolManifest[]
}

export interface JanusRuntimeToolHost {
  registry: RuntimeToolRegistry
  executeFunctionCall(input: {
    sessionId: string
    call: {
      toolName: string
      input: Record<string, unknown>
      correlationId?: string
      source?: 'function-calling'
      evidenceConfidence?: 'unknown' | 'low' | 'medium' | 'high'
      preview?: ApprovalPreview
    }
  }, callerId?: string): Promise<ToolResult>
}

export type JanusRuntimeAgentTool = JanusAgentTool & {
  label: string
  canonicalName: string
  description: string
  parameters: ToolDefinition['inputSchema']
  actionRisk: ActionRisk
}

export type JanusRuntimeToolPreview = (toolName: string, input: Record<string, unknown>) => ApprovalPreview | undefined

export interface JanusRuntimeWorkspaceResource {
  sessionId: string
}

const READ_ONLY_RISKS = new Set<ActionRisk>(['inspect', 'list', 'stat', 'read'])
const READ_ONLY_NAMES = new Set([
  'workspace.list', 'workspace.search', 'workspace.read',
  'project.detect', 'project.list-processes', 'project.process-output',
  'git.status', 'git.log', 'git.diff',
])

function asInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function resultContent(result: ToolResult): string {
  const value = toolResultToModelValue(result)
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

function resultToAgentResult(result: ToolResult): JanusAgentToolResult {
  return {
    content: resultContent(result),
    details: result,
    isError: result.status !== 'completed',
  }
}

function createRuntimeTool(
  host: JanusRuntimeToolHost,
  manifest: ToolManifest,
  sessionId: string | ((input: Record<string, unknown>) => string | undefined),
  callerId: string,
  preview?: JanusRuntimeToolPreview,
): JanusRuntimeAgentTool {
  return {
    name: manifest.providerName,
    label: manifest.canonicalName,
    canonicalName: manifest.canonicalName,
    description: manifest.description,
    parameters: manifest.inputSchema,
    actionRisk: manifest.actionRisk,
    executionMode: READ_ONLY_RISKS.has(manifest.actionRisk) ? 'parallel' : 'sequential',
    execute: async (call: JanusToolCall, signal) => {
      if (signal.aborted) return { content: 'Tool execution cancelled', isError: true }
      const input = asInput(call.arguments)
      const resolvedSessionId = typeof sessionId === 'function' ? sessionId(input) : sessionId
      if (!resolvedSessionId) return { content: 'Workspace session is unavailable', isError: true }
      const result = await host.executeFunctionCall({
        sessionId: resolvedSessionId,
        call: {
          toolName: manifest.canonicalName,
          input,
          correlationId: call.id,
          source: 'function-calling',
          evidenceConfidence: 'medium',
          ...(preview ? { preview: preview(manifest.canonicalName, input) } : {}),
        },
      }, callerId)
      return resultToAgentResult(result)
    },
  }
}

function manifests(host: JanusRuntimeToolHost): ToolManifest[] {
  return host.registry.listManifests?.() ?? createToolManifests(host.registry.list())
}

export function createJanusRuntimeTools(
  host: JanusRuntimeToolHost,
  sessionId: string,
  options: { callerId?: string; preview?: JanusRuntimeToolPreview } = {},
): JanusRuntimeAgentTool[] {
  const callerId = options.callerId ?? 'janus-agent-loop'
  return manifests(host).map((manifest) => createRuntimeTool(host, manifest, sessionId, callerId, options.preview))
}

export function createJanusRuntimeCodingTools(
  host: JanusRuntimeToolHost,
  sessionId: string,
  options: { callerId?: string; preview?: JanusRuntimeToolPreview } = {},
): JanusRuntimeAgentTool[] {
  return createJanusRuntimeTools(host, sessionId, options)
}

export function createJanusRuntimeReadOnlyTools(
  host: JanusRuntimeToolHost,
  sessionId: string,
  options: { callerId?: string; preview?: JanusRuntimeToolPreview } = {},
): JanusRuntimeAgentTool[] {
  return createJanusRuntimeTools(host, sessionId, options)
    .filter((tool) => READ_ONLY_NAMES.has(tool.name) || READ_ONLY_RISKS.has(tool.actionRisk))
}

export function createJanusRuntimeToolsForResources(
  host: JanusRuntimeToolHost,
  resources: Map<string, JanusRuntimeWorkspaceResource>,
  options: { callerId?: string; preview?: JanusRuntimeToolPreview } = {},
): JanusRuntimeAgentTool[] {
  const resolveSession = (input: Record<string, unknown>) => {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
    return resources.get(workspaceId)?.sessionId
  }
  const callerId = options.callerId ?? 'janus-agent-loop'
  return manifests(host).map((manifest) => createRuntimeTool(host, manifest, resolveSession, callerId, options.preview))
}

export function createJanusRuntimeReadOnlyToolsForResources(
  host: JanusRuntimeToolHost,
  resources: Map<string, JanusRuntimeWorkspaceResource>,
  options: { callerId?: string; preview?: JanusRuntimeToolPreview } = {},
): JanusRuntimeAgentTool[] {
  return createJanusRuntimeToolsForResources(host, resources, options)
    .filter((tool) => READ_ONLY_NAMES.has(tool.name) || READ_ONLY_RISKS.has(tool.actionRisk))
}
