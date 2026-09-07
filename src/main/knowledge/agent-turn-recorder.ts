import type { AgentEngine } from '../janus-runner/types'
import { configService } from '../config/service'
import {
  JANUSX_SYNTHETIC_HOOK_EVENTS,
  type AgentHookPayload,
  type RegisteredHookTerminal,
} from '../notifications/agent-hook-types'
import { knowledgeObservationService } from './observation-service'
import { knowledgeProcessingQueue } from './processing-queue'

interface ActiveTurn {
  id: string
  terminalId: string
  engine: AgentEngine
  workspaceId?: string
  workspacePath: string
  prompt?: string
  sessionId?: string
  startedAt: string
  startedAtMs: number
}

interface TerminalContext extends RegisteredHookTerminal {
  cwd: string
}

export interface AgentTurnRecorderEvent {
  type: 'captured' | 'skipped' | 'failed'
  reason?: string
  terminalId?: string
  engine?: AgentEngine
  hookEvent: string
  workspaceId?: string
  workspacePath?: string
  observationId?: string
}

const START_EVENTS = new Set(['UserPromptSubmit'])
const COMPLETION_EVENTS = new Set(['Stop'])
const FAILURE_EVENTS = new Set([
  'StopFailure',
  'PostToolUseFailure',
  // Synthetic aborts (transcript sentinel / pty exit): the turn ended without
  // a completion hook, record it as failed instead of leaking an open turn.
  JANUSX_SYNTHETIC_HOOK_EVENTS.apiError,
  JANUSX_SYNTHETIC_HOOK_EVENTS.orphaned,
])
const ATTENTION_EVENTS = new Set(['PermissionRequest', 'Notification'])

