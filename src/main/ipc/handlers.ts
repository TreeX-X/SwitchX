import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { watch, type FSWatcher } from 'fs'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { basename, join, relative, resolve } from 'path'
import {
  FILE_TREE_CHANNELS,
  WORKSPACE_CHANNELS,
  type FileNode,
  type Workspace,
  type WorkspaceCreateInput,
  type WorkspaceUpdates,
} from '../../shared/ipc/workspace'
import { sortWorkspaceSidebar } from '../../shared/workspace-sidebar'
import { SYSTEM_CHANNELS } from '../../shared/ipc/system'
import { authorizeRendererAction, type RendererActionAuthorizer } from '../agent/runtime/shell-runtime'
import { resolveCLIPath } from '../agent/cli-resolver'
import { buildVSCodeLaunchArgs } from '../ide-launch'

const WORKSPACES_DIR = join(app.getPath('userData'), 'janusx', 'workspaces')
const HIDDEN_FILETREE_ENTRIES = new Set(['.git', '.janusX'])
const watcherRegistry = new Map<string, FSWatcher>()
/** 根层非递归降级时,为已加载子目录额外挂的非递归 watcher */
const nestedWatcherRegistry = new Map<string, Map<string, FSWatcher>>()
const nonRecursiveWatchWorkspaces = new Set<string>()
const watcherTimers = new Map<string, NodeJS.Timeout>()
const watcherWindows = new Map<string, Set<BrowserWindow>>()
const watcherSubscribers = new Map<string, Set<WorkspaceWatcherSubscriber>>()
const watcherRecoveryTimers = new Map<string, NodeJS.Timeout>()

export type WorkspaceWatcherSubscriber = (
  eventType: 'change' | 'rename' | 'error',
  filename: string | Buffer | null,
) => void

export interface WorkspaceHandlerOptions {
  beforeWorkspaceDelete?: (workspaceId: string) => Promise<void> | void
  authorizeRendererAction?: RendererActionAuthorizer
}

type SaveFileExtension = 'md' | 'txt' | 'html'

export function resolveSaveFileDialogOptions(input: unknown) {
  if (!input || typeof input !== 'object') throw new Error('Invalid save file options')
  const { defaultName, extension } = input as { defaultName?: unknown; extension?: unknown }
  if (typeof defaultName !== 'string' || !defaultName.trim()) throw new Error('Invalid save file defaultName')
  if (extension !== 'md' && extension !== 'txt' && extension !== 'html') throw new Error('Unsupported save file extension')
  const labels: Record<SaveFileExtension, string> = { md: 'Markdown', txt: 'Plain Text', html: 'HTML' }
  return { defaultPath: defaultName, filters: [{ name: labels[extension], extensions: [extension] }] }
}

function sendToRenderer(mainWindow: BrowserWindow, channel: string, payload: unknown): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send(channel, payload)
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

function normalizeRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).replace(/\\/g, '/')
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const resolvedRoot = resolve(rootPath)
  const resolvedTarget = resolve(targetPath)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}\\`) || resolvedTarget.startsWith(`${resolvedRoot}/`)
}

function resolveWorkspacePath(rootPath: string, relativePathValue = ''): string | null {
  const safeRelativePath = relativePathValue.replace(/^[/\\]+/, '')
  const targetPath = resolve(rootPath, safeRelativePath)
  return isPathWithinRoot(rootPath, targetPath) ? targetPath : null
}

function sanitizeEntryName(nameValue: string): string | null {
  const name = nameValue.trim()
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) return null
  return name
}

function fileTreeResult(success: boolean, error?: string, path?: string): { success: boolean; error?: string; path?: string } {
  return { success, error, path }
}

async function getGitIgnoredPaths(rootPath: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set()

  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (ignored: Set<string>) => {
      if (settled) return
      settled = true
      resolve(ignored)
    }

    let command
    try {
      command = spawn('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
        cwd: rootPath,
        windowsHide: true,
      })
    } catch {
      finish(new Set())
      return
    }

    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    command.on('error', () => finish(new Set()))
    command.on('close', () => {
      finish(new Set(output.split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/').replace(/\/$/, ''))))
    })
    command.stdin.end(paths.join('\0') + '\0')
  })
}

async function inspectGitEntries(
  rootPath: string,
  targetDir: string,
  entries: import('fs').Dirent[],
): Promise<Array<{ entry: import('fs').Dirent; isGitIgnored: boolean }>> {
  const candidates = entries.map((entry) => {
    const relativePath = normalizeRelativePath(rootPath, join(targetDir, entry.name))
    // Keep directory candidates slashless. Git treats a trailing slash as a
    // recursive match, so a rule such as `docs/*` would incorrectly mark
    // `docs` itself as ignored.
    return relativePath
  })
  const ignored = await getGitIgnoredPaths(rootPath, candidates)
  return entries
    .filter((entry) => !HIDDEN_FILETREE_ENTRIES.has(entry.name))
    .map((entry) => {
      const relativePath = normalizeRelativePath(rootPath, join(targetDir, entry.name)).replace(/\/$/, '')
      return { entry, isGitIgnored: ignored.has(relativePath) }
    })
}

async function readDirectoryNodes(rootPath: string, targetDir: string): Promise<FileNode[]> {
  try {
    const entries = await inspectGitEntries(rootPath, targetDir, await readdir(targetDir, { withFileTypes: true }))
    const nodes = entries.map(({ entry, isGitIgnored }) => {
      const fullPath = join(targetDir, entry.name)
      const nodePath = normalizeRelativePath(rootPath, fullPath)

      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: nodePath,
          type: 'directory' as const,
          isGitIgnored,
          children: [],
          loaded: false,
        }
      }

      return {
        name: entry.name,
        path: nodePath,
        type: 'file' as const,
        isGitIgnored,
      }
    })

    nodes.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })

    return nodes
  } catch {
    return []
  }
}

function closeNestedWatchers(workspacePath: string): void {
  const nested = nestedWatcherRegistry.get(workspacePath)
  if (!nested) return
  for (const watcher of nested.values()) watcher.close()
  nestedWatcherRegistry.delete(workspacePath)
}

function closeWorkspaceWatcher(workspacePath: string): void {
  watcherRegistry.get(workspacePath)?.close()
  watcherRegistry.delete(workspacePath)
  closeNestedWatchers(workspacePath)
  nonRecursiveWatchWorkspaces.delete(workspacePath)
  const timer = watcherTimers.get(workspacePath)
  if (timer) clearTimeout(timer)
  watcherTimers.delete(workspacePath)
  const recoveryTimer = watcherRecoveryTimers.get(workspacePath)
  if (recoveryTimer) clearTimeout(recoveryTimer)
  watcherRecoveryTimers.delete(workspacePath)
}

function emitWorkspaceFsChange(
  workspacePath: string,
  eventType: 'change' | 'rename',
  filename: string | Buffer | null,
): void {
  for (const subscriber of watcherSubscribers.get(workspacePath) ?? []) {
    subscriber(eventType, filename)
  }

  const windows = watcherWindows.get(workspacePath)
  if (!windows?.size) return
  const existingTimer = watcherTimers.get(workspacePath)
  if (existingTimer) clearTimeout(existingTimer)

  watcherTimers.set(
    workspacePath,
    setTimeout(() => {
      watcherTimers.delete(workspacePath)
      const changedFilePath = filename ? join(workspacePath, filename.toString()) : null
      for (const window of windows) {
        sendToRenderer(window, FILE_TREE_CHANNELS.changed, { workspacePath, changedFilePath })
      }
    }, 150),
  )
}

function createWorkspaceFsWatcher(
  workspacePath: string,
  listener: (eventType: 'change' | 'rename', filename: string | Buffer | null) => void,
): { watcher: FSWatcher; recursive: boolean } {
  // 递归监听:win32/darwin 原生支持;Linux 上较新 Node(>=20)同样支持,
  // 旧内核/旧 Node 会同步抛 ERR_FEATURE_UNAVAILABLE_ON_PLATFORM,降级为仅监听根层
  try {
    return { watcher: watch(workspacePath, { recursive: true }, listener), recursive: true }
  } catch (err: any) {
    if (err?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw err
    return { watcher: watch(workspacePath, { recursive: false }, listener), recursive: false }
  }
}

/**
 * 非递归降级时为已展开/已加载目录补挂 watcher。
 * 事件统一汇入同一 workspace 的 debounce 通道,不单独广播。
 */
