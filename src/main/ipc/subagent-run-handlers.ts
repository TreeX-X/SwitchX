import { ipcMain } from 'electron'
import { subAgentRunRegistry } from '../janus-runner/subagent-run-registry'
import { SUBAGENT_RUN_CHANNELS } from '../../shared/ipc/janus-runner'

/** setMainWindow 由 register.ts 在每次窗口重建时重绑（audit M1） */
export function registerSubAgentRunHandlers(): void {
  ipcMain.handle(SUBAGENT_RUN_CHANNELS.list, async () => {
    return subAgentRunRegistry.listRuns()
  })
}
