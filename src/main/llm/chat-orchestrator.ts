/**
 * @file Chat 流式编排器（M3 收薄：Electron 壳适配器）
 * @description 整轮语义（资源校验、knowledge recall、工具装配、recovery、
 * 空回复兜底、observation 落库）已下沉到 `@janus-agent/janus-agent` 的
 * `runChatTurn`；本文件只保留壳侧能力，任何改动配 twin test
 * （tests/unit/llm/janus-agent-ports.test.ts）：
 *              - AbortController 生命周期与重复 requestId 仲裁
 *              - R6 steering 目标注册（端口实例来自 agent-core，壳只管生命周期）
 *              - ChatSessionRuntime LRU（实例来自 chat-core，随请求传入）
 *              - delta 40ms 合批 + reasoning 8k 转发上限（降 IPC 开销）
 *              - 窗口销毁守卫（reply 前检查 isDestroyed）
 *              - IPC 扇出：agentEvent / legacy delta / recallTrace / toolTrace / done / error
 * 偏离说明：recallTrace 通道改为整轮结束后再发（facade 经 result 返回；
 * 同 requestId，渲染端行为不变，仅徽标出现时机后移）。
 */

import { llmService } from './LlmService'
import { configService, DEFAULT_AGENT_MAX_STEPS } from '../config/service'
import { knowledgeObservationService } from '../knowledge/observation-service'
import { knowledgeProcessingQueue } from '../knowledge/processing-queue'
import { knowledgeContextService } from '../knowledge/context-service'
import { LLM_CHANNELS } from '../../shared/ipc/llm'
import type { ChatAgentEvent, ChatWorkspaceResource } from '../../shared/ipc/llm'
import { workspaceAgentRuntime } from '../agent/runtime/shell-runtime'
import { streamText } from './ai-runtime'
import {
  runChatTurn,
  type ChatTurnPorts,
} from '@janus-agent/janus-agent'
import { AgentSteeringPort } from '@janus-agent/agent-core'
import {
  ChatSessionRuntime,
  hasExplicitWorkspaceMutationIntent,
  prepareJanusChatRecall as prepareCoreRecall,
  toolTraceEntryFromResult,
  toolTraceHistoryMessage,
} from '@janus-agent/chat-core'
import {
  buildJanusChatTurnPorts,
  type JanusCaptureInput,
} from './janus-agent-ports'

/** 对话消息类型 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 流式对话请求参数 */
export interface ChatStreamRequest {
  requestId: string
  messages: ChatMessage[]
  providerId: string
  modelId?: string
  sourceTag?: 'janus-chat'
  conversationId?: string
  workspaceId?: string
  workspacePath?: string
  workspaceResources?: ChatWorkspaceResource[]
  toolTraces?: import('../../shared/ipc/llm').ChatToolTraceEntry[]
}

/*-- 纯 helper 继续沿用 chat-core（llm-handlers 与单测经此 re-export，链路不断） --*/
export { hasExplicitWorkspaceMutationIntent, toolTraceEntryFromResult, toolTraceHistoryMessage }

type ContextSearch = typeof knowledgeContextService.search

/**
 * Positional wrapper over chat-core's object-form recall (llm-handlers 的
 * 非流式路径沿用旧签名；默认后端仍是 knowledgeContextService）。
 */
export async function prepareJanusChatRecall(
  requestId: string,
  messages: ChatMessage[],
  workspaceId?: string,
  workspacePath?: string,
  search: ContextSearch = knowledgeContextService.search.bind(knowledgeContextService),
): Promise<{ messages: ChatMessage[]; trace: import('@janus-agent/chat-core').KnowledgeRecallTrace }> {
  return prepareCoreRecall({ requestId, messages, workspaceId, workspacePath, search })
}

/*-- delta 合批窗口：高速流下把每 token 一次 IPC 压到每 40ms 一次 --*/
const DELTA_FLUSH_MS = 40
/*-- 推理增量仅 UI 展示：超限后不再转发，省 IPC（渲染端另有 4k 截断） --*/
const REASONING_FORWARD_CAP_CHARS = 8_000

/** P6：默认 40（P6 前硬编码 20），经 agentMaxSteps 配置可调，仅 janus-chat 通道。 */
const CHAT_MAX_STEPS = DEFAULT_AGENT_MAX_STEPS

/** Active streaming chat abort controllers (module-scoped for shutdown). */
const abortControllers = new Map<string, AbortController>()
const chatSessions = new Map<string, ChatSessionRuntime>()
const MAX_CHAT_SESSIONS = 32

function getChatSession(conversationId: string): ChatSessionRuntime {
  const existing = chatSessions.get(conversationId)
  if (existing) {
    chatSessions.delete(conversationId)
    chatSessions.set(conversationId, existing)
    return existing
  }
  const session = new ChatSessionRuntime()
  chatSessions.set(conversationId, session)
  while (chatSessions.size > MAX_CHAT_SESSIONS) {
    const oldest = chatSessions.keys().next().value
    if (!oldest) break
    chatSessions.delete(oldest)
  }
  return session
}

