import type { BrowserWindow } from 'electron'
import { TERMINAL_EVENT_CHANNELS } from '../../shared/ipc/terminal'
import type { AgentEngine } from '../janus-runner/types'
import { configService } from '../config/service'
import { remoteNotificationDispatcher } from '../remote-notifications/dispatcher'
import type { RemoteNotificationType } from '../remote-notifications/types'
import { notifyAgentAttention, notifyAgentEvent } from './agent-notifier'
import {
  JANUSX_SYNTHETIC_HOOK_EVENTS,
  type AgentHookCompletion,
  type AgentHookCompletionKind,
  type AgentHookCoordinatorEvent,
  type AgentHookPayload,
  type AgentHookSource,
  type AgentHookTurnStart,
  type RegisteredHookTerminal,
} from './agent-hook-types'

interface ActiveHookTurn {
  id: string
  terminalId: string
  engine: AgentEngine
  source: AgentHookSource
  startedAtMs: number
  sessionId?: string
  transcriptPath?: string
}

interface AgentHookCoordinatorOptions {
  now?: () => number
  deliverCompletion?: (completion: AgentHookCompletion) => Promise<boolean> | boolean
  deliverAttention?: (payload: AgentHookPayload, terminal: RegisteredHookTerminal) => Promise<boolean> | boolean
  onEvent?: (event: AgentHookCoordinatorEvent) => void
  onResolvedPayload?: (payload: AgentHookPayload, terminal: RegisteredHookTerminal) => void
  onTurnStarted?: (turn: AgentHookTurnStart) => void
  onTurnEnded?: (terminalId: string) => void
}

interface TerminalResolution {
  terminal: RegisteredHookTerminal | null
  reason?: string
}

const COMPLETION_EVENTS = new Set(['Stop'])
const FAILURE_EVENTS = new Set(['StopFailure', 'PostToolUseFailure'])
const APPROVAL_EVENTS = new Set(['PermissionRequest'])
const START_EVENTS = new Set(['UserPromptSubmit'])
const SYNTHETIC_FAILURE_EVENTS = new Set<string>([
  JANUSX_SYNTHETIC_HOOK_EVENTS.apiError,
  JANUSX_SYNTHETIC_HOOK_EVENTS.orphaned,
])
const INTERRUPT_EVENTS = new Set<string>([JANUSX_SYNTHETIC_HOOK_EVENTS.interrupted, 'SessionEnd'])

function toIsoString(timestampMs: number): string {
  return new Date(timestampMs).toISOString()
}

function normalizeHookEvent(payload: AgentHookPayload): string {
  if (payload.source === 'opencode') {
    return payload.event
  }
  return payload.event.trim()
}

function normalizePathForMatch(value?: string): string | undefined {
  const normalized = value?.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
  return normalized || undefined
}

function getOpencodeStatus(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const properties = record.properties
  const candidates = [
    record.status,
    record.state,
    properties && typeof properties === 'object'
      ? (properties as Record<string, unknown>).status
      : undefined,
  ]

  return candidates.find((value): value is string => typeof value === 'string')
}

function isClaudeAttentionNotification(payload: AgentHookPayload): boolean {
  if (payload.source !== 'claude' || payload.event !== 'Notification') return false
  const raw = payload.raw
  if (!raw || typeof raw !== 'object') return true
  const matcher =
    (raw as Record<string, unknown>).matcher ??
    (raw as Record<string, unknown>).notification_type ??
    (raw as Record<string, unknown>).type

  if (typeof matcher !== 'string') return true
  return matcher === 'permission_prompt' || matcher === 'idle_prompt'
}

function isStartEvent(payload: AgentHookPayload): boolean {
  if (payload.source === 'opencode') {
    if (payload.event !== 'session.status') return false
    const status = getOpencodeStatus(payload.raw)
    return status === 'busy' || status === 'running'
  }

  return START_EVENTS.has(payload.event)
}

function isCompletionEvent(payload: AgentHookPayload): boolean {
  if (payload.source === 'opencode') return payload.event === 'session.idle'
  return COMPLETION_EVENTS.has(payload.event)
}

