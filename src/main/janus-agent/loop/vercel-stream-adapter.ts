import { streamText } from '../../llm/ai-runtime'
import { ToolCallAccumulator } from '../stream/tool-call-accumulator'
import type { AgentStreamToolCall, AgentUsage, NormalizedProviderError } from '../stream/types'
import type {
  JanusAgentEvent,
  JanusAgentMessage,
  JanusAgentStreamResult,
  JanusAgentTool,
  JanusToolCall,
} from './janus-agent-loop'

interface VercelTool {
  description?: string
  parameters: unknown
  execute?: (input: any) => Promise<unknown> | unknown
}

interface VercelStreamResult {
  textStream: AsyncIterable<string>
  fullStream?: AsyncIterable<VercelStreamPart>
  toolCalls?: Promise<Array<{ toolCallId: string; toolName: string; args: unknown }>>
}

interface VercelStreamPart {
  type: string
  textDelta?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  argsTextDelta?: string
  args?: unknown
  finishReason?: unknown
  usage?: { promptTokens?: number; completionTokens?: number }
  error?: unknown
}

type StreamTextFn = (options: Record<string, unknown>) => VercelStreamResult | Promise<VercelStreamResult>

/**
 * P6+R5：建流与消费期共用同一尝试预算（单轮最多 3 次 streamText 调用，
 * 退避 250ms→500ms，1000ms 仅 cap）。
 * R5 安全边界：消费期错误仅当本轮尝试尚未产生任何用户可见进度
 * （正文/推理/工具事件）时才重开一轮——下游（streamedText/pendingContent/
 * ThinkingRegion）没有丢弃重放机制，重试有进度轮次会造成正文翻倍。
 * INVALID_TOOL_CALL 等不可重试错误与有进度后的失败走原 model_error 通道不变。
 */
const MAX_STREAM_ATTEMPTS = 3

async function streamRetryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000)))
}

/** 仅在外层尝试循环内流转，从不逃逸到 stream 调用方（耗尽时调用处已转终态错误）。 */
class RetryableAttemptFailed extends Error {}

function parseToolResult(content: string): unknown {
  try { return JSON.parse(content) } catch { return content }
}

export function toVercelMessages(messages: JanusAgentMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.toolCallId ?? '',
          toolName: message.toolName ?? '',
          result: parseToolResult(message.content),
        }],
      }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool-call', toolCallId: call.id, toolName: call.name, args: call.arguments,
          })),
        ],
      }
    }
    return { role: message.role, content: message.content }
  })
}

export function createVercelModelTools(tools: Record<string, VercelTool>): Record<string, Omit<VercelTool, 'execute'>> {
  return Object.fromEntries(Object.entries(tools).map(([name, { execute: _execute, ...tool }]) => [name, tool]))
}

