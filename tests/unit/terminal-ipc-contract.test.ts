import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_EVENT_CHANNELS,
  TERMINAL_INVOKE_CHANNELS,
  TERMINAL_SEND_CHANNELS,
  type TerminalAPI,
} from '../../src/shared/ipc/terminal'

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  handle: vi.fn(),
  invoke: vi.fn(),
  onMain: vi.fn(),
  onRenderer: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

let terminalApi: TerminalAPI

vi.mock('electron', () => ({
  BrowserWindow: class {},
  contextBridge: {
    exposeInMainWorld: (_name: string, api: { terminal: TerminalAPI }) => {
      terminalApi = api.terminal
      mocks.expose(api)
    },
  },
  ipcMain: { handle: mocks.handle, on: mocks.onMain },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: mocks.onRenderer,
    removeListener: mocks.removeListener,
    send: mocks.send,
  },
}))

vi.mock('../../src/main/terminal/manager', () => ({
  terminalManager: { appendOutput: vi.fn(), create: vi.fn(), getOutputReplay: vi.fn(), kill: vi.fn(), killAll: vi.fn(), resize: vi.fn(), write: vi.fn() },
}))
vi.mock('@janus-agent/agent-core', async (importOriginal) => ({ ...(await importOriginal()), checkpointManager: {} }))
vi.mock('../../src/main/janus/analyzer', () => ({ analyzer: {} }))
vi.mock('../../src/main/agent/cli-resolver', () => ({ resolveCLIPath: vi.fn(async () => null) }))
vi.mock('../../src/main/agent/subagent-run-registry', () => ({ subAgentRunRegistry: {} }))
vi.mock('../../src/main/notifications/agent-hook-bridge', () => ({ AgentHookBridge: class { start = vi.fn(async () => {}); stop = vi.fn(); getEnv = vi.fn(() => ({})) } }))
vi.mock('../../src/main/notifications/agent-hook-config', () => ({ AgentHookConfigManager: class {} }))
vi.mock('../../src/main/notifications/agent-hook-coordinator', () => ({ AgentHookCoordinator: class { dispose = vi.fn() } }))
vi.mock('../../src/main/notifications/agent-hook-diagnostics', () => ({ AgentHookDiagnostics: class { record = vi.fn() }, summarizeCoordinatorEvent: vi.fn(), summarizeHookPayload: vi.fn() }))
vi.mock('../../src/main/terminal/diagnostics', () => ({ logTerminalDiagnostic: vi.fn() }))
vi.mock('../../src/main/knowledge/agent-turn-recorder', () => ({ agentTurnRecorder: { dispose: vi.fn(), setEventSink: vi.fn() } }))
vi.mock('../../src/main/shutdown/AppShutdown', () => ({ appShutdown: { configure: vi.fn(), isQuitting: false } }))
vi.mock('../../src/main/office/officecli-manager', () => ({ officecliManager: { resolveBinary: vi.fn(async () => null) } }))
vi.mock('../../src/main/office/office-agent-policy', () => ({ buildOfficeAgentSession: vi.fn(), mergeOfficeAgentEnv: vi.fn() }))

beforeAll(async () => {
  await import('../../src/preload/index')
  const { registerTerminalHandlers } = await import('../../src/main/ipc/terminal-handlers')
  registerTerminalHandlers(() => null)
})

describe('Terminal IPC contract', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.onRenderer.mockReset()
    mocks.removeListener.mockReset()
    mocks.send.mockReset()
  })

  it('defines unique channels and registers every main command', () => {
    const invokeChannels = Object.values(TERMINAL_INVOKE_CHANNELS)
    const sendChannels = Object.values(TERMINAL_SEND_CHANNELS)

    expect(new Set([...invokeChannels, ...sendChannels, ...Object.values(TERMINAL_EVENT_CHANNELS)]).size)
      .toBe(invokeChannels.length + sendChannels.length + Object.keys(TERMINAL_EVENT_CHANNELS).length)
    expect(mocks.handle.mock.calls.map(([channel]) => channel)).toEqual(expect.arrayContaining(invokeChannels))
    expect(mocks.onMain.mock.calls.map(([channel]) => channel)).toEqual(expect.arrayContaining(sendChannels))
  })

  it('routes typed commands with compatible payloads', async () => {
    const create = { id: 'terminal-1', workspaceId: 'workspace-1', cwd: 'C:\\repo', shell: 'pwsh.exe', preset: 'codex' }
    mocks.invoke.mockResolvedValue({ pid: 42 })

    await terminalApi.create(create)
    await terminalApi.replay(create.id)
    await terminalApi.kill(create.id)
    terminalApi.input(create.id, 'hello')
    terminalApi.resize(create.id, 120, 40)
    terminalApi.submitLine(create.id, 'prompt')

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, TERMINAL_INVOKE_CHANNELS.create, create)
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, TERMINAL_INVOKE_CHANNELS.replay, { id: create.id })
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, TERMINAL_INVOKE_CHANNELS.kill, { id: create.id })
    expect(mocks.send).toHaveBeenCalledWith(TERMINAL_SEND_CHANNELS.input, { id: create.id, data: 'hello' })
    expect(mocks.send).toHaveBeenCalledWith(TERMINAL_SEND_CHANNELS.resize, { id: create.id, cols: 120, rows: 40 })
    expect(mocks.send).toHaveBeenCalledWith(TERMINAL_SEND_CHANNELS.submitLine, { id: create.id, text: 'prompt' })
  })

  it('forwards event payloads and removes the exact listener', () => {
    const callback = vi.fn()
    const unsubscribe = terminalApi.onData(callback)
    const handler = mocks.onRenderer.mock.calls.at(-1)?.[1]
    const payload = { id: 'terminal-1', data: 'output', seq: 3 }

    handler({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith(TERMINAL_EVENT_CHANNELS.data, handler)
  })

  it('forwards structured telemetry events', () => {
    const callback = vi.fn()
    const unsubscribe = terminalApi.onTelemetry(callback)
    const handler = mocks.onRenderer.mock.calls.at(-1)?.[1]
    const payload = {
      id: 'terminal-1',
      telemetry: { contextTokens: 8_000, source: 'history', observedAt: 1_000 },
    }

    handler({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(mocks.removeListener).toHaveBeenCalledWith(TERMINAL_EVENT_CHANNELS.telemetry, handler)
  })

  it('does not expose a generic bridge', () => {
    expect(mocks.expose.mock.calls[0]?.[0]).not.toHaveProperty('invoke')
  })
})
