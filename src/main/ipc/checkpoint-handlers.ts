import { ipcMain } from 'electron'
import { access } from 'fs/promises'
import { checkpointManager } from '../janus-agent/checkpoint/checkpoint-manager'
import type { CheckpointEngine } from '../janus-agent/checkpoint/types'
import { captureForCwd, logKnowledgeCaptureFailure } from '../knowledge/workspace-identity'
import { CHECKPOINT_CHANNELS } from '../../shared/ipc/checkpoint'

export function registerCheckpointHandlers(): void {
  ipcMain.handle(
    CHECKPOINT_CHANNELS.create,
    async (
      _event,
      options: {
        terminalId: string
        engine: CheckpointEngine
        prompt: string
        cwd: string
      }
    ) => {
      const cwd = options.cwd?.trim()
      if (!cwd) throw new Error('Workspace path is empty')

      try {
        await access(cwd)
      } catch {
        throw new Error(`Workspace path does not exist: ${cwd}`)
      }

      await checkpointManager.initialize(cwd)

      const cp = await checkpointManager.createCheckpoint({ ...options, cwd })
      void captureForCwd(cwd, {
        source: 'checkpoint',
        type: 'checkpoint-event',
        content: options.prompt,
        summary: `Checkpoint created: ${cp.id}`,
        tags: ['checkpoint-create'],
        actor: options.engine,
        correlationId: cp.id,
        metadata: {
          checkpointId: cp.id,
          terminalId: cp.terminalId,
          branch: cp.branch,
          conversationIndex: cp.conversationIndex,
        },
      }).catch(logKnowledgeCaptureFailure)
      return {
        id: cp.id,
        terminalId: cp.terminalId,
        engine: cp.engine,
        conversationIndex: cp.conversationIndex,
        createdAt: cp.createdAt,
        branch: cp.branch,
        prompt: cp.prompt,
        fileCount: Object.keys(cp.filesSnapshot).length,
        changedFileCount: 0,
        status: cp.status,
      }
    }
  )

  ipcMain.handle(
    CHECKPOINT_CHANNELS.finalize,
    async (_event, { checkpointId, cwd }: { checkpointId: string; cwd: string }) => {
      await checkpointManager.finalizeCheckpoint(checkpointId, cwd)
      void captureForCwd(cwd, {
        source: 'checkpoint',
        type: 'checkpoint-event',
        content: `Checkpoint finalized: ${checkpointId}`,
        summary: `Checkpoint finalized: ${checkpointId}`,
        tags: ['checkpoint-finalize'],
        actor: 'system',
        correlationId: checkpointId,
      }).catch(logKnowledgeCaptureFailure)
      return { success: true }
    }
  )

  ipcMain.handle(
    CHECKPOINT_CHANNELS.restore,
    async (_event, { checkpointId, cwd }: { checkpointId: string; cwd: string }) => {
      const result = await checkpointManager.restoreCheckpoint(checkpointId, cwd)
      void captureForCwd(cwd, {
        source: 'checkpoint',
        type: 'checkpoint-event',
        content: `Checkpoint restored: ${checkpointId}`,
        summary: `Checkpoint restored: ${checkpointId}`,
        tags: ['checkpoint-restore'],
        actor: 'system',
        correlationId: checkpointId,
      }).catch(logKnowledgeCaptureFailure)
      return result
    }
  )

  ipcMain.handle(
    CHECKPOINT_CHANNELS.list,
    async (_event, filter?: { terminalId?: string; engine?: CheckpointEngine; cwd?: string }) => {
      const cps = await checkpointManager.listCheckpoints(filter)
      const changedCounts = await checkpointManager.getChangedFileCounts(
        cps.map(cp => cp.id),
        filter?.cwd,
      )
      return cps.map((cp) => ({
          id: cp.id,
          terminalId: cp.terminalId,
          engine: cp.engine,
          conversationIndex: cp.conversationIndex,
          createdAt: cp.createdAt,
          branch: cp.branch,
          prompt: cp.prompt,
          fileCount: Object.keys(cp.filesSnapshot).length,
          changedFileCount: changedCounts[cp.id] ?? 0,
          status: cp.status,
        }))
    }
  )

  ipcMain.handle(
    CHECKPOINT_CHANNELS.diff,
    async (
      _event,
      { checkpointId, filePath, cwd }: { checkpointId: string; filePath: string; cwd: string }
    ) => {
      return checkpointManager.getDiff(checkpointId, filePath, cwd)
    }
  )

  ipcMain.handle(
    CHECKPOINT_CHANNELS.diffAll,
    async (_event, { checkpointId, cwd }: { checkpointId: string; cwd: string }) => {
      return checkpointManager.getAllDiffs(checkpointId, cwd)
    }
  )

  ipcMain.handle(
    CHECKPOINT_CHANNELS.delete,
    async (_event, { checkpointId, cwd }: { checkpointId: string; cwd?: string }) => {
      await checkpointManager.deleteCheckpoint(checkpointId, cwd)
      return { success: true }
    }
  )

  ipcMain.handle(CHECKPOINT_CHANNELS.clearAll, async (_event, filter?: { cwd?: string }) => {
    await checkpointManager.clearAll(filter?.cwd)
    return { success: true }
  })
}
