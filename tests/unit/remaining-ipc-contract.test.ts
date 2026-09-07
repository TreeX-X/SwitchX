import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CHANNELS, SUBAGENT_RUN_CHANNELS, type AgentAPI, type SubAgentRunAPI } from '../../src/shared/ipc/janus-runner'
import { CHECKPOINT_CHANNELS, type CheckpointAPI } from '../../src/shared/ipc/checkpoint'
import { GIT_CHANNELS, type GitAPI } from '../../src/shared/ipc/git'
import { LLM_CHANNELS, type LlmAPI } from '../../src/shared/ipc/llm'
import { NOTIFICATION_SETTINGS_CHANNELS, type NotificationSettingsAPI } from '../../src/shared/ipc/settings'
import { SYSTEM_CHANNELS, type DesktopToastAPI, type DialogAPI, type SystemAPI, type WindowAPI } from '../../src/shared/ipc/system'

const invoke = vi.fn()
const send = vi.fn()
const on = vi.fn()
const removeListener = vi.fn()
let api: {
  agent: AgentAPI; checkpoint: CheckpointAPI; git: GitAPI; llm: LlmAPI
  notificationSettings: NotificationSettingsAPI; subAgentRun: SubAgentRunAPI
  dialog: DialogAPI; window: WindowAPI; system: SystemAPI; desktopToast: DesktopToastAPI
}

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, exposed: typeof api) => { api = exposed } },
  ipcRenderer: { invoke, send, on, removeListener },
}))

beforeAll(async () => {
  await import('../../src/preload/index')
})

describe('remaining typed IPC contracts', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    send.mockReset()
    on.mockReset()
    removeListener.mockReset()
  })

  it('defines a unique channel surface and exposes no generic bridge', () => {
    const channels = [
      ...Object.values(AGENT_CHANNELS), ...Object.values(SUBAGENT_RUN_CHANNELS),
      ...Object.values(CHECKPOINT_CHANNELS), ...Object.values(GIT_CHANNELS),
      ...Object.values(LLM_CHANNELS), ...Object.values(NOTIFICATION_SETTINGS_CHANNELS),
      ...Object.values(SYSTEM_CHANNELS),
    ]
    expect(new Set(channels).size).toBe(channels.length)
    expect(api).not.toHaveProperty('invoke')
    expect(api).not.toHaveProperty('send')
    expect(api).not.toHaveProperty('on')
  })

  it('routes request APIs through shared channel constants', async () => {
    await api.agent.listSessions()
    await api.checkpoint.list({ cwd: 'C:\\repo' })
    await api.git.status('C:\\repo')
    await api.git.fileBaseline('C:\\repo', 'README.md')
    await api.llm.getProviders()
    await api.notificationSettings.get()
    await api.notificationSettings.getFeishuControlStatus()
    await api.subAgentRun.list()
    await api.dialog.openDirectory()
    await api.window.minimize()
    await api.system.getDefaultShell()

    expect(invoke.mock.calls).toEqual([
      [AGENT_CHANNELS.listSessions],
      [CHECKPOINT_CHANNELS.list, { cwd: 'C:\\repo' }],
      [GIT_CHANNELS.status, 'C:\\repo'],
      [GIT_CHANNELS.fileBaseline, 'C:\\repo', 'README.md'],
      [LLM_CHANNELS.getProviders],
      [NOTIFICATION_SETTINGS_CHANNELS.get],
      [NOTIFICATION_SETTINGS_CHANNELS.feishuControlStatus],
      [SUBAGENT_RUN_CHANNELS.list],
      [SYSTEM_CHANNELS.openDirectory],
      [SYSTEM_CHANNELS.minimize],
      [SYSTEM_CHANNELS.defaultShell],
    ])
  })

  it('routes one-way and event APIs without exposing Electron events', () => {
    const toastListener = vi.fn()
    api.desktopToast.ready()
    api.desktopToast.action('activate')
    const unsubscribe = api.desktopToast.onShow(toastListener)
    const handler = on.mock.calls.at(-1)?.[1]
    const payload = { title: 'done', body: 'complete' }

    handler({}, payload)
    expect(send.mock.calls).toEqual([
      [SYSTEM_CHANNELS.toastReady],
      [SYSTEM_CHANNELS.toastAction, { action: 'activate' }],
    ])
    expect(toastListener).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith(SYSTEM_CHANNELS.toastShow, handler)
  })
})
