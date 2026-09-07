import { app, BrowserWindow, crashReporter, ipcMain } from 'electron'
import { isAgentHookClientInvocation, runAgentHookClient } from './notifications/agent-hook-client'
import { configureApplicationProfile, configureChromiumSessionPaths } from './bootstrap/session'

const isHookClient = isAgentHookClientInvocation()
const isLlmRuntimeSmoke = process.argv.includes('--smoke-test=llm-runtime')

configureApplicationProfile(isHookClient || isLlmRuntimeSmoke)
configureChromiumSessionPaths(isHookClient || isLlmRuntimeSmoke)

// AC1 / AC4: process-level exception fences.
// - Fatal exceptions during bootstrap (before app services are up) exit the
//   process so initialization failures are not masked.
// - Recoverable exceptions from pty/terminal/IPC callbacks (post-bootstrap) are
//   logged and swallowed so a single terminal failure cannot crash the whole
//   Electron process.
// - A burst of recoverable exceptions in a short window is treated as a
//   runaway main process and triggers app.relaunch() + app.exit() (AC4).
let bootstrapComplete = false
let recoverableBurst = 0
let burstResetTimer: ReturnType<typeof setTimeout> | null = null
const FATAL_BURST_THRESHOLD = 20
const FATAL_BURST_WINDOW_MS = 5000

function triggerFatalRelaunch(reason: string): void {
  console.error(`[main] fatal relaunch triggered: ${reason}`)
  try {
    if (app.isReady()) app.relaunch()
  } catch (err) {
    console.error('[main] app.relaunch failed:', err)
  }
  try {
    app.exit(1)
  } catch {
    process.exit(1)
  }
}

function handleRecoverableBurst(): void {
  recoverableBurst += 1
  if (burstResetTimer) clearTimeout(burstResetTimer)
  burstResetTimer = setTimeout(() => {
    recoverableBurst = 0
    burstResetTimer = null
  }, FATAL_BURST_WINDOW_MS)
  burstResetTimer.unref?.()
  if (recoverableBurst > FATAL_BURST_THRESHOLD) {
    triggerFatalRelaunch(`exception burst ${recoverableBurst} in ${FATAL_BURST_WINDOW_MS}ms`)
  }
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
  if (!bootstrapComplete) {
    // Fatal: bootstrap stage. Allow exit so failure is visible.
    process.exit(1)
    return
  }
  // Recoverable: swallow, but track burst to detect runaway main process.
  handleRecoverableBurst()
})

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
  if (!bootstrapComplete) {
    process.exit(1)
    return
  }
  handleRecoverableBurst()
})

if (isHookClient) {
  void runAgentHookClient()
    .catch(() => {})
    .finally(() => {
      process.exit(0)
    })
} else if (isLlmRuntimeSmoke) {
  void runLlmRuntimeSmoke()
} else {
  void bootstrapApp().then(() => {
    bootstrapComplete = true
  }).catch((err) => {
    console.error('[main] bootstrapApp failed:', err)
    if (!bootstrapComplete) process.exit(1)
  })
}

async function runLlmRuntimeSmoke(): Promise<void> {
  try {
    await app.whenReady()
    const [aiRuntime, { llmService }] = await Promise.all([
      import('./llm/ai-runtime'),
      import('./llm/LlmService'),
    ])
    const missingExports = ['generateObject', 'generateText', 'streamText']
      .filter((name) => typeof aiRuntime[name as keyof typeof aiRuntime] !== 'function')
    if (missingExports.length > 0) {
      throw new Error(`AI Runtime exports unavailable: ${missingExports.join(', ')}`)
    }

    await llmService.initialize()
    const adapterIds = llmService.getAvailableAdapters().map((adapter) => adapter.id)
    for (const requiredAdapter of ['openai-compatible', 'vertex-ai']) {
      if (!adapterIds.includes(requiredAdapter)) {
        throw new Error(`LLM adapter unavailable: ${requiredAdapter}`)
      }
    }

    console.log(`[llm-runtime-smoke] ok adapters=${adapterIds.join(',')}`)
    app.exit(0)
  } catch (error) {
    console.error('[llm-runtime-smoke] failed:', error)
    app.exit(1)
  }
}

