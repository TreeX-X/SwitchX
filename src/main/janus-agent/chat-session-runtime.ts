import type { ModelInfo } from '@janusx/llm-core'
import type { ToolResult } from '../../shared/ipc/agent-runtime'
import type { JanusAgentMessage } from './loop'

const DEFAULT_CONTEXT_WINDOW = 16_384
const DEFAULT_RESERVED_OUTPUT_TOKENS = 2_048
const SAFETY_MARGIN_TOKENS = 512
const MAX_LOADED_FILES = 3
const MAX_LOADED_FILE_CHARS = 6_000
const MAX_TOOL_CONTENT_CHARS = 6_000
const MAX_TOOL_MESSAGE_CHARS = 4_000

interface LoadedContextEntry {
  workspaceId: string
  path: string
  offset: number
  bytes: number
  truncated: boolean
  sha256: string
  content: string
  size: number
  loadedAt: number
  stale: boolean
}

interface ToolOutput {
  workspaceId?: unknown
  path?: unknown
  sha256?: unknown
  size?: unknown
  content?: unknown
  offset?: unknown
  bytes?: unknown
  truncated?: unknown
  changedPaths?: unknown
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4)
}

function bounded(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: `${value.slice(0, maxChars)}\n[truncated]`, truncated: true }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function toolOutput(result: ToolResult): ToolOutput | undefined {
  return asRecord(result.output) as ToolOutput | undefined
}

export class LoadedContextIndex {
  private readonly entries = new Map<string, LoadedContextEntry>()

  record(result: ToolResult): void {
    const output = toolOutput(result)
    if (!output) return
    if (result.toolName === 'workspace.read' && result.status === 'completed'
      && typeof output.workspaceId === 'string' && typeof output.path === 'string'
      && typeof output.sha256 === 'string' && typeof output.content === 'string') {
      const content = bounded(output.content, MAX_LOADED_FILE_CHARS)
      const offset = typeof output.offset === 'number' ? output.offset : 0
      const bytes = typeof output.bytes === 'number' ? output.bytes : output.content.length
      const key = `${output.workspaceId}:${output.path}:${offset}`
      this.entries.set(key, {
        workspaceId: output.workspaceId,
        path: output.path,
        offset,
        bytes,
        truncated: output.truncated === true || content.truncated,
        sha256: output.sha256,
        content: content.value,
        size: typeof output.size === 'number' ? output.size : output.content.length,
        loadedAt: Date.now(),
        stale: false,
      })
      return
    }

    if (result.status !== 'completed') return
    const changedPaths = Array.isArray(output.changedPaths) ? output.changedPaths : []
    const workspaceId = typeof output.workspaceId === 'string' ? output.workspaceId : result.workspaceId
    for (const path of changedPaths) {
      if (typeof path !== 'string') continue
      for (const entry of this.entries.values()) {
        if (entry.workspaceId === workspaceId && entry.path === path) entry.stale = true
      }
    }
  }

  asSystemMessage(remainingTokens: number): JanusAgentMessage | undefined {
    const eligible = [...this.entries.values()]
      .filter((entry) => !entry.stale)
      .sort((left, right) => right.loadedAt - left.loadedAt)
      .slice(0, MAX_LOADED_FILES)
    if (eligible.length === 0 || remainingTokens < 64) return undefined

    const sections: string[] = []
    let usedTokens = 0
    for (const entry of eligible) {
      const header = [
        `Loaded workspace evidence: ${entry.workspaceId}/${entry.path}`,
        `range=${entry.offset}-${entry.offset + entry.bytes}; sha256=${entry.sha256}; size=${entry.size};${entry.truncated ? ' truncated;' : ''} read again when a newer range is needed.`,
      ].join('\n')
      const availableChars = Math.max(0, (remainingTokens - usedTokens) * 4 - header.length - 1)
      if (availableChars < 128) continue
      const content = bounded(entry.content, Math.min(MAX_LOADED_FILE_CHARS, availableChars)).value
      const section = `${header}\n${content}`
      const cost = estimateTokens(section)
      if (usedTokens + cost > remainingTokens) continue
      sections.push(section)
      usedTokens += cost
    }
    return sections.length ? { role: 'system', content: sections.join('\n\n') } : undefined
  }
}

