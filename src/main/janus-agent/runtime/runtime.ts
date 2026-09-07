import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { normalizeAgentApprovalMode, type AgentApprovalMode, type AgentRuntimeEvent, type AgentSession, type ApprovalPreview, type ApprovalResult, type CreateAgentSessionInput, type ExecuteToolInput, type PolicyAuditQuery, type PolicyDecision, type PolicyDecisionRecord, type ToolResult } from '../../../shared/ipc/agent-runtime'
import { ToolRegistry, type RegisteredTool } from './registry'
import type { ResolveWorkspaceRoot } from '../../office/office-workspace-guard'
import { createPolicyDecisionRecord, evaluateWorkspaceActionPolicy, isSafeCompileCommand, redactPolicyValue, redactWorkingValue, sanitizePolicyText, settleApprovalDecision } from './policy-gate'
import { FilePolicyAuditStore, MemoryPolicyAuditStore, type PolicyAuditStore } from './policy-audit-store'

type Listener = (event: AgentRuntimeEvent) => void
type ApprovalOutcome = 'approved' | 'denied' | 'cancelled' | 'timed-out'
interface PendingApproval { resolve: (outcome: ApprovalOutcome) => void; callerId: string; expected: Omit<ApprovalResult, 'approved' | 'approvalId'> }
interface ActiveSession extends AgentSession { controller: AbortController; pending: Map<string, PendingApproval>; activeCalls: Set<Promise<void>>; ended: boolean; ownerId: string }
class ToolTimeoutError extends Error {}
const PATH_DENIAL_CODES = new Set(['ABSOLUTE_PATH', 'PATH_TRAVERSAL', 'OUTSIDE_WORKSPACE', 'TARGET_CHANGED', 'WORKSPACE_UNAVAILABLE', 'TARGET_UNAVAILABLE', 'TARGET_NOT_REGULAR'])

