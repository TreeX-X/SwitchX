/**
 * @file LLM IPC Handlers
 * @description IPC 通信处理器，暴露 LLM 服务给渲染进程。
 *              流式聊天编排已下沉到 janus-agent/chat-orchestrator（audit A2），
 *              本文件只做参数解包与 handler 注册。
 */

import { ipcMain } from 'electron'
import { llmService } from '../llm/LlmService'
import type { ProviderSettings } from '@janusx/llm-core'
import { knowledgeObservationService } from '../knowledge/observation-service'
import { knowledgeProcessingQueue } from '../knowledge/processing-queue'
import { getModelCatalogService } from '../llm/ModelCatalogService'
import { LLM_CHANNELS } from '../../shared/ipc/llm'
import type { ChatWorkspaceResource, LlmRuntimeStatus } from '../../shared/ipc/llm'
import { getDevelopmentLlmSyncStatus } from '../llm/development-config-sync'
import { generateText } from '../llm/ai-runtime'
import {
  abortChatStream,
  cancelChatSteer,
  handleChatStream,
  prepareJanusChatRecall,
  steerChatStream,
  type ChatMessage,
  type ChatStreamRequest,
} from '../llm/chat-orchestrator'

export {
  abortAllChatStreams,
  prepareJanusChatRecall,
  toolTraceEntryFromResult,
  toolTraceHistoryMessage,
} from '../llm/chat-orchestrator'

/** 对话请求参数 */
interface ChatRequest {
  messages: ChatMessage[]
  providerId: string
  modelId?: string
  sourceTag?: 'janus-chat'
  conversationId?: string
  workspaceId?: string
  workspacePath?: string
  workspaceResources?: ChatWorkspaceResource[]
}

let connectionStatus: LlmRuntimeStatus['connection'] = { state: 'checking' }

export async function refreshLlmRuntimeStatus(): Promise<LlmRuntimeStatus> {
  try {
    const configured = await llmService.getDefaultModel()
    if (!configured) {
      connectionStatus = { state: 'unconfigured', checkedAt: new Date().toISOString() }
    } else {
      const result = await llmService.testConnection(configured.provider, configured.modelId)
      connectionStatus = {
        state: result.success ? 'available' : 'unavailable',
        providerId: configured.provider.id,
        checkedAt: new Date().toISOString(),
        ...(result.latency !== undefined ? { latency: result.latency } : {}),
        ...(!result.success && result.error ? { error: result.error.slice(0, 500) } : {}),
      }
    }
  } catch (error) {
    connectionStatus = {
      state: 'unavailable',
      checkedAt: new Date().toISOString(),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    }
  }
  return { profileSync: getDevelopmentLlmSyncStatus(), connection: { ...connectionStatus } }
}

/**
 * 注册 LLM 相关的 IPC handlers
 */