function ensureNestedDirectoryWatcher(workspacePath: string, absoluteDir: string): void {
  if (!nonRecursiveWatchWorkspaces.has(workspacePath)) return
  if (resolve(absoluteDir) === resolve(workspacePath)) return

  const nested = nestedWatcherRegistry.get(workspacePath) ?? new Map<string, FSWatcher>()
  if (nested.has(absoluteDir)) {
    nestedWatcherRegistry.set(workspacePath, nested)
    return
  }

  try {
    const watcher = watch(absoluteDir, { recursive: false }, (eventType, filename) => {
      emitWorkspaceFsChange(workspacePath, eventType, filename)
    })
    watcher.on('error', () => {
      watcher.close()
      nestedWatcherRegistry.get(workspacePath)?.delete(absoluteDir)
    })
    nested.set(absoluteDir, watcher)
    nestedWatcherRegistry.set(workspacePath, nested)
  } catch {
    // ignore nested watcher registration failure
  }
}

function ensureWorkspaceWatcher(workspacePath: string): void {
  if (watcherRegistry.has(workspacePath)) return

  try {
    const { watcher, recursive } = createWorkspaceFsWatcher(
      workspacePath,
      (eventType, filename) => {
        emitWorkspaceFsChange(workspacePath, eventType, filename)
      },
    )

    if (!recursive) nonRecursiveWatchWorkspaces.add(workspacePath)
    else nonRecursiveWatchWorkspaces.delete(workspacePath)

    watcher.on('error', () => {
      for (const subscriber of watcherSubscribers.get(workspacePath) ?? []) {
        subscriber('error', null)
      }
      closeWorkspaceWatcher(workspacePath)
      if (watcherSubscribers.has(workspacePath) || watcherWindows.get(workspacePath)?.size) {
        const recoveryTimer = setTimeout(() => {
          watcherRecoveryTimers.delete(workspacePath)
          ensureWorkspaceWatcher(workspacePath)
        }, 150)
        recoveryTimer.unref?.()
        watcherRecoveryTimers.set(workspacePath, recoveryTimer)
      }
    })

    watcherRegistry.set(workspacePath, watcher)
  } catch {
    // ignore watcher registration failure
  }
}

function registerWorkspaceWatcher(mainWindow: BrowserWindow | null, workspacePath: string): void {
  const windows = watcherWindows.get(workspacePath) ?? new Set<BrowserWindow>()
  if (mainWindow) windows.add(mainWindow)
  watcherWindows.set(workspacePath, windows)
  ensureWorkspaceWatcher(workspacePath)
}

export function subscribeWorkspaceWatcher(
  workspacePath: string,
  subscriber: WorkspaceWatcherSubscriber,
): () => void {
  const subscribers = watcherSubscribers.get(workspacePath) ?? new Set<WorkspaceWatcherSubscriber>()
  subscribers.add(subscriber)
  watcherSubscribers.set(workspacePath, subscribers)
  ensureWorkspaceWatcher(workspacePath)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) watcherSubscribers.delete(workspacePath)
    if (!watcherSubscribers.has(workspacePath) && !watcherWindows.get(workspacePath)?.size) {
      closeWorkspaceWatcher(workspacePath)
    }
  }
}

export function disposeWorkspaceWatcher(workspacePath: string): void {
  closeWorkspaceWatcher(workspacePath)
  watcherWindows.delete(workspacePath)
  watcherSubscribers.delete(workspacePath)
}

export function disposeWorkspaceWatchers(): void {
  const workspacePaths = new Set([
    ...watcherRegistry.keys(),
    ...watcherRecoveryTimers.keys(),
    ...watcherWindows.keys(),
    ...watcherSubscribers.keys(),
  ])
  for (const workspacePath of workspacePaths) {
    disposeWorkspaceWatcher(workspacePath)
  }
}

