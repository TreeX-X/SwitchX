import type { CheckpointEngine } from '../../../shared/ipc/checkpoint'
export type { CheckpointEngine } from '../../../shared/ipc/checkpoint'

export interface SnapshotFileEntry {
  path: string
  hash: string
  size: number
}

export interface ConversationCheckpoint {
  id: string
  terminalId: string
  conversationIndex: number
  createdAt: string
  engine: CheckpointEngine
  branch: string
  prompt: string
  filesSnapshot: Record<string, SnapshotFileEntry>
  status: 'ready'
  schemaVersion: 2
}

export interface ConflictInfo {
  filePath: string
  resolution: 'snapshot'
}

export interface CheckpointCreateOptions {
  terminalId: string
  engine: CheckpointEngine
  prompt: string
  cwd: string
}