export function registerLlmHandlers(): void {
  ipcMain.handle(LLM_CHANNELS.runtimeStatus, () => refreshLlmRuntimeStatus())
  ipcMain.handle(LLM_CHANNELS.getCatalog, () => getModelCatalogService().getCatalog())
  ipcMain.handle(LLM_CHANNELS.refreshCatalog, async () => {
    const catalogService = getModelCatalogService()

    // Refreshing the catalog uses the main-process fetch implementation. Make
    // sure proxy detection has completed before the first request, then retry
    // once after re-detecting the proxy when the request fails.
    await llmService.initialize()
    let result = await catalogService.refresh()
    if (!result.success) {
      await llmService.initialize()
      result = await catalogService.refresh()
    }
    return result
  })

  // 获取所有 Provider 配置
  ipcMain.handle(LLM_CHANNELS.getProviders, async () => {
    try {
      return await llmService.getAllProviders()
    } catch (error: any) {
      console.error('[IPC] llm:get-providers error:', error)
      throw error
    }
  })

  // 保存 Provider 配置
  ipcMain.handle(LLM_CHANNELS.saveProvider, async (_, settings: ProviderSettings) => {
    try {
      return await llmService.saveProvider(settings)
    } catch (error: any) {
      console.error('[IPC] llm:save-provider error:', error)
      return { success: false, error: error.message }
    }
  })

  // 测试连接
  ipcMain.handle(LLM_CHANNELS.testConnection, async (_, payload: ProviderSettings & { testModel?: string }) => {
    try {
      return await llmService.testConnection(payload, payload.testModel)
    } catch (error: any) {
      console.error('[IPC] llm:test-connection error:', error)
      return { success: false, error: error.message }
    }
  })

  // 删除 Provider
  ipcMain.handle(LLM_CHANNELS.removeProvider, async (_, providerId: string) => {
    try {
      await llmService.removeProvider(providerId)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] llm:remove-provider error:', error)
      return { success: false, error: error.message }
    }
  })

  // 设置默认 Provider
  ipcMain.handle(LLM_CHANNELS.setDefaultProvider, async (_, providerId: string) => {
    try {
      await llmService.setDefaultProvider(providerId)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] llm:set-default-provider error:', error)
      return { success: false, error: error.message }
    }
  })

  // 获取可用模型列表
  ipcMain.handle(LLM_CHANNELS.listModels, async (_, providerId: string) => {
    try {
      return await llmService.listModels(providerId)
    } catch (error: any) {
      console.error('[IPC] llm:list-models error:', error)
      throw error
    }
  })

  // 获取可用适配器类型
  ipcMain.handle(LLM_CHANNELS.getAdapters, async () => {
    try {
      return llmService.getAvailableAdapters()
    } catch (error: any) {
      console.error('[IPC] llm:get-adapters error:', error)
      throw error
    }
  })

  // 获取默认 Provider
  ipcMain.handle(LLM_CHANNELS.getDefaultProvider, async () => {
    try {
      return await llmService.getDefaultModel()
    } catch (error: any) {
      console.error('[IPC] llm:get-default-provider error:', error)
      return null
    }
  })

  // 对话请求（非流式）
  ipcMain.handle(LLM_CHANNELS.chat, async (_, request: ChatRequest) => {
    try {
      const { messages, providerId, modelId, sourceTag, workspaceId, workspacePath, workspaceResources } = request
      const soleResource = workspaceResources?.length === 1 ? workspaceResources[0] : undefined

      const settings = await llmService.getProviderSettings(providerId)
      if (!settings) {
        throw new Error(`Provider "${providerId}" 未配置`)
      }

      const actualModelId = modelId || settings.modelId || ''
      if (!actualModelId) throw new Error('No model ID configured')

      // 过滤掉空内容的消息
      let formattedMessages = messages
        .filter(m => m.content && m.content.trim().length > 0)
        .map(m => ({
          role: m.role,
          content: m.content
        }))

      if (sourceTag === 'janus-chat') {
        formattedMessages = (await prepareJanusChatRecall(
          'non-stream',
          formattedMessages,
          soleResource?.workspaceId ?? workspaceId,
          soleResource?.workspacePath ?? workspacePath,
        )).messages
      }

      // 使用 AI SDK
      const model = await llmService.getLanguageModel(providerId, actualModelId)

      const result = await generateText({
        model: model as any,
        messages: formattedMessages.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content
        })),
      })

      if (sourceTag === 'janus-chat' && soleResource) {
        const userMessage = [...formattedMessages].reverse().find((message) => message.role === 'user')
        // Non-stream chat has no requestId; the owning session is the attached
        // agent session, falling back to the chat conversation.
        const sessionId = soleResource.agentSessionId || request.conversationId
        if (userMessage) {
          await knowledgeObservationService.capture({
            workspaceId: soleResource.workspaceId,
            workspacePath: soleResource.workspacePath,
            source: 'janus-chat',
            type: 'conversation-turn',
            content: userMessage.content,
            summary: 'Janus Chat user message',
            tags: ['janus-chat', 'user'],
            actor: 'user',
            sessionId,
          })
        }
        const assistantObservation = await knowledgeObservationService.capture({
          workspaceId: soleResource.workspaceId,
          workspacePath: soleResource.workspacePath,
          source: 'janus-chat',
          type: 'conversation-turn',
          content: result.text || '',
          summary: 'Janus Chat assistant response',
          tags: ['janus-chat', 'assistant'],
          actor: 'assistant',
          sessionId,
          metadata: {
            providerId,
            modelId: actualModelId,
          },
        })
        // Phase 5 (§6 gap close): non-stream chat also ends a session turn.
        knowledgeProcessingQueue.scheduleImmediate(
          assistantObservation?.workspaceId ?? soleResource.workspaceId,
        )
      }

      return result.text || ''
    } catch (error: any) {
      console.error('[IPC] llm:chat error:', error.message)
      throw error
    }
  })

  // 流式对话请求（单向 send/on 模式，确保事件可靠送达渲染端）
  // handleChatStream 内部全量捕获异常，不会产生 unhandled rejection
  ipcMain.on(LLM_CHANNELS.chatStream, (event, request: ChatStreamRequest) => handleChatStream(event, request))

  // 中止流式请求
  ipcMain.handle(LLM_CHANNELS.abort, async (_, requestId: string) => {
    abortChatStream(requestId)
    return { success: true }
  })

  // R6-full：流式中 steering 投递与撤销（目标不存在/流已结束即拒绝，由渲染端回退）。
  ipcMain.handle(LLM_CHANNELS.steer, async (_, input: { conversationId?: string; entryId: string; text: string }) => {
    return steerChatStream(input ?? { entryId: '', text: '' })
  })
  ipcMain.handle(LLM_CHANNELS.steerCancel, async (_, input: { conversationId?: string; entryId: string }) => {
    return cancelChatSteer(input ?? { entryId: '' })
  })

}
