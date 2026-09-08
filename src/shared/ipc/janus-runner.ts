import type { SubAgentRun, SubAgentRunRemovedEvent, SubAgentRunRole, SubAgentRunSource, SubAgentRunUpdatedEvent } from '../subAgentRun'
import type { AgentApprovalMode } from './agent-runtime'

export const AGENT_CHANNELS = {
  start: 'agent:start',
  cancel: 'agent:cancel',
  cancelAll: 'agent:cancelAll',
  listSessions: 'agent:listSessions',
  event: 'agent:event',
  notification: 'agent-notification:show',
  hookEvent: 'agent-hook:event',
} as const

export const SUBAGENT_RUN_CHANNELS = {
  list: 'subagent-run:list',
  updated: 'subagent-run:updated',
  removed: 'subagent-run:removed',
} as const

export type AgentEngine = 'claude' | 'codex' | 'opencode'

export type AgentEvent =
  | { type: 'text-delta'; delta: string; fullText: string }
  | { type: 'text-chunk'; text: string }
  | { type: 'tool-start'; id: string; name: string; arg: string; filePath?: string }
  | { type: 'tool-end'; id: string }
  | { type: 'phase'; phase: 'thinking' | 'tool' | 'command'; label?: string }
  | { type: 'error'; message: string }
  | { type: 'done'; exitCode?: number }

export interface AgentSpawnOptions {
  engine: AgentEngine
  prompt: string
  cwd: string
  model?: string
  timeoutMs?: number
  title?: string
  role?: SubAgentRunRole
  source?: SubAgentRunSource
  parentRunId?: string
  terminalId?: string
  rootRunId?: string
  rootTerminalId?: string
  missionId?: string
  nodeId?: string
  workspaceId?: string
  workspacePath?: string
  approvalMode?: AgentApprovalMode
}

export interface AgentSessionInfo {
  id: string
  engine: string
  startedAt: string
  status: string
}

export interface AgentNotificationPayload {
  id?: string
  type?: 'completed' | 'failed' | 'attention'
  engine?: string
  title?: string
  body?: string
  terminalId?: string
  workspaceId?: string
  createdAt?: string
}

export interface AgentAPI {
  start(options: AgentSpawnOptions): Promise<{ sessionId: string }>
  cancel(sessionId: string): Promise<{ success: boolean }>
  cancelAll(): Promise<{ success: boolean }>
  listSessions(): Promise<AgentSessionInfo[]>
  onEvent(callback: (payload: { sessionId: string; event: AgentEvent }) => void): () => void
  onNotification(callback: (payload: AgentNotificationPayload) => void): () => void
  onHookEvent(callback: (payload: unknown) => void): () => void
}

export interface SubAgentRunAPI {
  list(): Promise<SubAgentRun[]>
  onUpdated(callback: (payload: SubAgentRunUpdatedEvent) => void): () => void
  onRemoved(callback: (payload: SubAgentRunRemovedEvent) => void): () => void
}
