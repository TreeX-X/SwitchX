import type { ParticipantInstance, WorkflowRole } from './workflow-template'

export type AgentWorkState = 'queued' | 'working' | 'completed' | 'failed' | 'awaiting-input' | 'cancelled'

export interface AgentResultCard {
  id: string
  sessionId: string
  roundId: string
  agentId: string
  role: WorkflowRole
  title: string
  status: AgentWorkState
  summary: string
  createdAt: string
  updatedAt: string
  sourceEventIds: string[]
  sections?: Array<{ id: string; title: string; markdown: string }>
  evidenceRefs?: RoundtableEvidenceRef[]
  requiresUserAction?: boolean
}

export type RoundtableEvidenceRef =
  | { kind: 'workspace-file'; workspaceId: string; relativePath: string; sha256?: string; capturedAt?: string; sourceEventId?: string; workspaceVersion?: string; lineStart?: number; lineEnd?: number; origin?: 'snapshot' | 'tool' }
  | { kind: 'agent-card'; cardId: string; sourceEventId?: string }
  | { kind: 'event'; eventId: string }
export interface RoundtableWorkspaceResource {
  workspaceId: string
  workspacePath: string
  workspaceName: string
}

export type RoundtableFactStatus = 'confirmed' | 'proposal' | 'concern' | 'pending-validation' | 'rejected' | 'resolved'

export interface RoundtableFact {
  id: string
  kind: 'decision' | 'evidence' | 'risk' | 'action' | 'question' | 'requirement' | 'solution'
  status: RoundtableFactStatus
  title: string
  content: string
  sourceEventIds: string[]
  updatedAt: string
}

export interface ParchmentDocument {
  version: number
  title: string
  conclusion: string
  decisions: RoundtableFact[]
  evidence: RoundtableFact[]
  risks: RoundtableFact[]
  actions: RoundtableFact[]
  unresolved: RoundtableFact[]
  sourceEventIds: string[]
  humanReadable: HumanReadableParchment
}

export interface HumanReadableParchment {
  title: string
  conclusion: string
  decisions: string[]
  evidence: string[]
  risks: string[]
  actions: string[]
  pending: string[]
  conflicts: Array<{ topic: string; status: string }>
  draft: boolean
  sourceEventIds: string[]
}

export interface HostSynthesisConflict {
  id: string
  topic: string
  factIds: string[]
  status: 'open' | 'resolving' | 'resolved'
  sourceEventIds: string[]
}

export interface HostSynthesis {
  roundNumber: number
  final: boolean
  conclusion: string
  decisions: string[]
  evidence: string[]
  pending: string[]
  conflicts: HostSynthesisConflict[]
  risks: string[]
  actions: string[]
  /** §37.8: open/answered questions derived from question-kind facts. */
  questions: RoundtableQuestion[]
  sourceEventIds: string[]
  createdAt: string
}

/**
 * §37.6/§37.8: a member question collected by the host into the pool.
 * `fromAgentId` is empty when the origin cannot be attributed (e.g. facts
 * recorded before per-agent attribution existed); renderers fall back to a
 * generic member label in that case.
 */
export interface RoundtableQuestion {
  id: string
  text: string
  fromAgentId: string
  roundNumber: number
  status: 'open' | 'answered'
  factId?: string
  sourceEventIds: string[]
}

/**
 * §37.3: host-only pool write. Agents propose deltas; only ops carried by
 * `host:pool-update` mutate the shared pool (add new entries, update content,
 * or transition status). `opId` + envelope `eventId` dedup make retries safe.
 */
export interface RoundtablePoolUpdateOp {
  opId: string
  action: 'add' | 'update' | 'set-status'
  fact: RoundtableFact
}

export interface RoundtableUserMessage {
  id: string
  text: string
  roundNumber: number
  createdAt: string
  sourceEventId?: string
}

export interface RoundtableState {
  phase: 'idle' | 'running' | 'awaiting-user' | 'ended'
  sessionId?: string
  roundNumber: number
  userInput?: string
  participants: ParticipantInstance[]
  cards: AgentResultCard[]
  errors: string[]
  facts: RoundtableFact[]
  eventIds: string[]
  version: number
  workspaceResources: RoundtableWorkspaceResource[]
  workspaceContext?: string
  workspaceContextFiles?: string[]
  workspaceEvidenceRefs?: Extract<RoundtableEvidenceRef, { kind: 'workspace-file' }>[]
  hostDrafts?: HostSynthesis[]
  userMessages: RoundtableUserMessage[]
  /** Idempotency keys for advance retries: requestId -> created roundNumber. */
  advanceKeys?: Record<string, number>
}

export type RoundtableEvent =
  | ({ type: 'session:created'; sessionId: string; workflowId: string; workflowVersion: string })
  | ({ type: 'workspace:evidence-captured'; sessionId: string; refs: Extract<RoundtableEvidenceRef, { kind: 'workspace-file' }>[] })
  | ({ type: 'workspace:tool-started'; sessionId: string; roundId: string; agentId: string; toolCallId: string; toolName: string; workspaceId: string })
  | ({ type: 'workspace:tool-completed'; sessionId: string; roundId: string; agentId: string; toolCallId: string; toolName: string; workspaceId: string; evidenceRef?: Extract<RoundtableEvidenceRef, { kind: 'workspace-file' }> })
  | ({ type: 'workspace:tool-failed'; sessionId: string; roundId: string; agentId: string; toolCallId: string; toolName: string; workspaceId: string; errorCode: string; error: string })
  | ({ type: 'workspace:tool-cancelled'; sessionId: string; roundId: string; agentId: string; toolCallId: string; toolName: string; workspaceId: string })
  | ({ type: 'round:started'; sessionId: string; roundId: string; roundNumber: number; trigger: 'initial-input' | 'user-advance'; userInput?: string })
  | ({ type: 'user:message'; sessionId: string; message: RoundtableUserMessage })
  | ({ type: 'agent:queued'; sessionId: string; roundId: string; agentId: string; role: WorkflowRole })
  | ({ type: 'agent:working'; sessionId: string; roundId: string; agentId: string; role: WorkflowRole })
  | ({ type: 'agent:result'; sessionId: string; roundId: string; card: AgentResultCard })
  | ({ type: 'agent:error'; sessionId: string; roundId: string; agentId: string; role: WorkflowRole; error: string })
  | ({ type: 'round:awaiting-user'; sessionId: string; roundId: string; roundNumber: number })
  | ({ type: 'host:synthesis'; sessionId: string; roundId: string; synthesis: HostSynthesis })
  | ({ type: 'host:pool-update'; sessionId: string; roundId: string; ops: RoundtablePoolUpdateOp[] })
  | ({ type: 'session:ended'; sessionId: string })

export type RoundtableEventEnvelope = RoundtableEvent & { eventId: string; occurredAt: string }

export interface FixtureAgent {
  run(input: { sessionId: string; roundId: string; roundNumber: number; userInput?: string; priorCards: AgentResultCard[]; priorFacts?: RoundtableFact[]; workspaceResources?: RoundtableWorkspaceResource[]; workspaceContext?: string; stageId: string; hostMode?: 'intake' | 'merge' | 'synthesis'; workspaceTools?: RoundtableWorkspaceToolExecutor }): Promise<string>
}

export interface RoundtableWorkspaceToolExecutor {
  execute(name: 'workspace.list' | 'workspace.read' | 'workspace.readRange', input: Record<string, unknown>): Promise<unknown>
}
