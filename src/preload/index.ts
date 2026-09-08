import { contextBridge, ipcRenderer } from 'electron'
import os from 'os'
import { JANUS_PERSONA } from '../shared/janus/persona'
import { OFFICE_EVENT_CHANNELS, OFFICE_INVOKE_CHANNELS, type OfficeAPI } from '../shared/office'
import {
  FILE_CHANNELS,
  FILE_TREE_CHANNELS,
  WORKSPACE_CHANNELS,
  type FileAPI,
  type FileTreeAPI,
  type WorkspaceAPI,
} from '../shared/ipc/workspace'
import { LANGUAGE_SERVICE_CHANNELS, LANGUAGE_SERVICE_EVENT_CHANNELS, type LanguageServiceAPI } from '../shared/ipc/language-service'
import {
  TERMINAL_EVENT_CHANNELS,
  TERMINAL_INVOKE_CHANNELS,
  TERMINAL_SEND_CHANNELS,
  type TerminalAPI,
} from '../shared/ipc/terminal'
import { PROJECT_CHANNELS, type ProjectAPI } from '../shared/ipc/project'
import { BROWSER_EVENT_CHANNELS, BROWSER_INVOKE_CHANNELS, type BrowserAPI } from '../shared/ipc/browser'
import { KNOWLEDGE_CHANNELS, type KnowledgeAPI } from '../shared/ipc/knowledge'
import {
  JANUS_COMMAND_CHANNELS,
  JANUS_EVENT_CHANNELS,
  type JanusAPI
} from '../shared/ipc/janus'
import { AGENT_CHANNELS, SUBAGENT_RUN_CHANNELS, type AgentAPI, type SubAgentRunAPI } from '../shared/ipc/janus-runner'
import { AGENT_RUNTIME_CHANNELS, type AgentRuntimeAPI } from '../shared/ipc/agent-runtime'
import { CHECKPOINT_CHANNELS, type CheckpointAPI } from '../shared/ipc/checkpoint'
import { GIT_CHANNELS, type GitAPI } from '../shared/ipc/git'
import { LLM_CHANNELS, type LlmAPI } from '../shared/ipc/llm'
import { JANUS_CHAT_CHANNELS, type JanusChatAPI } from '../shared/ipc/janus-chat'
import { ROUNDTABLE_CHANNELS, type RoundtableAPI } from '../shared/ipc/roundtable'
import { AGENT_SETTINGS_CHANNELS, NOTIFICATION_SETTINGS_CHANNELS, type AgentSettingsAPI, type NotificationSettingsAPI } from '../shared/ipc/settings'
import { SYSTEM_CHANNELS, type DesktopToastAPI, type DialogAPI, type SystemAPI, type WindowAPI } from '../shared/ipc/system'

const workspaceAPI: WorkspaceAPI = {
  initialize: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.initialize),
  list: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.list),
  load: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.load, id),
  create: (input) => ipcRenderer.invoke(WORKSPACE_CHANNELS.create, input),
  update: (id, updates) => ipcRenderer.invoke(WORKSPACE_CHANNELS.update, id, updates),
  delete: (id) => ipcRenderer.invoke(WORKSPACE_CHANNELS.delete, id),
}

const fileTreeAPI: FileTreeAPI = {
  load: (rootPath) => ipcRenderer.invoke(FILE_TREE_CHANNELS.load, rootPath),
  children: (rootPath, relativePath) => ipcRenderer.invoke(FILE_TREE_CHANNELS.children, rootPath, relativePath),
  createFile: (rootPath, parentRelativePath, name) =>
    ipcRenderer.invoke(FILE_TREE_CHANNELS.createFile, rootPath, parentRelativePath, name),
  createDirectory: (rootPath, parentRelativePath, name) =>
    ipcRenderer.invoke(FILE_TREE_CHANNELS.createDirectory, rootPath, parentRelativePath, name),
  rename: (rootPath, relativePath, name) => ipcRenderer.invoke(FILE_TREE_CHANNELS.rename, rootPath, relativePath, name),
  move: (rootPath, sourceRelativePath, targetDirectoryRelativePath) =>
    ipcRenderer.invoke(FILE_TREE_CHANNELS.move, rootPath, sourceRelativePath, targetDirectoryRelativePath),
  delete: (rootPath, relativePath) => ipcRenderer.invoke(FILE_TREE_CHANNELS.delete, rootPath, relativePath),
  reveal: (rootPath, relativePath) => ipcRenderer.invoke(FILE_TREE_CHANNELS.reveal, rootPath, relativePath),
  onChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { workspacePath: string; changedFilePath?: string | null }) => callback(payload)
    ipcRenderer.on(FILE_TREE_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(FILE_TREE_CHANNELS.changed, handler)
  },
}