async function bootstrapApp(): Promise<void> {
  const [
    { disposeWorkspaceWatchers },
    { stopAllProjects },
    { abortAllChatStreams, refreshLlmRuntimeStatus },
    { registerApplicationIpc },
    { initializeOfficecliProvider, officecliManager },
    { createApplicationServices },
    { terminalManager },
    { agentStreamManager },
    { analyzer },
    { blueprintMaintenanceService },
    { desktopToastWindow },
    { appShutdown },
    { EditorWindowManager },
    { createMainWindow },
    { registerWindowIpc },
    { feishuInboundRuntime },
    { BrowserSurfaceManager },
    { clangdManager },
  ] = await Promise.all([
    import('./ipc/handlers'),
    import('./ipc/project-handlers'),
    import('./ipc/llm-handlers'),
    import('./ipc/register'),
    import('./office/officecli-manager'),
    import('./bootstrap/services'),
    import('./terminal/manager'),
    import('./janus-runner/stream-manager'),
    import('./janus/analyzer'),
    import('./janus/maintenance/service'),
    import('./notifications/desktop-toast-window'),
    import('./shutdown/AppShutdown'),
    import('./windows/editor-window'),
    import('./windows/main-window'),
    import('./windows/register-window-ipc'),
    import('./remote-notifications/feishu-inbound/runtime'),
    import('./browser/surface-manager'),
    import('./language-service/clangd-manager'),
  ])

  let mainWindow: BrowserWindow | null = null
  let quitAck: (() => void) | null = null
  ipcMain.on('app:prepareQuitAck', () => { quitAck?.(); quitAck = null })
  const editorWindows = new EditorWindowManager()
  const browserSurfaces = new BrowserSurfaceManager({ getMainWindow: () => mainWindow })
  const getOfficeWindows = (): BrowserWindow[] => [
    ...(mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : []),
    ...editorWindows.list(),
  ]
  const { resolveOfficeWorkspaceRoot, officecliInstaller, officeWatchPool, officeArtifactIndex, languageServiceInstallers } =
    createApplicationServices(getOfficeWindows)

  appShutdown.configure({
    abortChatStreams: () => abortAllChatStreams(),
    cancelAnalyzer: () => analyzer.cancelAll(),
    cancelBlueprintMaintenance: () => blueprintMaintenanceService.cancelAll(),
    killTerminals: () => terminalManager.killAll(),
    killAgents: () => agentStreamManager.killAll(),
    stopProjects: () => stopAllProjects(),
    stopLanguageServices: () => clangdManager.disposeAll(),
    stopOfficeWatches: () => officeWatchPool.stopAll(),
    disposeOfficeArtifactIndexes: () => officeArtifactIndex.disposeAll(),
    disposeWatchers: () => disposeWorkspaceWatchers(),
    destroyToast: () => desktopToastWindow.destroy(),
    closeEditors: () => editorWindows.closeAll(),
    destroyBrowserSurfaces: () => browserSurfaces.destroyAll(),
    stopCompanion: () => feishuInboundRuntime.stop(),
  })

  function createWindow(): void {
    mainWindow = createMainWindow(() => {
      officeArtifactIndex.disposeAll()
      void feishuInboundRuntime.stop()
      mainWindow = null
      if (process.platform === 'darwin') return
      if (appShutdown.isQuitting) return
      app.quit()
    })
    registerApplicationIpc({
      mainWindow,
      getAllowedWindows: getOfficeWindows,
      resolveWorkspaceRoot: resolveOfficeWorkspaceRoot,
      officeWatchPool,
      officeArtifactIndex,
      officecliInstaller,
      browserSurfaces,
      languageServiceInstallers,
    })
    registerWindowIpc(editorWindows, () => mainWindow)
    feishuInboundRuntime.configure(mainWindow)
    void feishuInboundRuntime.reconfigure()
  }

  const hasSingleInstanceLock = app.requestSingleInstanceLock()

  if (!hasSingleInstanceLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow()
      return
    }

    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    // Keep macOS app alive until explicit quit; other platforms exit.
    if (process.platform === 'darwin') return
    if (appShutdown.isQuitting) return
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (appShutdown.isQuitting) return
    event.preventDefault()
    const ack = mainWindow && !mainWindow.isDestroyed()
      ? new Promise<void>((resolve) => {
          quitAck = resolve
          mainWindow!.webContents.send('app:prepareQuit')
          setTimeout(resolve, 1_000).unref?.()
        })
      : Promise.resolve()
    void ack.then(() => appShutdown.beginQuit({ reason: 'before-quit' }))
  })

  // I-2 [P2] AC1: await app.whenReady() inside bootstrapApp's async flow so
  // createWindow() runs before bootstrapApp resolves. A throw from
  // createMainWindow / registerApplicationIpc / registerWindowIpc inside
  // createWindow rejects bootstrapApp, which the outer .catch turns into
  // process.exit(1) — failure is visible, not masked by bootstrapComplete
  // already being true. bootstrapComplete is set by the outer .then only
  // after bootstrapApp resolves, i.e. only after createWindow succeeded.
  await app.whenReady()
  // AC4: local-only crash dump; never uploads. Relaunch path is handled
  // by triggerFatalRelaunch on runaway exception bursts.
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false })
  } catch (err) {
    console.error('[main] crashReporter.start failed:', err)
  }
  officecliManager.configureManagedBinaryPath(await officecliInstaller.getManagedBinary())
  await initializeOfficecliProvider()
  createWindow()
  void refreshLlmRuntimeStatus()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}
