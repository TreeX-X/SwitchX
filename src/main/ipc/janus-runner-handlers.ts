import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { agentStreamManager } from '../janus-runner/stream-manager'
import { notifyAgentEvent } from '../notifications/agent-notifier'
import { configService } from '../config/service'
import type { AgentSpawnOptions } from '../janus-runner/types'
import { normalizeAgentApprovalMode } from '../../shared/ipc/agent-runtime'
import { subAgentRunRegistry } from '../janus-runner/subagent-run-registry'
import type { AgentEvent } from '../janus-runner/types'
import type { CaptureObservationInput } from '../../shared/knowledge'
import { knowledgeObservationService } from '../knowledge/observation-service'
import { logKnowledgeCaptureFailure } from '../knowledge/workspace-identity'
import { AGENT_CHANNELS } from '../../shared/ipc/janus-runner'

function summarizeAgentEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'text-delta':
      return 'Streaming response'
    case 'text-chunk':
      return event.text.slice(0, 120)
    case 'tool-start':
      return `Tool started: ${event.name}`
    case 'tool-end':
      return `Tool completed: ${event.id}`
    case 'phase':
      return event.label ?? event.phase
    case 'error':
      return event.message
    case 'done':
      return event.exitCode === 0 || event.exitCode === undefined ? 'Completed' : `Exited with code ${event.exitCode}`
  }
}

function statusFromAgentEvent(event: AgentEvent): 'running' | 'done' | 'failed' {
  if (event.type === 'error') return 'failed'
  if (event.type === 'done') return event.exitCode === 0 || event.exitCode === undefined ? 'done' : 'failed'
  return 'running'
}

function toObservationPayload(
  event: AgentEvent,
  options: AgentSpawnOptions,
  sessionId: string
): CaptureObservationInput | null {
  const workspacePath = options.workspacePath ?? options.cwd
  if (!workspacePath) return null

  const base = {
    workspaceId: options.workspaceId,
    workspacePath,
    source: 'agent-stream' as const,
    visibility: 'workspace' as const,
    actor: options.engine,
    correlationId: sessionId,
    sessionId,
    agentId: options.engine,
    metadata: {
      engine: options.engine,
      sessionId,
      title: options.title,
      role: options.role,
      source: options.source,
    },
  }

  switch (event.type) {
    case 'text-delta':
      return null
    case 'text-chunk':
      return {
        ...base,
        type: 'conversation-turn',
        content: event.text,
        summary: event.text.slice(0, 120),
        tags: ['agent-output'],
      }
    case 'tool-start':
      return {
        ...base,
        type: 'tool-call',
        content: `${event.name} ${event.arg}`.trim(),
        summary: `Tool started: ${event.name}`,
        fileRefs: event.filePath ? [event.filePath] : [],
        tags: ['tool-start'],
        metadata: { ...base.metadata, toolId: event.id, toolName: event.name },
      }
    case 'tool-end':
      return {
        ...base,
        type: 'tool-result',
        content: `Tool completed: ${event.id}`,
        summary: `Tool completed: ${event.id}`,
        tags: ['tool-end'],
        metadata: { ...base.metadata, toolId: event.id },
      }
    case 'phase':
      return {
        ...base,
        type: 'system-event',
        content: event.label ?? event.phase,
        summary: `Phase: ${event.phase}`,
        tags: ['agent-phase'],
        metadata: { ...base.metadata, phase: event.phase, label: event.label },
      }
    case 'error':
      return {
        ...base,
        type: 'system-event',
        content: event.message,
        summary: 'Agent error',
        tags: ['agent-error'],
      }
    case 'done':
      return {
        ...base,
        type: 'system-event',
        content:
          event.exitCode === 0 || event.exitCode === undefined
            ? 'Agent completed'
            : `Agent exited with code ${event.exitCode}`,
        summary: 'Agent completed',
        tags: ['agent-done'],
        metadata: { ...base.metadata, exitCode: event.exitCode },
      }
  }
}

