import type { ToolCall, ToolDefinition, ToolInputSchema } from '../../../shared/ipc/agent-runtime'
import { createToolManifests, type ToolManifest } from './tool-manifest'

export interface RegisteredTool extends ToolDefinition {
  execute: (input: Record<string, unknown>, context: { workspaceId: string; workspaceRoot: string; signal: AbortSignal }) => Promise<unknown> | unknown
}

const SUPPORTED_PROPERTY_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object'])
const SUPPORTED_ACTION_RISKS = new Set([
  'inspect', 'list', 'stat', 'read', 'write', 'create', 'config-apply', 'run', 'restore', 'delete', 'external-command', 'network',
])
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

function validSchema(schema: ToolInputSchema): boolean {
  if (!schema || schema.type !== 'object') return false
  if (schema.properties && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) return false
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return false
  if (schema.required && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length || schema.required.some((key) => typeof key !== 'string' || !schema.properties || !hasOwn(schema.properties, key)))) return false
  return Object.values(schema.properties ?? {}).every((property) =>
    property !== null
    && typeof property === 'object'
    && SUPPORTED_PROPERTY_TYPES.has(property.type)
    && (property.enum === undefined || Array.isArray(property.enum)),
  )
}

export function validateToolInput(schema: ToolInputSchema, input: unknown): input is Record<string, unknown> {
  if (!validSchema(schema) || !input || typeof input !== 'object' || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  for (const key of schema.required ?? []) if (!hasOwn(value, key)) return false
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) if (!schema.properties || !hasOwn(schema.properties, key)) return false
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!hasOwn(value, key)) continue
    const actual = value[key]
    if (property.enum && !property.enum.some((item) => Object.is(item, actual))) return false
    if (property.type === 'string' && typeof actual !== 'string') return false
    if (property.type === 'number' && typeof actual !== 'number') return false
    if (property.type === 'boolean' && typeof actual !== 'boolean') return false
    if (property.type === 'array' && !Array.isArray(actual)) return false
    if (property.type === 'object' && (!actual || typeof actual !== 'object' || Array.isArray(actual))) return false
  }
  return true
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  register(tool: RegisteredTool): void {
    if (!tool.name || !SUPPORTED_ACTION_RISKS.has(tool.actionRisk) || !validSchema(tool.inputSchema) || typeof tool.execute !== 'function') throw new Error('Invalid tool definition')
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }
  get(name: string): RegisteredTool | undefined { return this.tools.get(name) }
  list(): ToolDefinition[] { return [...this.tools.values()].map(({ execute: _execute, ...definition }) => definition) }
  listManifests(): ToolManifest[] { return createToolManifests(this.list()) }
  validateCall(call: ToolCall): RegisteredTool {
    const tool = this.tools.get(call.toolName)
    if (!tool) throw new Error(`Unknown tool: ${call.toolName}`)
    if (!validateToolInput(tool.inputSchema, call.input)) throw new Error(`Invalid input for tool: ${call.toolName}`)
    return tool
  }
}
