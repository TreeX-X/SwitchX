import { createHash, randomUUID } from 'crypto'
import { readFile, writeFile, mkdir, readdir, unlink, stat, rm } from 'fs/promises'
import { join, relative, dirname, resolve } from 'path'
import type { ConversationCheckpoint, ConflictInfo, CheckpointCreateOptions, SnapshotFileEntry, CheckpointEngine } from './types'
import { BlobStore } from './blob-store'
import { GitAdapter } from './git-adapter'
import { generateUnifiedDiff } from './diff-engine'

const MAX_CHECKPOINTS = 40
const SNAPSHOT_SKIP_DIRS = new Set([
  '.git',
  '.janusX',
  'node_modules',
  'out',
  'dist',
  'build',
  '.next',
  '.vite',
  '.turbo',
  'coverage',
])

interface HashCacheEntry {
  mtimeMs: number
  size: number
  sha1: string
}

interface WorkspaceCheckpointState {
  workspacePath: string
  storagePath: string
  checkpoints: Map<string, ConversationCheckpoint>
  blobStore: BlobStore
  hashCache: Map<string, HashCacheEntry>
}

export class CheckpointManager {
  private workspaceStates = new Map<string, WorkspaceCheckpointState>()
  private gitAdapter = new GitAdapter()
  private activeWorkspaceKey = ''

  async initialize(workspacePath: string): Promise<void> {
    const resolvedWorkspacePath = resolve(workspacePath)

    try {
      const st = await stat(resolvedWorkspacePath)
      if (!st.isDirectory()) throw new Error(`Not a directory: ${workspacePath}`)
    } catch {
      throw new Error(`工作区路径不存在或不是目录: ${workspacePath}`)
    }

    const workspaceKey = this.getWorkspaceKey(resolvedWorkspacePath)
    const existing = this.workspaceStates.get(workspaceKey)
    if (existing) {
      this.activeWorkspaceKey = workspaceKey
      return
    }

    const storagePath = join(resolvedWorkspacePath, '.janusX', 'checkpoints')
    const blobStore = new BlobStore(join(storagePath, 'blobs'))
    const state: WorkspaceCheckpointState = {
      workspacePath: resolvedWorkspacePath,
      storagePath,
      checkpoints: new Map<string, ConversationCheckpoint>(),
      blobStore,
      hashCache: new Map<string, HashCacheEntry>(),
    }

    await mkdir(join(state.storagePath, 'blobs'), { recursive: true })
    await state.blobStore.initialize()
    await this.loadIndex(state)
    await this.garbageCollectBlobs(state)

    this.workspaceStates.set(workspaceKey, state)
    this.activeWorkspaceKey = workspaceKey
  }

  private getWorkspaceKey(workspacePath: string): string {
    return resolve(workspacePath)
  }

  private async getWorkspaceState(cwd?: string): Promise<WorkspaceCheckpointState> {
    if (cwd) {
      const workspaceKey = this.getWorkspaceKey(cwd)
      let state = this.workspaceStates.get(workspaceKey)
      if (!state) {
        await this.initialize(cwd)
        state = this.workspaceStates.get(workspaceKey)
      } else {
        this.activeWorkspaceKey = workspaceKey
      }
      if (state) return state
    }

    const activeState = this.workspaceStates.get(this.activeWorkspaceKey)
    if (!activeState) throw new Error('Checkpoint manager is not initialized')
    return activeState
  }

  async createCheckpoint(options: CheckpointCreateOptions): Promise<ConversationCheckpoint> {
    const state = await this.getWorkspaceState(options.cwd)
    const id = randomUUID()
    const branch = await this.gitAdapter.getCurrentBranch(options.cwd).catch(() => 'unknown')
    const currentIndex = this.nextConversationIndex(state)

    const filesSnapshot = await this.captureWorkspaceSnapshot(state, options.cwd)

    const checkpoint: ConversationCheckpoint = {
      id,
      terminalId: options.terminalId,
      conversationIndex: currentIndex,
      createdAt: new Date().toISOString(),
      engine: options.engine,
      branch,
      prompt: options.prompt,
      filesSnapshot,
      status: 'ready',
      schemaVersion: 2,
    }

    state.checkpoints.set(id, checkpoint)
    await this.saveCheckpoint(state, checkpoint)
    this.pruneOldCheckpoints(state).catch(() => {})
    return checkpoint
  }