export function registerAgentHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(AGENT_CHANNELS.start, async (_event, options: AgentSpawnOptions) => {
    const effectiveOptions: AgentSpawnOptions = { ...options, approvalMode: normalizeAgentApprovalMode(options.approvalMode ?? await configService.getAgentApprovalMode()) }
    const sessionId = randomUUID()
    const startedAt = new Date().toISOString()

    subAgentRunRegistry.createRun({
      id: sessionId,
      source: effectiveOptions.source ?? 'headless',
      engine: effectiveOptions.engine,
      role: effectiveOptions.role ?? 'subagent',
      status: 'queued',
      title: effectiveOptions.title ?? `${effectiveOptions.engine} agent`,
      parentRunId: effectiveOptions.parentRunId,
      terminalId: effectiveOptions.terminalId,
      rootRunId: effectiveOptions.rootRunId,
      rootTerminalId: effectiveOptions.rootTerminalId,
      missionId: effectiveOptions.missionId,
      nodeId: effectiveOptions.nodeId,
      workspaceId: effectiveOptions.workspaceId,
      workspacePath: effectiveOptions.workspacePath ?? effectiveOptions.cwd,
      startedAt,
      lastEvent: 'Queued',
    })

    if (effectiveOptions.workspacePath ?? effectiveOptions.cwd) {
      void knowledgeObservationService.capture({
        workspaceId: effectiveOptions.workspaceId,
        workspacePath: effectiveOptions.workspacePath ?? effectiveOptions.cwd,
        source: 'agent-stream',
        type: 'conversation-turn',
        content: effectiveOptions.prompt,
        summary: effectiveOptions.title ?? `${effectiveOptions.engine} agent prompt`,
        tags: ['agent-prompt'],
        actor: 'user',
        correlationId: sessionId,
        sessionId,
        agentId: effectiveOptions.engine,
        metadata: {
          engine: effectiveOptions.engine,
          title: effectiveOptions.title,
          role: effectiveOptions.role,
          source: effectiveOptions.source,
        },
      }).catch(logKnowledgeCaptureFailure)
    }

    // Wire event forwarding to renderer
    agentStreamManager.onEvent(sessionId, (event) => {
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(AGENT_CHANNELS.event, { sessionId, event })
      }
      subAgentRunRegistry.updateRun(sessionId, {
        status: statusFromAgentEvent(event),
        lastEvent: summarizeAgentEvent(event),
      })
      if (mainWindow) {
        void configService
          .getNotificationSettings()
          .then((settings) => {
            notifyAgentEvent(
              mainWindow,
              {
                sessionId,
                engine: effectiveOptions.engine,
                startedAt: agentStreamManager.getSession(sessionId)?.startedAt ?? startedAt,
              },
              event,
              settings,
            )
          })
          .catch(() => {
            notifyAgentEvent(mainWindow, {
              sessionId,
              engine: effectiveOptions.engine,
              startedAt: agentStreamManager.getSession(sessionId)?.startedAt ?? startedAt,
            }, event)
          })
      }

      const observation = toObservationPayload(event, effectiveOptions, sessionId)
      if (observation) {
        void knowledgeObservationService.capture(observation).catch(logKnowledgeCaptureFailure)
      }
    })

    void agentStreamManager
      .startWithId(sessionId, effectiveOptions)
      .then(() => {
        subAgentRunRegistry.updateRun(sessionId, {
          status: 'running',
          lastEvent: 'Started',
        })
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        subAgentRunRegistry.updateRun(sessionId, {
          status: 'failed',
          lastEvent: message,
        })
      })

    return { sessionId }
  })

  ipcMain.handle(AGENT_CHANNELS.cancel, async (_event, { sessionId }: { sessionId: string }) => {
    agentStreamManager.cancel(sessionId)
    subAgentRunRegistry.finishRun(sessionId, 'cancelled', 'Cancelled')
    return { success: true }
  })

  ipcMain.handle(AGENT_CHANNELS.cancelAll, async () => {
    agentStreamManager.cancelAll()
    for (const run of subAgentRunRegistry.listRuns()) {
      if (run.source === 'headless' && (run.status === 'queued' || run.status === 'running')) {
        subAgentRunRegistry.finishRun(run.id, 'cancelled', 'Cancelled')
      }
    }
    return { success: true }
  })

  ipcMain.handle(AGENT_CHANNELS.listSessions, async () => {
    return agentStreamManager.listSessions().map(s => ({
      id: s.id,
      engine: s.engine,
      startedAt: s.startedAt,
      status: s.status,
    }))
  })
}
