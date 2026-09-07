import type { AgentUsage, NormalizedProviderError } from '../stream/types'

/**
 * Policy-free agent loop shared by chat, project configuration, and blueprint tools.
 *
 * The loop owns turn and tool-call sequencing only. Approval, knowledge, tracing,
 * and persistence stay in hooks or the session layer.
 */

export interface JanusAgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolName?: string
  toolCalls?: JanusToolCall[]
}

export interface JanusToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface JanusAgentToolResult {
  content: string
  details?: unknown
  isError?: boolean
  terminate?: boolean
}

export interface JanusAgentTool {
  name: string
  executionMode?: 'sequential' | 'parallel'
  execute: (call: JanusToolCall, signal: AbortSignal, onUpdate?: (partialResult: unknown) => void) => Promise<JanusAgentToolResult>
}

export interface JanusAgentStreamResult {
  message: JanusAgentMessage
  toolCalls?: JanusToolCall[]
}

export type JanusAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: JanusAgentMessage[] }
  | { type: 'turn_start'; turn: number }
  | { type: 'turn_end'; turn: number; message: JanusAgentMessage; toolResults: JanusAgentMessage[] }
  | { type: 'message_start'; message: JanusAgentMessage }
  | { type: 'message_update'; delta: string }
  | { type: 'reasoning_update'; delta: string }
  | { type: 'message_end'; message: JanusAgentMessage }
  | { type: 'tool_call_start'; callId: string; name?: string }
  | { type: 'tool_call_update'; callId: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call_ready'; call: JanusToolCall }
  | { type: 'model_finish'; reason: 'stop' | 'tool_calls' | 'length' | 'unknown'; usage?: AgentUsage }
  | { type: 'model_error'; error: NormalizedProviderError }
  | { type: 'tool_execution_start'; call: JanusToolCall }
  | { type: 'tool_execution_update'; call: JanusToolCall; partialResult: unknown }
  | { type: 'tool_execution_end'; call: JanusToolCall; result: JanusAgentToolResult; isError: boolean }
  | { type: 'steering_consumed'; keys: string[] }

export interface JanusBeforeToolCallContext {
  call: JanusToolCall
  tool: JanusAgentTool
  turn: number
}

export interface JanusBeforeToolCallResult {
  block?: boolean
  reason?: string
  terminate?: boolean
}

export interface JanusAfterToolCallContext extends JanusBeforeToolCallContext {
  result: JanusAgentToolResult
}

export interface JanusShouldStopAfterTurnContext {
  turn: number
  message: JanusAgentMessage
  toolResults: JanusAgentMessage[]
  messages: JanusAgentMessage[]
}

export interface JanusAgentLoopConfig {
  tools: JanusAgentTool[]
  stream: (messages: JanusAgentMessage[], signal: AbortSignal, emit: (event: JanusAgentEvent) => void) => Promise<JanusAgentStreamResult>
  transformContext?: (messages: JanusAgentMessage[], signal: AbortSignal) => Promise<JanusAgentMessage[]>
  beforeToolCall?: (context: JanusBeforeToolCallContext, signal: AbortSignal) => Promise<JanusBeforeToolCallResult | undefined>
  afterToolCall?: (context: JanusAfterToolCallContext, signal: AbortSignal) => Promise<JanusAgentToolResult | undefined>
  getSteeringMessages?: (context: { turn: number; messages: JanusAgentMessage[] }) => Promise<JanusAgentMessage[]>
  /**
   * R6-full：轮中 steering 抢占端口（调用方创建并持有，生产者随时 push）。
   * - 流式生成中 push 会立即打断本轮 stream（仅生产者驱动，无轮询）。
   * - 工具执行中 push 不打断在途工具（副作用不可撤回），在串行工具间隙
   *   与并行批次结束后应用，已完成结果保留，未执行调用直接丢弃。
   * - 被打断轮次的半截 toolCalls 一律剥离（只保留正文）：半截调用配不到
   *   tool 结果，进模型上下文会违反 provider tool_use/tool_result 配对约束。
   * - 每条 steering 消耗 exactly once（destructive take），消耗时发
   *   steering_consumed 事件；被打断轮次同样计入 maxTurns（无限纠偏=无限花销）。
   */
  steeringPort?: AgentSteeringPort
  getFollowUpMessages?: (context: { turn: number; messages: JanusAgentMessage[] }) => Promise<JanusAgentMessage[]>
  /** pi parity: graceful stop after a completed turn, before steering/follow-up queues. */
  shouldStopAfterTurn?: (context: JanusShouldStopAfterTurnContext, signal: AbortSignal) => Promise<boolean>
  maxTurns?: number
  onEvent?: (event: JanusAgentEvent) => void
}

/** R6-full 抢占端口：生产者 push（附不透明 key 供消费回执），loop 在检查点 take。 */
export interface SteeredEntry {
  key: string
  message: JanusAgentMessage
}

export class AgentSteeringPort {
  private pending: SteeredEntry[] = []
  private preempt: (() => void) | null = null

  /** 生产者：入队并在流式生成中时立即打断（工具执行中仅排队，到间隙应用）。 */
  push(key: string, message: JanusAgentMessage): void {
    this.pending.push({ key, message })
    this.preempt?.()
  }

  /** 生产者：撤销尚未被消耗的条目，已消耗返回 false。 */
  remove(key: string): boolean {
    const index = this.pending.findIndex((entry) => entry.key === key)
    if (index < 0) return false
    this.pending.splice(index, 1)
    return true
  }

  get size(): number {
    return this.pending.length
  }

  /** loop 内部：轮次各检查点破坏性读取（exactly once）。 */
  take(): SteeredEntry[] {
    const taken = this.pending
    this.pending = []
    return taken
  }

  /** loop 内部：流式尝试起止时装配/拆除打断钩子。 */
  armPreempt(fn: (() => void) | null): void {
    this.preempt = fn
  }
}

function errorResult(error: unknown): JanusAgentToolResult {
  return {
    content: error instanceof Error ? error.message : String(error),
    isError: true,
  }
}

function toolMessage(call: JanusToolCall, result: JanusAgentToolResult): JanusAgentMessage {
  return { role: 'tool', content: result.content, toolCallId: call.id, toolName: call.name }
}

export async function runJanusAgentLoop(
  initialMessages: JanusAgentMessage[],
  config: JanusAgentLoopConfig,
  signal: AbortSignal = new AbortController().signal,
): Promise<JanusAgentMessage[]> {
  const tools = new Map(config.tools.map((tool) => [tool.name, tool]))
  const messages = [...initialMessages]
  const emit = (event: JanusAgentEvent) => config.onEvent?.(event)
  const maxTurns = Math.max(1, config.maxTurns ?? 20)

  emit({ type: 'agent_start' })
  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (signal.aborted) break
      emit({ type: 'turn_start', turn })
      // R6-full：本轮注入过 steering 则强制续轮（steering 本身就是“继续干”的
      // 指令，不能让无工具分支直接 break，否则纠偏无人回答）。
      let steeredThisTurn = false
      const context = config.transformContext
        ? await config.transformContext([...messages], signal)
        : [...messages]
      // R6-full：流式尝试独占一个 abort 域——steer 打断只杀本轮生成，
      // 不污染后续工具执行用的父 signal；父 abort 照常透传。
      const attemptController = new AbortController()
      const propagateParentAbort = () => attemptController.abort()
      signal.addEventListener('abort', propagateParentAbort, { once: true })
      if (signal.aborted) attemptController.abort()
      config.steeringPort?.armPreempt(() => attemptController.abort())
      let streamed: JanusAgentStreamResult
      try {
        streamed = await config.stream(context, attemptController.signal, emit)
      } finally {
        signal.removeEventListener('abort', propagateParentAbort)
        config.steeringPort?.armPreempt(null)
      }
      // R6-full：流式后检查点。被打断则收半截正文（toolCalls 一律剥离——
      // 半截调用配不到 tool 结果，进模型上下文会违反 provider
      // tool_use/tool_result 配对约束；其 tool_call_ready 卡片停在
      // requested，本轮 UI 状态，下轮重置），注入 steering，走无工具分支。
      const steeredAfterStream = config.steeringPort?.take() ?? []
      if (steeredAfterStream.length > 0) {
        emit({ type: 'steering_consumed', keys: steeredAfterStream.map((entry) => entry.key) })
        steeredThisTurn = true
        const keptText = streamed.message.content.trim()
        const keptMessage: JanusAgentMessage = { role: 'assistant', content: keptText }
        if (keptText) messages.push(keptMessage)
        emit({ type: 'message_end', message: keptMessage })
        messages.push(...steeredAfterStream.map((entry) => entry.message))
        streamed = { message: keptMessage, toolCalls: [] }
      } else {
        messages.push(streamed.message)
        emit({ type: 'message_end', message: streamed.message })
      }

      const toolCalls = streamed.toolCalls ?? []
      if (toolCalls.length === 0) {
        emit({ type: 'turn_end', turn, message: streamed.message, toolResults: [] })
        if (config.shouldStopAfterTurn
          && await config.shouldStopAfterTurn({ turn, message: streamed.message, toolResults: [], messages: [...messages] }, signal)) break
        const followUp = config.getFollowUpMessages ? await config.getFollowUpMessages({ turn, messages: [...messages] }) : []
        // R6-full：tail awaits（shouldStop/followUp）期间到达的 steering 同样强制续轮。
        if (config.steeringPort) {
          const lateSteered = config.steeringPort.take()
          if (lateSteered.length > 0) {
            emit({ type: 'steering_consumed', keys: lateSteered.map((entry) => entry.key) })
            steeredThisTurn = true
            messages.push(...lateSteered.map((entry) => entry.message))
          }
        }
        if (followUp.length === 0 && !steeredThisTurn) break
        messages.push(...followUp)
        continue
      }

      const toolResults: JanusAgentMessage[] = []
      // pi parity: stop only when EVERY finalized result in the batch sets
      // terminate:true; mixed batches continue normally.
      const terminateFlags: boolean[] = []
      // R6-full：工具间隙检查点。steer 不打断在途工具（副作用不可撤回），
      // 只在串行间隙与并行批次后应用；已完成结果保留，未执行调用直接丢弃。
      const pendingInject: JanusAgentMessage[] = []
      const drainSteering = (): boolean => {
        if (!config.steeringPort) return false
        const injected = config.steeringPort.take()
        if (injected.length === 0) return false
        emit({ type: 'steering_consumed', keys: injected.map((entry) => entry.key) })
        steeredThisTurn = true
        pendingInject.push(...injected.map((entry) => entry.message))
        return true
      }
      const execute = async (call: JanusToolCall): Promise<JanusAgentMessage> => {
        emit({ type: 'tool_execution_start', call })
        const tool = tools.get(call.name)
        if (!tool) {
          const result = errorResult(`Unknown tool: ${call.name}`)
          emit({ type: 'tool_execution_end', call, result, isError: true })
          terminateFlags.push(false)
          return toolMessage(call, result)
        }
        const before = config.beforeToolCall ? await config.beforeToolCall({ call, tool, turn }, signal) : undefined
        if (before?.block) {
          const result = { content: before.reason ?? 'Tool call blocked', isError: true, terminate: before.terminate }
          emit({ type: 'tool_execution_end', call, result, isError: true })
          terminateFlags.push(before.terminate === true)
          return toolMessage(call, result)
        }

        let result: JanusAgentToolResult
        try {
          result = await tool.execute(call, signal, (partialResult) => emit({ type: 'tool_execution_update', call, partialResult }))
        } catch (error) {
          result = errorResult(error)
        }
        const overridden = config.afterToolCall
          ? await config.afterToolCall({ call, tool, turn, result }, signal)
          : undefined
        result = overridden ?? result
        emit({ type: 'tool_execution_end', call, result, isError: result.isError === true })
        terminateFlags.push(result.terminate === true)
        return toolMessage(call, result)
      }

      const parallelCalls = toolCalls.filter((call) => tools.get(call.name)?.executionMode === 'parallel')
      const sequentialCalls = toolCalls.filter((call) => tools.get(call.name)?.executionMode !== 'parallel')
      toolResults.push(...await Promise.all(parallelCalls.map(execute)))
      let steeredMidTurn = drainSteering()
      if (!steeredMidTurn) {
        for (const call of sequentialCalls) {
          if (drainSteering()) {
            steeredMidTurn = true
            break
          }
          toolResults.push(await execute(call))
        }
      }
      messages.push(...toolResults, ...pendingInject)
      emit({ type: 'turn_end', turn, message: streamed.message, toolResults })
      if (terminateFlags.length > 0 && terminateFlags.every(Boolean)) break
      if (config.shouldStopAfterTurn
        && await config.shouldStopAfterTurn({ turn, message: streamed.message, toolResults, messages: [...messages] }, signal)) break

      // R6-full：轮尾检查点——覆盖 tail awaits（afterToolCall/shouldStop/
      // followUp）期间到达的 steering，与既有 getSteeringMessages 槽位合并。
      const lateSteered = config.steeringPort?.take() ?? []
      if (lateSteered.length > 0) {
        emit({ type: 'steering_consumed', keys: lateSteered.map((entry) => entry.key) })
      }
      const steering = [
        ...lateSteered.map((entry) => entry.message),
        ...(config.getSteeringMessages ? await config.getSteeringMessages({ turn, messages: [...messages] }) : []),
      ]
      if (steering.length > 0) messages.push(...steering)
    }
  } finally {
    emit({ type: 'agent_end', messages: [...messages] })
  }
  return messages
}