function compactToolMessage(message: JanusAgentMessage): JanusAgentMessage {
  if (message.role !== 'tool') return message
  try {
    const value = JSON.parse(message.content) as unknown
    const output = asRecord(value)
    if (output && typeof output.content === 'string') {
      const content = bounded(output.content, MAX_TOOL_CONTENT_CHARS)
      return {
        ...message,
        content: JSON.stringify({
          ...output,
          content: content.value,
          ...(content.truncated ? { truncated: true, guidance: 'Use workspace.read again for another range.' } : {}),
        }),
      }
    }
  } catch {
    // Non-JSON tool output is still bounded below.
  }
  return { ...message, content: bounded(message.content, MAX_TOOL_MESSAGE_CHARS).value }
}

function toolDigest(message: JanusAgentMessage): string | undefined {
  if (message.role !== 'tool') return undefined
  const label = message.toolName ?? 'tool'
  let parsed: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(message.content) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    parsed = undefined
  }
  const workspaceId = typeof parsed?.workspaceId === 'string' ? String(parsed.workspaceId) : ''
  const scope = workspaceId ? `${workspaceId} ` : ''
  if (parsed) {
    if (Array.isArray(parsed.entries)) {
      const path = typeof parsed.path === 'string' && parsed.path ? parsed.path : '.'
      return `- ${label} ${scope}${path}: ${String(parsed.entries.length)} entries${parsed.truncated === true ? ' (truncated)' : ''}`
    }
    if (Array.isArray(parsed.matches)) {
      const query = typeof parsed.query === 'string' ? `"${String(parsed.query).slice(0, 80)}"` : ''
      const head = (parsed.matches as Array<{ path?: unknown; line?: unknown }>)
        .slice(0, 5)
        .map((match) => typeof match.path === 'string' ? `${match.path}${typeof match.line === 'number' ? `#L${match.line}` : ''}` : undefined)
        .filter((item): item is string => !!item)
        .join(', ')
      return `- ${label} ${scope}${query}: ${String(parsed.matches.length)} matches${head ? ` (${head})` : ''}${parsed.truncated === true ? ' (truncated)' : ''}`
    }
    if (typeof parsed.content === 'string' && typeof parsed.path === 'string') {
      const sha = typeof parsed.sha256 === 'string' ? ` sha256=${String(parsed.sha256).slice(0, 12)}…` : ''
      return `- ${label} ${scope}${String(parsed.path)}${sha} (content retained in loaded evidence when available)`
    }
    if (typeof parsed.error === 'string') {
      return `- ${label} ${scope}${parsed.status ?? 'failed'}: ${String(parsed.error).slice(0, 160)}`
    }
    if (typeof parsed.status === 'string' && parsed.status !== 'completed') {
      return `- ${label} ${scope}${String(parsed.status)}`
    }
  }
  const fallback = message.content.length > 160 ? `${message.content.slice(0, 160)}…` : message.content
  return `- ${label} ${scope}${fallback}`
}

/**
 * pi-inspired deterministic handoff (no extra LLM call): when old turn units
 * are pruned to fit the budget, keep exact digests (paths/hashes/queries)
 * instead of dropping them silently. Unlike pi's LLM summary this never
 * paraphrases hashes, so workspace.edit expectedHash stays valid.
 */
