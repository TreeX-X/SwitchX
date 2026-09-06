import type { RoundtableEvent, RoundtableEventEnvelope, RoundtableState, RoundtableUserMessage } from './events'

/** Checkpoint schema version. Bump when the persisted shape changes. */
export const ROUNDTABLE_CHECKPOINT_VERSION = 1

export const EMPTY_ROUNDTABLE_STATE: RoundtableState = {
  phase: 'idle', roundNumber: 0, participants: [], cards: [], errors: [], facts: [], eventIds: [], version: 0, workspaceResources: [], workspaceContextFiles: [], workspaceEvidenceRefs: [], hostDrafts: [], userMessages: [],
}

/**
 * Migrate an unknown persisted snapshot to the current schema. Old journal
 * lines predate newer fields; fill defaults instead of failing the restore.
 */
export function migrateRoundtableState(raw: unknown): RoundtableState {
  const value = (raw ?? {}) as Partial<RoundtableState>
  return {
    phase: value.phase ?? 'idle',
    sessionId: value.sessionId,
    roundNumber: value.roundNumber ?? 0,
    userInput: value.userInput,
    participants: [...(value.participants ?? [])],
    cards: [...(value.cards ?? [])],
    errors: [...(value.errors ?? [])],
    facts: [...(value.facts ?? [])],
    eventIds: [...(value.eventIds ?? [])],
    version: value.version ?? 0,
    workspaceResources: [...(value.workspaceResources ?? [])],
    workspaceContext: value.workspaceContext ?? '',
    workspaceContextFiles: [...(value.workspaceContextFiles ?? [])],
    workspaceEvidenceRefs: [...(value.workspaceEvidenceRefs ?? [])],
    hostDrafts: [...(value.hostDrafts ?? []).map((draft) => ({ ...draft, questions: [...(draft.questions ?? [])] }))],
    userMessages: [...(value.userMessages ?? [])],
    advanceKeys: value.advanceKeys ? { ...value.advanceKeys } : undefined,
  }
}

/**
 * Demote a snapshot that was persisted mid-round (crash/restart) back to a
 * resumable state. The interruption itself is recorded in errors; no history
 * is fabricated. Pure function so service.restore stays testable.
 */
export function markInterrupted(state: RoundtableState): RoundtableState {
  if (state.phase !== 'running') return state
  return {
    ...state,
    phase: 'awaiting-user',
    errors: [...state.errors, 'Roundtable was interrupted while running; review the last round before advancing.'],
  }
}

export function reduceRoundtableEvent(state: RoundtableState, event: RoundtableEventEnvelope | RoundtableEvent): RoundtableState {
  const eventId = 'eventId' in event ? event.eventId : undefined
  if (eventId && state.eventIds.includes(eventId)) return state
  const next = { ...state, cards: [...state.cards], errors: [...state.errors], facts: [...state.facts], eventIds: [...state.eventIds], version: state.version + 1 }
  if (eventId) next.eventIds.push(eventId)
  switch (event.type) {
    case 'session:created': return { ...next, phase: 'running', sessionId: event.sessionId, roundNumber: 0 }
    case 'workspace:evidence-captured': return { ...next, workspaceEvidenceRefs: [...(next.workspaceEvidenceRefs ?? []), ...event.refs] }
    case 'workspace:tool-completed': return event.evidenceRef
      ? { ...next, workspaceEvidenceRefs: [...(next.workspaceEvidenceRefs ?? []).filter((ref) => !(ref.workspaceId === event.evidenceRef!.workspaceId && ref.relativePath === event.evidenceRef!.relativePath && ref.sha256 === event.evidenceRef!.sha256 && ref.origin === event.evidenceRef!.origin && ref.lineStart === event.evidenceRef!.lineStart && ref.lineEnd === event.evidenceRef!.lineEnd)), event.evidenceRef] }
      : next
    case 'round:started': return { ...next, phase: 'running', sessionId: event.sessionId, roundNumber: event.roundNumber, userInput: event.userInput }
    case 'user:message': {
      const stamped: RoundtableUserMessage = event.message.sourceEventId
        ? event.message
        : { ...event.message, sourceEventId: 'eventId' in event ? event.eventId : undefined }
      const seen = new Set(next.userMessages.map((item) => item.id))
      if (seen.has(stamped.id)) return next
      return { ...next, userMessages: [...next.userMessages, stamped] }
    }
    case 'agent:result': {
      const index = next.cards.findIndex((card) => card.id === event.card.id)
      if (index >= 0) next.cards[index] = event.card
      else next.cards.push(event.card)
      return next
    }
    case 'agent:error': return { ...next, errors: [...next.errors, `${event.agentId}: ${event.error}`] }
    case 'round:awaiting-user': return { ...next, phase: 'awaiting-user', roundNumber: event.roundNumber, sessionId: event.sessionId }
    case 'host:synthesis': {
      const drafts = [...(next.hostDrafts ?? [])]
      const index = drafts.findIndex((draft) => draft.roundNumber === event.synthesis.roundNumber && draft.final === event.synthesis.final)
      if (index >= 0) drafts[index] = event.synthesis
      else drafts.push(event.synthesis)
      return { ...next, hostDrafts: drafts }
    }
    case 'host:pool-update': {
      // Host-only pool write (§37.3). Envelope eventId dedup above already
      // makes exact retries a no-op; ops with unknown ids (except add) are
      // ignored rather than fabricated.
      const facts = [...next.facts]
      for (const op of event.ops) {
        const index = facts.findIndex((fact) => fact.id === op.fact.id)
        if (op.action === 'add') {
          if (index < 0) facts.push(op.fact)
        } else if (index >= 0) {
          facts[index] = op.action === 'set-status'
            ? { ...facts[index], status: op.fact.status, updatedAt: op.fact.updatedAt, sourceEventIds: [...new Set([...facts[index].sourceEventIds, ...op.fact.sourceEventIds])] }
            : { ...op.fact }
        }
      }
      return { ...next, facts }
    }
    case 'session:ended': return { ...next, phase: 'ended', sessionId: event.sessionId }
    default: return next
  }
}

export function replayRoundtableEvents(events: RoundtableEventEnvelope[]): RoundtableState {
  return events.reduce(reduceRoundtableEvent, EMPTY_ROUNDTABLE_STATE)
}
