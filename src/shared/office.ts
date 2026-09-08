export const OFFICE_EXTENSIONS = ['.docx', '.xlsx', '.pptx'] as const
export type OfficeExtension = (typeof OFFICE_EXTENSIONS)[number]

export const OFFICE_INVOKE_CHANNELS = {
  detect: 'office:detect',
  listFiles: 'office:files:list',
  startPreview: 'office:preview:start',
  stopPreview: 'office:preview:stop',
  reloadPreview: 'office:preview:reload',
  buildPrompt: 'office:prompt:build',
  installerStatus: 'office:installer:status',
  installerStart: 'office:installer:start',
  installerCancel: 'office:installer:cancel',
  installerRemove: 'office:installer:remove',
} as const

export const OFFICE_EVENT_CHANNELS = {
  filesChanged: 'office:files:changed',
  watchEvicted: 'office:watch-evicted',
  installerProgress: 'office:installer:progress',
} as const

export type OfficeInvokeChannel = (typeof OFFICE_INVOKE_CHANNELS)[keyof typeof OFFICE_INVOKE_CHANNELS]
export type OfficeEventChannel = (typeof OFFICE_EVENT_CHANNELS)[keyof typeof OFFICE_EVENT_CHANNELS]

export interface OfficeAPI {
  detect(request: OfficeWorkspaceRequest): Promise<OfficeResult<OfficecliPublicInfo>>
  listFiles(request: OfficeWorkspaceRequest): Promise<OfficeResult<OfficeFileEntry[]>>
  startPreview(request: OfficeFileRequest): Promise<OfficeResult<OfficePreviewLease>>
  stopPreview(request: OfficeStopPreviewRequest): Promise<OfficeResult<null>>
  reloadPreview(request: OfficeReloadPreviewRequest): Promise<OfficeResult<OfficePreviewLease>>
  buildPrompt(request: OfficeBuildPromptRequest): Promise<OfficeResult<OfficePrompt>>
  installerStatus(request: OfficeInstallerStatusRequest): Promise<OfficeResult<OfficeManagedInstallStatus>>
  installerStart(request: OfficeInstallerStartRequest): Promise<OfficeResult<OfficeManagedInstallStatus>>
  installerCancel(request: OfficeInstallerCancelRequest): Promise<OfficeResult<OfficeManagedInstallStatus>>
  installerRemove(request: OfficeInstallerRemoveRequest): Promise<OfficeResult<OfficeManagedInstallStatus>>
  onInstallerProgress(listener: (event: OfficeInstallerProgressEvent) => void): () => void
  onFilesChanged(listener: (event: OfficeFilesChangedEvent) => void): () => void
  onWatchEvicted(listener: (event: OfficeWatchEvictedEvent) => void): () => void
}

export const OFFICE_WATCH_ERROR_CODES = [
  'NOT_INSTALLED',
  'INCOMPATIBLE',
  'NOT_OFFICE',
  'OUTSIDE_ROOT',
  'START_FAILED',
  'PORT_TIMEOUT',
  'NO_PORT',
  'TOO_MANY',
  'SCAN_LIMIT',
  'IO',
] as const

export type OfficeWatchErrorCode = (typeof OFFICE_WATCH_ERROR_CODES)[number]
export type OfficeErrorCode = OfficeWatchErrorCode | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'UNAVAILABLE'

export const OFFICE_SKILL_IDS = ['officecli-xlsx', 'officecli-docx', 'officecli-pptx'] as const
export type OfficeSkillId = (typeof OFFICE_SKILL_IDS)[number]

export interface OfficeFileEntry {
  relPath: string
  mtimeMs: number
  size: number
  ext: OfficeExtension
}

export interface OfficecliManualInstallGuidance {
  repository: string
  release: string
  targetVersion: string
  integrity: string
  windows: readonly string[]
  automaticInstallEnabled: false
  automaticUninstallEnabled: false
}

