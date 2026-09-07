import { ipcMain, BrowserWindow } from 'electron'
import { terminalManager } from '../terminal/manager'
import { checkpointManager } from '../janus-agent/checkpoint/checkpoint-manager'
import type { CheckpointEngine } from '../janus-agent/checkpoint/types'
import { analyzer } from '../janus/analyzer'
import { isTerminalPreset, resolveTerminalLaunchProgram } from '../../shared/terminalLaunch'
import { resolveCLIPath } from '../janus-runner/cli-resolver'
import { subAgentRunRegistry } from '../janus-runner/subagent-run-registry'
import type { SubAgentRunEngine } from '../../shared/subAgentRun'
import { AgentHookBridge } from '../notifications/agent-hook-bridge'
import { AgentHookConfigManager } from '../notifications/agent-hook-config'
import { AgentHookCoordinator } from '../notifications/agent-hook-coordinator'
import { AgentTurnSentinel } from '../notifications/agent-turn-sentinel'
import {
  JANUSX_SYNTHETIC_HOOK_EVENTS,
  type AgentHookPayload,
  type AgentHookSource,
} from '../notifications/agent-hook-types'
import {
  AgentHookDiagnostics,
  summarizeCoordinatorEvent,
  summarizeHookPayload,
} from '../notifications/agent-hook-diagnostics'
import { logTerminalDiagnostic } from '../terminal/diagnostics'
import { agentTurnRecorder } from '../knowledge/agent-turn-recorder'
import { appShutdown } from '../shutdown/AppShutdown'
import { officecliManager } from '../office/officecli-manager'
import { existsSync } from 'fs'
import { extname, resolve } from 'path'
import { buildOfficeAgentSession, mergeOfficeAgentEnv } from '../office/office-agent-policy'
import {
  TERMINAL_EVENT_CHANNELS,
  TERMINAL_INVOKE_CHANNELS,
  TERMINAL_SEND_CHANNELS,
  type TerminalCreateRequest,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type TerminalSubmitLinePayload,
  type TerminalWarmupRequest,
} from '../../shared/ipc/terminal'
import { AGENT_CHANNELS } from '../../shared/ipc/janus-runner'
import { CHECKPOINT_CHANNELS } from '../../shared/ipc/checkpoint'
import { companionSessionState } from '../companion/session-state'
import { rollbackTerminalCreation } from '../companion/terminal-creation-rollback'
import { terminalContextCoordinator } from '../runtime-telemetry/coordinator'
import { createTerminalColorQueryResponder } from '../../shared/terminalColorQuery'
import {
  createTerminalServiceErrorDetector,
  isTerminalInterrupt,
  type TerminalServiceErrorDetector,
} from '../notifications/terminal-turn-signals'

// Track checkpoint state per terminal
interface TerminalCpState {
  checkpointId: string | null  // current pending checkpoint
  cwd: string
  workspaceId: string
  engine: CheckpointEngine
  initialized: boolean         // whether checkpointManager.initialize() succeeded
  creating: boolean
  // AC6: per-id creation lock. True while a terminal:create for this id is
  // in flight; concurrent create requests with the same id are rejected.
  creationLocked: boolean
  pendingSubmitTexts: string[]
  // Retained for lifecycle cleanup compatibility. AI activity status is
  // sourced exclusively from agent hooks, never inferred from PTY output.
  flowStatus: 'wait' | 'running'
  flowTimer: ReturnType<typeof setTimeout> | null
  lastDataAt: number
  // Hook lifecycle is authoritative once observed; ignore prompt echoes.
  hookStatus?: 'running' | 'wait' | 'error'
  // Set when JanusX itself initiated the kill (kill IPC / same-id replace) so
  // pty exit with an open turn reads as a silent user interrupt, not a crash.
  userKillRequested?: boolean
}

const terminalStates = new Map<string, TerminalCpState>()

let companionTerminalCreator: ((config: TerminalCreateRequest) => Promise<{ pid: number }>) | null = null

/**
 * 当前主窗口 getter：由 registerTerminalHandlers 注入。
 * 事件发送方每次调用取最新窗口，窗口重建后不再持有旧引用（audit M1）。
 */
let getHostWindow: () => BrowserWindow | null = () => null

/** 窗口 closed 时的终端侧清理；由 register.ts 在每个新窗口上挂载。 */
let hostWindowClosedHandler: (() => void) | null = null

export function handleTerminalHostWindowClosed(): void {
  hostWindowClosedHandler?.()
}

/*-- P3: pty 输出 IPC 合批。每 chunk 一次 send 在编译输出等场景可达每秒数千次，
     按终端 id 累积 ~16ms 再 flush；replay/exit/kill 前强制 flush 保证顺序一致。 --*/
const TERMINAL_DATA_FLUSH_MS = 16

interface PendingTerminalData {
  data: string
  seq: number
  timer: ReturnType<typeof setTimeout> | null
}

