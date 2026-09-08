/**
 * @file ChatTurnPorts adapter: JanusX shell services behind the agent facade.
 * @description Pure wiring (no Electron imports): every host capability is an
 * injected function so unit tests drive the adapter without singletons.
 * `chat-orchestrator.ts` supplies the production singletons; twin tests cover
 * parity with the pre-separation inline logic (same errors, same payloads).
 */
import type {
  ExecuteToolInput,
  ToolDefinition,
  ToolManifest,
  ToolResult,
} from '@janus-agent/agent-core'
import type { ChatTurnPorts } from '@janus-agent/janus-agent'
import type { KnowledgeSource, ObservationType, StructuredCloneValue } from '../../shared/knowledge'

export interface JanusAgentSessionShape {
  id: string
  status: string
  workspace: {
    workspaceId: string
    workspaceRoot: string
  }
}

export interface JanusModelInfoShape {
  id: string
  supportsFunctionCalling?: boolean
  contextWindow?: number
  maxOutputTokens?: number
}

export interface JanusCaptureInput {
  workspaceId: string
  workspacePath: string
  source: KnowledgeSource
  type: ObservationType
  content: string
  summary: string
  tags: string[]
  actor: string
  correlationId: string
  sessionId: string
  metadata?: Record<string, StructuredCloneValue>
}

export interface JanusChatTurnPortsDeps {
  callerId: string
  getProviderSettings: (providerId: string) => Promise<{ modelId?: string } | null>
  getLanguageModel: (providerId: string, modelId: string) => Promise<unknown>
  /** Optional: older LlmService shapes lack a catalog; the gate is then skipped. */
  listModels?: (providerId: string) => Promise<JanusModelInfoShape[]>
  getMaxTurns: () => Promise<number>
  getAgentSession: (agentSessionId: string) => JanusAgentSessionShape | null | undefined
  executeFunctionCall: (input: ExecuteToolInput, callerId: string) => Promise<ToolResult>
  listRegistryTools: () => ToolDefinition[]
  listRegistryManifests: () => ToolManifest[] | undefined
  knowledgeSearch: NonNullable<ChatTurnPorts['knowledgeSearch']>
  captureObservation: (input: JanusCaptureInput) => Promise<{ workspaceId?: string } | null | undefined>
  scheduleSettled: (workspaceId: string) => void
  streamTextFn: ChatTurnPorts['streamTextFn']
}

/**
 * Shell parity notes (twin-tested; deviation needs a twin test update):
 * - missing provider / model errors match the pre-separation messages
 * - unavailable sessions throw before any model call, same messages
 * - function-calling gate fires only on explicit `false`
 * - capture payloads (tags/actor/summary/metadata) match the inline version;
 *   `notifySettled` fires once per target workspace after capture
 */
export function buildJanusChatTurnPorts(deps: JanusChatTurnPortsDeps): ChatTurnPorts {
  return {
    model: {
      resolve: async (providerId, modelId) => {
        const settings = await deps.getProviderSettings(providerId)
        if (!settings) {
          throw new Error(`Provider "${providerId}" 未配置`)
        }
        const actualModelId = modelId || settings.modelId || ''
        if (!actualModelId) throw new Error('No model ID configured')
        const model = await deps.getLanguageModel(providerId, actualModelId)
        const infos = typeof deps.listModels === 'function'
          ? await deps.listModels(providerId).catch(() => [])
          : []
        const info = infos.find((candidate) => candidate.id === actualModelId)
        return {
          model,
          modelId: actualModelId,
          supportsFunctionCalling: info?.supportsFunctionCalling,
          contextWindow: info?.contextWindow,
          maxOutputTokens: info?.maxOutputTokens,
        }
      },
      getMaxTurns: () => deps.getMaxTurns(),
    },
    sessions: {
      getSession: (agentSessionId) => {
        const session = deps.getAgentSession(agentSessionId)
        if (!session) return null
        return {
          sessionId: session.id,
          workspaceId: session.workspace.workspaceId,
          workspaceRoot: session.workspace.workspaceRoot,
          status: session.status,
        }
      },
    },
    tools: {
      executeFunctionCall: (input, callerId) => deps.executeFunctionCall(input, callerId),
      registry: {
        list: () => deps.listRegistryTools(),
        // The facade tolerates an undefined return (`?.() ?? createToolManifests`)
        // and rebuilds manifests itself; the cast only satisfies the declared shape.
        listManifests: (() => deps.listRegistryManifests()) as () => ToolManifest[],
      },
    },
    streamTextFn: deps.streamTextFn,
    knowledgeSearch: deps.knowledgeSearch,
    knowledgeCapture: {
      captureTurn: async (capture) => {
        for (const target of capture.targets) {
          const sessionId = target.sessionId || capture.correlationId
          if (capture.userText) {
            await deps.captureObservation({
              workspaceId: target.workspaceId,
              workspacePath: target.workspacePath,
              source: 'janus-chat',
              type: 'conversation-turn',
              content: capture.userText,
              summary: 'Janus Chat user message',
              tags: ['janus-chat', 'user'],
              actor: 'user',
              correlationId: capture.correlationId,
              sessionId,
            })
          }
          await deps.captureObservation({
            workspaceId: target.workspaceId,
            workspacePath: target.workspacePath,
            source: 'janus-chat',
            type: 'conversation-turn',
            content: capture.assistantText,
            summary: 'Janus Chat assistant response',
            tags: ['janus-chat', 'assistant'],
            actor: 'assistant',
            correlationId: capture.correlationId,
            sessionId,
            metadata: { providerId: capture.providerId, modelId: capture.modelId },
          })
        }
      },
      notifySettled: async (workspaceId) => {
        deps.scheduleSettled(workspaceId)
      },
    },
  }
}
