import type { OperationResult } from './workspace'

export const SYSTEM_CHANNELS = {
  defaultShell: 'system:getDefaultShell', platform: 'system:getPlatform',
  openDirectory: 'dialog:openDirectory', saveFile: 'dialog:saveFile', showMessageBox: 'dialog:showMessageBox',
  minimize: 'window:minimize', maximize: 'window:maximize', close: 'window:close',
  openEditor: 'editor-window:open', refreshEditor: 'editor-window:refresh', editorReady: 'editor-window:ready', embedEditor: 'editor-window:embed', editorEmbedded: 'editor-window:embedded',
  setAlwaysOnTop: 'editor-window:set-always-on-top', runtimeTelemetry: 'runtime-telemetry:get',
  toastReady: 'desktop-toast:ready', toastAction: 'desktop-toast:action', toastShow: 'desktop-toast:show',
  getLanguage: 'app:getLanguage', setLanguage: 'app:setLanguage',
  openVSCode: 'system:openVSCode',
  prepareQuit: 'app:prepareQuit',
  prepareQuitAck: 'app:prepareQuitAck',
} as const

export interface RuntimeTelemetryRequest {
  /** JanusX terminal identity. Main process resolves its exact external-session binding. */
  terminalId?: string
  preset?: 'shell' | 'claude' | 'codex' | 'opencode' | 'janus'
  cwd?: string
  startedAt?: number
  sessionId?: string
}
export type RuntimeTelemetrySource = 'provider-event' | 'history' | 'terminal-text' | 'model-registry' | 'configuration'
export type RuntimeTelemetryConfidence = 'authoritative' | 'derived' | 'declared' | 'estimated'
export interface RuntimeTelemetrySnapshot {
  detectedModel?: string; contextTokens?: number; contextWindowTokens?: number; inputTokens?: number; outputTokens?: number
  cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number
  filePath?: string; sessionId?: string; observedAt?: number
  source?: RuntimeTelemetrySource; confidence?: RuntimeTelemetryConfidence
  /** A hook or adapter explicitly associated this external session with one JanusX terminal. */
  sessionBinding?: 'exact'
  /** Only present when the adapter has counted compactions for an exactly bound session. */
  compactionCount?: number
  compactionCountConfidence?: 'exact'
  /** The latest runtime model selection event for this session. */
  modelChangedAt?: number
}
export interface DesktopToastPayload {
  id?: string; type?: 'completed' | 'failed' | 'attention'; engine?: string; title?: string; body?: string
  terminalId?: string; workspaceId?: string; createdAt?: string
}

export interface DialogAPI {
  openDirectory(): Promise<{ canceled: boolean; filePaths: string[] }>
  saveFile(options: { defaultName?: string; extension?: string }): Promise<{ canceled: boolean; filePath?: string }>
  showMessageBox(options: { message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number }): Promise<{ response: number }>
}
export interface WindowAPI {
  minimize(): Promise<void>; maximize(): Promise<void>; close(): Promise<void>
  openEditor(payload: { filePath?: string; workspacePath?: string }): Promise<{ success?: boolean }>
  editorReady(): void
  embedEditor(payload: { filePath: string; workspacePath: string; content?: string; isDirty?: boolean }): Promise<{ success?: boolean }>
  setAlwaysOnTop(value: boolean): Promise<{ value: boolean }>
  onEditorEmbedded(callback: (payload: { filePath: string; workspacePath: string; content?: string; isDirty?: boolean }) => void): () => void
  onEditorRefresh(callback: (payload: { filePath: string; workspacePath: string }) => void): () => void
}
export interface SystemAPI {
  getDefaultShell(): Promise<string>; getPlatform(): Promise<NodeJS.Platform>
  openVSCode(workspacePath: string): Promise<OperationResult>
  getRuntimeTelemetry(request: RuntimeTelemetryRequest): Promise<RuntimeTelemetrySnapshot | null>
  getLanguage(): Promise<string | null>
  setLanguage(lang: string): Promise<void>
  onPrepareQuit(callback: () => Promise<void> | void): () => void
}
export interface DesktopToastAPI {
  ready(): void; action(action: 'activate' | 'dismiss'): void
  onShow(callback: (payload: DesktopToastPayload) => void): () => void
}