export interface OfficecliPublicInfo {
  installed: boolean
  compatible: boolean
  version?: string
  source?: 'path' | 'known-location' | 'managed'
  manualInstall?: OfficecliManualInstallGuidance
  existingTerminalNotice?: string
}

export interface OfficecliInfo extends OfficecliPublicInfo {
  path?: string
  runtimeError?: string
}

export interface OfficePreviewLease {
  previewLeaseId: string
  port: number
  relPath: string
}

export interface OfficeWorkspaceRequest {
  workspaceId: string
}

export interface OfficeFileRequest extends OfficeWorkspaceRequest {
  relPath: string
}

export interface OfficeStopPreviewRequest extends OfficeFileRequest {
  previewLeaseId: string
}

export interface OfficeReloadPreviewRequest extends OfficeStopPreviewRequest {}

export interface OfficeBuildPromptRequest extends OfficeFileRequest {
  terminalPreset: 'shell' | 'claude' | 'codex' | 'opencode' | 'janus'
  skillId?: OfficeSkillId
}

export interface OfficePrompt {
  text: string
  mode: 'generic' | 'specific' | 'guidance'
}

export interface OfficeError {
  code: OfficeErrorCode
  message: string
}

export type OfficeResult<T> = { ok: true; value: T } | { ok: false; error: OfficeError }

export interface OfficeFilesChangedEvent {
  workspaceId: string
  entries: OfficeFileEntry[]
  reason: 'initial' | 'reconciled' | 'watch'
}

export interface OfficeWatchEvictedEvent {
  previewLeaseIds: string[]
  relPath: string
  reason: 'crashed' | 'workspace-removed' | 'shutdown'
}

export interface OfficeInstallerProgressEvent {
  stage: 'idle' | 'downloading' | 'verifying' | 'installing' | 'complete' | 'failed'
  percent?: number
  message?: string
}

export interface OfficeManagedInstallStatus {
  state: 'not-installed' | 'ready' | 'busy' | 'failed'
  version?: string
  sha256?: string
  source?: string
  location: string
  existingTerminalNotice?: string
  error?: string
}

export interface OfficeInstallerStatusRequest {
  workspaceId?: string
}

export interface OfficeInstallerCancelRequest {
  workspaceId?: string
}

export interface OfficeInstallerStartRequest {
  workspaceId?: string
  confirmed: true
  repair?: boolean
}

export interface OfficeInstallerRemoveRequest {
  workspaceId?: string
  confirmed: true
}

export type OfficeInvokeRequestMap = {
  [OFFICE_INVOKE_CHANNELS.detect]: OfficeWorkspaceRequest
  [OFFICE_INVOKE_CHANNELS.listFiles]: OfficeWorkspaceRequest
  [OFFICE_INVOKE_CHANNELS.startPreview]: OfficeFileRequest
  [OFFICE_INVOKE_CHANNELS.stopPreview]: OfficeStopPreviewRequest
  [OFFICE_INVOKE_CHANNELS.reloadPreview]: OfficeReloadPreviewRequest
  [OFFICE_INVOKE_CHANNELS.buildPrompt]: OfficeBuildPromptRequest
  [OFFICE_INVOKE_CHANNELS.installerStatus]: OfficeInstallerStatusRequest
  [OFFICE_INVOKE_CHANNELS.installerStart]: OfficeInstallerStartRequest
  [OFFICE_INVOKE_CHANNELS.installerCancel]: OfficeInstallerCancelRequest
  [OFFICE_INVOKE_CHANNELS.installerRemove]: OfficeInstallerRemoveRequest
}