export function droppedTurnsHandoffMessage(dropped: JanusAgentMessage[][]): JanusAgentMessage | undefined {
  const lines = dropped.flatMap((unit) => unit.map(toolDigest).filter((line): line is string => !!line))
  if (lines.length === 0) return undefined
  const boundedLines = lines.slice(-24)
  return {
    role: 'system',
    content: [
      `Older workspace evidence (${lines.length} tool results) was pruned to fit the context budget.`,
      'Continue from these digests instead of re-listing blindly. Re-read a file before editing it.',
      ...boundedLines,
    ].join('\n'),
  }
}
function agentTurnUnits(messages: JanusAgentMessage[]): JanusAgentMessage[][] {
  const units: JanusAgentMessage[][] = []
  for (let index = messages.length - 1; index >= 0;) {
    if (messages[index].role !== 'tool') {
      units.push([messages[index]])
      index -= 1
      continue
    }
    const end = index + 1
    while (index >= 0 && messages[index].role === 'tool') index -= 1
    const start = index >= 0 && messages[index].role === 'assistant' && messages[index].toolCalls?.length
      ? index
      : index + 1
    units.push(messages.slice(start, end))
    index = start - 1
  }
  return units
}

export interface ChatContextBuildOptions {
  model?: Pick<ModelInfo, 'contextWindow' | 'maxOutputTokens'>
}

/** Builds a model context view without mutating the persisted conversation history. */
export class ChatSessionRuntime {
  readonly loadedContext = new LoadedContextIndex()

  recordToolResult(result: ToolResult): void {
    this.loadedContext.record(result)
  }

  buildContext(messages: JanusAgentMessage[], options: ChatContextBuildOptions = {}): JanusAgentMessage[] {
    const contextWindow = options.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
    const reservedOutput = Math.min(options.model?.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS, DEFAULT_RESERVED_OUTPUT_TOKENS)
    const budget = contextWindow - reservedOutput - SAFETY_MARGIN_TOKENS
    const systems = messages.filter((message) => message.role === 'system')
    const systemTokens = systems.reduce((total, message) => total + estimateTokens(message.content), 0)
    if (systemTokens >= budget) throw new Error('SYSTEM_CONTEXT_EXCEEDS_BUDGET')

    const context = [...systems]
    let usedTokens = systemTokens
    const evidence = this.loadedContext.asSystemMessage(Math.max(0, budget - usedTokens))
    if (evidence) {
      context.push(evidence)
      usedTokens += estimateTokens(evidence.content)
    }

    const insertAt = systems.length + (evidence ? 1 : 0)
    const units = agentTurnUnits(messages.filter((message) => message.role !== 'system'))
    const dropped: JanusAgentMessage[][] = []
    let keptCount = 0
    for (const unit of units) {
      const compacted = unit.map(compactToolMessage)
      const unitTokens = compacted.reduce((total, message) => total + estimateTokens(message.content), 0)
      if (usedTokens + unitTokens > budget) {
        if (keptCount === 0) throw new Error('CURRENT_TURN_EXCEEDS_CONTEXT_BUDGET')
        dropped.push(unit)
        continue
      }
      // Units arrive newest-first; always splicing at the same index restores
      // chronological order: [systems, evidence, oldest..newest].
      context.splice(insertAt, 0, ...compacted)
      usedTokens += unitTokens
      keptCount += 1
    }
    // Summarize everything pruned so exploration is not silently lost.
    // pi uses an LLM summary here; we use exact digests to keep sha256 usable.
    if (dropped.length > 0) {
      const handoff = droppedTurnsHandoffMessage(dropped)
      if (handoff) {
        const handoffTokens = estimateTokens(handoff.content)
        if (usedTokens + handoffTokens <= budget) {
          context.splice(insertAt, 0, handoff)
          usedTokens += handoffTokens
        } else {
          // Budget too tight for the full digest: keep a truncated head note
          // rather than dropping exploration entirely.
          const head = bounded(handoff.content, Math.max(256, (budget - usedTokens) * 4 - 64))
          if (usedTokens + estimateTokens(head.value) <= budget) {
            context.splice(insertAt, 0, { role: 'system', content: head.value })
          }
        }
      }
    }
    return context
  }
}