function isFailureEvent(payload: AgentHookPayload): boolean {
  if (SYNTHETIC_FAILURE_EVENTS.has(payload.event)) return true
  if (payload.source === 'opencode') return payload.event === 'session.error'
  return FAILURE_EVENTS.has(payload.event)
}

function isInterruptEvent(payload: AgentHookPayload): boolean {
  return INTERRUPT_EVENTS.has(payload.event)
}

/**
 * Synthetic turn-end signals and SessionEnd are reconciliation sources: they
 * only close a turn that is actually open. The first end signal to arrive wins;
 * later ones are dropped so multiple sources can never double-notify. Real
 * CLI completion hooks (Stop/session.idle) keep their fallback delivery even
 * without a tracked turn — if one arrives after a sentinel abort, the sentinel
 * was wrong and the late completion is the correction.
 */
function requiresActiveTurn(payload: AgentHookPayload): boolean {
  return SYNTHETIC_FAILURE_EVENTS.has(payload.event) || INTERRUPT_EVENTS.has(payload.event)
}

function resolveTurnEndKind(payload: AgentHookPayload): AgentHookCompletionKind | null {
  if (isInterruptEvent(payload)) return 'interrupted'
  if (isFailureEvent(payload)) return 'failed'
  if (isCompletionEvent(payload)) return 'done'
  return null
}

function getRawString(raw: unknown, keys: string[]): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function isAttentionEvent(payload: AgentHookPayload): boolean {
  if (payload.source === 'opencode') return payload.event === 'permission.asked'
  return APPROVAL_EVENTS.has(payload.event) || isClaudeAttentionNotification(payload)
}

function isApprovalEvent(payload: AgentHookPayload): boolean {
  return APPROVAL_EVENTS.has(payload.event) || payload.event === 'permission.asked'
}

function buildAttentionRemoteEventId(
  payload: AgentHookPayload,
  terminal: RegisteredHookTerminal,
  type: RemoteNotificationType,
): string {
  const sessionId = payload.sessionId?.trim()
  if (sessionId) return `${payload.source}:${type}:${sessionId}`

  return [
    terminal.terminalId,
    type,
    payload.event,
    payload.timestamp ?? '',
    payload.message ?? '',
  ].join(':')
}

