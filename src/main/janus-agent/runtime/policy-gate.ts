import { extname } from 'path'
import { randomUUID } from 'node:crypto'
import type {
  ActionRisk,
  AgentApprovalMode,
  ApprovalDecision,
  EvidenceConfidence,
  PolicyDecision,
  PolicyDecisionRecord,
} from '../../../shared/ipc/agent-runtime'
import type { TrustedWorkspaceTarget } from './path-guard'

export type WorkspaceReadPolicyDecision = Omit<PolicyDecision, 'outcome' | 'actionRisk'> & {
  outcome: 'allow' | 'deny'
  actionRisk: 'read'
}

const SENSITIVE_DIRECTORIES = new Set(['.aws', '.azure', '.git', '.gnupg', '.kube', '.secrets', '.ssh', 'secrets'])
const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.envrc',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
])
const SENSITIVE_EXTENSIONS = new Set(['.jks', '.key', '.keystore', '.p12', '.pem', '.pfx'])

export function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split(/[\\/]+/).filter(Boolean)
  const filename = segments.at(-1) ?? ''
  const normalizedPath = segments.join('/')
  return segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))
    || SENSITIVE_FILENAMES.has(filename)
    || filename.startsWith('.env.')
    || normalizedPath === '.docker/config.json'
    || normalizedPath.endsWith('/.docker/config.json')
    || normalizedPath === '.config/gcloud/application_default_credentials.json'
    || normalizedPath.endsWith('/.config/gcloud/application_default_credentials.json')
    || /^client_secret(?:[-_.].*)?\.json$/.test(filename)
    || /^service[-_]account(?:[-_.].*)?\.json$/.test(filename)
    || SENSITIVE_EXTENSIONS.has(extname(filename))
}

const READ_ONLY_ACTIONS = new Set<ActionRisk>(['inspect', 'list', 'stat', 'read'])

/**
 * P5 安全编译模式放行：可信工作区内的只读型构建命令在 per-action 下免逐次审批。
 * 名单集中在此（代码级常量，fail-closed；R2 起总开关经 settings 接线
 * `safeCompileAutoAllow`，会话级透传，见 runtime.ts）。
 * `npx tsc --noEmit`、`node scripts/check-*.mjs`。含 shell 元字符、`..`、绝对
 * 路径、超长参数一律不放行；执行层的 program/args 校验仍会再生效（fail-closed）。
 */
export const SAFE_COMPILE_MANAGERS = new Set(['npm', 'yarn', 'pnpm', 'bun'])
export const SAFE_COMPILE_SCRIPTS = new Set(['build', 'typecheck', 'lint', 'test'])
export const SAFE_COMPILE_CHECK_SCRIPT = /^scripts\/check-[^/]+\.mjs$/
const SAFE_COMMAND_ARG_META = /[&|<>^\r\n\0]/

export function isSafeCompileCommand(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName !== 'command.run') return false
  const program = typeof input.program === 'string' ? input.program.trim().toLowerCase() : ''
  const args = Array.isArray(input.args) ? input.args : undefined
  if (!program || !args || args.length > 100 || !args.every((arg) => typeof arg === 'string')) return false
  if (args.some((arg) => arg.length > 4096 || SAFE_COMMAND_ARG_META.test(arg))) return false
  // 仅裸命令名：工作区相对可执行路径（program 含 / 或 \) 永不放行。
  if (!program || /[/\\]/.test(program)) return false
  if (SAFE_COMPILE_MANAGERS.has(program)) {
    return (args.length === 2 && args[0] === 'run' && SAFE_COMPILE_SCRIPTS.has(args[1]))
      || (args.length === 1 && args[0] === 'test')
  }
  if (program === 'npx') {
    return args[0] === 'tsc' && args.includes('--noEmit')
  }
  if (program === 'node') {
    return args.length >= 1 && SAFE_COMPILE_CHECK_SCRIPT.test(args[0])
  }
  return false
}const EVIDENCE_CONFIDENCE_VALUES = new Set<EvidenceConfidence>(['unknown', 'low', 'medium', 'high'])
const SECRET_FIELD_PARTS = ['apikey', 'authorization', 'cookie', 'credential', 'password', 'privatekey', 'secret', 'token']
const SECRET_TEXT_PATTERNS = [
  /\bBearer\s+[^\s,;]+/gi,
  /\bsk-[a-z0-9_-]{8,}\b/gi,
  /\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
]
// Patterns that are near-certain credential material. Unlike SECRET_TEXT_PATTERNS
// (display/audit redaction, tolerant of false positives), these are the only
// patterns allowed to mask content handed back to the model as working data —
// broad assignment patterns like `apiKey: x` would corrupt ordinary source files
// and break hash-bound workspace edits.
const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
]

export function redactHighConfidenceSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false
  const next = HIGH_CONFIDENCE_SECRET_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, () => {
      redacted = true
      return '[REDACTED]'
    }),
    text,
  )
  return { text: next, redacted }
}