const fileAPI: FileAPI = {
  read: (filePath) => ipcRenderer.invoke(FILE_CHANNELS.read, filePath),
  save: (filePath, content) => ipcRenderer.invoke(FILE_CHANNELS.save, filePath, content),
  readBinary: (filePath) => ipcRenderer.invoke(FILE_CHANNELS.readBinary, filePath),
  stat: (filePath) => ipcRenderer.invoke(FILE_CHANNELS.stat, filePath),
  sourceFiles: (workspacePath) => ipcRenderer.invoke(FILE_CHANNELS.sourceFiles, workspacePath),
}

const languageServiceAPI: LanguageServiceAPI = {
  definition: (request) => ipcRenderer.invoke(LANGUAGE_SERVICE_CHANNELS.definition, request),
  installer: {
    status: (request) => ipcRenderer.invoke(LANGUAGE_SERVICE_CHANNELS.installerStatus, request),
    start: (request) => ipcRenderer.invoke(LANGUAGE_SERVICE_CHANNELS.installerStart, request),
    cancel: (request) => ipcRenderer.invoke(LANGUAGE_SERVICE_CHANNELS.installerCancel, request),
    remove: (request) => ipcRenderer.invoke(LANGUAGE_SERVICE_CHANNELS.installerRemove, request),
    onInstallerProgress: (listener) => subscribeIpcEvent(LANGUAGE_SERVICE_EVENT_CHANNELS.installerProgress, listener),
  },
}

function subscribeIpcEvent<T>(channel: string, callback: (event: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const terminalAPI: TerminalAPI = {
  warmup: (request) => ipcRenderer.invoke(TERMINAL_INVOKE_CHANNELS.warmup, request),
  create: (request) => ipcRenderer.invoke(TERMINAL_INVOKE_CHANNELS.create, request),
  replay: (id) => ipcRenderer.invoke(TERMINAL_INVOKE_CHANNELS.replay, { id }),
  kill: (id) => ipcRenderer.invoke(TERMINAL_INVOKE_CHANNELS.kill, { id }),
  input: (id, data) => ipcRenderer.send(TERMINAL_SEND_CHANNELS.input, { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send(TERMINAL_SEND_CHANNELS.resize, { id, cols, rows }),
  submitLine: (id, text) => ipcRenderer.send(TERMINAL_SEND_CHANNELS.submitLine, { id, text }),
  onData: (callback) => subscribeIpcEvent(TERMINAL_EVENT_CHANNELS.data, callback),
  onExit: (callback) => subscribeIpcEvent(TERMINAL_EVENT_CHANNELS.exit, callback),
  onFocus: (callback) => subscribeIpcEvent(TERMINAL_EVENT_CHANNELS.focus, callback),
  onCreated: (callback) => subscribeIpcEvent(TERMINAL_EVENT_CHANNELS.created, callback),
  onStatus: (callback) => subscribeIpcEvent(TERMINAL_EVENT_CHANNELS.status, callback),
  onTelemetry: (callback) => subscribeIpcEvent(TERMINAL_EVENT_CHANNELS.telemetry, callback),
}

const projectAPI: ProjectAPI = {
  detect: (projectPath) => ipcRenderer.invoke(PROJECT_CHANNELS.detect, projectPath),
  detectWithDetails: (projectPath) => ipcRenderer.invoke(PROJECT_CHANNELS.detectWithDetails, projectPath),
  readConfig: (projectPath) => ipcRenderer.invoke(PROJECT_CHANNELS.readConfig, projectPath),
  writeConfig: (projectPath, config) => ipcRenderer.invoke(PROJECT_CHANNELS.writeConfig, projectPath, config),
  createDefaultConfig: (projectPath, projectType, projectName) =>
    ipcRenderer.invoke(PROJECT_CHANNELS.createDefaultConfig, projectPath, projectType, projectName),
  validateConfig: (config) => ipcRenderer.invoke(PROJECT_CHANNELS.validateConfig, config),
  test: (projectPath, script) => ipcRenderer.invoke(PROJECT_CHANNELS.test, projectPath, script),
  run: (projectPath, configName) => ipcRenderer.invoke(PROJECT_CHANNELS.run, projectPath, configName),
  stop: (projectId) => ipcRenderer.invoke(PROJECT_CHANNELS.stop, projectId),
  list: () => ipcRenderer.invoke(PROJECT_CHANNELS.list),
  get: (projectId) => ipcRenderer.invoke(PROJECT_CHANNELS.get, projectId),
  schemas: () => ipcRenderer.invoke(PROJECT_CHANNELS.schemas),
}

const browserAPI: BrowserAPI = {
  createSurface: (request) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.createSurface, request),
  destroySurface: (surfaceId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.destroySurface, surfaceId),
  popOut: (surfaceId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.popOut, surfaceId),
  embed: (surfaceId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.embed, surfaceId),
  setBounds: (surfaceId, bounds) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.setBounds, surfaceId, bounds),
  getState: (surfaceId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.getState, surfaceId),
  openTab: (surfaceId, url) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.openTab, surfaceId, url),
  closeTab: (surfaceId, tabId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.closeTab, surfaceId, tabId),
  activateTab: (surfaceId, tabId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.activateTab, surfaceId, tabId),
  navigate: (surfaceId, tabId, url) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.navigate, surfaceId, tabId, url),
  goBack: (surfaceId, tabId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.goBack, surfaceId, tabId),
  goForward: (surfaceId, tabId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.goForward, surfaceId, tabId),
  reload: (surfaceId, tabId) => ipcRenderer.invoke(BROWSER_INVOKE_CHANNELS.reload, surfaceId, tabId),
  onStateChanged: (callback) => subscribeIpcEvent(BROWSER_EVENT_CHANNELS.state, callback),
  onAgentControlChanged: (callback) => subscribeIpcEvent(BROWSER_EVENT_CHANNELS.agentControl, callback),
}

