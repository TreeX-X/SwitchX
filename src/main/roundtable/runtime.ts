import { realpath, stat } from 'node:fs/promises'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { AgentResultCard, FixtureAgent, RoundtableEvent, RoundtableEventEnvelope, RoundtableFact, RoundtableState, RoundtableWorkspaceResource, RoundtableEvidenceRef } from '../../shared/roundtable/events'
import { EMPTY_ROUNDTABLE_STATE, reduceRoundtableEvent } from '../../shared/roundtable/state'
import { synthesizeHostDraft, harvestQuestionTexts, harvestAnsweredTexts } from '../../shared/roundtable/host-synthesis'
import { defaultRoundtableWorkflow, participantsForRole, validateWorkflowTemplate, type ParticipantInstance, type WorkflowStage, type WorkflowTemplate } from '../../shared/roundtable/workflow-template'
import { AgentRegistry } from './agent-registry'
import { janusWorkspaceFs } from '../janus-agent/environment/janus-workspace-fs'
import { executeRoundtableWorkspaceTool } from './workspace-tools'

type GraphState = {
  sessionId: string
  roundId: string
  roundNumber: number
  userInput?: string
  cards: AgentResultCard[]
  errors: string[]
  workspaceResources: RoundtableWorkspaceResource[]
  workspaceContext: string
}

const GraphAnnotation = Annotation.Root({
  sessionId: Annotation<string>(), roundId: Annotation<string>(), roundNumber: Annotation<number>(),
  userInput: Annotation<string | undefined>(),
  cards: Annotation<AgentResultCard[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  errors: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  workspaceResources: Annotation<RoundtableWorkspaceResource[]>({ reducer: (_left, right) => right, default: () => [] }),
  workspaceContext: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
})

const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

export interface RoundtableRuntimeOptions {
  /** Resolve a workspaceId to its canonical registered root. When provided,
   * start() re-resolves every resource and ignores client-supplied paths. */
  resolveWorkspace?: (workspaceId: string) => Promise<{ path: string; name?: string }>
  /** Per-tool timeout in milliseconds (default 30s). */
  toolTimeoutMs?: number
}

function workspaceToolError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Race a task against a timeout. Exported for unit tests. */
export function withTimeout<T>(task: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(workspaceToolError(code, message)), ms)
  })
  return Promise.race([task.finally(() => { if (timer) clearTimeout(timer) }), timeout])
}

export class RoundtableRuntime {
  private readonly agents: Map<string, FixtureAgent>
  private readonly template: WorkflowTemplate
  private readonly listeners = new Set<(event: RoundtableEventEnvelope) => void>()
  private readonly controller = new AbortController()
  private readonly resolveWorkspace?: (workspaceId: string) => Promise<{ path: string; name?: string }>
  private readonly toolTimeoutMs: number
  private state: RoundtableState = { ...EMPTY_ROUNDTABLE_STATE }

  constructor(agents: Record<string, FixtureAgent> | AgentRegistry, template: WorkflowTemplate = defaultRoundtableWorkflow, options: RoundtableRuntimeOptions = {}) {
    validateWorkflowTemplate(template)
    this.agents = agents instanceof AgentRegistry
      ? new Map(agents.list().map((agent) => [agent.id, agent]))
      : new Map(Object.entries(agents))
    this.template = template
    this.resolveWorkspace = options.resolveWorkspace
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000
  }