export type OfficeInvokeResultMap = {
  [OFFICE_INVOKE_CHANNELS.detect]: OfficecliPublicInfo
  [OFFICE_INVOKE_CHANNELS.listFiles]: OfficeFileEntry[]
  [OFFICE_INVOKE_CHANNELS.startPreview]: OfficePreviewLease
  [OFFICE_INVOKE_CHANNELS.stopPreview]: null
  [OFFICE_INVOKE_CHANNELS.reloadPreview]: OfficePreviewLease
  [OFFICE_INVOKE_CHANNELS.buildPrompt]: OfficePrompt
  [OFFICE_INVOKE_CHANNELS.installerStatus]: OfficeManagedInstallStatus
  [OFFICE_INVOKE_CHANNELS.installerStart]: OfficeManagedInstallStatus
  [OFFICE_INVOKE_CHANNELS.installerCancel]: OfficeManagedInstallStatus
  [OFFICE_INVOKE_CHANNELS.installerRemove]: OfficeManagedInstallStatus
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false }

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const TERMINAL_PRESETS = new Set(['shell', 'claude', 'codex', 'opencode'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && WORKSPACE_ID_PATTERN.test(value)
}

function isRelPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

export function validateOfficeInvokeRequest<C extends OfficeInvokeChannel>(
  channel: C,
  input: unknown,
): ValidationResult<OfficeInvokeRequestMap[C]> {
  if (!isRecord(input)) return { ok: false }

  if (channel === OFFICE_INVOKE_CHANNELS.installerStatus || channel === OFFICE_INVOKE_CHANNELS.installerCancel) {
    if (input.workspaceId !== undefined && !isWorkspaceId(input.workspaceId)) return { ok: false }
    return hasOnlyKeys(input, ['workspaceId'])
      ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
      : { ok: false }
  }

  if (channel === OFFICE_INVOKE_CHANNELS.installerStart) {
    if (input.workspaceId !== undefined && !isWorkspaceId(input.workspaceId)) return { ok: false }
    return hasOnlyKeys(input, ['workspaceId', 'confirmed', 'repair']) && input.confirmed === true &&
      (input.repair === undefined || typeof input.repair === 'boolean')
      ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
      : { ok: false }
  }

  if (channel === OFFICE_INVOKE_CHANNELS.installerRemove) {
    if (input.workspaceId !== undefined && !isWorkspaceId(input.workspaceId)) return { ok: false }
    return hasOnlyKeys(input, ['workspaceId', 'confirmed']) && input.confirmed === true
      ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
      : { ok: false }
  }

  if (!isWorkspaceId(input.workspaceId)) return { ok: false }

  if (channel === OFFICE_INVOKE_CHANNELS.detect || channel === OFFICE_INVOKE_CHANNELS.listFiles) {
    return hasOnlyKeys(input, ['workspaceId'])
      ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
      : { ok: false }
  }

  if (!isRelPath(input.relPath)) return { ok: false }

  if (channel === OFFICE_INVOKE_CHANNELS.startPreview) {
    return hasOnlyKeys(input, ['workspaceId', 'relPath'])
      ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
      : { ok: false }
  }

  if (channel === OFFICE_INVOKE_CHANNELS.stopPreview || channel === OFFICE_INVOKE_CHANNELS.reloadPreview) {
    return hasOnlyKeys(input, ['workspaceId', 'relPath', 'previewLeaseId']) &&
      typeof input.previewLeaseId === 'string' && input.previewLeaseId.length > 0
      ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
      : { ok: false }
  }

  const skillIdIsValid =
    input.skillId === undefined || (OFFICE_SKILL_IDS as readonly unknown[]).includes(input.skillId)
  return hasOnlyKeys(input, ['workspaceId', 'relPath', 'terminalPreset', 'skillId']) &&
    typeof input.terminalPreset === 'string' && TERMINAL_PRESETS.has(input.terminalPreset) && skillIdIsValid
    ? { ok: true, value: input as unknown as OfficeInvokeRequestMap[C] }
    : { ok: false }
}

export function officeOk<T>(value: T): OfficeResult<T> {
  return { ok: true, value }
}

export function officeError(code: OfficeErrorCode, message: string): OfficeResult<never> {
  return { ok: false, error: { code, message } }
}
