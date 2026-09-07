import type { AgentStreamToolCall } from './types'

interface PendingToolCall {
  name?: string
  argumentsText: string
}

export interface ToolCallAccumulatorOptions {
  validate?: (call: AgentStreamToolCall) => string | undefined
}

export type ToolCallResolution =
  | { status: 'ready'; call: AgentStreamToolCall }
  | { status: 'invalid'; error: string }
  | { status: 'duplicate' }
  | { status: 'aborted' }

export class ToolCallAccumulator {
  private readonly pending = new Map<string, PendingToolCall>()
  private readonly completed = new Set<string>()
  private readonly aborted = new Set<string>()

  constructor(private readonly options: ToolCallAccumulatorOptions = {}) {}

  start(callId: string, name?: string): boolean {
    if (!callId || this.completed.has(callId) || this.aborted.has(callId)) return false
    const current = this.pending.get(callId)
    if (current) {
      if (!current.name && name) current.name = name
      return false
    }
    this.pending.set(callId, { name, argumentsText: '' })
    return true
  }

  append(callId: string, argumentsDelta: string, name?: string): boolean {
    if (!callId || this.completed.has(callId) || this.aborted.has(callId)) return false
    this.start(callId, name)
    const current = this.pending.get(callId)
    if (!current) return false
    if (!current.name && name) current.name = name
    current.argumentsText += argumentsDelta
    return true
  }

  complete(input: { callId: string; name?: string; arguments?: unknown }): ToolCallResolution {
    const { callId } = input
    if (this.aborted.has(callId)) return { status: 'aborted' }
    if (this.completed.has(callId)) return { status: 'duplicate' }

    this.start(callId, input.name)
    const current = this.pending.get(callId)
    this.pending.delete(callId)
    this.completed.add(callId)

    const name = input.name ?? current?.name
    if (!name) return { status: 'invalid', error: 'Tool call is missing a name' }

    let argumentsValue: unknown
    try {
      const source = input.arguments ?? current?.argumentsText
      argumentsValue = typeof source === 'string' ? JSON.parse(source) : source
    } catch {
      return { status: 'invalid', error: 'Tool call arguments are not valid JSON' }
    }

    if (argumentsValue === undefined) {
      return { status: 'invalid', error: 'Tool call is missing arguments' }
    }

    const call: AgentStreamToolCall = { id: callId, name, arguments: argumentsValue }
    const validationError = this.options.validate?.(call)
    return validationError ? { status: 'invalid', error: validationError } : { status: 'ready', call }
  }

  abort(callId: string): void {
    this.pending.delete(callId)
    this.aborted.add(callId)
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