export function registerWorkspaceHandlers(
  getMainWindow: () => BrowserWindow | null,
  options: WorkspaceHandlerOptions = {},
): void {
  const authorize = options.authorizeRendererAction ?? authorizeRendererAction
  // 窗口 closed 时的 disposeWorkspaceWatchers 由 register.ts 统一挂载（audit M1）

  ipcMain.handle(WORKSPACE_CHANNELS.initialize, async () => {
    try {
      await ensureDir(WORKSPACES_DIR)
      const files = await readdir(WORKSPACES_DIR)
      const workspaces: Workspace[] = []
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await readFile(join(WORKSPACES_DIR, file), 'utf-8')
          workspaces.push(JSON.parse(data))
        }
      }
      const orderedWorkspaces = sortWorkspaceSidebar(workspaces)
      return {
        loadState: orderedWorkspaces.length > 0 ? 'workspace-loaded' : 'no-workspace',
        workspaces: orderedWorkspaces,
        activeWorkspaceId: orderedWorkspaces[0]?.id || null,
      }
    } catch {
      return { loadState: 'no-workspace', workspaces: [], activeWorkspaceId: null }
    }
  })

  ipcMain.handle(WORKSPACE_CHANNELS.list, async () => {
    await ensureDir(WORKSPACES_DIR)
    const files = await readdir(WORKSPACES_DIR)
    const workspaces: Workspace[] = []
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await readFile(join(WORKSPACES_DIR, file), 'utf-8')
        workspaces.push(JSON.parse(data))
      }
    }
    return sortWorkspaceSidebar(workspaces)
  })

  ipcMain.handle(WORKSPACE_CHANNELS.load, async (_event, id: string) => {
    const data = await readFile(join(WORKSPACES_DIR, `${id}.json`), 'utf-8')
    return JSON.parse(data)
  })

  ipcMain.handle(WORKSPACE_CHANNELS.create, async (event, dto: WorkspaceCreateInput) => {
    if (!await authorize(event, { workspaceRoot: dto.path, toolName: 'legacy.workspace.create', actionRisk: 'create', source: 'renderer-user', preview: { summary: 'Create workspace record', paths: [dto.path], truncated: false } })) throw new Error('Workspace creation denied by workspace policy')
    await ensureDir(WORKSPACES_DIR)
    const workspace = {
      id: randomUUID(),
      name: dto.name,
      path: dto.path,
      clis: [],
      layout: { mode: 'grid', positions: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeFile(join(WORKSPACES_DIR, `${workspace.id}.json`), JSON.stringify(workspace, null, 2))
    return workspace
  })

  ipcMain.handle(WORKSPACE_CHANNELS.update, async (event, id: string, updates: WorkspaceUpdates) => {
    const filePath = join(WORKSPACES_DIR, `${id}.json`)
    const data = JSON.parse(await readFile(filePath, 'utf-8'))
    const workspaceRoot = typeof data.path === 'string' ? data.path : id
    if (!await authorize(event, { workspaceRoot, toolName: 'legacy.workspace.update', actionRisk: 'write', source: 'renderer-user', preview: { summary: 'Update workspace record', paths: [workspaceRoot], detail: Object.keys(updates).join(', '), truncated: false } })) throw new Error('Workspace update denied by workspace policy')
    const updated = { ...data, ...updates, updatedAt: new Date().toISOString() }
    await writeFile(filePath, JSON.stringify(updated, null, 2))
    return updated
  })

  ipcMain.handle(WORKSPACE_CHANNELS.delete, async (event, id: string) => {
    try {
      const recordPath = join(WORKSPACES_DIR, `${id}.json`)
      const record = JSON.parse(await readFile(recordPath, 'utf-8')) as { path?: unknown }
      const workspaceRoot = typeof record.path === 'string' ? record.path : id
      if (!await authorize(event, { workspaceRoot, toolName: 'legacy.workspace.delete', actionRisk: 'delete', source: 'renderer-user', preview: { summary: 'Delete workspace record', paths: [workspaceRoot], truncated: false } })) return { success: false }
      await options.beforeWorkspaceDelete?.(id)
      await unlink(recordPath)
      if (typeof record.path === 'string') disposeWorkspaceWatcher(record.path)
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  ipcMain.handle(SYSTEM_CHANNELS.openDirectory, async () => {
    const mainWindow = getMainWindow()
    const dialogOptions = { properties: ['openDirectory'] as Array<'openDirectory'> }
    return mainWindow ? dialog.showOpenDialog(mainWindow, dialogOptions) : dialog.showOpenDialog(dialogOptions)
  })

  ipcMain.handle(SYSTEM_CHANNELS.saveFile, async (_event, options: unknown) => {
    const mainWindow = getMainWindow()
    const saveOptions = resolveSaveFileDialogOptions(options)
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions)
    return { canceled: result.canceled, ...(result.filePath ? { filePath: result.filePath } : {}) }
  })

  ipcMain.handle(SYSTEM_CHANNELS.showMessageBox, async (_event, options: unknown) => {
    const mainWindow = getMainWindow()
    const opts = options as { message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number }
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, opts)
      : await dialog.showMessageBox(opts)
    return { response: result.response }
  })


  ipcMain.handle(SYSTEM_CHANNELS.defaultShell, () => {
    if (process.platform === 'win32') return 'powershell.exe'
    return process.env.SHELL || '/bin/bash'
  })

  ipcMain.handle(SYSTEM_CHANNELS.platform, () => {
    return process.platform
  })

  ipcMain.handle(SYSTEM_CHANNELS.openVSCode, async (_event, rootPath: string) => {
    const workspacePath = resolve(rootPath)
    try {
      if (!(await stat(workspacePath)).isDirectory()) return fileTreeResult(false, 'Workspace path is not a directory')

      const codePath = await resolveCLIPath('code')
      if (!codePath) return fileTreeResult(false, 'VS Code command was not found')

      const profilePath = join(app.getPath('userData'), `vscode-workspace-profile-${process.pid}`)
      await new Promise<void>((complete, fail) => {
        const child = spawn(codePath, buildVSCodeLaunchArgs(workspacePath, profilePath), {
          detached: true,
          stdio: 'ignore',
        })
        child.once('error', fail)
        child.once('spawn', () => {
          child.unref()
          complete()
        })
      })
      return fileTreeResult(true)
    } catch (error) {
      return fileTreeResult(false, error instanceof Error ? error.message : 'Failed to open VS Code')
    }
  })

  ipcMain.handle(FILE_TREE_CHANNELS.load, async (_event, rootPath: string) => {
    registerWorkspaceWatcher(getMainWindow(), rootPath)
    // 根层在非递归模式下已由 ensureWorkspaceWatcher 监听
    return readDirectoryNodes(rootPath, rootPath)
  })

  ipcMain.handle(FILE_TREE_CHANNELS.children, async (_event, rootPath: string, relativePathValue: string) => {
    const targetDir = resolveWorkspacePath(rootPath, relativePathValue)
    if (!targetDir) return []

    try {
      const info = await stat(targetDir)
      if (!info.isDirectory()) return []
    } catch {
      return []
    }

    registerWorkspaceWatcher(getMainWindow(), rootPath)
    // Linux 非递归降级:children 成功后为该绝对目录补 watcher,才能收到深层变更
    ensureNestedDirectoryWatcher(rootPath, targetDir)
    return readDirectoryNodes(rootPath, targetDir)
  })

  ipcMain.handle(FILE_TREE_CHANNELS.createFile, async (event, rootPath: string, parentRelativePath: string, nameValue: string) => {
    const name = sanitizeEntryName(nameValue)
    const parentDir = resolveWorkspacePath(rootPath, parentRelativePath)
    if (!name || !parentDir) return fileTreeResult(false, 'Invalid file name')

    const targetPath = resolve(parentDir, name)
    if (!isPathWithinRoot(rootPath, targetPath)) return fileTreeResult(false, 'Invalid target path')

    try {
      if (!await authorize(event, { workspaceRoot: rootPath, toolName: 'legacy.file-tree.create-file', actionRisk: 'create', source: 'renderer-user', preview: { summary: 'Create file', paths: [targetPath], truncated: false } })) return fileTreeResult(false, 'File creation denied by workspace policy')
      const parentInfo = await stat(parentDir)
      if (!parentInfo.isDirectory()) return fileTreeResult(false, 'Parent is not a directory')
      await writeFile(targetPath, '', { encoding: 'utf-8', flag: 'wx' })
      return fileTreeResult(true, undefined, normalizeRelativePath(rootPath, targetPath))
    } catch (err: any) {
      return fileTreeResult(false, err.message || 'Failed to create file')
    }
  })

  ipcMain.handle(FILE_TREE_CHANNELS.createDirectory, async (event, rootPath: string, parentRelativePath: string, nameValue: string) => {
    const name = sanitizeEntryName(nameValue)
    const parentDir = resolveWorkspacePath(rootPath, parentRelativePath)
    if (!name || !parentDir) return fileTreeResult(false, 'Invalid folder name')

    const targetPath = resolve(parentDir, name)
    if (!isPathWithinRoot(rootPath, targetPath)) return fileTreeResult(false, 'Invalid target path')

    try {
      if (!await authorize(event, { workspaceRoot: rootPath, toolName: 'legacy.file-tree.create-directory', actionRisk: 'create', source: 'renderer-user', preview: { summary: 'Create directory', paths: [targetPath], truncated: false } })) return fileTreeResult(false, 'Directory creation denied by workspace policy')
      const parentInfo = await stat(parentDir)
      if (!parentInfo.isDirectory()) return fileTreeResult(false, 'Parent is not a directory')
      await mkdir(targetPath)
      return fileTreeResult(true, undefined, normalizeRelativePath(rootPath, targetPath))
    } catch (err: any) {
      return fileTreeResult(false, err.message || 'Failed to create folder')
    }
  })

  ipcMain.handle(FILE_TREE_CHANNELS.rename, async (event, rootPath: string, relativePathValue: string, nameValue: string) => {
    const name = sanitizeEntryName(nameValue)
    const sourcePath = resolveWorkspacePath(rootPath, relativePathValue)
    if (!name || !sourcePath || resolve(sourcePath) === resolve(rootPath)) {
      return fileTreeResult(false, 'Invalid rename target')
    }

    const targetPath = resolve(sourcePath, '..', name)
    if (!isPathWithinRoot(rootPath, targetPath)) return fileTreeResult(false, 'Invalid target path')

    try {
      if (!await authorize(event, { workspaceRoot: rootPath, toolName: 'legacy.file-tree.rename', actionRisk: 'write', source: 'renderer-user', preview: { summary: 'Rename workspace item', paths: [sourcePath, targetPath], truncated: false } })) return fileTreeResult(false, 'Rename denied by workspace policy')
      await rename(sourcePath, targetPath)
      return fileTreeResult(true, undefined, normalizeRelativePath(rootPath, targetPath))
    } catch (err: any) {
      return fileTreeResult(false, err.message || 'Failed to rename item')
    }
  })

  ipcMain.handle(FILE_TREE_CHANNELS.move, async (event, rootPath: string, sourceRelativePath: string, targetDirectoryRelativePath: string) => {
    const sourcePath = resolveWorkspacePath(rootPath, sourceRelativePath)
    const targetDirectory = resolveWorkspacePath(rootPath, targetDirectoryRelativePath)
    if (!sourcePath || !targetDirectory || resolve(sourcePath) === resolve(rootPath)) {
      return fileTreeResult(false, 'Invalid move target')
    }

    const targetPath = resolve(targetDirectory, basename(sourcePath))
    if (!isPathWithinRoot(rootPath, targetPath)) return fileTreeResult(false, 'Invalid target path')

    try {
      if (!await authorize(event, { workspaceRoot: rootPath, toolName: 'legacy.file-tree.move', actionRisk: 'write', source: 'renderer-user', preview: { summary: 'Move workspace file', paths: [sourcePath, targetPath], truncated: false } })) return fileTreeResult(false, 'Move denied by workspace policy')
      const [sourceInfo, targetDirectoryInfo] = await Promise.all([stat(sourcePath), stat(targetDirectory)])
      if (!sourceInfo.isFile()) return fileTreeResult(false, 'Only files can be moved')
      if (!targetDirectoryInfo.isDirectory()) return fileTreeResult(false, 'Target is not a directory')
      if (resolve(sourcePath) === resolve(targetPath)) {
        return fileTreeResult(true, undefined, normalizeRelativePath(rootPath, sourcePath))
      }

      try {
        await stat(targetPath)
        return fileTreeResult(false, 'A file with the same name already exists')
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }

      await rename(sourcePath, targetPath)
      return fileTreeResult(true, undefined, normalizeRelativePath(rootPath, targetPath))
    } catch (err: any) {
      return fileTreeResult(false, err.message || 'Failed to move file')
    }
  })

  ipcMain.handle(FILE_TREE_CHANNELS.delete, async (event, rootPath: string, relativePathValue: string) => {
    const targetPath = resolveWorkspacePath(rootPath, relativePathValue)
    if (!targetPath || resolve(targetPath) === resolve(rootPath)) {
      return fileTreeResult(false, 'Cannot delete workspace root')
    }

    try {
      if (!await authorize(event, { workspaceRoot: rootPath, toolName: 'legacy.file-tree.delete', actionRisk: 'delete', source: 'renderer-user', preview: { summary: 'Delete workspace item', paths: [targetPath], truncated: false } })) return fileTreeResult(false, 'Delete denied by workspace policy')
      await rm(targetPath, { recursive: true, force: false })
      return fileTreeResult(true)
    } catch (err: any) {
      return fileTreeResult(false, err.message || 'Failed to delete item')
    }
  })

  ipcMain.handle(FILE_TREE_CHANNELS.reveal, async (_event, rootPath: string, relativePathValue: string) => {
    const targetPath = resolveWorkspacePath(rootPath, relativePathValue)
    if (!targetPath) return fileTreeResult(false, 'Invalid target path')

    shell.showItemInFolder(targetPath)
    return fileTreeResult(true)
  })
}