function normalizePath(value?: string): string | undefined {
  return value?.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase() || undefined
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

function normalizeHookEvent(payload: AgentHookPayload): string {
  return payload.source === 'opencode' ? payload.event : payload.event.trim()
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
  if (payload.source === 'opencode') return payload.event === 'session.error'
  return FAILURE_EVENTS.has(payload.event)
}

function isAttentionEvent(payload: AgentHookPayload): boolean {
  if (payload.source === 'opencode') return payload.event === 'permission.asked'
  return ATTENTION_EVENTS.has(payload.event)
}

function hasText(value?: string): value is string {
  return Boolean(value?.trim())
}

function timestampToMs(timestamp?: string): number | undefined {
  if (!timestamp) return undefined
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

class AgentTurnRecorder {
  private readonly terminals = new Map<string, TerminalContext>()
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private eventSink?: (event: AgentTurnRecorderEvent) => void

  registerTerminal(terminal: TerminalContext): void {
    this.terminals.set(terminal.terminalId, terminal)
  }

  setEventSink(sink?: (event: AgentTurnRecorderEvent) => void): void {
    this.eventSink = sink
  }

  unregisterTerminal(terminalId: string): void {
    this.terminals.delete(terminalId)
    this.activeTurns.delete(terminalId)
  }

  dispose(): void {
    this.terminals.clear()
    this.activeTurns.clear()
  }

  handleHookPayload(payload: AgentHookPayload): void {
    void this.recordHookPayload(payload).catch((error) => {
      this.emit({
        type: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        terminalId: payload.terminalId,
        engine: payload.source,
        hookEvent: payload.event,
        workspaceId: payload.workspaceId,
        workspacePath: payload.cwd,
      })
      console.warn(
        '[knowledge] failed to record agent hook observation:',
        error instanceof Error ? error.message : String(error),
      )
    })
  }

  private async isEnabled(): Promise<boolean> {
    const settings = await configService.getKnowledgeSettings()
    return settings.enabled
  }

  private resolveTerminal(payload: AgentHookPayload): TerminalContext | null {
    if (payload.terminalId) {
      const terminal = this.terminals.get(payload.terminalId)
      if (terminal) return terminal
    }

    const sameEngine = Array.from(this.terminals.values()).filter(
      (terminal) => terminal.engine === payload.source,
    )
    if (sameEngine.length === 0) return null

    const workspaceMatches = payload.workspaceId
      ? sameEngine.filter((terminal) => terminal.workspaceId === payload.workspaceId)
      : []
    if (workspaceMatches.length === 1) return workspaceMatches[0]

    const payloadCwd = normalizePath(payload.cwd)
    const cwdSource = workspaceMatches.length > 0 ? workspaceMatches : sameEngine
    const cwdMatches = payloadCwd
      ? cwdSource.filter((terminal) => normalizePath(terminal.cwd) === payloadCwd)
      : []
    if (cwdMatches.length === 1) return cwdMatches[0]

    return sameEngine.length === 1 ? sameEngine[0] : null
  }

  private async recordHookPayload(rawPayload: AgentHookPayload): Promise<void> {
    if (!(await this.isEnabled())) {
      this.emit({
        type: 'skipped',
        reason: 'knowledge-disabled',
        terminalId: rawPayload.terminalId,
        engine: rawPayload.source,
        hookEvent: rawPayload.event,
        workspaceId: rawPayload.workspaceId,
        workspacePath: rawPayload.cwd,
      })
      return
    }

    const payload = {
      ...rawPayload,
      event: normalizeHookEvent(rawPayload),
    }
    const terminal = this.resolveTerminal(payload)
    if (!terminal?.cwd) {
      this.emit({
        type: 'skipped',
        reason: 'terminal-not-found',
        terminalId: payload.terminalId,
        engine: payload.source,
        hookEvent: payload.event,
        workspaceId: payload.workspaceId,
        workspacePath: payload.cwd,
      })
      return
    }

    if (isStartEvent(payload)) {
      await this.recordStart(payload, terminal)
      return
    }

    if (isAttentionEvent(payload)) {
      await this.recordAttention(payload, terminal)
      return
    }

    if (isFailureEvent(payload)) {
      await this.recordEnd(payload, terminal, true)
      return
    }

    if (isCompletionEvent(payload)) {
      await this.recordEnd(payload, terminal, false)
      return
    }

    this.emit({
      type: 'skipped',
      reason: 'unsupported-hook-event',
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      hookEvent: payload.event,
      workspaceId: terminal.workspaceId,
      workspacePath: terminal.cwd,
    })
  }

  private async recordStart(
    payload: AgentHookPayload,
    terminal: TerminalContext,
  ): Promise<void> {
    const activeTurn = this.activeTurns.get(terminal.terminalId)
    if (
      activeTurn &&
      (!hasText(payload.message) ||
        (payload.sessionId === activeTurn.sessionId && payload.message === activeTurn.prompt))
    ) {
      return
    }

    const now = timestampToMs(payload.timestamp) ?? Date.now()
    const startedAt = new Date(now).toISOString()
    const turn: ActiveTurn = {
      id: `${terminal.terminalId}:${now}`,
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      workspaceId: terminal.workspaceId,
      workspacePath: terminal.cwd,
      prompt: payload.message,
      sessionId: payload.sessionId,
      startedAt,
      startedAtMs: now,
    }
    this.activeTurns.set(terminal.terminalId, turn)

    const observation = await knowledgeObservationService.capture({
      workspaceId: terminal.workspaceId,
      workspacePath: terminal.cwd,
      source: 'agent-stream',
      type: hasText(payload.message) ? 'conversation-turn' : 'system-event',
      content: hasText(payload.message)
        ? payload.message
        : `${terminal.engine} terminal task started`,
      summary: `${terminal.engine} terminal task started`,
      tags: ['terminal-hook', 'turn-started', terminal.engine],
      actor: hasText(payload.message) ? 'user' : terminal.engine,
      correlationId: turn.id,
      sessionId: payload.sessionId,
      agentId: terminal.engine,
      metadata: {
        terminalId: terminal.terminalId,
        engine: terminal.engine,
        hookEvent: payload.event,
        sessionId: payload.sessionId,
        startedAt,
      },
    })
    this.emitCaptured(payload, terminal, observation.id)
  }

  private async recordAttention(
    payload: AgentHookPayload,
    terminal: TerminalContext,
  ): Promise<void> {
    const activeTurn = this.activeTurns.get(terminal.terminalId)
    const observation = await knowledgeObservationService.capture({
      workspaceId: terminal.workspaceId,
      workspacePath: terminal.cwd,
      source: 'agent-stream',
      type: 'system-event',
      content: payload.message?.trim() || `${terminal.engine} terminal needs attention`,
      summary: `${terminal.engine} terminal attention`,
      tags: ['terminal-hook', 'turn-attention', terminal.engine],
      actor: terminal.engine,
      correlationId: activeTurn?.id ?? `terminal:${terminal.terminalId}`,
      sessionId: payload.sessionId ?? activeTurn?.sessionId,
      agentId: terminal.engine,
      metadata: {
        terminalId: terminal.terminalId,
        engine: terminal.engine,
        hookEvent: payload.event,
        sessionId: payload.sessionId,
      },
    })
    this.emitCaptured(payload, terminal, observation.id)
  }

  private async recordEnd(
    payload: AgentHookPayload,
    terminal: TerminalContext,
    failed: boolean,
  ): Promise<void> {
    const activeTurn = this.activeTurns.get(terminal.terminalId)
    const endedAtMs = timestampToMs(payload.timestamp) ?? Date.now()
    const durationMs = activeTurn ? endedAtMs - activeTurn.startedAtMs : undefined
    this.activeTurns.delete(terminal.terminalId)

    const observation = await knowledgeObservationService.capture({
      workspaceId: terminal.workspaceId,
      workspacePath: terminal.cwd,
      source: 'agent-stream',
      type: hasText(payload.message) && !failed ? 'conversation-turn' : 'system-event',
      content: hasText(payload.message)
        ? payload.message
        : failed
          ? `${terminal.engine} terminal task failed`
          : `${terminal.engine} terminal task completed`,
      summary: failed
        ? `${terminal.engine} terminal task failed`
        : `${terminal.engine} terminal task completed`,
      tags: ['terminal-hook', failed ? 'turn-failed' : 'turn-completed', terminal.engine],
      actor: terminal.engine,
      correlationId: activeTurn?.id ?? `terminal:${terminal.terminalId}`,
      sessionId: payload.sessionId ?? activeTurn?.sessionId,
      agentId: terminal.engine,
      metadata: {
        terminalId: terminal.terminalId,
        engine: terminal.engine,
        hookEvent: payload.event,
        sessionId: payload.sessionId ?? activeTurn?.sessionId,
        startedAt: activeTurn?.startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs,
        failed,
        prompt: activeTurn?.prompt,
      },
    })
    // Phase 5 (§6 gap close): the turn ended — bypass the capture debounce so
    // deterministic sedimentation runs promptly for this workspace.
    knowledgeProcessingQueue.scheduleImmediate(
      observation?.workspaceId ?? terminal.workspaceId ?? '',
    )
    this.emitCaptured(payload, terminal, observation.id)
  }

  private emitCaptured(
    payload: AgentHookPayload,
    terminal: TerminalContext,
    observationId: string,
  ): void {
    this.emit({
      type: 'captured',
      terminalId: terminal.terminalId,
      engine: terminal.engine,
      hookEvent: payload.event,
      workspaceId: terminal.workspaceId,
      workspacePath: terminal.cwd,
      observationId,
    })
  }

  private emit(event: AgentTurnRecorderEvent): void {
    this.eventSink?.(event)
  }
}

export const agentTurnRecorder = new AgentTurnRecorder()