  onEvent(listener: (event: RoundtableEventEnvelope) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** Abort pending workspace tool calls. In-flight tools observe cancellation
   * and emit workspace:tool-cancelled instead of hanging. */
  cancel(): void { this.controller.abort() }
  getState(): RoundtableState { return { ...this.state, participants: [...this.state.participants], cards: [...this.state.cards], errors: [...this.state.errors], facts: [...this.state.facts], eventIds: [...this.state.eventIds], workspaceResources: [...this.state.workspaceResources], workspaceContextFiles: [...(this.state.workspaceContextFiles ?? [])], workspaceEvidenceRefs: [...(this.state.workspaceEvidenceRefs ?? [])], hostDrafts: (this.state.hostDrafts ?? []).map((draft) => ({ ...draft, questions: [...(draft.questions ?? [])] })), userMessages: [...this.state.userMessages], advanceKeys: this.state.advanceKeys ? { ...this.state.advanceKeys } : undefined } }
  hydrate(state: RoundtableState): void {
    this.state = {
      ...state,
      participants: [...(state.participants ?? [])], cards: [...(state.cards ?? [])], errors: [...(state.errors ?? [])],
      facts: [...(state.facts ?? [])], eventIds: [...(state.eventIds ?? [])], workspaceResources: [...(state.workspaceResources ?? [])],
      workspaceContextFiles: [...(state.workspaceContextFiles ?? [])], workspaceContext: state.workspaceContext ?? '',
      workspaceEvidenceRefs: [...(state.workspaceEvidenceRefs ?? [])], hostDrafts: [...(state.hostDrafts ?? []).map((draft) => ({ ...draft, questions: [...(draft.questions ?? [])] }))],
      userMessages: [...(state.userMessages ?? [])], advanceKeys: state.advanceKeys ? { ...state.advanceKeys } : undefined,
    }
  }
  addFact(fact: RoundtableFact): void { this.state = { ...this.state, facts: [...this.state.facts.filter((item) => item.id !== fact.id), fact], version: this.state.version + 1 } }

  private async resolveStartResources(resources: RoundtableWorkspaceResource[]): Promise<RoundtableWorkspaceResource[]> {
    const resolved: RoundtableWorkspaceResource[] = []
    for (const resource of resources) {
      if (!WORKSPACE_ID_PATTERN.test(resource.workspaceId)) throw workspaceToolError('WORKSPACE_TOOL_INVALID_WORKSPACE_ID', `Invalid workspace id: ${resource.workspaceId}`)
      if (this.resolveWorkspace) {
        let registration: { path: string; name?: string }
        try {
          registration = await this.resolveWorkspace(resource.workspaceId)
        } catch (error) {
          throw workspaceToolError('WORKSPACE_TOOL_NOT_ATTACHED', error instanceof Error ? error.message : `Workspace is not attached: ${resource.workspaceId}`)
        }
        const canonical = await this.canonicalDirectory(registration.path, resource.workspaceId)
        resolved.push({ workspaceId: resource.workspaceId, workspaceName: registration.name ?? resource.workspaceName, workspacePath: canonical })
      } else {
        // No registry available (fixture/tests): still enforce a real
        // directory boundary so fake or escaped paths fail closed.
        const canonical = await this.canonicalDirectory(resource.workspacePath, resource.workspaceId)
        resolved.push({ ...resource, workspacePath: canonical })
      }
    }
    return resolved
  }

  private async canonicalDirectory(candidate: string, workspaceId: string): Promise<string> {
    let canonical: string
    try {
      canonical = await realpath(candidate)
    } catch {
      throw workspaceToolError('WORKSPACE_TOOL_NOT_ATTACHED', `Workspace is unavailable: ${workspaceId}`)
    }
    try {
      if (!(await stat(canonical)).isDirectory()) throw workspaceToolError('WORKSPACE_TOOL_NOT_ATTACHED', `Workspace is not a directory: ${workspaceId}`)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('WORKSPACE_TOOL_')) throw error
      throw workspaceToolError('WORKSPACE_TOOL_NOT_ATTACHED', `Workspace is unavailable: ${workspaceId}`)
    }
    return canonical
  }