export class AgentHookCoordinator {
  private readonly terminals = new Map<string, RegisteredHookTerminal>()
  private readonly activeTurns = new Map<string, ActiveHookTurn>()
  private readonly syntheticTurnEnds = new Set<string>()
  private readonly now: () => number
  private readonly deliverCompletion: (completion: AgentHookCompletion) => Promise<boolean> | boolean
  private readonly deliverAttention: (payload: AgentHookPayload, terminal: RegisteredHookTerminal) => Promise<boolean> | boolean
  private readonly onEvent?: (event: AgentHookCoordinatorEvent) => void
  private readonly onResolvedPayload?: (payload: AgentHookPayload, terminal: RegisteredHookTerminal) => void
  private readonly onTurnStarted?: (turn: AgentHookTurnStart) => void
  private readonly onTurnEnded?: (terminalId: string) => void

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    options: AgentHookCoordinatorOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.deliverCompletion = options.deliverCompletion ?? ((completion) => this.defaultDeliverCompletion(completion))
    this.deliverAttention = options.deliverAttention ?? ((payload, terminal) => this.defaultDeliverAttention(payload, terminal))
    this.onEvent = options.onEvent
    this.onResolvedPayload = options.onResolvedPayload
    this.onTurnStarted = options.onTurnStarted
    this.onTurnEnded = options.onTurnEnded
  }

  registerTerminal(terminal: RegisteredHookTerminal): void {
    this.terminals.set(terminal.terminalId, terminal)
  }

  unregisterTerminal(terminalId: string): void {
    this.terminals.delete(terminalId)
    this.syntheticTurnEnds.delete(terminalId)
    if (this.activeTurns.delete(terminalId)) {
      this.onTurnEnded?.(terminalId)
    }
  }

  hasActiveTurn(terminalId: string): boolean {
    return this.activeTurns.has(terminalId)
  }

  dispose(): void {
    this.terminals.clear()
    this.syntheticTurnEnds.clear()
    for (const terminalId of [...this.activeTurns.keys()]) {
      this.activeTurns.delete(terminalId)
      this.onTurnEnded?.(terminalId)
    }
  }

  handleHookPayload(payload: AgentHookPayload): void {
    const normalizedEvent = normalizeHookEvent(payload)
    this.emit({
      type: 'received',
      terminalId: payload.terminalId,
      engine: payload.source,
      source: payload.source,
      hookEvent: normalizedEvent,
    })

    const resolution = this.resolveTerminal(payload)
    const terminal = resolution.terminal
    if (!terminal) {
      this.emit({
        type: 'unmatched',
        terminalId: payload.terminalId,
        engine: payload.source,
        source: payload.source,
        hookEvent: normalizedEvent,
        reason: resolution.reason ?? 'terminal-not-found',
        delivered: false,
      })
      return
    }

    const normalizedPayload = {
      ...payload,
      event: normalizedEvent,
      terminalId: terminal.terminalId,
      workspaceId: terminal.workspaceId,
      cwd: payload.cwd ?? terminal.cwd,
    }

    const turnEndKind = resolveTurnEndKind(normalizedPayload)
    if (
      turnEndKind &&
      !requiresActiveTurn(normalizedPayload) &&
      !this.activeTurns.has(terminal.terminalId) &&
      this.syntheticTurnEnds.has(terminal.terminalId)
    ) {
      this.emit({
        type: 'ignored',
        terminalId: terminal.terminalId,
        engine: terminal.engine,
        source: normalizedPayload.source,
        hookEvent: normalizedPayload.event,
        reason: 'turn-already-ended',
        delivered: false,
      })
      return
    }
    this.onResolvedPayload?.(normalizedPayload, terminal)

    if (isStartEvent(normalizedPayload)) {
      this.startTurn(normalizedPayload, terminal)
      return
    }

    if (isAttentionEvent(normalizedPayload)) {
      this.notifyAttention(normalizedPayload, terminal)
      return
    }

    if (turnEndKind) {
      if (requiresActiveTurn(normalizedPayload) && !this.activeTurns.has(terminal.terminalId)) {
        this.emit({
          type: 'ignored',
          terminalId: terminal.terminalId,
          engine: terminal.engine,
          source: normalizedPayload.source,
          hookEvent: normalizedPayload.event,
          reason: 'no-active-turn',
          delivered: false,
        })
        return
      }
      this.completeTurn(normalizedPayload, terminal, turnEndKind)
      return
    }

    this.emit({
      type: 'ignored',
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      source: normalizedPayload.source,
      hookEvent: normalizedPayload.event,
      reason: 'unsupported-hook-event',
    })
  }

  private resolveTerminal(payload: AgentHookPayload): TerminalResolution {
    if (payload.terminalId) {
      const terminal = this.terminals.get(payload.terminalId)
      if (terminal) return { terminal }
    }

    const sameEngine = Array.from(this.terminals.values()).filter(
      (terminal) => terminal.engine === payload.source,
    )
    if (sameEngine.length === 0) {
      return {
        terminal: null,
        reason: payload.terminalId ? 'terminal-id-stale-and-no-engine-match' : 'no-engine-terminal',
      }
    }

    const workspaceMatches = payload.workspaceId
      ? sameEngine.filter((terminal) => terminal.workspaceId === payload.workspaceId)
      : []
    if (workspaceMatches.length === 1) return { terminal: workspaceMatches[0] }

    const payloadCwd = normalizePathForMatch(payload.cwd)
    const cwdSource = workspaceMatches.length > 0 ? workspaceMatches : sameEngine
    const cwdMatches = payloadCwd
      ? cwdSource.filter((terminal) => normalizePathForMatch(terminal.cwd) === payloadCwd)
      : []
    if (cwdMatches.length === 1) return { terminal: cwdMatches[0] }

    if (sameEngine.length === 1) {
      return { terminal: sameEngine[0] }
    }

    if (payload.workspaceId && workspaceMatches.length > 1) {
      return { terminal: null, reason: 'multiple-workspace-engine-terminals' }
    }
    if (payload.cwd && cwdMatches.length > 1) {
      return { terminal: null, reason: 'multiple-cwd-engine-terminals' }
    }

    return {
      terminal: null,
      reason: payload.terminalId ? 'terminal-id-stale-and-fallback-miss' : 'ambiguous-terminal',
    }
  }

  private startTurn(payload: AgentHookPayload, terminal: RegisteredHookTerminal): ActiveHookTurn {
    const now = this.now()
    this.syntheticTurnEnds.delete(terminal.terminalId)
    const turn: ActiveHookTurn = {
      id: `${terminal.terminalId}:${now}`,
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      source: payload.source,
      startedAtMs: now,
      sessionId: payload.sessionId,
      transcriptPath: getRawString(payload.raw, ['transcript_path', 'transcriptPath']),
    }

    this.activeTurns.set(terminal.terminalId, turn)
    this.onTurnStarted?.({
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      source: payload.source,
      sessionId: turn.sessionId,
      transcriptPath: turn.transcriptPath,
    })
    this.emit({
      type: 'started',
      terminalId: terminal.terminalId,
      turnId: turn.id,
      engine: terminal.engine,
      source: payload.source,
      hookEvent: payload.event,
    })
    return turn
  }

  private notifyAttention(payload: AgentHookPayload, terminal: RegisteredHookTerminal): void {
    Promise.resolve(this.deliverAttention(payload, terminal))
      .then((delivered) => {
        this.emit({
          type: payload.event === 'PermissionRequest' || payload.event === 'permission.asked' ? 'approval' : 'attention',
          terminalId: terminal.terminalId,
          engine: terminal.engine,
          source: payload.source,
          hookEvent: payload.event,
          delivered,
        })
      })
      .catch((error) => {
        this.emit({
          type: 'ignored',
          terminalId: terminal.terminalId,
          engine: terminal.engine,
          source: payload.source,
          hookEvent: payload.event,
          reason: error instanceof Error ? error.message : String(error),
          delivered: false,
        })
      })
  }

  private completeTurn(
    payload: AgentHookPayload,
    terminal: RegisteredHookTerminal,
    kind: AgentHookCompletionKind,
  ): void {
    const activeTurn = this.activeTurns.get(terminal.terminalId)
    if (requiresActiveTurn(payload)) {
      this.syntheticTurnEnds.add(terminal.terminalId)
    }
    const endedAtMs = this.now()
    const completion: AgentHookCompletion = {
      turnId: activeTurn?.id ?? `${terminal.terminalId}:${endedAtMs}`,
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      source: payload.source,
      hookEvent: payload.event,
      startedAt: activeTurn ? toIsoString(activeTurn.startedAtMs) : undefined,
      endedAt: toIsoString(endedAtMs),
      kind,
      failed: kind === 'failed',
      message: payload.message,
    }

    if (this.activeTurns.delete(terminal.terminalId)) {
      this.onTurnEnded?.(terminal.terminalId)
    }

    const lifecycle = kind === 'failed' ? 'failed' : kind === 'interrupted' ? 'interrupted' : 'completed'
    Promise.resolve(this.deliverCompletion(completion))
      .then((delivered) => {
        this.emit({
          type: lifecycle,
          terminalId: terminal.terminalId,
          turnId: completion.turnId,
          engine: terminal.engine,
          source: payload.source,
          hookEvent: payload.event,
          delivered,
        })
      })
      .catch((error) => {
        this.emit({
          type: 'ignored',
          terminalId: terminal.terminalId,
          turnId: completion.turnId,
          engine: terminal.engine,
          source: payload.source,
          hookEvent: payload.event,
          reason: error instanceof Error ? error.message : String(error),
          delivered: false,
        })
      })
  }

  private async defaultDeliverCompletion(completion: AgentHookCompletion): Promise<boolean> {
    // User-initiated ends (interrupt, kill, session teardown) correct the
    // status silently: the user is at the keyboard, a toast would be noise.
    if (completion.kind === 'interrupted') return false
    const mainWindow = this.getMainWindow()
    if (!mainWindow) return false
    const settings = await configService.getNotificationSettings()
    const delivered = notifyAgentEvent(
      mainWindow,
      {
        sessionId: `terminal:${completion.terminalId}`,
        engine: completion.engine,
        startedAt: completion.startedAt,
        endedAt: completion.endedAt,
      },
      completion.failed
        ? { type: 'error', message: completion.message ?? `${completion.engine} hook reported failure` }
        : { type: 'done', exitCode: 0 },
      settings,
      {
        terminalId: completion.terminalId,
        onClick: () => this.focusTerminal(completion.terminalId),
        onDesktopToastShown: () => {
          this.emit({
            type: 'desktop-toast-shown',
            terminalId: completion.terminalId,
            turnId: completion.turnId,
            engine: completion.engine,
            source: completion.source,
            hookEvent: completion.hookEvent,
            delivered: true,
          })
        },
        onDesktopToastFailure: (error) => {
          this.emit({
            type: 'desktop-toast-failed',
            terminalId: completion.terminalId,
            turnId: completion.turnId,
            engine: completion.engine,
            source: completion.source,
            hookEvent: completion.hookEvent,
            reason: `desktop-toast-failed: ${error}`,
            delivered: false,
          })
        },
      },
    )

    void remoteNotificationDispatcher.dispatch(
      {
        id: `${completion.turnId}:${completion.failed ? 'failed' : 'completed'}`,
        engine: completion.engine,
        type: completion.failed ? 'failed' : 'completed',
        terminalId: completion.terminalId,
        title: completion.failed ? 'JanusX - Agent failed' : 'JanusX - Agent completed',
        body: completion.failed
          ? completion.message ?? `${completion.engine} hook reported failure`
          : `${completion.engine} session completed.`,
        createdAt: completion.endedAt,
        severity: completion.failed ? 'error' : 'success',
        startedAt: completion.startedAt,
        endedAt: completion.endedAt,
      },
      { settings: settings.remote },
    )

    return delivered
  }

  private async defaultDeliverAttention(
    payload: AgentHookPayload,
    terminal: RegisteredHookTerminal,
  ): Promise<boolean> {
    const mainWindow = this.getMainWindow()
    if (!mainWindow) return false
    const settings = await configService.getNotificationSettings()
    const delivered = notifyAgentAttention(
      mainWindow,
      {
        sessionId: `terminal:${terminal.terminalId}`,
        engine: terminal.engine,
      },
      payload.message,
      settings,
      {
        terminalId: terminal.terminalId,
        workspaceId: terminal.workspaceId,
        onClick: () => this.focusTerminal(terminal.terminalId),
        onDesktopToastShown: () => {
          this.emit({
            type: 'desktop-toast-shown',
            terminalId: terminal.terminalId,
            engine: terminal.engine,
            source: payload.source,
            hookEvent: payload.event,
            delivered: true,
          })
        },
        onDesktopToastFailure: (error) => {
          this.emit({
            type: 'desktop-toast-failed',
            terminalId: terminal.terminalId,
            engine: terminal.engine,
            source: payload.source,
            hookEvent: payload.event,
            reason: `desktop-toast-failed: ${error}`,
            delivered: false,
          })
        },
      },
    )

    const type: RemoteNotificationType = isApprovalEvent(payload) ? 'approval' : 'attention'
    void remoteNotificationDispatcher.dispatch(
      {
        id: buildAttentionRemoteEventId(payload, terminal, type),
        engine: terminal.engine,
        type,
        terminalId: terminal.terminalId,
        workspaceId: terminal.workspaceId,
        workspacePath: terminal.cwd,
        title: `JanusX - ${terminal.engine} needs attention`,
        body: payload.message?.trim() || `Handle the ${terminal.engine} request in JanusX.`,
        createdAt: payload.timestamp ?? new Date(this.now()).toISOString(),
        severity: type === 'approval' ? 'warning' : 'info',
      },
      { settings: settings.remote },
    )

    return delivered
  }

  private focusTerminal(terminalId: string): void {
    const mainWindow = this.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send(TERMINAL_EVENT_CHANNELS.focus, { id: terminalId })
  }

  private emit(event: AgentHookCoordinatorEvent): void {
    this.onEvent?.(event)
  }
}