const knowledgeAPI: KnowledgeAPI = {
  contracts: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.contracts),
  bootstrap: (workspacePath) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.bootstrap, workspacePath),
  observe: (input) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.observe, input),
  listObservations: (query) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listObservations, query),
  pruneObservations: (query) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.pruneObservations, query),
  autoPruneObservations: (nowMs) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.autoPruneObservations, nowMs),
  resolveObservationContent: (observation) =>
    ipcRenderer.invoke(KNOWLEDGE_CHANNELS.resolveObservationContent, observation),
  retentionStats: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.retentionStats),
  listAudit: (query) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listAudit, query),
  auditStats: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.auditStats),
  listCandidates: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listCandidates),
  listGraphCandidates: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listGraphCandidates),
  listWikiPatchCandidates: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listWikiPatchCandidates),
  rejectCandidate: (input) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.rejectCandidate, input),
  applyCandidate: (input) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.applyCandidate, input),
  search: (query) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.search, query),
  listTruth: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listTruth),
  revokeTruth: (input) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.revokeTruth, input),
  listConflicts: (workspaceId) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.listConflicts, workspaceId),
  recordFeedback: (input) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.recordFeedback, input),
  feedbackSummary: (workspaceId) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.feedbackSummary, workspaceId),
  context: (request) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.context, request),
  diagnostics: (query) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.diagnostics, query),
  processNow: (input) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.processNow, input),
  processingStats: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.processingStats),
  externalMcpStatus: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.externalMcpStatus),
  registerExternalMcp: (client) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.registerExternalMcp, client),
  getSettings: () => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.getSettings),
  updateSettings: (settings) => ipcRenderer.invoke(KNOWLEDGE_CHANNELS.updateSettings, settings),
}