  async start(input: string | { prompt: string; workspaceResources?: RoundtableWorkspaceResource[] }): Promise<RoundtableState> {
    const value = (typeof input === 'string' ? input : input.prompt).trim()
    const requestedResources = typeof input === 'string' ? [] : (input.workspaceResources ?? []).map((resource) => ({ ...resource }))
    if (!value || this.state.phase !== 'idle') throw new Error('A non-empty input is required to start an idle roundtable')
    const workspaceResources = await this.resolveStartResources(requestedResources)
    const sessionId = `session-${Date.now()}`
    const contextParts: string[] = []
    const contextFiles: string[] = []
    const evidenceRefs: Extract<RoundtableEvidenceRef, { kind: 'workspace-file' }>[] = []
    for (const resource of workspaceResources) {
      const result = await janusWorkspaceFs.collectTextEvidence(resource.workspacePath, resource.workspaceId, new AbortController().signal, { maxFiles: 40, maxFileBytes: 12 * 1024, maxContextBytes: 96 * 1024 })
      if (result.ok) {
        contextParts.push(`\n### Workspace: ${resource.workspaceName} (${resource.workspacePath})\n${result.value.context}`)
        for (const file of result.value.manifest.files) {
          contextFiles.push(`${resource.workspaceName}/${file.path}`)
          evidenceRefs.push({ kind: 'workspace-file', workspaceId: resource.workspaceId, relativePath: file.path, sha256: file.sha256, capturedAt: new Date().toISOString(), workspaceVersion: result.value.manifest.gitHead, origin: 'snapshot' })
        }
      }
    }
    this.state = { ...EMPTY_ROUNDTABLE_STATE, phase: 'running', sessionId, roundNumber: 1, userInput: value, participants: this.allParticipants(), workspaceResources, workspaceContext: contextParts.join('\n'), workspaceContextFiles: contextFiles, workspaceEvidenceRefs: [], facts: [] }
    this.emit({ type: 'session:created', sessionId, workflowId: this.template.id, workflowVersion: this.template.version })
    this.emit({ type: 'user:message', sessionId, message: { id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`, text: value, roundNumber: 1, createdAt: new Date().toISOString() } })
    if (evidenceRefs.length) this.emit({ type: 'workspace:evidence-captured', sessionId, refs: evidenceRefs })
    this.state = { ...this.state, facts: contextFiles.map((path, index) => ({ id: `workspace-${sessionId}-${path}`, kind: 'evidence', status: 'confirmed', title: 'Workspace file', content: path, sourceEventIds: [this.state.workspaceEvidenceRefs?.[index]?.sourceEventId].filter((id): id is string => Boolean(id)), updatedAt: new Date().toISOString() })) }
    this.state = { ...this.state, roundNumber: 1, userInput: value, participants: this.allParticipants() }
    return this.runRound(value, 'initial-input')
  }

  async advance(input = '', requestId?: string): Promise<RoundtableState> {
    if (this.state.phase !== 'awaiting-user' || !this.state.sessionId) {
      // Transport retries reuse the requestId: if this exact advance already
      // created its round, return the current state instead of throwing.
      if (requestId && this.state.sessionId && this.state.advanceKeys?.[requestId] !== undefined) return this.getState()
      throw new Error('Roundtable is not waiting for user advance')
    }
    const trimmed = input.trim()
    const sessionId = this.state.sessionId
    const roundNumber = this.state.roundNumber + 1
    this.state = {
      ...this.state,
      phase: 'running',
      roundNumber,
      userInput: trimmed || undefined,
      errors: [],
      advanceKeys: requestId ? { ...(this.state.advanceKeys ?? {}), [requestId]: roundNumber } : this.state.advanceKeys,
    }
    // Non-empty supplements join the event log; empty advances intentionally
    // leave no blank user message behind.
    if (trimmed) this.emit({ type: 'user:message', sessionId, message: { id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`, text: trimmed, roundNumber, createdAt: new Date().toISOString() } })
    return this.runRound(this.state.userInput, 'user-advance')
  }

  end(): RoundtableState {
    if (!this.state.sessionId || this.state.phase === 'idle') throw new Error('Roundtable has not started')
    if (this.state.phase === 'running') throw new Error('A running round cannot be ended')
    const sessionId = this.state.sessionId
    try {
      this.emit({ type: 'host:synthesis', sessionId, roundId: `${sessionId}-round-${this.state.roundNumber}`, synthesis: synthesizeHostDraft(this.getState(), { final: true }) })
    } catch { /* final draft is best-effort; facts remain the source of truth */ }
    this.emit({ type: 'session:ended', sessionId })
    return this.getState()
  }