// Working-data redaction for tool outputs returned to the model: masks only
// high-confidence secrets and never rewrites by field name, so file content
// stays byte-identical to disk wherever no real credential is present.
export function redactWorkingValue(value: unknown): unknown {
  if (typeof value === 'string') return redactHighConfidenceSecrets(value).text
  if (Array.isArray(value)) return value.map(redactWorkingValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactWorkingValue(item)]))
}

export function redactPolicyValue(value: unknown): unknown {
  if (typeof value === 'string') return SECRET_TEXT_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value)
  if (Array.isArray(value)) return value.map(redactPolicyValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    return [key, SECRET_FIELD_PARTS.some((part) => normalizedKey.includes(part)) ? '[REDACTED]' : redactPolicyValue(item)]
  }))
}

export function projectPolicyInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectPolicyInput)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? `[string:${value.length}]` : value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectPolicyInput(item)]))
}

export function sanitizePolicyText(value: unknown): string {
  return String(redactPolicyValue(value)).slice(0, 2_000)
}

export function evaluateWorkspaceActionPolicy(input: {
  actionRisk: ActionRisk
  evidenceConfidence?: EvidenceConfidence
  relativePath?: string
  approvalMode?: AgentApprovalMode
}): PolicyDecision {
  const evidenceConfidence = input.evidenceConfidence && EVIDENCE_CONFIDENCE_VALUES.has(input.evidenceConfidence)
    ? input.evidenceConfidence
    : 'unknown'
  if (input.relativePath !== undefined && isSensitivePath(input.relativePath)) {
    return {
      outcome: 'deny',
      evidenceConfidence,
      actionRisk: input.actionRisk,
      approvalPolicy: 'none',
      approvalDecision: 'denied',
      reasonCode: 'SENSITIVE_PATH',
    }
  }
  if (READ_ONLY_ACTIONS.has(input.actionRisk)) {
    return {
      outcome: 'allow',
      evidenceConfidence,
      actionRisk: input.actionRisk,
      approvalPolicy: 'none',
      approvalDecision: 'not-required',
      reasonCode: input.actionRisk === 'read' ? 'READ_ALLOWED' : 'READ_ONLY_ALLOWED',
    }
  }
  if (input.approvalMode === 'auto-run') {
    return {
      outcome: 'allow',
      evidenceConfidence,
      actionRisk: input.actionRisk,
      approvalPolicy: 'auto-run',
      approvalDecision: 'not-required',
      reasonCode: 'AUTO_RUN_ALLOWED',
    }
  }
  return {
    outcome: 'approval-required',
    evidenceConfidence,
    actionRisk: input.actionRisk,
    approvalPolicy: 'per-action',
    approvalDecision: 'pending',
    reasonCode: 'ACTION_REQUIRES_APPROVAL',
  }
}

const APPROVAL_RESULTS: Record<Exclude<ApprovalDecision, 'not-required' | 'pending'>, Pick<PolicyDecision, 'outcome' | 'reasonCode'>> = {
  approved: { outcome: 'allow', reasonCode: 'APPROVAL_GRANTED' },
  denied: { outcome: 'deny', reasonCode: 'APPROVAL_DENIED' },
  cancelled: { outcome: 'deny', reasonCode: 'APPROVAL_CANCELLED' },
  'timed-out': { outcome: 'deny', reasonCode: 'APPROVAL_TIMED_OUT' },
}

export function settleApprovalDecision(decision: PolicyDecision, approvalDecision: keyof typeof APPROVAL_RESULTS): PolicyDecision {
  const result = APPROVAL_RESULTS[approvalDecision]
  return { ...decision, ...result, approvalDecision }
}

export function createPolicyDecisionRecord(input: {
  decision: PolicyDecision
  workspaceId: string
  sessionId: string
  correlationId: string
  toolName: string
  toolInput?: Record<string, unknown>
}): PolicyDecisionRecord {
  return {
    id: randomUUID(),
    ...input.decision,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    toolName: input.toolName,
    createdAt: new Date().toISOString(),
    input: input.toolInput ? projectPolicyInput(input.toolInput) as Record<string, unknown> : undefined,
    provenance: 'agent-runtime',
  }
}

export function evaluateWorkspaceReadPolicy(
  target: Pick<TrustedWorkspaceTarget, 'relativePath'>,
): WorkspaceReadPolicyDecision {
  if (isSensitivePath(target.relativePath)) {
    return {
      outcome: 'deny',
      evidenceConfidence: 'unknown',
      actionRisk: 'read',
      approvalPolicy: 'none',
      approvalDecision: 'denied',
      reasonCode: 'SENSITIVE_PATH',
    }
  }
  return {
    outcome: 'allow',
    evidenceConfidence: 'unknown',
    actionRisk: 'read',
    approvalPolicy: 'none',
    approvalDecision: 'not-required',
    reasonCode: 'READ_ALLOWED',
  }
}