/** Abort every in-flight LLM chat stream. Safe to call repeatedly. */
export function abortAllChatStreams(): void {
  for (const controller of abortControllers.values()) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }
  abortControllers.clear()
}

export function abortChatStream(requestId: string): void {
  abortControllers.get(requestId)?.abort()
}

/**
 * R6-full：进行中流的 steering 目标注册（key = conversationId ?? requestId）。
 * 队列只活在请求生命周期内：renderer 历史已乐观追加用户原文并随会话落盘，
 * 主侧无需另行落盘；请求结束（成功/失败/取消）即丢弃未消费条目——下次发送
 * 会从渲染端历史自然带上这些文本，不丢不重。
 */
const activeSteerTargets = new Map<string, { requestId: string; port: AgentSteeringPort }>()
const MAX_STEER_ENTRIES_PER_REQUEST = 10

export function steerChatStream(input: { conversationId?: string; entryId: string; text: string }): { accepted: boolean; error?: string } {
  const content = typeof input.text === 'string' ? input.text.trim() : ''
  if (!content) return { accepted: false, error: 'Empty steering text' }
  if (typeof input.entryId !== 'string' || !input.entryId) return { accepted: false, error: 'Invalid steering entry id' }
  const key = input.conversationId || ''
  const target = key ? activeSteerTargets.get(key) : undefined
  if (!target || !abortControllers.has(target.requestId)) {
    if (key) activeSteerTargets.delete(key)
    return { accepted: false, error: 'No active stream for this conversation' }
  }
  if (target.port.size >= MAX_STEER_ENTRIES_PER_REQUEST) {
    return { accepted: false, error: 'Steering queue is full for this stream' }
  }
  // 入队即抢占：port 内部打断在途流式尝试；工具执行中则到间隙应用。
  target.port.push(input.entryId, { role: 'user', content })
  return { accepted: true }
}

export function cancelChatSteer(input: { conversationId?: string; entryId: string }): { cancelled: boolean } {
  const key = input.conversationId || ''
  const target = key ? activeSteerTargets.get(key) : undefined
  if (!target) return { cancelled: false }
  return { cancelled: target.port.remove(input.entryId) }
}

/** 单向 send/on 模式的 chatStream 事件端点（渲染端按 requestId 过滤） */
interface ChatStreamReplyTarget {
  reply: (channel: string, payload: unknown) => void
  sender?: { id?: number; isDestroyed?: () => boolean }
}

/** 壳默认 ports：生产单例装配（可注入版本见 janus-agent-ports）。 */
function defaultChatTurnPorts(callerId: string): ChatTurnPorts {
  return buildJanusChatTurnPorts({
    callerId,
    getProviderSettings: (providerId) => llmService.getProviderSettings(providerId),
    getLanguageModel: (providerId, modelId) => llmService.getLanguageModel(providerId, modelId),
    listModels: (providerId) => {
      const catalog = llmService as typeof llmService & {
        listModels?: (provider: string) => Promise<Array<{ id: string; supportsFunctionCalling?: boolean; contextWindow?: number; maxOutputTokens?: number }>>
      }
      return typeof catalog.listModels === 'function' ? catalog.listModels(providerId) : Promise.resolve([])
    },
    getMaxTurns: () => configService.getAgentMaxSteps().catch(() => CHAT_MAX_STEPS),
    getAgentSession: (agentSessionId) => workspaceAgentRuntime.getSession(agentSessionId),
    executeFunctionCall: (input, caller) => workspaceAgentRuntime.executeFunctionCall(input, caller),
    listRegistryTools: () => workspaceAgentRuntime.registry.list(),
    listRegistryManifests: () => workspaceAgentRuntime.registry.listManifests?.(),
    knowledgeSearch: (input) => knowledgeContextService.search({
      query: input.query,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      maxItems: input.maxItems,
      maxChars: input.maxChars,
    }),
    captureObservation: (input: JanusCaptureInput) => knowledgeObservationService.capture({
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      source: input.source,
      type: input.type,
      content: input.content,
      summary: input.summary,
      tags: input.tags,
      actor: input.actor,
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }),
    scheduleSettled: (workspaceId) => {
      knowledgeProcessingQueue.scheduleImmediate(workspaceId)
    },
    streamTextFn: streamText as unknown as ChatTurnPorts['streamTextFn'],
  })
}