  private async runRound(userInput: string | undefined, trigger: 'initial-input' | 'user-advance'): Promise<RoundtableState> {
    const sessionId = this.state.sessionId!
    const roundNumber = this.state.roundNumber
    const roundId = `${sessionId}-round-${roundNumber}`
    this.emit({ type: 'round:started', sessionId, roundId, roundNumber, trigger, userInput })
    const graph = this.buildGraph(roundId)
    const result = await graph.invoke({ sessionId, roundId, roundNumber: this.state.roundNumber, userInput, cards: [], errors: [], workspaceResources: this.state.workspaceResources, workspaceContext: this.state.workspaceContext ?? '' })
    // Agent events have already been reduced into state; only the lifecycle event changes phase.
    void result
    this.state = { ...this.state, roundNumber, userInput }
    this.emit({ type: 'round:awaiting-user', sessionId, roundId, roundNumber })
    try {
      this.emit({ type: 'host:synthesis', sessionId, roundId, synthesis: synthesizeHostDraft(this.getState()) })
    } catch { /* draft is best-effort; facts remain queryable without it */ }
    return this.getState()
  }

  private buildGraph(roundId: string) {
    return new StateGraph(GraphAnnotation)
      .addNode('run-template', async (state: GraphState) => this.runTemplate(state, roundId))
      .addEdge(START, 'run-template')
      .addEdge('run-template', END)
      .compile()
  }

  private async runTemplate(state: GraphState, roundId: string) {
    const cards: AgentResultCard[] = []
    const errors: string[] = []
    for (const stage of this.template.stages) {
      const participants = participantsForRole(this.template, stage.role)
      const stageState = { ...state, cards: state.cards.concat(cards), errors: state.errors.concat(errors) }
      const results = await Promise.all(participants.map((participant) => this.runAgent(stageState, participant, roundId, stage, cards)))
      for (const result of results) {
        cards.push(...(result.cards ?? []))
        errors.push(...(result.errors ?? []))
      }
    }
    return { cards, errors }
  }