const janusAPI: JanusAPI = {
  listBlueprints: (cwd) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.listBlueprints, cwd),
  listBlueprintSummaries: (cwd) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.listBlueprintSummaries, cwd),
  loadBlueprint: (cwd, id) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.loadBlueprint, cwd, id),
  createBlueprint: (cwd, input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.createBlueprint, cwd, input),
  updateBlueprint: (cwd, id, patch) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.updateBlueprint, cwd, id, patch),
  deleteBlueprint: (cwd, id) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.deleteBlueprint, cwd, id),
  createNode: (cwd, blueprintId, input, parentId) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.createNode, cwd, blueprintId, input, parentId),
  updateNode: (cwd, blueprintId, nodeId, patch) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.updateNode, cwd, blueprintId, nodeId, patch),
  deleteNode: (cwd, blueprintId, nodeId) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.deleteNode, cwd, blueprintId, nodeId),
  replaceNodeFeatures: (cwd, blueprintId, nodeId, features) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.replaceNodeFeatures, cwd, blueprintId, nodeId, features),
  addNodeFeature: (cwd, blueprintId, nodeId, feature) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.addNodeFeature, cwd, blueprintId, nodeId, feature),
  updateNodeFeature: (cwd, blueprintId, nodeId, featureId, patch) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.updateNodeFeature, cwd, blueprintId, nodeId, featureId, patch),
  deleteNodeFeature: (cwd, blueprintId, nodeId, featureId) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.deleteNodeFeature, cwd, blueprintId, nodeId, featureId),
  focusNode: (payload) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.focusNode, payload.workspacePath, payload.nodeId),
  bindTerminal: (cwd, nodeId, terminalId) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.bindTerminal, cwd, nodeId, terminalId),
  analyze: (payload) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.analyze, payload),
  applyAnalysisPatch: (payload) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.applyAnalysisPatch, payload),
  listAnalyses: (payload) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.listAnalyses, payload),
  applyAnalysis: (payload) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.applyAnalysis, payload),
  listRequirementCandidates: (payload) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.listRequirementCandidates, payload),
  acceptRequirementCandidate: (payload) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.acceptRequirementCandidate, payload),
  rejectRequirementCandidate: (payload) =>
    ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.rejectRequirementCandidate, payload),
  acceptDiscovered: (payload) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.acceptDiscovered, payload),
  listMaintenanceTasks: () => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceList),
  listMaintenanceAudits: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceAuditList, input),
  startMaintenanceTask: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceStart, input),
  sendMaintenanceMessage: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceMessage, input),
  generateMaintenanceProposal: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenancePropose, input),
  applyMaintenanceChangeSet: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceApply, input),
  cancelMaintenanceTask: (taskId) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceCancel, taskId),
  completeMaintenanceTask: (taskId) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceComplete, taskId),
  prepareMaintenanceUndo: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceUndoPrepare, input),
  applyMaintenanceUndo: (input) => ipcRenderer.invoke(JANUS_COMMAND_CHANNELS.maintenanceUndoApply, input),
  onAnalysisResult: (callback) => subscribeIpcEvent(JANUS_EVENT_CHANNELS.analysis, callback),
  onDiscovered: (callback) => subscribeIpcEvent(JANUS_EVENT_CHANNELS.discovered, callback),
  onMaintenanceTask: (callback) => subscribeIpcEvent(JANUS_EVENT_CHANNELS.maintenance, callback),
}

const roundtableAPI: RoundtableAPI = {
  start: (input) => ipcRenderer.invoke(ROUNDTABLE_CHANNELS.start, input),
  advance: (sessionId, input, requestId) => ipcRenderer.invoke(ROUNDTABLE_CHANNELS.advance, sessionId, input, requestId),
  end: (sessionId) => ipcRenderer.invoke(ROUNDTABLE_CHANNELS.end, sessionId),
  getState: (sessionId) => ipcRenderer.invoke(ROUNDTABLE_CHANNELS.state, sessionId),
  restore: (sessionId) => ipcRenderer.invoke(ROUNDTABLE_CHANNELS.restore, sessionId),
  export: (sessionId) => ipcRenderer.invoke(ROUNDTABLE_CHANNELS.export, sessionId),
  onEvent: (callback) => subscribeIpcEvent(ROUNDTABLE_CHANNELS.event, callback),
}