/** 流式对话编排：由 llm-handlers 的 ipcMain.on(chatStream) 委托调用 */
export async function handleChatStream(event: ChatStreamReplyTarget, request: ChatStreamRequest): Promise<void> {
  const { requestId, messages, providerId, modelId, sourceTag, conversationId, workspaceId, workspacePath, workspaceResources, toolTraces } = request

  // 重复 requestId：先中止旧流，避免旧 controller 被覆盖后失去 cancel 句柄
  const previous = abortControllers.get(requestId)
  if (previous) {
    try {
      previous.abort()
    } catch {
      // ignore
    }
  }

  const controller = new AbortController()
  let reasoningChars = 0
  abortControllers.set(requestId, controller)
  // R6-full：本请求的 steering 端口（重复 conversationId 时新请求直接覆盖旧目标）。
  const steerKey = conversationId || requestId
  const steeringPort = new AgentSteeringPort()
  activeSteerTargets.set(steerKey, { requestId, port: steeringPort })

  // 窗口销毁后 event.reply 会抛异常并造成 unhandled rejection，统一守卫
  const sendEvent = (
    channel: typeof LLM_CHANNELS.delta | typeof LLM_CHANNELS.done | typeof LLM_CHANNELS.error | typeof LLM_CHANNELS.recallTrace | typeof LLM_CHANNELS.toolTrace | typeof LLM_CHANNELS.agentEvent,
    payload: unknown,
  ) => {
    if (typeof event.sender?.isDestroyed === 'function' && event.sender.isDestroyed()) return
    try {
      event.reply(channel, payload)
    } catch {
      /* 窗口销毁竞态，丢弃事件 */
    }
  }

  const sendError = (message: string) => {
    sendEvent(LLM_CHANNELS.error, { requestId, error: message })
  }
  const sendAgentEvent = (agentEvent: ChatAgentEvent) => sendEvent(LLM_CHANNELS.agentEvent, agentEvent)

  // delta 合批：累积增量，40ms 定时 flush；循环结束/异常前强制 flush
  let pendingDelta = ''
  let deltaTimer: NodeJS.Timeout | null = null
  const flushDelta = () => {
    if (deltaTimer) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    if (!pendingDelta) return
    const delta = pendingDelta
    pendingDelta = ''
    sendEvent(LLM_CHANNELS.delta, { requestId, delta, done: false })
  }
  const queueDelta = (delta: string) => {
    pendingDelta += delta
    if (!deltaTimer) deltaTimer = setTimeout(flushDelta, DELTA_FLUSH_MS)
  }

  try {
    const callerId = `renderer:${event.sender?.id ?? 'unknown'}`
    const ports = defaultChatTurnPorts(callerId)
    const chatSession = getChatSession(conversationId ?? requestId)

    const result = await runChatTurn(
      {
        requestId,
        messages,
        providerId,
        modelId,
        sourceTag,
        conversationId,
        workspaceId,
        workspacePath,
        workspaceResources,
        toolTraces,
        callerId,
        chatSession,
        steeringPort,
      },
      ports,
      {
        onEvent: (agentEvent) => {
          if (controller.signal.aborted) return
          if (agentEvent.type === 'reasoning_delta') {
            if (reasoningChars >= REASONING_FORWARD_CAP_CHARS) return
            reasoningChars += agentEvent.delta.length
          }
          sendAgentEvent(agentEvent)
          if (agentEvent.type === 'text_delta') queueDelta(agentEvent.delta)
        },
      },
      controller.signal,
    )
    flushDelta()

    // 用户中止：半截回复不写入知识库（facade 内已跳过 capture），直接收尾
    if (controller.signal.aborted || result.cancelled) {
      // facade 在取消时已发 stream_end(cancelled)；此处只补 done 通道
      sendEvent(LLM_CHANNELS.done, { requestId })
      return
    }

    if (sourceTag === 'janus-chat' && result.recallTrace) {
      sendEvent(LLM_CHANNELS.recallTrace, result.recallTrace)
    }
    if (result.toolTraces.length > 0) {
      sendEvent(LLM_CHANNELS.toolTrace, { requestId, entries: result.toolTraces })
    }
    sendEvent(LLM_CHANNELS.delta, { requestId, delta: '', done: true })
    sendEvent(LLM_CHANNELS.done, { requestId })
  } catch (error: any) {
    flushDelta()
    // 用户主动取消时不作为错误上报
    if (controller.signal.aborted || error?.name === 'AbortError') {
      sendAgentEvent({ type: 'stream_end', requestId, cancelled: true })
      sendEvent(LLM_CHANNELS.done, { requestId })
      return
    }
    console.error('[IPC] llm:chat-stream error:', error.message || error)
    sendAgentEvent({ type: 'stream_error', requestId, error: error.message || String(error) })
    sendError(error.message || String(error))
  } finally {
    if (deltaTimer) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    // R6-full：请求结束即丢弃 steering 目标（未消费条目以渲染端历史为准，不补发）。
    const steerTarget = activeSteerTargets.get(steerKey)
    if (steerTarget?.requestId === requestId) {
      activeSteerTargets.delete(steerKey)
    }
    // 重复 requestId 时新流已换新 controller，只清理仍属于本次的条目
    if (abortControllers.get(requestId) === controller) {
      abortControllers.delete(requestId)
    }
  }
}