export class WorkspaceAgentRuntime {
  readonly registry = new ToolRegistry()
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly listeners = new Set<Listener>()
  constructor(private resolveWorkspaceRoot?: ResolveWorkspaceRoot, private readonly auditStore: PolicyAuditStore = new MemoryPolicyAuditStore()) {}
  setWorkspaceResolver(resolveWorkspaceRoot: ResolveWorkspaceRoot): void { this.resolveWorkspaceRoot = resolveWorkspaceRoot }
  onEvent(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(event: AgentRuntimeEvent): void { for (const listener of this.listeners) listener(event) }

  private async recordPolicyDecision(
    session: ActiveSession,
    correlationId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    decision: PolicyDecision,
  ): Promise<PolicyDecisionRecord> {
    const record = createPolicyDecisionRecord({
      decision,
      workspaceId: session.workspace.workspaceId,
      sessionId: session.id,
      correlationId,
      toolName,
      toolInput,
    })
    await this.auditStore.record(record)
    this.emit({ type: 'policy-decided', decision: structuredClone(record) })
    return record
  }

  async createSession(input: CreateAgentSessionInput, ownerId = 'internal'): Promise<AgentSession> {
    if (!input.workspaceId?.trim() || !input.workspaceRoot?.trim() || !this.resolveWorkspaceRoot) throw new Error('workspaceId and workspaceRoot are required')
    const trustedRoot = await this.resolveWorkspaceRoot(input.workspaceId)
    if (!trustedRoot) throw new Error('Workspace is not registered')
    const root = await realpath(trustedRoot)
    if ((await realpath(input.workspaceRoot)) !== root) throw new Error('workspaceRoot does not match registered workspace')
    if (!statSync(root).isDirectory()) throw new Error('workspaceRoot must be a directory')
    const now = new Date().toISOString()
    const session: ActiveSession = { id: randomUUID(), workspace: { workspaceId: input.workspaceId, workspaceRoot: root }, status: 'running', createdAt: now, updatedAt: now, timeoutMs: input.timeoutMs ?? 120_000, approvalMode: normalizeAgentApprovalMode(input.approvalMode), safeCompileAutoAllow: input.safeCompileAutoAllow !== false, controller: new AbortController(), pending: new Map(), activeCalls: new Set(), ended: false, ownerId }
    this.sessions.set(session.id, session)
    this.emit({ type: 'session-created', session: this.publicSession(session) })
    return this.publicSession(session)
  }

  async executeTool(input: ExecuteToolInput, callerId = 'internal'): Promise<ToolResult> {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error('Unknown session')
    const correlationId = input.call.correlationId ?? randomUUID()
    this.emit({ type: 'tool-requested', sessionId: session.id, correlationId, toolName: input.call.toolName })
    if (session.status !== 'running' || session.controller.signal.aborted) { const result = this.result(session, input.call.toolName, correlationId, 'cancelled', undefined, 'Session is not running'); this.emit({ type: 'tool-cancelled', result }); return result }
    let complete!: () => void
    const activeCall = new Promise<void>((resolve) => { complete = resolve })
    session.activeCalls.add(activeCall)
    try { return await this.executeActiveTool(session, input, correlationId, callerId) }
    finally { session.activeCalls.delete(activeCall); complete(); this.endSessionWhenIdle(session) }
  }

  private async executeActiveTool(session: ActiveSession, input: ExecuteToolInput, correlationId: string, callerId: string): Promise<ToolResult> {
    let tool: RegisteredTool
    let executionInput: Record<string, unknown>
    try {
      executionInput = structuredClone(input.call.input)
      tool = this.registry.validateCall({ ...input.call, input: executionInput })
    } catch (error) { const result = this.result(session, input.call.toolName, correlationId, 'failed', undefined, error instanceof Error ? error.message : String(error)); this.emit({ type: 'tool-failed', result }); return result }
    const relativePath = typeof executionInput.path === 'string' ? executionInput.path : undefined
    let policyDecision = evaluateWorkspaceActionPolicy({
      actionRisk: tool.actionRisk,
      evidenceConfidence: input.call.evidenceConfidence,
      relativePath,
      approvalMode: session.approvalMode,
    })
    // P5：安全编译命令在 per-action 下免逐次审批（仍记审计 AUTO_RUN_ALLOWED；
    // 危险模式/敏感路径走原 deny/审批链；执行层校验照常 fail-closed）。
    // R2：会话 safeCompileAutoAllow=false 时关闭该放行，一律走逐次审批。
    if (policyDecision.outcome === 'approval-required' && session.safeCompileAutoAllow !== false && isSafeCompileCommand(tool.name, executionInput)) {
      policyDecision = {
        ...policyDecision,
        outcome: 'allow',
        approvalPolicy: 'auto-run',
        approvalDecision: 'not-required',
        reasonCode: 'AUTO_RUN_ALLOWED',
      }
    }
    let policyRecord = await this.recordPolicyDecision(session, correlationId, tool.name, executionInput, policyDecision)
    if (policyDecision.outcome === 'deny') {
      const result = this.result(session, tool.name, correlationId, 'failed', undefined, 'Tool denied by workspace policy', undefined, undefined, policyDecision.reasonCode, policyRecord)
      this.emit({ type: 'tool-failed', result })
      return result
    }
    if (policyDecision.outcome === 'approval-required') {
      if (session.status !== 'running' || session.controller.signal.aborted) {
        const result = this.result(session, tool.name, correlationId, 'cancelled', undefined, 'Session cancelled', undefined, undefined, 'APPROVAL_CANCELLED', policyRecord)
        this.emit({ type: 'tool-cancelled', result }); return result
      }
      const preview = this.validatePreview(tool.actionRisk, input.call.preview)
      if (preview === null) {
        const result = this.result(session, tool.name, correlationId, 'failed', undefined, 'Mutation approval requires bounded preview metadata', undefined, undefined, 'PREVIEW_REQUIRED', policyRecord)
        this.emit({ type: 'tool-failed', result }); return result
      }
      const approvalId = randomUUID()
      const request = {
        id: approvalId,
        sessionId: session.id,
        workspaceId: session.workspace.workspaceId,
        correlationId,
        toolName: tool.name,
        input: structuredClone(policyRecord.input ?? {}),
        evidenceConfidence: policyDecision.evidenceConfidence,
        actionRisk: policyDecision.actionRisk,
        approvalPolicy: 'per-action' as const,
        reasonCode: 'ACTION_REQUIRES_APPROVAL' as const,
        preview: preview ?? undefined,
        createdAt: new Date().toISOString(),
      }
      // Approvals wait on a human, not a machine: no timer here. The wait ends
      // only when the user resolves it or the session is cancelled; only tool
      // execution below runs under session.timeoutMs.
      let resolveOutcome!: (outcome: ApprovalOutcome) => void
      const outcomePromise = new Promise<ApprovalOutcome>((resolve) => { resolveOutcome = resolve })
      session.pending.set(approvalId, { resolve: resolveOutcome, callerId, expected: { workspaceId: session.workspace.workspaceId, sessionId: session.id, correlationId, toolName: tool.name, actionRisk: tool.actionRisk } })
      this.emit({ type: 'approval-requested', request })
      const outcome = await outcomePromise
      policyDecision = settleApprovalDecision(policyDecision, outcome)
      policyRecord = await this.recordPolicyDecision(session, correlationId, tool.name, executionInput, policyDecision)
      if (outcome !== 'approved') {
        const timedOut = outcome === 'timed-out'
        const result = this.result(session, tool.name, correlationId, timedOut ? 'timed-out' : 'cancelled', undefined, timedOut ? 'Tool approval timed out' : outcome === 'denied' ? 'Tool approval denied' : 'Session cancelled', approvalId, undefined, policyDecision.reasonCode, policyRecord)
        this.emit({ type: timedOut ? 'tool-timed-out' : 'tool-cancelled', result }); return result
      }
    }
    if (session.status !== 'running' || session.controller.signal.aborted) {
      const result = this.result(session, tool.name, correlationId, 'cancelled', undefined, 'Session cancelled')
      this.emit({ type: 'tool-cancelled', result }); return result
    }
    const startedAt = new Date().toISOString(); this.emit({ type: 'tool-started', sessionId: session.id, correlationId, toolName: tool.name, startedAt })
    const executionController = new AbortController()
    const abortExecution = () => executionController.abort()
    session.controller.signal.addEventListener('abort', abortExecution, { once: true })
    try {
      if (session.status !== 'running' || session.controller.signal.aborted) throw new Error('Tool execution cancelled')
      const output = await this.withTimeout(Promise.resolve(tool.execute(executionInput, { workspaceId: session.workspace.workspaceId, workspaceRoot: session.workspace.workspaceRoot, signal: executionController.signal })), session.timeoutMs, session.controller.signal, executionController)
      const result = this.result(session, tool.name, correlationId, 'completed', redactWorkingValue(output), undefined, undefined, startedAt, policyDecision.reasonCode, policyRecord)
      // Broadcast a display-redacted copy; the caller (model tool loop) needs the
      // working output intact or hash-bound edits can never match the file again.
      this.emit({ type: 'tool-completed', result: { ...result, output: redactPolicyValue(result.output) } }); return result
    } catch (error) {
      const timedOut = error instanceof ToolTimeoutError
      const status = timedOut ? 'timed-out' : session.controller.signal.aborted ? 'cancelled' : 'failed'
      if (timedOut) this.timeoutSession(session)
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      if (errorCode === 'SENSITIVE_PATH' || (errorCode && PATH_DENIAL_CODES.has(errorCode))) {
        policyDecision = { ...policyDecision, outcome: 'deny', approvalDecision: 'denied', reasonCode: errorCode as PolicyDecision['reasonCode'] }
        policyRecord = await this.recordPolicyDecision(session, correlationId, tool.name, executionInput, policyDecision)
      }
      const result = this.result(session, tool.name, correlationId, status, undefined, sanitizePolicyText(error instanceof Error ? error.message : error), undefined, startedAt, errorCode ?? policyDecision.reasonCode, policyRecord)
      this.emit({ type: timedOut ? 'tool-timed-out' : status === 'cancelled' ? 'tool-cancelled' : 'tool-failed', result }); return result
    } finally {
      session.controller.signal.removeEventListener('abort', abortExecution)
    }
  }

  async cancelSession(id: string): Promise<AgentSession> { const session = this.sessions.get(id); if (!session) throw new Error('Unknown session'); if (session.status === 'running') { session.status = 'cancelled'; session.updatedAt = new Date().toISOString(); session.controller.abort(); this.settleApprovals(session, 'cancelled'); await Promise.all([...session.activeCalls]); this.endSessionWhenIdle(session) }; return this.publicSession(session) }
  resolveApproval(input: unknown, callerId = 'internal'): boolean {
    if (!input || typeof input !== 'object') return false
    const value = input as Partial<ApprovalResult>
    if (typeof value.approvalId !== 'string' || typeof value.approved !== 'boolean') return false
    const session = typeof value.sessionId === 'string' ? this.sessions.get(value.sessionId) : undefined
    const pending = session?.pending.get(value.approvalId)
    if (!pending || pending.callerId !== callerId || Object.entries(pending.expected).some(([key, expected]) => value[key as keyof ApprovalResult] !== expected)) return false
    session!.pending.delete(value.approvalId); pending.resolve(value.approved ? 'approved' : 'denied'); return true
  }
  setApprovalMode(sessionId: string, mode: AgentApprovalMode, callerId = 'internal'): AgentSession | null {
    const session = this.sessions.get(sessionId)
    if (!session || (session.ownerId !== callerId && callerId !== 'internal')) return null
    if (session.status !== 'running') return this.publicSession(session)
    session.approvalMode = normalizeAgentApprovalMode(mode)
    session.updatedAt = new Date().toISOString()
    this.emit({ type: 'session-updated', session: this.publicSession(session) })
    return this.publicSession(session)
  }
  executeFunctionCall(input: ExecuteToolInput, callerId = 'internal'): Promise<ToolResult> { return this.executeTool({ ...input, call: { ...input.call, source: 'function-calling' } }, callerId) }
  executePlannerStep(input: ExecuteToolInput, callerId = 'internal'): Promise<ToolResult> { return this.executeTool({ ...input, call: { ...input.call, source: 'planner' } }, callerId) }
  getSession(id: string): AgentSession | null { const session = this.sessions.get(id); return session ? this.publicSession(session) : null }
  queryPolicyAudit(query: PolicyAuditQuery = {}): Promise<PolicyDecisionRecord[]> { return this.auditStore.query(query) }
  getPolicyAuditRecords(sessionId?: string): Promise<PolicyDecisionRecord[]> { return this.queryPolicyAudit({ sessionId }) }
  private validatePreview(actionRisk: RegisteredTool['actionRisk'], preview?: ApprovalPreview): ApprovalPreview | undefined | null {
    const requiresPreview = ['write', 'create', 'config-apply', 'external-command', 'network'].includes(actionRisk)
    if (!requiresPreview && actionRisk !== 'run') return undefined
    if (!preview) return requiresPreview ? null : undefined
    if (typeof preview.summary !== 'string' || preview.summary.length < 1 || preview.summary.length > 500 || !Array.isArray(preview.paths) || preview.paths.length > 20 || preview.paths.some((path) => typeof path !== 'string' || path.length > 500) || typeof preview.truncated !== 'boolean' || (preview.detail !== undefined && (typeof preview.detail !== 'string' || preview.detail.length > 4_000))) return null
    return {
      summary: sanitizePolicyText(preview.summary),
      paths: preview.paths.map(sanitizePolicyText),
      detail: preview.detail === undefined ? undefined : sanitizePolicyText(preview.detail),
      truncated: preview.truncated,
    }
  }
  private publicSession(session: ActiveSession): AgentSession { return { id: session.id, workspace: { ...session.workspace }, status: session.status, createdAt: session.createdAt, updatedAt: session.updatedAt, timeoutMs: session.timeoutMs, approvalMode: session.approvalMode, safeCompileAutoAllow: session.safeCompileAutoAllow !== false } }
  private endSession(session: ActiveSession): void { if (session.ended) return; session.ended = true; this.emit({ type: 'session-ended', session: this.publicSession(session) }) }
  private endSessionWhenIdle(session: ActiveSession): void { if (session.status !== 'running' && session.activeCalls.size === 0) this.endSession(session) }
  private settleApprovals(session: ActiveSession, outcome: ApprovalOutcome): void { session.pending.forEach(({ resolve }) => resolve(outcome)); session.pending.clear() }
  private timeoutSession(session: ActiveSession): void { if (session.status !== 'running') return; session.status = 'timed-out'; session.updatedAt = new Date().toISOString(); session.controller.abort(); this.settleApprovals(session, 'cancelled') }
  private result(session: ActiveSession, toolName: string, correlationId: string, status: ToolResult['status'], output?: unknown, error?: string, approvalId?: string, startedAt = new Date().toISOString(), reasonCode?: string, policyDecision?: PolicyDecisionRecord): ToolResult { const completedAt = new Date().toISOString(); const safeError = error ? sanitizePolicyText(error) : undefined; const summary = safeError ? `${toolName} ${status}: ${safeError}` : `${toolName} ${status}`; return { workspaceId: session.workspace.workspaceId, sessionId: session.id, correlationId, toolName, status, startedAt, completedAt, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), summary, output, error: safeError, approvalId, reasonCode, policyDecision } }
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal, executionController: AbortController): Promise<T> { return await new Promise<T>((resolve, reject) => { const timer = setTimeout(() => { executionController.abort(); reject(new ToolTimeoutError('Tool execution timed out')) }, timeoutMs); const abort = () => { clearTimeout(timer); executionController.abort(); reject(new Error('Tool execution cancelled')) }; if (signal.aborted) return abort(); signal.addEventListener('abort', abort, { once: true }); promise.then((value) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value) }, (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) }) }) }
}

export const workspaceAgentRuntime = new WorkspaceAgentRuntime(undefined, new FilePolicyAuditStore())
