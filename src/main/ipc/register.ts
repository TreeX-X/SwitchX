import type { BrowserWindow } from 'electron'
import type { OfficeArtifactIndex } from '../office/office-artifact-index'
import type { OfficecliInstaller } from '../office/officecli-installer'
import type { OfficeWatchPool } from '../office/office-watch-pool'
import type { ResolveWorkspaceRoot } from '../office/office-workspace-guard'
import { createProductionOfficeOperations } from '../office/office-handler-operations'
import type { BrowserSurfaceManager } from '../browser/surface-manager'
import type { ManagedBinaryInstaller } from '../language-service/installer'
import type { LanguageServiceId } from '../../shared/ipc/language-service'
import { registerAgentHandlers } from './janus-runner-handlers'
import { registerBrowserHandlers } from './browser-handlers'
import { registerCheckpointHandlers } from './checkpoint-handlers'
import { registerFileHandlers } from './file-handlers'
import { registerGitHandlers } from './git-handlers'
import { disposeWorkspaceWatchers, registerWorkspaceHandlers } from './handlers'
import { registerJanusHandlers } from './janus-handlers'
import { registerJanusChatHandlers } from './janus-chat-handlers'
import { registerRoundtableHandlers } from './roundtable-handlers'
import { registerKnowledgeHandlers } from './knowledge-handlers'
import { registerLanguageHandlers } from './language-handlers'
import { registerLanguageServiceHandlers } from './language-service-handlers'
import { registerLanguageServiceInstallerHandlers, type LanguageServiceInstallerHandlerOptions } from './language-service-installer-handlers'
import { registerLlmHandlers } from './llm-handlers'
import { registerOfficeHandlers } from './office-handlers'
import { registerProjectHandlers } from './project-handlers'
import { registerRuntimeTelemetryHandlers } from './runtime-telemetry-handlers'
import { registerSettingsHandlers } from './settings-handlers'
import { registerSubAgentRunHandlers } from './subagent-run-handlers'
import { handleTerminalHostWindowClosed, registerTerminalHandlers } from './terminal-handlers'
import { knowledgeProcessingQueue } from '../knowledge/processing-queue'
import { knowledgeObservationService } from '../knowledge/observation-service'
import { runDeterministicStage } from '../knowledge/deterministic-extractor'
import { runLlmStage } from '../knowledge/llm-stage'
import { terminalManager } from '../terminal/manager'
import { analyzer } from '../janus/analyzer'
import { blueprintMaintenanceService } from '../janus/maintenance/service'
import { subAgentRunRegistry } from '../janus-runner/subagent-run-registry'
import { ipcMain } from 'electron'
import { registerAgentRuntimeHandlers } from './agent-runtime-handlers'

export interface RegisterApplicationIpcOptions {
  mainWindow: BrowserWindow
  getAllowedWindows: () => BrowserWindow[]
  resolveWorkspaceRoot: ResolveWorkspaceRoot
  officeWatchPool: OfficeWatchPool
  officeArtifactIndex: OfficeArtifactIndex
  officecliInstaller: OfficecliInstaller
  browserSurfaces: BrowserSurfaceManager
  languageServiceInstallers: ReadonlyMap<LanguageServiceId, ManagedBinaryInstaller>
}

/** 幂等守卫：重复调用不再触发 "Attempted to register a second handler"。 */
let applicationIpcRegistered = false

/**
 * 当前主窗口。handler 通过 getter 读取，而非按值捕获——
 * macOS activate / second-instance 重建窗口后，旧闭包不再持有已销毁窗口，
 * 新窗口也能继续收到 terminal/janus-agent/checkpoint 事件（audit M1）。
 */
let currentMainWindow: BrowserWindow | null = null

function getCurrentMainWindow(): BrowserWindow | null {
  return currentMainWindow && !currentMainWindow.isDestroyed() ? currentMainWindow : null
}