export function createLoopToolsFromVercel(tools: Record<string, VercelTool>): JanusAgentTool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    executionMode: 'sequential',
    execute: async (call, signal) => {
      if (signal.aborted) return { content: 'Tool execution cancelled', isError: true }
      if (!tool.execute) return { content: `Tool has no executor: ${name}`, isError: true }
      try {
        const output = await tool.execute(
          call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
            ? call.arguments as Record<string, unknown>
            : {},
        )
        return { content: typeof output === 'string' ? output : JSON.stringify(output) }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toolValidation(tools: Record<string, VercelTool> | undefined, call: AgentStreamToolCall): string | undefined {
  const tool = tools?.[call.name]
  if (!tool) return `Unknown tool: ${call.name}`
  if (!isRecord(call.arguments)) return `Invalid arguments for tool: ${call.name}`
  const schema = tool.parameters as { safeParse?: (input: unknown) => { success: boolean } }
  return schema.safeParse && !schema.safeParse(call.arguments).success
    ? `Invalid arguments for tool: ${call.name}`
    : undefined
}

function finishReason(value: unknown): 'stop' | 'tool_calls' | 'length' | 'unknown' {
  if (value === 'stop' || value === 'tool-calls' || value === 'length') {
    return value === 'tool-calls' ? 'tool_calls' : value
  }
  return 'unknown'
}

function usage(value: VercelStreamPart['usage']): AgentUsage | undefined {
  if (!value) return undefined
  return { promptTokens: value.promptTokens ?? 0, completionTokens: value.completionTokens ?? 0 }
}

function modelError(error: unknown): NormalizedProviderError {
  const source = isRecord(error) ? error : undefined
  const status = typeof source?.statusCode === 'number'
    ? source.statusCode
    : typeof source?.status === 'number' ? source.status : undefined
  return {
    code: error instanceof Error && error.name ? error.name : 'PROVIDER_STREAM_ERROR',
    message: error instanceof Error && error.message ? error.message : 'Provider stream failed',
    retryable: status === 429 || (status !== undefined && status >= 500),
    ...(status !== undefined ? { status } : {}),
  }
}

function asToolCall(part: VercelStreamPart): { callId: string; name?: string; arguments?: unknown } | undefined {
  return typeof part.toolCallId === 'string' && part.toolCallId
    ? { callId: part.toolCallId, name: part.toolName, arguments: part.args }
    : undefined
}

export function createVercelStream(options: {
  model: unknown
  tools?: Record<string, VercelTool>
  streamTextFn?: StreamTextFn
}) {
  const modelTools = options.tools ? createVercelModelTools(options.tools) : undefined
  const streamTextFn = options.streamTextFn ?? streamText as unknown as StreamTextFn
  async function runStreamAttempt(
    attemptMessages: JanusAgentMessage[],
    attemptSignal: AbortSignal,
    attemptEmit: (event: JanusAgentEvent) => void,
    canRetry: boolean,
  ): Promise<JanusAgentStreamResult> {
    const assistant: JanusAgentMessage = { role: 'assistant', content: '' }
    attemptEmit({ type: 'message_start', message: assistant })
    let result: VercelStreamResult
    try {
      result = await streamTextFn({
        model: options.model,
        messages: toVercelMessages(attemptMessages),
        abortSignal: attemptSignal,
        ...(modelTools ? { tools: modelTools } : {}),
        ...(modelTools ? { experimental_toolCallStreaming: true } : {}),
        maxSteps: 1,
      })
    } catch (error) {
      if (canRetry && !attemptSignal.aborted && modelError(error).retryable) {
        throw new RetryableAttemptFailed(error instanceof Error ? error.message : 'Provider stream failed', { cause: error })
      }
      throw error
    }
    // R5：本轮已向下游吐过用户可见进度即不可再重试（见文件顶注释）。
    let emittedProgress = false
    const emitProgress = (event: JanusAgentEvent) => { emittedProgress = true; attemptEmit(event) }
    const failConsumption = (error: unknown): never => {
      if (canRetry && !attemptSignal.aborted && !emittedProgress && modelError(error).retryable) {
        throw new RetryableAttemptFailed(error instanceof Error ? error.message : 'Provider stream failed', { cause: error })
      }
      throw error
    }
    const accumulator = new ToolCallAccumulator({ validate: (call) => toolValidation(options.tools, call) })
    const toolCalls: JanusToolCall[] = []
    const completeToolCall = (input: { callId: string; name?: string; arguments?: unknown }) => {
      const resolution = accumulator.complete(input)
      if (resolution.status === 'ready') {
        const call: JanusToolCall = resolution.call
        toolCalls.push(call)
        emitProgress({ type: 'tool_call_ready', call })
        return
      }
      if (resolution.status === 'invalid') {
        const error: NormalizedProviderError = {
          code: 'INVALID_TOOL_CALL',
          message: resolution.error,
          retryable: false,
        }
        attemptEmit({ type: 'model_error', error })
        throw new Error(resolution.error)
      }
    }

    try {
      if (result.fullStream) {
        for await (const part of result.fullStream) {
          if (attemptSignal.aborted) break
          switch (part.type) {
            case 'text-delta': {
              const delta = part.textDelta ?? part.delta ?? ''
              assistant.content += delta
              emitProgress({ type: 'message_update', delta })
              break
            }
            case 'reasoning-delta':
              emitProgress({ type: 'reasoning_update', delta: part.textDelta ?? part.delta ?? '' })
              break
            case 'tool-call-streaming-start':
              if (part.toolCallId && accumulator.start(part.toolCallId, part.toolName)) {
                emitProgress({ type: 'tool_call_start', callId: part.toolCallId, name: part.toolName })
              }
              break
            case 'tool-call-delta':
              if (part.toolCallId) {
                const started = accumulator.start(part.toolCallId, part.toolName)
                if (started) emitProgress({ type: 'tool_call_start', callId: part.toolCallId, name: part.toolName })
                if (accumulator.append(part.toolCallId, part.argsTextDelta ?? part.delta ?? '', part.toolName)) {
                  emitProgress({
                    type: 'tool_call_update',
                    callId: part.toolCallId,
                    name: part.toolName,
                    argumentsDelta: part.argsTextDelta ?? part.delta ?? '',
                  })
                }
              }
              break
            case 'tool-call': {
              const call = asToolCall(part)
              if (call) completeToolCall(call)
              break
            }
            case 'finish':
              emitProgress({ type: 'model_finish', reason: finishReason(part.finishReason), usage: usage(part.usage) })
              break
            case 'error': {
              const error = modelError(part.error)
              if (canRetry && !attemptSignal.aborted && !emittedProgress && error.retryable) {
                throw new RetryableAttemptFailed(error.message, { cause: part.error })
              }
              attemptEmit({ type: 'model_error', error })
              throw new Error(error.message)
            }
          }
        }
      } else {
        for await (const delta of result.textStream) {
          if (attemptSignal.aborted) break
          assistant.content += delta
          emitProgress({ type: 'message_update', delta })
        }
        const calls = await (result.toolCalls ?? Promise.resolve([]))
        for (const call of calls) completeToolCall({
          callId: call.toolCallId,
          name: call.toolName,
          arguments: call.args,
        })
      }
    } catch (error) {
      if (error instanceof RetryableAttemptFailed) throw error
      failConsumption(error)
    }
    if (toolCalls.length) assistant.toolCalls = toolCalls
    return { message: assistant, toolCalls }
  }

  return async (
    messages: JanusAgentMessage[],
    signal: AbortSignal,
    emit: (event: JanusAgentEvent) => void,
  ): Promise<JanusAgentStreamResult> => {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return await runStreamAttempt(messages, signal, emit, attempt < MAX_STREAM_ATTEMPTS)
      } catch (error) {
        if (!(error instanceof RetryableAttemptFailed) || attempt >= MAX_STREAM_ATTEMPTS || signal.aborted) throw error
        await streamRetryDelay(attempt)
        if (signal.aborted) throw error
      }
    }
  }
}
