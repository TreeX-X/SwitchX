import type {
  FeishuRemoteProviderConfig,
  RemoteProviderId,
  RemoteNotificationSettings,
  RemoteSendResult,
} from '../../shared/notifications'
import type { AgentEngine } from '../janus-runner/types'

export type RemoteNotificationType = 'completed' | 'failed' | 'attention' | 'approval'
export type RemoteNotificationSeverity = 'info' | 'success' | 'warning' | 'error'
export type { RemoteProviderId, RemoteSendResult }

export interface RemoteNotificationEvent {
  id: string
  engine: AgentEngine
  type: RemoteNotificationType
  terminalId?: string
  workspaceId?: string
  workspacePath?: string
  title: string
  body: string
  createdAt: string
  severity: RemoteNotificationSeverity
  startedAt?: string
  endedAt?: string
}

export interface RemoteNotificationProvider {
  id: RemoteProviderId
  send(
    event: RemoteNotificationEvent,
    config: FeishuRemoteProviderConfig,
    options: RemoteProviderSendOptions,
  ): Promise<void>
  test(config: FeishuRemoteProviderConfig, options: RemoteProviderSendOptions): Promise<void>
}

export interface RemoteProviderSendOptions {
  timeoutMs: number
}

export interface RemoteNotificationDispatchOptions {
  settings?: RemoteNotificationSettings
}