export function registerApplicationIpc(options: RegisterApplicationIpcOptions): void {
  const { mainWindow, officeWatchPool, officeArtifactIndex } = options

  // 每次窗口重建都重绑窗口级引用与生命周期监听；幂等守卫只拦 handler 注册。
  currentMainWindow = mainWindow
  analyzer.setMainWindow(mainWindow)
  blueprintMaintenanceService.setMainWindow(mainWindow)
  subAgentRunRegistry.setMainWindow(mainWindow)
  mainWindow.on('closed', () => {
    if (currentMainWindow === mainWindow) currentMainWindow = null
    analyzer.setMainWindow(null)
    blueprintMaintenanceService.setMainWindow(null)
    subAgentRunRegistry.setMainWindow(null)
    // Also disposed from AppShutdown; function is idempotent.
    disposeWorkspaceWatchers()
    handleTerminalHostWindowClosed()
  })

  registerAgentRuntimeHandlers(getCurrentMainWindow, ipcMain, options.resolveWorkspaceRoot)
  if (applicationIpcRegistered) return
  applicationIpcRegistered = true

  registerWorkspaceHandlers(getCurrentMainWindow, {
    beforeWorkspaceDelete: async (workspaceId) => {
      // 删除工作区前先回收其全部终端，避免 pty 子进程变孤儿；onExit 负责状态清理。
      terminalManager.killByWorkspace(workspaceId)
      await officeWatchPool.stopUnderRoot(workspaceId)
      officeArtifactIndex.dispose(workspaceId)
    },
  })
  registerTerminalHandlers(getCurrentMainWindow)
  registerBrowserHandlers(getCurrentMainWindow, options.browserSurfaces)
  registerGitHandlers()
  registerAgentHandlers(getCurrentMainWindow)
  registerCheckpointHandlers()
  registerFileHandlers()
  registerProjectHandlers()
  registerLlmHandlers()
  registerJanusHandlers()
  registerJanusChatHandlers()
  registerRoundtableHandlers(getCurrentMainWindow)
  registerRuntimeTelemetryHandlers()
  registerSettingsHandlers()
  registerLanguageHandlers()
  registerLanguageServiceHandlers()
  registerLanguageServiceInstallerHandlers({
    getAllowedWindows: options.getAllowedWindows,
    installers: options.languageServiceInstallers,
  })
  registerSubAgentRunHandlers()
  registerKnowledgeHandlers()
  // Phase 1-2: plug the deterministic stage into the processing queue and
  // report unprocessed ranges from the persisted cursor on startup.
  // Phase 2: the LLM stage runs after each deterministic batch (mode/model gated).
  knowledgeProcessingQueue.configureDeterministicHandler((batch) =>
    runDeterministicStage(batch).then(() => undefined),
  )
  knowledgeProcessingQueue.configureLlmHandler((batch) => runLlmStage(batch))
  // Phase 5 (§6): retention maintenance joins the queue — daily low-peak
  // autoPrune + archive + compact with confirm:true. Best-effort: failures
  // audit processing_failed and retry on the next due-check.
  knowledgeProcessingQueue.configureMaintenanceHandler(async () => {
    await knowledgeObservationService.autoPrune()
    await knowledgeObservationService.archiveOldShards({ confirm: true })
    await knowledgeObservationService.compactEvidence({ confirm: true })
  })
  void knowledgeProcessingQueue.startupRestore()
    .then(({ pendingTotal }) => {
      if (pendingTotal > 0) console.log(`[knowledge] processing queue restored with ${pendingTotal} pending observations`)
    })
    .catch((error: unknown) => {
      console.error(`[knowledge] queue startup restore failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  void knowledgeProcessingQueue.maybeRunMaintenanceIfDue()
    .catch((error: unknown) => {
      console.error(`[knowledge] maintenance startup run failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  knowledgeProcessingQueue.startMaintenanceLoop()
  registerOfficeHandlers({
    getAllowedWindows: options.getAllowedWindows,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    operations: createProductionOfficeOperations({ artifactIndex: officeArtifactIndex, watchPool: officeWatchPool }),
    installer: options.officecliInstaller,
  })
}
