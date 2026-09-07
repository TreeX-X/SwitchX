import { BrowserWindow } from 'electron'
import * as electron from 'electron'
import type { AgentEvent, AgentSpawnOptions } from '../janus-runner/types'
import {
  DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  normalizeAgentNotificationSettings,
  type AgentNotificationSettings,
} from '../../shared/notifications'
import { desktopToastWindow, type DesktopToastPayload } from './desktop-toast-window'
import { AGENT_CHANNELS } from '../../shared/ipc/janus-runner'

interface AgentNotificationContext {
  sessionId: string
  engine: AgentSpawnOptions['engine']
  startedAt?: string
  endedAt?: string
}

interface AgentNotificationOptions {
  onClick?: () => void
  onDesktopToastShown?: () => void
  onDesktopToastFailure?: (error: string) => void
  terminalId?: string
  workspaceId?: string
}

interface AgentNotificationPayload {
  type: 'completed' | 'failed' | 'attention'
  engine: AgentNotificationContext['engine']
  title: string
  body: string
  terminalId?: string
  workspaceId?: string
}

function getElapsedSeconds(startedAt?: string, endedAt?: string): number | null {
  if (!startedAt) return null
  const timestamp = Date.parse(startedAt)
  if (!Number.isFinite(timestamp)) return null
  const endedTimestamp = endedAt ? Date.parse(endedAt) : NaN
  const end = Number.isFinite(endedTimestamp) ? endedTimestamp : Date.now()
  return Math.max(0, Math.floor((end - timestamp) / 1000))
}

function truncateMessage(message: string, maxLength: number): string {
  const clean = message.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, Math.max(0, maxLength - 3))}...`
}

function focusMainWindow(mainWindow: BrowserWindow, options: AgentNotificationOptions): void {
  if (mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  options.onClick?.()
}

function sendRendererNotification(
  mainWindow: BrowserWindow,
  payload: DesktopToastPayload,
): boolean {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false

  mainWindow.webContents.send(AGENT_CHANNELS.notification, {
    ...payload,
  })
  return true
}

function sendNativeNotification(
  mainWindow: BrowserWindow,
  payload: DesktopToastPayload,
  options: AgentNotificationOptions,
): boolean {
  const NativeNotification = (electron as typeof electron & {
    Notification?: typeof import('electron').Notification
  }).Notification
  if (!NativeNotification || !NativeNotification.isSupported()) return false
  try {
    const notification = new NativeNotification({ title: payload.title, body: payload.body })
    notification.on('click', () => focusMainWindow(mainWindow, options))
    notification.on('failed', (_event, error) => {
      options.onDesktopToastFailure?.(String(error || 'native-notification-failed'))
      sendRendererNotification(mainWindow, payload)
    })
    notification.show()
    return true
  } catch (error) {
    options.onDesktopToastFailure?.(error instanceof Error ? error.message : String(error))
    return false
  }
}

function createNotificationPayload(payload: AgentNotificationPayload): DesktopToastPayload {
  return {
    id: `${payload.type}:${payload.engine}:${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...payload,
  }
}

function showLocalNotification(
  mainWindow: BrowserWindow,
  input: AgentNotificationPayload,
  options: AgentNotificationOptions,
): boolean {
  const payload = createNotificationPayload(input)
  let desktopShown = false
  const sendRendererFallback = (): boolean => sendRendererNotification(mainWindow, payload)
  const sendFallback = (): boolean => {
    const nativeDelivered = sendNativeNotification(mainWindow, payload, options)
    if (nativeDelivered) {
      console.warn(`[notifications] using native fallback for ${payload.type}`)
      return true
    }

    const rendererDelivered = sendRendererFallback()
    if (rendererDelivered) {
      console.warn(`[notifications] using main-renderer fallback for ${payload.type}`)
    }
    return rendererDelivered
  }
  const desktopDelivered = desktopToastWindow.show(payload, {
    onClick: () => focusMainWindow(mainWindow, options),
    onShown: () => {
      desktopShown = true
      options.onDesktopToastShown?.()
    },
    onError: (error) => {
      options.onDesktopToastFailure?.(error)
      if (!desktopShown) sendFallback()
    },
  })

  return desktopDelivered || sendFallback()
}

export function notifyAgentEvent(
  mainWindow: BrowserWindow,
  context: AgentNotificationContext,
  event: AgentEvent,
  settings: AgentNotificationSettings = DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  options: AgentNotificationOptions = {},
): boolean {
  if (event.type !== 'done' && event.type !== 'error') return false
  if (mainWindow.isDestroyed()) return false

  const resolvedSettings = normalizeAgentNotificationSettings(settings)
  if (!resolvedSettings.desktopEnabled) return false

  const isFailure =
    event.type === 'error' ||
    (event.type === 'done' && typeof event.exitCode === 'number' && event.exitCode !== 0)

  if (!isFailure && !resolvedSettings.notifyOnSuccess) return false
  if (isFailure && !resolvedSettings.notifyOnFailure) return false

  const elapsedSeconds = getElapsedSeconds(context.startedAt, context.endedAt)
  if (
    elapsedSeconds !== null &&
    resolvedSettings.minDurationSeconds > 0 &&
    elapsedSeconds < resolvedSettings.minDurationSeconds
  ) {
    return false
  }

  const failureBody =
    resolvedSettings.includeErrorMessage && event.type === 'error' && event.message.trim()
      ? `${context.engine} session failed: ${truncateMessage(
          event.message,
          resolvedSettings.errorMessageMaxLength,
        )}`
      : `${context.engine} session needs attention. Click to return to JanusX.`

  const title = isFailure ? 'JanusX - Agent failed' : 'JanusX - Agent completed'
  const body = isFailure ? failureBody : `${context.engine} session completed. Click to return to JanusX.`

  return showLocalNotification(mainWindow, {
    type: isFailure ? 'failed' : 'completed',
    engine: context.engine,
    title,
    body,
    terminalId: options.terminalId,
    workspaceId: options.workspaceId,
  }, options)
}

export function notifyAgentAttention(
  mainWindow: BrowserWindow,
  context: AgentNotificationContext,
  message: string | undefined,
  settings: AgentNotificationSettings = DEFAULT_AGENT_NOTIFICATION_SETTINGS,
  options: AgentNotificationOptions = {},
): boolean {
  if (mainWindow.isDestroyed()) return false

  const resolvedSettings = normalizeAgentNotificationSettings(settings)
  if (!resolvedSettings.desktopEnabled) return false

  const title = `JanusX - ${context.engine} needs attention`
  const body = message?.trim()
    ? truncateMessage(message, resolvedSettings.errorMessageMaxLength)
    : `Click to return to JanusX and handle the ${context.engine} request.`

  return showLocalNotification(mainWindow, {
    type: 'attention',
    engine: context.engine,
    title,
    body,
    terminalId: options.terminalId,
    workspaceId: options.workspaceId,
  }, options)
}
