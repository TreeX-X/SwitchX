import { describe, expect, it } from 'vitest'
import {
  evaluateWorkspaceActionPolicy,
  evaluateWorkspaceReadPolicy,
  redactHighConfidenceSecrets,
  redactPolicyValue,
  redactWorkingValue,
  settleApprovalDecision,
} from '../../../src/main/janus-agent/runtime/policy-gate'
import { normalizeAgentApprovalMode } from '../../../src/shared/ipc/agent-runtime'

describe('workspace read policy', () => {
  it('normalizes unknown permission settings to strict approval', () => {
    expect(normalizeAgentApprovalMode(undefined)).toBe('per-action')
    expect(normalizeAgentApprovalMode('unexpected')).toBe('per-action')
    expect(normalizeAgentApprovalMode('auto-run')).toBe('auto-run')
  })
  it.each([
    'src/index.ts',
    'docs/environment.md',
    'config/application.json',
    'assets/private-key-guide.txt',
    'secret/example.txt',
    'secrets-guide/example.txt',
    '.envrc.example',
    '.docker/config.example.json',
    '.config/gcloud/README.md',
    '',
  ])(
    'allows ordinary read target %s without approval',
    (relativePath) => {
      expect(evaluateWorkspaceReadPolicy({ relativePath })).toEqual({
        outcome: 'allow',
        evidenceConfidence: 'unknown',
        actionRisk: 'read',
        approvalPolicy: 'none',
        approvalDecision: 'not-required',
        reasonCode: 'READ_ALLOWED',
      })
    },
  )

  it.each([
    '.env',
    '.ENV.LOCAL',
    '.envrc',
    'config\\.npmrc',
    '.ssh/id_rsa',
    '.AWS/credentials',
    'secrets/client_secret.production.json',
    'secrets/service-account-ci.json',
    'certificates/signing.PEM',
    'certificates/release.p12',
    'secrets/application.json',
    '.secrets/application.json',
    '.docker/config.json',
    'home/.docker/config.json',
    '.config/gcloud/application_default_credentials.json',
    'home/.config/gcloud/application_default_credentials.json',
  ])('denies sensitive read target %s with an explainable reason', (relativePath) => {
    expect(evaluateWorkspaceReadPolicy({ relativePath })).toEqual({
      outcome: 'deny',
      evidenceConfidence: 'unknown',
      actionRisk: 'read',
      approvalPolicy: 'none',
      approvalDecision: 'denied',
      reasonCode: 'SENSITIVE_PATH',
    })
  })

  it.each(['inspect', 'list', 'stat', 'read'] as const)('allows read-only %s without approval', (actionRisk) => {
    expect(evaluateWorkspaceActionPolicy({ actionRisk, evidenceConfidence: 'high' })).toMatchObject({
      outcome: 'allow',
      evidenceConfidence: 'high',
      approvalPolicy: 'none',
      approvalDecision: 'not-required',
      reasonCode: actionRisk === 'read' ? 'READ_ALLOWED' : 'READ_ONLY_ALLOWED',
    })
  })

  it.each(['write', 'create', 'config-apply', 'run', 'restore', 'delete', 'external-command', 'network'] as const)(
    'requires per-action approval for %s regardless of confidence',
    (actionRisk) => {
      const low = evaluateWorkspaceActionPolicy({ actionRisk, evidenceConfidence: 'low' })
      const high = evaluateWorkspaceActionPolicy({ actionRisk, evidenceConfidence: 'high' })
      expect(low).toMatchObject({ outcome: 'approval-required', approvalPolicy: 'per-action', approvalDecision: 'pending' })
      expect(high).toMatchObject({ outcome: 'approval-required', approvalPolicy: 'per-action', approvalDecision: 'pending' })
      expect(settleApprovalDecision(high, 'approved')).toMatchObject({
        outcome: 'allow', approvalDecision: 'approved', reasonCode: 'APPROVAL_GRANTED',
      })
    },
  )

  it.each(['write', 'create', 'config-apply', 'run', 'restore', 'delete', 'external-command', 'network'] as const)(
    'allows ordinary %s in auto-run mode without approval',
    (actionRisk) => {
      expect(evaluateWorkspaceActionPolicy({ actionRisk, approvalMode: 'auto-run' })).toMatchObject({
        outcome: 'allow', approvalPolicy: 'auto-run', approvalDecision: 'not-required', reasonCode: 'AUTO_RUN_ALLOWED',
      })
    },
  )

  it('keeps sensitive paths denied in auto-run mode', () => {
    expect(evaluateWorkspaceActionPolicy({ actionRisk: 'write', relativePath: '.env', approvalMode: 'auto-run' })).toMatchObject({
      outcome: 'deny', approvalPolicy: 'none', reasonCode: 'SENSITIVE_PATH',
    })
  })

  it('denies sensitive targets and redacts secret-bearing fields', () => {
    expect(evaluateWorkspaceActionPolicy({ actionRisk: 'write', relativePath: '.env' })).toMatchObject({
      outcome: 'deny', reasonCode: 'SENSITIVE_PATH',
    })
    expect(redactPolicyValue({ path: 'config.json', apiKey: 'secret', nested: { access_token: 'token', value: 'ok' } })).toEqual({
      path: 'config.json', apiKey: '[REDACTED]', nested: { access_token: '[REDACTED]', value: 'ok' },
    })
  })

  it('keeps ordinary secret-shaped source code intact as working data', () => {
    const source = 'const apiKey = process.env.MY_KEY\nconst token = getToken()\npassword: readPassword()'
    expect(redactHighConfidenceSecrets(source)).toEqual({ text: source, redacted: false })
    expect(redactWorkingValue({ content: source, apiKey: 'field-name-untouched' })).toEqual({
      content: source,
      apiKey: 'field-name-untouched',
    })
  })

  it('masks only high-confidence credential material in working data', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'
    const key = 'sk-abcdefghijklmnop1234'
    expect(redactHighConfidenceSecrets(`before\n${pem}\nafter ${key}`)).toEqual({
      text: 'before\n[REDACTED]\nafter [REDACTED]',
      redacted: true,
    })
    expect(redactWorkingValue({ nested: [pem] })).toEqual({ nested: ['[REDACTED]'] })
    // Short sk- prefixes stay below the high-confidence threshold.
    expect(redactHighConfidenceSecrets('sk-short123').redacted).toBe(false)
  })

  it('normalizes untrusted confidence metadata without changing authority', () => {
    const decision = evaluateWorkspaceActionPolicy({
      actionRisk: 'write',
      evidenceConfidence: 'certain' as never,
    })
    expect(decision).toMatchObject({
      evidenceConfidence: 'unknown',
      outcome: 'approval-required',
      approvalPolicy: 'per-action',
    })
  })
})