const pendingTerminalData = new Map<string, PendingTerminalData>()

function flushTerminalData(id: string): void {
  const pending = pendingTerminalData.get(id)
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingTerminalData.delete(id)
  if (pending.data) {
    sendToRenderer(getHostWindow(), TERMINAL_EVENT_CHANNELS.data, { id, data: pending.data, seq: pending.seq })
  }
}

function queueTerminalData(id: string, data: string, seq: number): void {
  const pending = pendingTerminalData.get(id)
  if (pending) {
    pending.data += data
    pending.seq = seq
    return
  }
  const entry: PendingTerminalData = { data, seq, timer: null }
  pendingTerminalData.set(id, entry)
  entry.timer = setTimeout(() => flushTerminalData(id), TERMINAL_DATA_FLUSH_MS)
}

function dropPendingTerminalData(id: string): void {
  const pending = pendingTerminalData.get(id)
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingTerminalData.delete(id)
}

export function createCompanionTerminal(config: TerminalCreateRequest): Promise<{ pid: number }> {
  if (!companionTerminalCreator) throw new Error('Terminal lifecycle is not available')
  return companionTerminalCreator(config)
}

/** Finalize current pending checkpoints for all terminals (best-effort, no wipe). */
export async function finalizePendingTerminalCheckpoints(): Promise<void> {
  const pending = Array.from(terminalStates.entries())
    .filter(([, state]) => Boolean(state.checkpointId))
    .map(([id, state]) => ({ id, checkpointId: state.checkpointId!, cwd: state.cwd }))

  await Promise.all(
    pending.map(async ({ id, checkpointId, cwd }) => {
      try {
        await checkpointManager.finalizeCheckpoint(checkpointId, cwd)
        const state = terminalStates.get(id)
        if (state?.checkpointId === checkpointId) {
          state.checkpointId = null
        }
      } catch (err) {
        console.error('Checkpoint finalize on shutdown failed:', err)
      }
    }),
  )
}

function sendToRenderer(mainWindow: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  try {
    mainWindow.webContents.send(channel, payload)
  } catch (err) {
    // AC2: webContents.send can throw synchronously when the window is torn down
    // between the liveness check and the send (TOCTOU). Swallow so a native
    // pty callback cannot crash the main process.
    console.error(`[terminal] sendToRenderer(${channel}) failed:`, err)
  }
}

function normalizeSubmittedPrompt(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trimEnd()
}

function enqueueCheckpointFromSubmit(id: string, text: string): void {
  const prompt = normalizeSubmittedPrompt(text)
  if (!prompt.trim()) return

  const state = terminalStates.get(id)
  if (!state) {
    sendToRenderer(getHostWindow(), CHECKPOINT_CHANNELS.event, {
      type: 'error',
      terminalId: id,
      error: 'Terminal checkpoint state not found',
    })
    return
  }

  state.pendingSubmitTexts.push(prompt)
  processCheckpointQueue(id)
}

/** Remote control uses the same checkpoint transaction as renderer submit-line. */
export function submitCompanionTerminalLine(id: string, text: string): void {
  terminalManager.write(id, `${text}\r`)
  enqueueCheckpointFromSubmit(id, text)
}

function processCheckpointQueue(id: string): void {
  const state = terminalStates.get(id)
  if (!state || !state.initialized || state.creating) return

  const prompt = state.pendingSubmitTexts.shift()
  if (!prompt) return

  state.creating = true

  const previousCpId = state.checkpointId
  state.checkpointId = null

  checkpointManager.finalizeAndCreateCheckpoint(previousCpId, {
    terminalId: id,
    engine: state.engine,
    prompt,
    cwd: state.cwd,
  }).then(({ finalized, checkpoint }) => {
    if (finalized && previousCpId) {
      sendToRenderer(getHostWindow(), CHECKPOINT_CHANNELS.event, {
        type: 'finalized',
        terminalId: id,
        checkpointId: previousCpId,
      })
    }
    state.checkpointId = checkpoint.id
    sendToRenderer(getHostWindow(), CHECKPOINT_CHANNELS.event, {
      type: 'created',
      terminalId: id,
      checkpointId: checkpoint.id,
    })
  }).catch((err) => {
    state.checkpointId = previousCpId
    const message = err instanceof Error ? err.message : String(err)
    console.error('Checkpoint lifecycle failed:', err)
    sendToRenderer(getHostWindow(), CHECKPOINT_CHANNELS.event, {
      type: 'error',
      terminalId: id,
      error: message,
    })
  }).finally(() => {
    state.creating = false
    processCheckpointQueue(id)
  })
}

const AGENT_CLI_COMMANDS = ['claude', 'codex', 'opencode', 'janus'] as const
type WarmupEngine = (typeof AGENT_CLI_COMMANDS)[number]

function isWarmupEngine(value: string): value is WarmupEngine {
  return (AGENT_CLI_COMMANDS as readonly string[]).includes(value)
}