const officeAPI: OfficeAPI = {
  detect: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.detect, request),
  listFiles: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.listFiles, request),
  startPreview: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.startPreview, request),
  stopPreview: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.stopPreview, request),
  reloadPreview: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.reloadPreview, request),
  buildPrompt: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.buildPrompt, request),
  installerStatus: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.installerStatus, request),
  installerStart: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.installerStart, request),
  installerCancel: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.installerCancel, request),
  installerRemove: (request) => ipcRenderer.invoke(OFFICE_INVOKE_CHANNELS.installerRemove, request),
  onInstallerProgress: (callback) => subscribeIpcEvent(OFFICE_EVENT_CHANNELS.installerProgress, callback),
  onFilesChanged: (callback) => subscribeIpcEvent(OFFICE_EVENT_CHANNELS.filesChanged, callback),
  onWatchEvicted: (callback) => subscribeIpcEvent(OFFICE_EVENT_CHANNELS.watchEvicted, callback),
}

const llmAPI: LlmAPI = {
  getProviders: () => ipcRenderer.invoke(LLM_CHANNELS.getProviders),
  getRuntimeStatus: () => ipcRenderer.invoke(LLM_CHANNELS.runtimeStatus),
  saveProvider: (settings) => ipcRenderer.invoke(LLM_CHANNELS.saveProvider, settings),
  testConnection: (settings) => ipcRenderer.invoke(LLM_CHANNELS.testConnection, settings),
  removeProvider: (providerId) => ipcRenderer.invoke(LLM_CHANNELS.removeProvider, providerId),
  setDefaultProvider: (providerId) => ipcRenderer.invoke(LLM_CHANNELS.setDefaultProvider, providerId),
  listModels: (providerId) => ipcRenderer.invoke(LLM_CHANNELS.listModels, providerId),
  getModelCatalog: () => ipcRenderer.invoke(LLM_CHANNELS.getCatalog),
  refreshModelCatalog: () => ipcRenderer.invoke(LLM_CHANNELS.refreshCatalog),
  getAdapters: () => ipcRenderer.invoke(LLM_CHANNELS.getAdapters),
  getDefaultProvider: () => ipcRenderer.invoke(LLM_CHANNELS.getDefaultProvider),
  chat: (request) => ipcRenderer.invoke(LLM_CHANNELS.chat, request),
  startChatStream: (request) => ipcRenderer.send(LLM_CHANNELS.chatStream, request),
  abortChat: (requestId) => ipcRenderer.invoke(LLM_CHANNELS.abort, requestId),
  steerChat: (input) => ipcRenderer.invoke(LLM_CHANNELS.steer, input),
  cancelSteerChat: (input) => ipcRenderer.invoke(LLM_CHANNELS.steerCancel, input),
  onDelta: (callback) => subscribeIpcEvent(LLM_CHANNELS.delta, callback),
  onDone: (callback) => subscribeIpcEvent(LLM_CHANNELS.done, callback),
  onError: (callback) => subscribeIpcEvent(LLM_CHANNELS.error, callback),
  onAgentEvent: (callback) => subscribeIpcEvent(LLM_CHANNELS.agentEvent, callback),
  onRecallTrace: (callback) => subscribeIpcEvent(LLM_CHANNELS.recallTrace, callback),
  onToolTrace: (callback) => subscribeIpcEvent(LLM_CHANNELS.toolTrace, callback),
}

const agentAPI: AgentAPI = {
  start: (options) => ipcRenderer.invoke(AGENT_CHANNELS.start, options),
  cancel: (sessionId) => ipcRenderer.invoke(AGENT_CHANNELS.cancel, { sessionId }),
  cancelAll: () => ipcRenderer.invoke(AGENT_CHANNELS.cancelAll),
  listSessions: () => ipcRenderer.invoke(AGENT_CHANNELS.listSessions),
  onEvent: (callback) => subscribeIpcEvent(AGENT_CHANNELS.event, callback),
  onNotification: (callback) => subscribeIpcEvent(AGENT_CHANNELS.notification, callback),
  onHookEvent: (callback) => subscribeIpcEvent(AGENT_CHANNELS.hookEvent, callback),
}