  private async runAgent(state: GraphState, participant: ParticipantInstance, roundId: string, stage: WorkflowStage, roundCards: AgentResultCard[]) {
    const { sessionId } = state
    // §37: hostMode defaults to synthesis so templates without the field keep
    // the legacy single-host behavior byte for byte.
    const hostMode = participant.role === 'host' ? (stage.hostMode ?? 'synthesis') : undefined
    // §37.3: an intake with no fresh user text leaves the pool untouched —
    // skip silently instead of emitting phantom host activity.
    if (hostMode === 'intake' && !state.userInput) return {}
    this.emit({ type: 'agent:queued', sessionId, roundId, agentId: participant.id, role: participant.role })
    this.emit({ type: 'agent:working', sessionId, roundId, agentId: participant.id, role: participant.role })
    // §37.3: user demand enters the pool deterministically ahead of any model
    // call, so the requirement survives even a host model failure.
    if (hostMode === 'intake' && state.userInput) {
      this.emit({
        type: 'host:pool-update', sessionId, roundId,
        ops: [{
          opId: `intake-${roundId}`, action: 'add',
          fact: {
            id: `pool-req-${roundId}`, kind: 'requirement', status: 'proposal',
            title: '用户需求', content: state.userInput,
            sourceEventIds: [], updatedAt: new Date().toISOString(),
          },
        }],
      })
    }
    // §37.6 deterministic merge (P0-3): harvest member questions from this
    // round's refiner (merge) / challenger (synthesis) prose ahead of the
    // model call, so questions reach the pool even when the host model fails.
    // Re-asked questions are skipped by normalized comparison with the pool.
    if ((hostMode === 'merge' || hostMode === 'synthesis') && roundCards.length) {
      const wantedRole = hostMode === 'merge' ? 'refiner' : 'challenger'
      const known = new Set(this.state.facts.filter((fact) => fact.kind === 'question').map((fact) => fact.content.trim().toLowerCase().replace(/\s+/g, ' ')))
      const fresh = harvestQuestionTexts(roundCards.filter((card) => card.role === wantedRole))
        .filter((text) => !known.has(text.trim().toLowerCase().replace(/\s+/g, ' ')))
      if (fresh.length) {
        const now = new Date().toISOString()
        this.emit({
          type: 'host:pool-update', sessionId, roundId,
          ops: fresh.map((text, index) => ({
            opId: `harvest-${roundId}-${hostMode}-${index}`, action: 'add' as const,
            fact: {
              id: `pool-q-${roundId}-${hostMode}-${index}`, kind: 'question' as const,
              status: 'pending-validation' as const, title: '成员提问', content: text,
              sourceEventIds: [], updatedAt: now,
            },
          })),
        })
      }
    }
    // P1a answer resolution: the intake host quotes settled questions under an
    // `Answered:` section. Each line must normalize-match an OPEN pool
    // question; unmatched lines are ignored so hallucinations resolve nothing.
    // Ops stay idempotent: re-emitting set-status on an already-resolved fact
    // only merges source ids.
    if ((hostMode === 'merge' || hostMode === 'synthesis') && roundCards.length) {
      const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ')
      const openByNorm = new Map(this.state.facts
        .filter((fact) => fact.kind === 'question' && fact.status !== 'resolved' && fact.status !== 'rejected')
        .map((fact) => [norm(fact.content), fact]))
      const seenResolve = new Set<string>()
      const matched = harvestAnsweredTexts(roundCards.filter((card) => card.role === 'host'))
        .map((text) => openByNorm.get(norm(text)))
        .filter((fact): fact is RoundtableFact => Boolean(fact))
        .filter((fact) => {
          if (seenResolve.has(fact.id)) return false
          seenResolve.add(fact.id)
          return true
        })
      if (matched.length) {
        const now = new Date().toISOString()
        this.emit({
          type: 'host:pool-update', sessionId, roundId,
          ops: matched.map((fact, index) => ({
            opId: `resolve-${roundId}-${hostMode}-${index}`, action: 'set-status' as const,
            fact: { ...fact, status: 'resolved' as const, updatedAt: now },
          })),
        })
      }
    }
    try {
      const summary = await this.agents.get(participant.id)?.run({ sessionId, roundId, roundNumber: state.roundNumber, userInput: state.userInput, priorCards: state.cards, priorFacts: this.state.facts, workspaceResources: this.state.workspaceResources, workspaceContext: this.state.workspaceContext, stageId: stage.id, hostMode, workspaceTools: { execute: (name, input) => this.executeWorkspaceTool(name, input, participant.id, roundId) } })
        ?? `Fixture result for ${participant.id}`
      const now = new Date().toISOString()
      const card: AgentResultCard = {
        id: `${roundId}-${participant.id}`, sessionId, roundId, agentId: participant.id,
        role: participant.role, title: `${participant.role} result`, status: 'completed', summary,
        sections: [{ id: 'summary', title: 'Summary', markdown: summary }],
        evidenceRefs: [...(this.state.workspaceEvidenceRefs ?? []), ...state.cards.map((item) => ({ kind: 'agent-card' as const, cardId: item.id }))],
        requiresUserAction: participant.role === 'host' && summary.includes('?'),
        createdAt: now, updatedAt: now, sourceEventIds: [],
      }
      this.emit({ type: 'agent:result', sessionId, roundId, card })
      return { cards: [card] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'agent:error', sessionId, roundId, agentId: participant.id, role: participant.role, error: message })
      return { errors: [`${participant.id}: ${message}`] }
    }
  }

  private allParticipants(): ParticipantInstance[] { return this.template.participants.flatMap((item) => item.instances) }
  private async executeWorkspaceTool(name: 'workspace.list' | 'workspace.read' | 'workspace.readRange', input: Record<string, unknown>, agentId: string, roundId: string): Promise<unknown> {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
    const resource = this.state.workspaceResources.find((item) => item.workspaceId === workspaceId)
    // This throw becomes a tool-result error (not a fatal run error), so name
    // the valid ids: the model can retry with a corrected workspaceId.
    if (!resource) throw workspaceToolError('WORKSPACE_TOOL_NOT_ATTACHED', `Workspace "${workspaceId || '(empty)'}" is not attached to this roundtable. Attached ids: ${this.state.workspaceResources.map((item) => item.workspaceId).join(', ') || '(none)'}. Copy one exactly.`)
    const toolCallId = `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.emit({ type: 'workspace:tool-started', sessionId: this.state.sessionId!, roundId, agentId, toolCallId, toolName: name, workspaceId })
    if (this.controller.signal.aborted) {
      this.emit({ type: 'workspace:tool-cancelled', sessionId: this.state.sessionId!, roundId, agentId, toolCallId, toolName: name, workspaceId })
      throw workspaceToolError('WORKSPACE_TOOL_CANCELLED', 'Roundtable workspace tool cancelled')
    }
    try {
      const task = executeRoundtableWorkspaceTool(name, input, { workspaceId, workspaceRoot: resource.workspacePath, signal: this.controller.signal })
      const result = this.toolTimeoutMs > 0
        ? await withTimeout(task, this.toolTimeoutMs, 'WORKSPACE_TOOL_TIMEOUT', `Workspace tool timed out: ${name}`)
        : await task
      const value = result as { path?: string; sha256?: string; lineStart?: number; lineEnd?: number }
      const evidenceRef = value.sha256 && value.path ? { kind: 'workspace-file' as const, workspaceId, relativePath: value.path, sha256: value.sha256, capturedAt: new Date().toISOString(), lineStart: value.lineStart, lineEnd: value.lineEnd, origin: 'tool' as const } : undefined
      this.emit({ type: 'workspace:tool-completed', sessionId: this.state.sessionId!, roundId, agentId, toolCallId, toolName: name, workspaceId, evidenceRef })
      return result
    } catch (error) {
      if (this.controller.signal.aborted) this.emit({ type: 'workspace:tool-cancelled', sessionId: this.state.sessionId!, roundId, agentId, toolCallId, toolName: name, workspaceId })
      else this.emit({ type: 'workspace:tool-failed', sessionId: this.state.sessionId!, roundId, agentId, toolCallId, toolName: name, workspaceId, errorCode: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'WORKSPACE_TOOL_FAILED', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  private emit(event: RoundtableEvent): void {
    const eventId = `${event.type}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let normalizedEvent: RoundtableEvent = event
    if (event.type === 'workspace:evidence-captured') {
      normalizedEvent = { ...event, refs: event.refs.map((ref) => ({ ...ref, sourceEventId: eventId })) }
    } else if (event.type === 'host:pool-update') {
      normalizedEvent = { ...event, ops: event.ops.map((op) => ({ ...op, fact: { ...op.fact, sourceEventIds: [...new Set([...op.fact.sourceEventIds, eventId])] } })) }
    } else if (event.type === 'workspace:tool-completed' && event.evidenceRef) {
      normalizedEvent = { ...event, evidenceRef: { ...event.evidenceRef, sourceEventId: eventId } }
    }
    const envelope: RoundtableEventEnvelope = { ...normalizedEvent, eventId, occurredAt: new Date().toISOString() }
    this.state = reduceRoundtableEvent(this.state, envelope)
    if (event.type === 'agent:result') {
      const kind = event.card.role === 'challenger' ? 'risk' : event.card.role === 'host' ? 'decision' : 'evidence'
      // Stage B gate: host synthesis must not self-confirm. Only cards that
      // cite tool-derived file evidence (origin 'tool' + sha256) may land as
      // confirmed; everything else stays pending-validation for stage C.
      const hasToolEvidence = (event.card.evidenceRefs ?? []).some((ref) => ref.kind === 'workspace-file' && ref.origin === 'tool' && Boolean(ref.sha256))
      const status = event.card.role === 'host'
        ? (hasToolEvidence ? 'confirmed' : 'pending-validation')
        : event.card.role === 'challenger' ? 'concern' : 'proposal'
      this.addFact({ id: `fact-${event.card.id}`, kind, status, title: event.card.title, content: event.card.summary, sourceEventIds: [envelope.eventId], updatedAt: envelope.occurredAt })
    }
    this.listeners.forEach((listener) => listener(envelope))
  }
}