async function resolveOfficecliLaunchAssets(): Promise<{
  pathDir: string | undefined
  binaryPath: string | undefined
}> {
  // Prefer session cache (resolveBinary only detect()s when verifiedBinary is empty).
  // Do not call refreshAgentPathDir() on every create — full capability probes are expensive.
  const binary = await officecliManager.resolveBinary()
  return {
    pathDir: officecliManager.resolveAgentPathDir(),
    binaryPath: binary?.path,
  }
}

export function registerTerminalHandlers(getMainWindow: () => BrowserWindow | null): void {
  getHostWindow = getMainWindow
  const hookDiagnostics = new AgentHookDiagnostics()
  const serviceErrorDetectors = new Map<string, TerminalServiceErrorDetector>()
  agentTurnRecorder.setEventSink((event) => {
    hookDiagnostics.record({
      stage: `knowledge-${event.type}`,
      source: event.engine,
      event: event.hookEvent,
      terminalId: event.terminalId,
      workspaceId: event.workspaceId,
      engine: event.engine,
      reason: event.reason,
      detail: event.observationId ?? event.workspacePath,
    })
  })
  const refreshRuntimeTelemetry = async (
    terminalId: string,
    engine: Exclude<CheckpointEngine, 'shell' | 'manual'>,
    cwd: string,
    sessionId?: string,
  ) => {
    const instance = terminalManager.getInstance(terminalId)
    if (!instance) return
    if (sessionId) terminalContextCoordinator.bindSession(terminalId, engine, sessionId)
    const telemetry = await terminalContextCoordinator.getSnapshot({
      terminalId,
      preset: engine,
      cwd,
      startedAt: instance.createdAt,
      sessionId,
    })
    if (telemetry) {
      sendToRenderer(getMainWindow(), TERMINAL_EVENT_CHANNELS.telemetry, {
        id: terminalId,
        telemetry,
      })
    }
  }

  // Single ingest point for CLI-origin (bridge) and main-process synthetic
  // (sentinel / pty-exit) hook payloads: identical diagnostics + coordinator path.
  function ingestHookPayload(payload: AgentHookPayload): void {
    hookDiagnostics.record(summarizeHookPayload(payload))
    hookCoordinator.handleHookPayload(payload)
  }

  // Secondary deterministic turn-end source: Claude's Stop hook does not fire
  // when a turn aborts on an API error or user interrupt, which used to leave
  // the sidebar on "running" forever with no notification. The sentinel tails
  // the session transcript (event-driven, no timeouts) and reports those ends.
  const turnSentinel = new AgentTurnSentinel({
    onSignal: (signal) => {
      ingestHookPayload({
        source: signal.engine,
        event:
          signal.kind === 'api-error'
            ? JANUSX_SYNTHETIC_HOOK_EVENTS.apiError
            : JANUSX_SYNTHETIC_HOOK_EVENTS.interrupted,
        terminalId: signal.terminalId,
        message: signal.message,
        timestamp: new Date().toISOString(),
      })
    },
    onDiagnostic: (record) => {
      hookDiagnostics.record({
        stage: `sentinel-${record.stage}`,
        terminalId: record.terminalId,
        detail: record.detail,
      })
    },
  })

  const hookCoordinator = new AgentHookCoordinator(getMainWindow, {
    onEvent: (event) => {
      hookDiagnostics.record(summarizeCoordinatorEvent(event))
      sendToRenderer(getMainWindow(), AGENT_CHANNELS.hookEvent, event)
    },
    onTurnStarted: (turn) => {
      // Transcript sentinel is claude-specific: opencode reports session.error
      // itself and codex has no transcript contract yet (pty-exit still covers it).
      if (turn.source !== 'claude') return
      turnSentinel.beginTurn({
        terminalId: turn.terminalId,
        engine: turn.engine,
        transcriptPath: turn.transcriptPath,
        sessionId: turn.sessionId,
      })
    },
    onTurnEnded: (terminalId) => {
      turnSentinel.endTurn(terminalId)
    },
    onResolvedPayload: (payload, terminal) => {
      const state = terminalStates.get(terminal.terminalId)
      const event = payload.event.toLowerCase()
      const rawStatus = JSON.stringify(payload.raw ?? '')
      const syntheticFails =
        event === JANUSX_SYNTHETIC_HOOK_EVENTS.apiError || event === JANUSX_SYNTHETIC_HOOK_EVENTS.orphaned
      const syntheticCompletes =
        event === JANUSX_SYNTHETIC_HOOK_EVENTS.interrupted || event === 'sessionend'
      const startsTurn = payload.source === 'opencode'
        ? event === 'session.status' && /busy|running/i.test(rawStatus)
        : event === 'userpromptsubmit'
      const completesTurn = syntheticCompletes || (payload.source === 'opencode'
        ? event === 'session.idle'
        : event === 'stop')
      const failsTurn = syntheticFails || (payload.source === 'opencode'
        ? event === 'session.error'
        : event === 'stopfailure' || event === 'posttoolusefailure')
      const needsAttention = payload.source === 'opencode'
        ? event === 'permission.asked'
        : event === 'permissionrequest' || event === 'notification'
      if (state && (startsTurn || completesTurn || failsTurn || needsAttention)) {
        if (startsTurn) serviceErrorDetectors.get(terminal.terminalId)?.reset()
        // Turn 级失败（429 限流 / 5xx 过载 / StopFailure / session.error）时 CLI
        // 进程仍活着、回到 prompt 等待下一次输入：上报 'wait' 保持终端可用，
        // 失败通知仍由 hookCoordinator.deliverCompletion 独立下发，不受影响。
        // 只有 'orphaned'（turn 未结束时 pty 已死，后续 onExit 会确认）才上报
        // 'error'，与 TerminalStatus“pty 非零退出”的语义对齐，避免误弹遮罩锁死输入。
        const ptyDead = event === JANUSX_SYNTHETIC_HOOK_EVENTS.orphaned
        state.hookStatus = startsTurn ? 'running' : ptyDead ? 'error' : 'wait'
        sendToRenderer(getMainWindow(), TERMINAL_EVENT_CHANNELS.status, {
          id: terminal.terminalId,
          status: state.hookStatus,
        })
      }
      companionSessionState.handleHookPayload(payload)
      agentTurnRecorder.handleHookPayload(payload)
      if (payload.sessionId) {
        const refresh = () => refreshRuntimeTelemetry(
          terminal.terminalId,
          terminal.engine as Exclude<CheckpointEngine, 'shell' | 'manual'>,
          terminal.cwd ?? payload.cwd ?? '',
          payload.sessionId,
        ).catch(() => undefined)
        void refresh()
      }
      if (/stop|complete|idle|janusx\.turn\./i.test(payload.event)) {
        const refresh = () => refreshRuntimeTelemetry(
          terminal.terminalId,
          terminal.engine as Exclude<CheckpointEngine, 'shell' | 'manual'>,
          terminal.cwd ?? payload.cwd ?? '',
          payload.sessionId,
        ).catch(() => undefined)
        void refresh()
        setTimeout(() => { void refresh() }, 750)
      }
    },
  })
  const hookBridge = new AgentHookBridge({
    onPayload: (payload) => {
      ingestHookPayload(payload)
    },
  })
  const hookConfigManager = new AgentHookConfigManager()
  /** Per-session gate so second+ Claude/Codex/OpenCode creates skip hook file IO. */
  const hooksInstalledThisSession = new Set<Exclude<CheckpointEngine, 'shell' | 'manual'>>()

  async function ensureHooksInstalled(engine: Exclude<CheckpointEngine, 'shell' | 'manual'>): Promise<void> {
    if (engine === 'janus') {
      // janus TUI emits no hook events (turn status comes from PTY signals);
      // there are no hook files to install. Mark and return.
      hooksInstalledThisSession.add(engine)
      return
    }
    if (hooksInstalledThisSession.has(engine) && await hookConfigManager.isInstalled(engine)) return
    await hookConfigManager.ensureInstalled(engine)
    hooksInstalledThisSession.add(engine)
  }

  // Fire-and-forget: first create should not wait on listen() or cold where.exe.
  void hookBridge.start().catch((err) => {
    console.error('Agent hook bridge prestart failed:', err)
  })
  for (const command of AGENT_CLI_COMMANDS) {
    void resolveCLIPath(command).catch(() => undefined)
  }
  void officecliManager.resolveBinary().catch(() => undefined)

  // Register terminal/hook cleanup into the unified shutdown path.
  // Window close without full quit still needs local cleanup.
  appShutdown.configure({
    finalizePendingCheckpoints: () => finalizePendingTerminalCheckpoints(),
    stopHookBridge: () => hookBridge.stop(),
    disposeTerminalSession: () => {
      for (const id of [...pendingTerminalData.keys()]) dropPendingTerminalData(id)
      terminalStates.clear()
      serviceErrorDetectors.clear()
      hooksInstalledThisSession.clear()
      hookCoordinator.dispose()
      turnSentinel.dispose()
      companionSessionState.clear()
      agentTurnRecorder.dispose()
      agentTurnRecorder.setEventSink(undefined)
    },
  })

  // 窗口 closed 清理逻辑；由 register.ts 在每个新窗口的 closed 事件上触发，
  // 窗口重建后仍然生效（旧实现只挂在首个窗口上，audit M1）。
  hostWindowClosedHandler = () => {
    if (appShutdown.isQuitting) return
    // Non-darwin: index mainWindow.closed triggers app.quit -> AppShutdown.
    // AC8: synchronously kill all ptys first so no native pty callback can
    // reach a destroyed webContents during the finalize window. Final state
    // cleanup still runs in AppShutdown.
    if (process.platform !== 'darwin') {
      try {
        void terminalManager.killAll()
      } catch (err) {
        console.error('[terminal] killAll on window close failed:', err)
      }
      return
    }

    // Darwin keeps the app process alive after the last window closes.
    void finalizePendingTerminalCheckpoints()
      .catch((err) => console.error('Checkpoint finalize on window close failed:', err))
      .finally(() => {
        void terminalManager.killAll()
        terminalStates.clear()
        serviceErrorDetectors.clear()
        hooksInstalledThisSession.clear()
        hookCoordinator.dispose()
        turnSentinel.dispose()
        companionSessionState.clear()
        agentTurnRecorder.dispose()
        agentTurnRecorder.setEventSink(undefined)
        void hookBridge.stop()
      })
  }

  ipcMain.handle(TERMINAL_INVOKE_CHANNELS.warmup, async (_event, payload?: TerminalWarmupRequest) => {
    const requested = Array.isArray(payload?.engines)
      ? payload.engines.filter((engine): engine is WarmupEngine => typeof engine === 'string' && isWarmupEngine(engine))
      : []

    await Promise.all([
      hookBridge.start().catch(() => undefined),
      officecliManager.resolveBinary().catch(() => undefined),
      ...requested.map((engine) => resolveCLIPath(engine).catch(() => null)),
      ...requested.map(async (engine) => {
        try {
          await ensureHooksInstalled(engine)
        } catch {
          // Warmup is best-effort; create path still retries setup.
        }
      }),
    ])

    return { ok: true as const }
  })

  const createTerminalLifecycle = async (config: TerminalCreateRequest) => {
    const { id, cwd, shell, preset, command, args, cols, rows } = config

    const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId : ''
    const engine: CheckpointEngine =
      isTerminalPreset(preset) && preset !== 'shell' ? preset : 'shell'

    // AC6: per-id creation lock. Concurrent terminal:create with the same id
    // (e.g. double-click preset, retry during launch) is rejected so the
    // second caller does not race checkpointManager.initialize on the same
    // cwd or collide with the first pty spawn (Vector B/F).
    const priorState = terminalStates.get(id)
    if (priorState?.creationLocked) {
      const existingInstance = terminalManager.getInstance(id)
      if (existingInstance) return { pid: existingInstance.pty.pid }
      throw new Error(`Terminal ${id} is already being created`)
    }

    // AC5: replacing an existing terminal with the same id. Tear down the
    // old pty and clear stale flow timer / run registry so the old onExit
    // callback cannot kill the new pty and the old flowTimer cannot push
    // status events into the new terminal (Vector A/D/E).
    if (priorState) {
      // Same-id replace is a user action; the old pty's exit must not read as a crash.
      priorState.userKillRequested = true
      if (priorState.flowTimer) {
        clearTimeout(priorState.flowTimer)
        priorState.flowTimer = null
      }
      // 旧 pty 未 flush 的合批数据不再属于新终端，丢弃
      dropPendingTerminalData(id)
      if (priorState.engine && priorState.engine !== 'shell') {
        try {
          subAgentRunRegistry.finishRun(
            `terminal:${id}`,
            'cancelled',
            'Replaced by new terminal with same id',
          )
        } catch (err) {
          console.error(`[terminal] finishRun on replace failed for ${id}:`, err)
        }
      }
    }
    try {
      terminalManager.kill(id)
    } catch (err) {
      console.error(`[terminal] kill-on-replace failed for ${id}:`, err)
    }

    // Pre-stub a locked state so concurrent callers see the lock immediately.
    // This is replaced by the full state below once the pty is spawned.
    terminalStates.set(id, {
      checkpointId: null,
      cwd,
      workspaceId,
      engine,
      initialized: false,
      creating: false,
      creationLocked: true,
      pendingSubmitTexts: [],
      flowStatus: 'wait',
      flowTimer: null,
      lastDataAt: 0,
      hookStatus: undefined,
    })

    const launchProgram = resolveTerminalLaunchProgram(
      isTerminalPreset(preset) ? preset : { command, args },
    )

    const resolveProgramPromise = (async () => {
      if (!launchProgram) return undefined
      try {
        const resolved = await resolveCLIPath(launchProgram.command)
        // Never pass a non-existent or extensionless Windows path to node-pty.
        // Fall back to the bare command so CreateProcess can still search PATHEXT.
        if (
          resolved &&
          (process.platform !== 'win32' ||
            (existsSync(resolved) && Boolean(extname(resolved))))
        ) {
          return { command: resolved, args: launchProgram.args }
        }
      } catch {
        // Fall back to bare command; PATH-based spawn may still succeed.
      }
      return launchProgram
    })()

    const hookEnvPromise = (async (): Promise<Record<string, string> | undefined> => {
      // janus TUI emits no hook events: skip bridge env entirely (no hook
      // files exist to install and no turn pipeline consumes the ids).
      if (engine === 'shell' || engine === 'janus') return undefined
      try {
        await hookBridge.start()
        await ensureHooksInstalled(engine)
        return hookConfigManager.buildTerminalEnv(
          {
            terminalId: id,
            workspaceId,
            engine,
          },
          hookBridge.getEnv(),
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('Agent hook setup failed:', err)
        const event = {
          type: 'ignored',
          terminalId: id,
          engine,
          source: engine,
          hookEvent: 'setup',
          reason: message,
          delivered: false,
        } as const
        hookDiagnostics.record(summarizeCoordinatorEvent(event))
        sendToRenderer(getMainWindow(), AGENT_CHANNELS.hookEvent, event)
        return undefined
      }
    })()

    // I-1 [P1] AC6: resolveOfficecliLaunchAssets() can reject when
    // officecliManager.resolveBinary() -> detect() -> run() fails (no
    // internal catch; see line 251's own .catch(() => undefined) proof).
    // Without this guard, Promise.all below rejects between the pre-stub
    // set (creationLocked: true) and the inner try that would release it,
    // leaking the lock and permanently deadlocking same-id creates.
    // Mirror the resolveProgramPromise/hookEnvPromise internal guard so
    // all three legs of Promise.all are non-rejecting.
    const officePromise = resolveOfficecliLaunchAssets().catch(() => ({
      pathDir: undefined as string | undefined,
      binaryPath: undefined as string | undefined,
    }))

    const [resolvedProgram, hookEnvBase, office] = await Promise.all([
      resolveProgramPromise,
      hookEnvPromise,
      officePromise,
    ])

    logTerminalDiagnostic('terminal create requested', {
      id,
      workspaceId,
      cwd,
      shell,
      preset,
      engine,
      program: resolvedProgram?.command,
      programArgs: resolvedProgram?.args,
    })

    let instance
    try {
      const officeMcpEntry = resolve(__dirname, '..', 'office-mcp.js')
      const officeSession = buildOfficeAgentSession(engine, cwd, office.binaryPath, officeMcpEntry)
      if (officeSession.limitation) {
        logTerminalDiagnostic('Office automation policy-only mode', { engine, limitation: officeSession.limitation })
      }
      const hookEnv = mergeOfficeAgentEnv(hookEnvBase, officeSession)
      instance = terminalManager.create({
        id,
        workspaceId,
        cwd,
        shell,
        program: resolvedProgram?.command,
        programArgs: resolvedProgram?.args,
        cols: typeof cols === 'number' ? cols : undefined,
        rows: typeof rows === 'number' ? rows : undefined,
        env: hookEnv,
      }, office.pathDir)
      if (engine === 'codex') {
        serviceErrorDetectors.set(id, createTerminalServiceErrorDetector())
      } else {
        serviceErrorDetectors.delete(id)
      }
      // Only soft-revalidate when create had no officecli cache; avoid clearing a warm cache mid-flight.
      if (!office.pathDir && !office.binaryPath) {
        void officecliManager.refreshAgentPathDir().catch(() => undefined)
      }
    } catch (err) {
      logTerminalDiagnostic('terminal create failed', {
        id,
        workspaceId,
        cwd,
        shell,
        preset,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      // Release the creation lock stub so a later retry is not blocked.
      terminalStates.delete(id)
      throw err
    }

    try {
    // Hook/coordinator/recorder/subagent-run registration is hook-payload
    // driven; janus emits no hooks (turn status comes from PTY signals), so
    // janus terminals skip all three systems plus the janus-runner registry.
    // finishRun on unknown ids is a safe no-op, so exit/replace paths stay.
    if (engine !== 'shell' && engine !== 'janus') {
      hookCoordinator.registerTerminal({
        terminalId: id,
        engine,
        workspaceId,
        cwd,
      })
      companionSessionState.registerTerminal({
        terminalId: id,
        engine,
        workspaceId,
        cwd,
      })
      agentTurnRecorder.registerTerminal({
        terminalId: id,
        engine,
        workspaceId,
        cwd,
      })

      subAgentRunRegistry.upsertRun({
        id: `terminal:${id}`,
        terminalId: id,
        rootRunId: `terminal:${id}`,
        rootTerminalId: id,
        missionId: id,
        workspaceId,
        workspacePath: cwd,
        source: 'terminal',
        engine: engine as SubAgentRunEngine,
        role: 'main',
        status: 'running',
        title: `${engine} terminal`,
        lastEvent: 'Terminal session started',
      })
    }

    terminalStates.set(id, {
      checkpointId: null,
      cwd,
      workspaceId,
      engine,
      initialized: false,
      creating: false,
      creationLocked: false,
      pendingSubmitTexts: [],
      flowStatus: 'wait',
      flowTimer: null,
      lastDataAt: 0,
      hookStatus: undefined,
    })

    // AC5/AC6: capture the pid of the pty we are about to register callbacks
    // on. If this terminal is later replaced by a new pty with the same id
    // (AC5 cleanup path), the old pty's native onData/onExit callbacks can
    // still fire asynchronously and would otherwise mutate the new terminal's
    // state (Vector A/E). The guard skips stale callbacks whose pty no longer
    // matches the current instance for this id.
    const registeredPid = instance.pty.pid
    const colorQueryResponder = engine === 'codex'
      ? createTerminalColorQueryResponder()
      : null

    // PTY output: keep a bounded replay buffer so remounted terminals can recover
    // after workspace switches, then forward live data to the renderer.
    instance.pty.onData((data: string) => {
      // AC3: isolate native pty callback exceptions so a single terminal's
      // failure cannot crash the main process or other terminals.
      try {
        // AC5: skip stale callbacks from a replaced pty.
        const current = terminalManager.getInstance(id)
        if (current && current.pty.pid !== registeredPid) return

        const colorQueryResponse = colorQueryResponder?.push(data)
        if (colorQueryResponse) {
          terminalManager.write(id, colorQueryResponse)
        }

        if (hookCoordinator.hasActiveTurn(id)) {
          const serviceError = serviceErrorDetectors.get(id)?.push(data)
          if (serviceError) {
            ingestHookPayload({
              source: 'codex',
              event: JANUSX_SYNTHETIC_HOOK_EVENTS.apiError,
              terminalId: id,
              message: serviceError,
              timestamp: new Date().toISOString(),
            })
          }
        }

        const seq = terminalManager.appendOutput(id, data)
        // kill 后窗口期实例已移除，appendOutput 返回 null：跳过转发，避免 seq undefined 的乱序数据。
        if (seq === null) return
        queueTerminalData(id, data, seq)

        // PTY output includes user input echo, prompt redraws and ANSI repaint
        // sequences. It is deliberately not used to infer AI activity.
      } catch (err) {
        console.error(`[terminal ${id}] onData error:`, err)
      }
    })

    // Terminal exit: finalize any pending checkpoint.
    instance.pty.onExit(({ exitCode }: { exitCode: number }) => {
      // AC3: isolate onExit callback exceptions; a throw here must not crash
      // the main process or leave the terminal in a half-cleaned state.
      try {
        // AC5: if this onExit is from a replaced pty (a new pty with the same
        // id now lives in the manager), skip all cleanup — the new terminal
        // owns the state now. A missing instance means the pty was killed
        // without replacement (user close / shutdown), so cleanup proceeds.
        const current = terminalManager.getInstance(id)
        if (current && current.pty.pid !== registeredPid) return

        // I-3 [P2] AC5: a replacement create is in flight (pre-stub locked).
        // The old pty's onExit was scheduled asynchronously by the AC5
        // kill-old step and can fire during the new create's `await
        // Promise.all` window, after the pre-stub state has been set but
        // before the new pty is spawned (getInstance is undefined in this
        // gap, so the registeredPid guard above does not return). Skip
        // cleanup so the new create's pre-stub state (incl. creationLocked)
        // is not deleted out from under it — otherwise AC6's lock is
        // dropped early and a concurrent same-id create can race
        // checkpointManager.initialize (Vector B/F). This also subsumes
        // the I-4 double-finishRun noise: the early return skips the
        // stale finishRun call entirely.
        const state0 = terminalStates.get(id)
        if (state0?.creationLocked) return

        // Turn-end reconciliation: a pty death with a turn still open means no
        // completion hook will ever arrive. Route a synthetic end through the
        // hook pipeline before teardown so sidebar status and desktop
        // notification both settle. JanusX-initiated kills and app shutdown
        // are user actions: correct silently instead of raising a failure toast.
        if (state0 && state0.engine !== 'shell' && hookCoordinator.hasActiveTurn(id)) {
          const silent = state0.userKillRequested === true || appShutdown.isQuitting
          ingestHookPayload({
            source: state0.engine as AgentHookSource,
            event: silent
              ? JANUSX_SYNTHETIC_HOOK_EVENTS.interrupted
              : JANUSX_SYNTHETIC_HOOK_EVENTS.orphaned,
            terminalId: id,
            message: silent
              ? undefined
              : `${state0.engine} process exited (code ${exitCode}) while a turn was still running`,
            timestamp: new Date().toISOString(),
          })
        }

        flushTerminalData(id)
        sendToRenderer(getMainWindow(), TERMINAL_EVENT_CHANNELS.exit, { id, exitCode })
        terminalManager.kill(id)

        const state = terminalStates.get(id)
        if (state?.flowTimer) {
          clearTimeout(state.flowTimer)
          state.flowTimer = null
        }
        if (state?.engine && state.engine !== 'shell') {
          subAgentRunRegistry.finishRun(
            `terminal:${id}`,
            exitCode === 0 ? 'done' : 'failed',
            exitCode === 0 ? 'Terminal completed' : `Terminal exited with code ${exitCode}`
          )
        }
        if (state?.checkpointId) {
          const cpId = state.checkpointId
          checkpointManager.finalizeCheckpoint(cpId, state.cwd).then(() => {
            sendToRenderer(getMainWindow(), CHECKPOINT_CHANNELS.event, {
              type: 'finalized',
              checkpointId: cpId,
            })
          }).catch(err => console.error('Checkpoint finalize failed:', err))
        }
        // Janus Analyzer runs only for AI CLI terminals.
        if (state && state.engine !== 'shell') {
          analyzer.analyzeTerminal(state.cwd, id).catch(err => console.error('[janus] terminal-close analyze failed:', err))
        }
        terminalStates.delete(id)
        serviceErrorDetectors.delete(id)
        companionSessionState.unregisterTerminal(id)
        hookCoordinator.unregisterTerminal(id)
        agentTurnRecorder.unregisterTerminal(id)
        terminalContextCoordinator.unbindTerminal(id)
      } catch (err) {
        console.error(`[terminal ${id}] onExit error:`, err)
        // Best-effort cleanup so a partial failure does not leak state.
        try { terminalStates.delete(id) } catch {}
        try { serviceErrorDetectors.delete(id) } catch {}
        try { companionSessionState.unregisterTerminal(id) } catch {}
        try { hookCoordinator.unregisterTerminal(id) } catch {}
        try { agentTurnRecorder.unregisterTerminal(id) } catch {}
        try { terminalContextCoordinator.unbindTerminal(id) } catch {}
      }
    })

    checkpointManager.initialize(cwd).then(() => {
      const state = terminalStates.get(id)
      if (state) {
        state.initialized = true
        processCheckpointQueue(id)
      }
      sendToRenderer(getMainWindow(), CHECKPOINT_CHANNELS.ready, { terminalId: id, success: true })
    }).catch((err) => {
      console.error('Checkpoint init failed:', err)
      sendToRenderer(getMainWindow(), CHECKPOINT_CHANNELS.ready, { terminalId: id, success: false, error: String(err) })
    })

    sendToRenderer(getMainWindow(), TERMINAL_EVENT_CHANNELS.created, {
      id, workspaceId, cwd, preset: engine, shell, pid: instance.pty.pid,
    })
    return { pid: instance.pty.pid }
    } catch (error) {
      rollbackTerminalCreation({
        clearState: () => {
          terminalStates.delete(id)
          serviceErrorDetectors.delete(id)
        },
        unregisterCompanion: () => companionSessionState.unregisterTerminal(id),
        unregisterHook: () => hookCoordinator.unregisterTerminal(id),
        unregisterRecorder: () => agentTurnRecorder.unregisterTerminal(id),
        unregisterTelemetry: () => terminalContextCoordinator.unbindTerminal(id),
        removeRun: () => subAgentRunRegistry.removeRun(`terminal:${id}`),
        killPty: () => terminalManager.kill(id),
      })
      throw error
    }
  }
  companionTerminalCreator = createTerminalLifecycle
  ipcMain.handle(TERMINAL_INVOKE_CHANNELS.create, async (_event, config: TerminalCreateRequest) => (
    createTerminalLifecycle(config)
  ))

  // Ctrl+C ends the active turn without exiting the interactive CLI process.
  ipcMain.on(TERMINAL_SEND_CHANNELS.input, (_event, { id, data }: TerminalInputPayload) => {
    const state = terminalStates.get(id)
    if (state && state.engine !== 'shell' && isTerminalInterrupt(data) && hookCoordinator.hasActiveTurn(id)) {
      ingestHookPayload({
        source: state.engine as AgentHookSource,
        event: JANUSX_SYNTHETIC_HOOK_EVENTS.interrupted,
        terminalId: id,
        timestamp: new Date().toISOString(),
      })
    }
    terminalManager.write(id, data)
  })

  // Submit-line handler: renderer sends one complete user input transaction.
  ipcMain.on(TERMINAL_SEND_CHANNELS.submitLine, (_event, { id, text }: TerminalSubmitLinePayload) => {
    enqueueCheckpointFromSubmit(id, text)
  })

  ipcMain.on(TERMINAL_SEND_CHANNELS.resize, (_event, { id, cols, rows }: TerminalResizePayload) => {
    terminalManager.resize(id, cols, rows)
  })

  ipcMain.handle(TERMINAL_INVOKE_CHANNELS.replay, async (_event, { id }: { id: string }) => {
    // 先把未 flush 的合批数据发出去再取快照，保证快照 seq 之后到达的事件不含快照内数据
    flushTerminalData(id)
    return terminalManager.getOutputReplay(id) ?? { data: '', seq: 0 }
  })

  ipcMain.handle(TERMINAL_INVOKE_CHANNELS.kill, async (_event, { id }: { id: string }) => {
    const st = terminalStates.get(id)
    if (st) {
      st.userKillRequested = true
      if (st.flowTimer) {
        clearTimeout(st.flowTimer)
        st.flowTimer = null
      }
    }
    dropPendingTerminalData(id)
    terminalManager.kill(id)
    return { success: true }
  })
}