const agentRuntimeAPI: AgentRuntimeAPI = {
  createSession: (input) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.createSession, input),
  executeTool: (input) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.executeTool, input),
  cancelSession: (sessionId) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.cancelSession, sessionId),
  queryPolicyAudit: (query) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.queryPolicyAudit, query),
  resolveApproval: (input) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.resolveApproval, input),
  getSession: (sessionId) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.getSession, sessionId),
  setApprovalMode: (sessionId, mode) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.setApprovalMode, { sessionId, mode }),
  executeFunctionCall: (input) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.executeFunctionCall, input),
  executePlannerStep: (input) => ipcRenderer.invoke(AGENT_RUNTIME_CHANNELS.executePlannerStep, input),
  onEvent: (callback) => subscribeIpcEvent(AGENT_RUNTIME_CHANNELS.event, callback),
}

const checkpointAPI: CheckpointAPI = {
  create: (input) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.create, input),
  finalize: (checkpointId, cwd) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.finalize, { checkpointId, cwd }),
  restore: (checkpointId, cwd) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.restore, { checkpointId, cwd }),
  list: (filter) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.list, filter),
  diff: (checkpointId, filePath, cwd) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.diff, { checkpointId, filePath, cwd }),
  diffAll: (checkpointId, cwd) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.diffAll, { checkpointId, cwd }),
  delete: (checkpointId, cwd) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.delete, { checkpointId, cwd }),
  clearAll: (cwd) => ipcRenderer.invoke(CHECKPOINT_CHANNELS.clearAll, cwd ? { cwd } : undefined),
  onEvent: (callback) => subscribeIpcEvent(CHECKPOINT_CHANNELS.event, callback),
  onReady: (callback) => subscribeIpcEvent(CHECKPOINT_CHANNELS.ready, callback),
}

const gitAPI: GitAPI = {
  status: (cwd) => ipcRenderer.invoke(GIT_CHANNELS.status, cwd),
  log: (cwd, maxCount) => ipcRenderer.invoke(GIT_CHANNELS.log, cwd, maxCount),
  stage: (cwd, paths) => ipcRenderer.invoke(GIT_CHANNELS.stage, cwd, paths),
  unstage: (cwd, paths) => ipcRenderer.invoke(GIT_CHANNELS.unstage, cwd, paths),
  commit: (cwd, message) => ipcRenderer.invoke(GIT_CHANNELS.commit, cwd, message),
  push: (cwd) => ipcRenderer.invoke(GIT_CHANNELS.push, cwd),
  pull: (cwd) => ipcRenderer.invoke(GIT_CHANNELS.pull, cwd),
  discard: (cwd, relativePath) => ipcRenderer.invoke(GIT_CHANNELS.discard, cwd, relativePath),
  commitChanges: (cwd, hash) => ipcRenderer.invoke(GIT_CHANNELS.commitChanges, cwd, hash),
  fileBaseline: (cwd, relativePath) => ipcRenderer.invoke(GIT_CHANNELS.fileBaseline, cwd, relativePath),
}

const janusChatAPI: JanusChatAPI = {
  load: () => ipcRenderer.invoke(JANUS_CHAT_CHANNELS.load),
  save: (snapshot) => ipcRenderer.invoke(JANUS_CHAT_CHANNELS.save, snapshot).then(() => undefined),
}

const notificationSettingsAPI: NotificationSettingsAPI = {
  get: () => ipcRenderer.invoke(NOTIFICATION_SETTINGS_CHANNELS.get),
  update: (settings) => ipcRenderer.invoke(NOTIFICATION_SETTINGS_CHANNELS.update, settings),
  testFeishu: (settings) => ipcRenderer.invoke(NOTIFICATION_SETTINGS_CHANNELS.testFeishu, settings),
  getFeishuControlStatus: () => ipcRenderer.invoke(NOTIFICATION_SETTINGS_CHANNELS.feishuControlStatus),
}

const agentSettingsAPI: AgentSettingsAPI = {
  get: () => ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.get),
  update: (settings) => ipcRenderer.invoke(AGENT_SETTINGS_CHANNELS.update, settings),
}

const subAgentRunAPI: SubAgentRunAPI = {
  list: () => ipcRenderer.invoke(SUBAGENT_RUN_CHANNELS.list),
  onUpdated: (callback) => subscribeIpcEvent(SUBAGENT_RUN_CHANNELS.updated, callback),
  onRemoved: (callback) => subscribeIpcEvent(SUBAGENT_RUN_CHANNELS.removed, callback),
}