  async finalizeAndCreateCheckpoint(
    previousCheckpointId: string | null,
    options: CheckpointCreateOptions,
  ): Promise<{ finalized: boolean; checkpoint: ConversationCheckpoint }> {
    let finalized = false
    if (previousCheckpointId) {
      try {
        await this.finalizeCheckpoint(previousCheckpointId, options.cwd)
        finalized = true
      } catch (err) {
        console.error('Checkpoint finalize failed (continuing with create):', err)
      }
    }

    const checkpoint = await this.createCheckpoint(options)
    return { finalized, checkpoint }
  }

  async finalizeCheckpoint(checkpointId: string, cwd: string): Promise<void> {
    const state = await this.getWorkspaceState(cwd)
    const checkpoint = state.checkpoints.get(checkpointId)
    if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`)

    if (checkpoint.status !== 'ready') {
      checkpoint.status = 'ready'
      await this.saveCheckpoint(state, checkpoint)
    }
  }

  async restoreCheckpoint(checkpointId: string, cwd: string): Promise<{ conflicts: ConflictInfo[] }> {
    const state = await this.getWorkspaceState(cwd)
    const checkpoint = state.checkpoints.get(checkpointId)
    if (!checkpoint) throw new Error(`Checkpoint not found: ${checkpointId}`)

    const targetPaths = new Set(Object.keys(checkpoint.filesSnapshot))
    const currentPaths = new Set(await this.listSnapshotFilePaths(cwd))

    for (const path of targetPaths) {
      const entry = checkpoint.filesSnapshot[path]
      const content = await state.blobStore.retrieve(entry.hash)
      if (!content) {
        throw new Error(`Checkpoint blob missing for ${path}`)
      }

      const targetPath = this.resolveWorkspacePath(cwd, path)
      if (!targetPath) {
        throw new Error(`Invalid checkpoint path: ${path}`)
      }

      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, content)
    }

    for (const path of currentPaths) {
      if (targetPaths.has(path)) continue
      const targetPath = this.resolveWorkspacePath(cwd, path)
      if (!targetPath) continue
      await rm(targetPath, { force: true })
    }

    await this.deleteCheckpointsAfter(state, checkpoint)

    return { conflicts: [] }
  }

  async listCheckpoints(filter?: { terminalId?: string; engine?: CheckpointEngine; cwd?: string }): Promise<ConversationCheckpoint[]> {
    const state = await this.getWorkspaceState(filter?.cwd)
    let results = Array.from(state.checkpoints.values())
    if (filter?.terminalId) results = results.filter(cp => cp.terminalId === filter.terminalId)
    if (filter?.engine) results = results.filter(cp => cp.engine === filter.engine)
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async deleteCheckpoint(checkpointId: string, cwd?: string): Promise<void> {
    const state = await this.getWorkspaceState(cwd)
    const checkpoint = state.checkpoints.get(checkpointId)
    if (!checkpoint) return

    state.checkpoints.delete(checkpointId)
    try {
      await unlink(join(state.storagePath, `${checkpointId}.json`))
    } catch {}
    await this.saveIndex(state).catch(() => {})
    await this.garbageCollectBlobs(state).catch(() => {})
  }

  private nextConversationIndex(state: WorkspaceCheckpointState): number {
    return Math.max(0, ...Array.from(state.checkpoints.values()).map(cp => cp.conversationIndex)) + 1
  }

  private async deleteCheckpointsAfter(state: WorkspaceCheckpointState, target: ConversationCheckpoint): Promise<void> {
    const stale = Array.from(state.checkpoints.values()).filter(
      cp => cp.conversationIndex > target.conversationIndex,
    )
    for (const cp of stale) {
      await this.deleteCheckpoint(cp.id, state.workspacePath)
    }
  }

  private async pruneOldCheckpoints(state: WorkspaceCheckpointState): Promise<void> {
    const checkpoints = Array.from(state.checkpoints.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    const excess = checkpoints.length - MAX_CHECKPOINTS
    if (excess <= 0) return

    for (const cp of checkpoints.slice(0, excess)) {
      await this.deleteCheckpoint(cp.id, state.workspacePath)
    }
  }

  async clearAll(cwd?: string): Promise<void> {
    if (!cwd) {
      await this.clearAllLoaded()
      return
    }

    const state = await this.getWorkspaceState(cwd)
    await this.clearState(state)
  }

  async clearAllLoaded(): Promise<void> {
    const states = Array.from(this.workspaceStates.values())
    for (const state of states) {
      await this.clearState(state)
    }
    this.workspaceStates.clear()
    this.activeWorkspaceKey = ''
  }

  private async clearState(state: WorkspaceCheckpointState): Promise<void> {
    const all = Array.from(state.checkpoints.values())
    for (const cp of all) {
      try {
        await unlink(join(state.storagePath, `${cp.id}.json`))
      } catch {}
    }
    state.checkpoints.clear()
    try {
      await unlink(join(state.storagePath, 'index.json'))
    } catch {}
    await state.blobStore.clear()
  }

  async getDiff(checkpointId: string, filePath: string, cwd?: string): Promise<string> {
    const state = await this.getWorkspaceState(cwd)
    const checkpoint = state.checkpoints.get(checkpointId)
    if (!checkpoint) return ''

    const snapshot = checkpoint.filesSnapshot[filePath]
    const targetContent = snapshot ? await state.blobStore.retrieve(snapshot.hash) : null
    if (snapshot && !targetContent) return ''

    const currentContent = await this.safeReadWorkspaceFile(cwd ?? state.workspacePath, filePath)
    if (!snapshot && !currentContent) return ''

    return generateUnifiedDiff(
      filePath,
      currentContent?.toString() ?? '',
      targetContent?.toString() ?? '',
    )
  }

  async getAllDiffs(checkpointId: string, cwd: string): Promise<string> {
    const state = await this.getWorkspaceState(cwd)
    const checkpoint = state.checkpoints.get(checkpointId)
    if (!checkpoint) return ''

    const parts: string[] = []
    const changedPaths = await this.getChangedFilePaths(checkpoint, cwd)
    for (const filePath of changedPaths) {
      const diff = await this.getDiff(checkpointId, filePath, cwd)
      if (diff) parts.push(diff)
    }
    return parts.join('\n')
  }

  async getChangedFileCount(checkpointId: string, cwd?: string): Promise<number> {
    const state = await this.getWorkspaceState(cwd)
    const checkpoint = state.checkpoints.get(checkpointId)
    if (!checkpoint) return 0
    const changedPaths = await this.getChangedFilePaths(checkpoint, cwd ?? state.workspacePath)
    return changedPaths.length
  }

  async getChangedFileCounts(
    checkpointIds: string[],
    cwd?: string,
  ): Promise<Record<string, number>> {
    const state = await this.getWorkspaceState(cwd)
    const result: Record<string, number> = {}
    const targetCwd = cwd ?? state.workspacePath
    if (!targetCwd) {
      for (const id of checkpointIds) result[id] = 0
      return result
    }

    const currentFiles = await this.captureWorkspaceHashIndex(targetCwd)
    for (const id of checkpointIds) {
      const checkpoint = state.checkpoints.get(id)
      result[id] = checkpoint ? this.getChangedFilePathsFromIndex(checkpoint, currentFiles).length : 0
    }
    return result
  }

  private async getChangedFilePaths(
    checkpoint: ConversationCheckpoint,
    cwd: string,
  ): Promise<string[]> {
    if (!cwd) return []

    const currentFiles = await this.captureWorkspaceHashIndex(cwd)
    return this.getChangedFilePathsFromIndex(checkpoint, currentFiles)
  }

  private getChangedFilePathsFromIndex(
    checkpoint: ConversationCheckpoint,
    currentFiles: Record<string, { hash: string; size: number }>,
  ): string[] {
    const paths = new Set([
      ...Object.keys(checkpoint.filesSnapshot),
      ...Object.keys(currentFiles),
    ])

    return Array.from(paths)
      .filter((path) => {
        const snapshot = checkpoint.filesSnapshot[path]
        const current = currentFiles[path]
        if (!snapshot || !current) return true
        return snapshot.hash !== current.hash || snapshot.size !== current.size
      })
      .sort()
  }

  private async captureWorkspaceHashIndex(
    cwd: string,
  ): Promise<Record<string, { hash: string; size: number }>> {
    const files: Record<string, { hash: string; size: number }> = {}
    const filePaths = await this.listSnapshotFilePaths(cwd)

    for (const relPath of filePaths) {
      const absolutePath = this.resolveWorkspacePath(cwd, relPath)
      if (!absolutePath) continue
      try {
        const content = await readFile(absolutePath)
        files[relPath] = {
          hash: this.hashContent(content),
          size: content.byteLength,
        }
      } catch {}
    }

    return files
  }

  private async saveCheckpoint(state: WorkspaceCheckpointState, checkpoint: ConversationCheckpoint): Promise<void> {
    await mkdir(state.storagePath, { recursive: true })
    const data = JSON.stringify(checkpoint, null, 2)
    await writeFile(join(state.storagePath, `${checkpoint.id}.json`), data)
    await this.saveIndex(state)
  }

  private async loadIndex(state: WorkspaceCheckpointState): Promise<void> {
    try {
      const files = await readdir(state.storagePath)
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'index.json') continue
        try {
          const data = await readFile(join(state.storagePath, file), 'utf-8')
          const cp = this.normalizeCheckpoint(JSON.parse(data) as Partial<ConversationCheckpoint>)
          if (!cp) continue
          state.checkpoints.set(cp.id, cp)
        } catch {}
      }
    } catch {}
  }

  private async saveIndex(state: WorkspaceCheckpointState): Promise<void> {
    await mkdir(state.storagePath, { recursive: true })
    const index = {
      version: 2,
      checkpointIds: Array.from(state.checkpoints.keys()),
    }
    await writeFile(join(state.storagePath, 'index.json'), JSON.stringify(index, null, 2))
  }

  private async garbageCollectBlobs(state: WorkspaceCheckpointState): Promise<void> {
    const referenced = new Set<string>()
    for (const checkpoint of state.checkpoints.values()) {
      for (const entry of Object.values(checkpoint.filesSnapshot)) {
        if (entry.hash) referenced.add(entry.hash)
      }
    }

    const storedHashes = await state.blobStore.listHashes()
    for (const hash of storedHashes) {
      if (!referenced.has(hash)) {
        await state.blobStore.delete(hash)
      }
    }
  }

  private async captureWorkspaceSnapshot(
    state: WorkspaceCheckpointState,
    cwd: string,
  ): Promise<Record<string, SnapshotFileEntry>> {
    const files: Record<string, SnapshotFileEntry> = {}
    const filePaths = await this.listSnapshotFilePaths(cwd)

    for (const relPath of filePaths) {
      const absolutePath = this.resolveWorkspacePath(cwd, relPath)
      if (!absolutePath) continue
      await this.addFileToSnapshot(state, files, cwd, absolutePath)
    }

    return files
  }

  private async addFileToSnapshot(
    state: WorkspaceCheckpointState,
    files: Record<string, SnapshotFileEntry>,
    cwd: string,
    absolutePath: string,
  ): Promise<void> {
    try {
      const relPath = relative(cwd, absolutePath).replace(/\\/g, '/')
      if (this.shouldSkipSnapshotPath(relPath)) return

      let stats: Awaited<ReturnType<typeof stat>> | null = null
      try {
        stats = await stat(absolutePath)
      } catch {
        stats = null
      }

      // Fast path: stat unchanged (mtimeMs AND size both match) and the blob
      // for the cached hash still exists -> reuse hash without reading content.
      if (stats) {
        const cached = state.hashCache.get(relPath)
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          if (await state.blobStore.exists(cached.sha1)) {
            files[relPath] = { path: relPath, hash: cached.sha1, size: cached.size }
            return
          }
        }
      }

      // Slow path: cache miss, stat changed/unavailable, or blob evicted.
      // Read content, (re)store the blob, and backfill the cache.
      const content = await readFile(absolutePath)
      const hash = await state.blobStore.store(content)
      files[relPath] = {
        path: relPath,
        hash,
        size: content.byteLength,
      }
      if (stats) {
        state.hashCache.set(relPath, { mtimeMs: stats.mtimeMs, size: stats.size, sha1: hash })
      } else {
        state.hashCache.delete(relPath)
      }
    } catch {}
  }

  private shouldSkipSnapshotPath(filePath: string): boolean {
    return filePath.split(/[\\/]/).some(segment => SNAPSHOT_SKIP_DIRS.has(segment))
  }

  private async listSnapshotFilePaths(cwd: string): Promise<string[]> {
    const gitFiles = await this.gitAdapter.listTrackedFiles(cwd)
    if (gitFiles.length > 0) {
      return Array.from(new Set(
        gitFiles
          .map(path => path.replace(/\\/g, '/'))
          .filter(path => !this.shouldSkipSnapshotPath(path) && this.resolveWorkspacePath(cwd, path)),
      )).sort()
    }

    const paths: string[] = []
    for await (const absolutePath of this.walkWorkspaceFiles(cwd)) {
      const relPath = relative(cwd, absolutePath).replace(/\\/g, '/')
      if (!this.shouldSkipSnapshotPath(relPath)) paths.push(relPath)
    }
    return paths.sort()
  }

  private hashContent(content: Buffer): string {
    return createHash('sha1').update(content).digest('hex')
  }

  private async *walkWorkspaceFiles(root: string): AsyncGenerator<string> {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue
      const absolutePath = join(root, entry.name)
      if (entry.isDirectory()) {
        yield* this.walkWorkspaceFiles(absolutePath)
      } else if (entry.isFile()) {
        yield absolutePath
      }
    }
  }

  private async safeReadWorkspaceFile(cwd: string, filePath: string): Promise<Buffer | null> {
    if (!cwd) return null
    const targetPath = this.resolveWorkspacePath(cwd, filePath)
    if (!targetPath) return null
    try {
      return await readFile(targetPath)
    } catch {
      return null
    }
  }

  private resolveWorkspacePath(cwd: string, filePath: string): string | null {
    if (!cwd) return null
    if (!filePath || filePath.includes('\0')) return null
    const resolvedWorkspace = resolve(cwd)
    const resolvedPath = resolve(resolvedWorkspace, filePath)
    const rel = relative(resolvedWorkspace, resolvedPath)
    if (!rel || rel.startsWith('..') || rel === '.') return null
    if (this.shouldSkipSnapshotPath(rel)) {
      return null
    }
    return join(cwd, rel)
  }

  private normalizeCheckpoint(raw: Partial<ConversationCheckpoint>): ConversationCheckpoint | null {
    if (
      !raw.id ||
      !raw.terminalId ||
      typeof raw.conversationIndex !== 'number' ||
      !raw.createdAt ||
      !raw.engine ||
      !raw.branch ||
      typeof raw.prompt !== 'string'
    ) {
      return null
    }

    const normalizedFiles: Record<string, SnapshotFileEntry> = {}
    const rawFiles = raw.filesSnapshot ?? {}
    for (const [path, value] of Object.entries(rawFiles)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Partial<SnapshotFileEntry> & { beforeHash?: string }
      const hash = entry.hash ?? entry.beforeHash
      if (!hash) continue
      normalizedFiles[path] = {
        path,
        hash,
        size: typeof entry.size === 'number' ? entry.size : 0,
      }
    }

    return {
      id: raw.id,
      terminalId: raw.terminalId,
      conversationIndex: raw.conversationIndex,
      createdAt: raw.createdAt,
      engine: raw.engine,
      branch: raw.branch,
      prompt: raw.prompt,
      filesSnapshot: normalizedFiles,
      status: 'ready',
      schemaVersion: 2,
    }
  }
}

export const checkpointManager = new CheckpointManager()