const dialogAPI: DialogAPI = {
  openDirectory: () => ipcRenderer.invoke(SYSTEM_CHANNELS.openDirectory),
  saveFile: (options) => ipcRenderer.invoke(SYSTEM_CHANNELS.saveFile, options),
  showMessageBox: (options) => ipcRenderer.invoke(SYSTEM_CHANNELS.showMessageBox, options),
}
const windowAPI: WindowAPI = {
  minimize: () => ipcRenderer.invoke(SYSTEM_CHANNELS.minimize),
  maximize: () => ipcRenderer.invoke(SYSTEM_CHANNELS.maximize),
  close: () => ipcRenderer.invoke(SYSTEM_CHANNELS.close),
  openEditor: (payload) => ipcRenderer.invoke(SYSTEM_CHANNELS.openEditor, payload),
  editorReady: () => ipcRenderer.send(SYSTEM_CHANNELS.editorReady),
  embedEditor: (payload) => ipcRenderer.invoke(SYSTEM_CHANNELS.embedEditor, payload),
  setAlwaysOnTop: (value) => ipcRenderer.invoke(SYSTEM_CHANNELS.setAlwaysOnTop, value),
  onEditorEmbedded: (callback) => subscribeIpcEvent(SYSTEM_CHANNELS.editorEmbedded, callback),
  onEditorRefresh: (callback) => subscribeIpcEvent(SYSTEM_CHANNELS.refreshEditor, callback),
}
const systemAPI: SystemAPI = {
  getDefaultShell: () => ipcRenderer.invoke(SYSTEM_CHANNELS.defaultShell),
  getPlatform: () => ipcRenderer.invoke(SYSTEM_CHANNELS.platform),
  openVSCode: (workspacePath) => ipcRenderer.invoke(SYSTEM_CHANNELS.openVSCode, workspacePath),
  getRuntimeTelemetry: (request) => ipcRenderer.invoke(SYSTEM_CHANNELS.runtimeTelemetry, request),
  getLanguage: () => ipcRenderer.invoke(SYSTEM_CHANNELS.getLanguage),
  setLanguage: (lang) => ipcRenderer.invoke(SYSTEM_CHANNELS.setLanguage, lang),
  onPrepareQuit: (callback) => {
    const handler = async () => {
      await callback()
      ipcRenderer.send(SYSTEM_CHANNELS.prepareQuitAck)
    }
    ipcRenderer.on(SYSTEM_CHANNELS.prepareQuit, handler)
    return () => ipcRenderer.removeListener(SYSTEM_CHANNELS.prepareQuit, handler)
  },
}
const desktopToastAPI: DesktopToastAPI = {
  ready: () => ipcRenderer.send(SYSTEM_CHANNELS.toastReady),
  action: (action) => ipcRenderer.send(SYSTEM_CHANNELS.toastAction, { action }),
  onShow: (callback) => subscribeIpcEvent(SYSTEM_CHANNELS.toastShow, callback),
}

contextBridge.exposeInMainWorld('electron', {
  /*-- 同步暴露平台与 Windows build 号，供渲染端构造 xterm windowsPty 用 --*/
  /*-- preload 在 Node 环境，可同步读取；os.release() 形如 "10.0.22621"，第三段为 build 号 --*/
  platform: process.platform,
  windowsBuild:
    process.platform === 'win32' ? Number(os.release().split('.')[2]) || undefined : undefined,

  /*-- Janus 人格 prompt 单一来源：主进程 Analyzer 与渲染层 JanusChat 共用 --*/
  janusPersona: JANUS_PERSONA,
  workspace: workspaceAPI,
  fileTree: fileTreeAPI,
  file: fileAPI,
  languageService: languageServiceAPI,
  terminal: terminalAPI,
  project: projectAPI,
  browser: browserAPI,
  knowledge: knowledgeAPI,
  janus: janusAPI,
  office: officeAPI,
  llm: llmAPI,
  janusChat: janusChatAPI,
  roundtable: roundtableAPI,
  agent: agentAPI,
  agentRuntime: agentRuntimeAPI,
  checkpoint: checkpointAPI,
  git: gitAPI,
  notificationSettings: notificationSettingsAPI,
  agentSettings: agentSettingsAPI,
  subAgentRun: subAgentRunAPI,
  dialog: dialogAPI,
  window: windowAPI,
  system: systemAPI,
  desktopToast: desktopToastAPI,
})
