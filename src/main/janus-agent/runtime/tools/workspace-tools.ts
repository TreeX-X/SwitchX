import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { resolveWorkspaceTarget } from '../path-guard'
import { evaluateWorkspaceReadPolicy, isSensitivePath, redactHighConfidenceSecrets } from '../policy-gate'
import type { RegisteredTool, ToolRegistry } from '../registry'
import { isTextBuffer, janusWorkspaceFs } from '../../environment/janus-workspace-fs'
import { checkpointManager } from '../../checkpoint/checkpoint-manager'
import {
  atomicReplaceWorkspaceFile,
  createWorkspaceFile,
  prepareWorkspaceEdit,
  prepareWorkspaceUnifiedDiffEdit,
  MAX_WORKSPACE_EDIT_BYTES,
  type WorkspaceExactReplacement,
} from '../file-transaction'

const DEFAULT_MAX_BYTES = 256 * 1024
const MAX_MAX_BYTES = 1024 * 1024
const DEFAULT_DEPTH = 2
const MAX_DEPTH = 4
const DEFAULT_MAX_ENTRIES = 200
const MAX_MAX_ENTRIES = 1000
const registeredRegistries = new WeakSet<ToolRegistry>()

export const workspaceReadTool: RegisteredTool = {
  name: 'workspace.read',
  description: 'Read a UTF-8 text file inside the current workspace',
  actionRisk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      offset: { type: 'number' },
      maxBytes: { type: 'number' },
    },
    required: ['workspaceId', 'path'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path
    const offset = input.offset ?? 0
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.read workspaceId must match the active workspace resource')
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.read path must be a string')
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
      throw new Error('workspace.read offset must be a non-negative integer')
    }
    if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 0 || Number(maxBytes) > MAX_MAX_BYTES) {
      throw new Error(`workspace.read maxBytes must be an integer between 0 and ${MAX_MAX_BYTES}`)
    }
    if (context.signal.aborted) throw new Error('workspace.read cancelled')

    const read = await janusWorkspaceFs.readWorkspaceTextRange(
      context.workspaceRoot,
      requestedPath,
      Number(offset),
      Number(maxBytes),
      evaluateWorkspaceReadPolicy,
    )
    if (!read.ok) throw read.error
    const range = read.value
    if (context.signal.aborted) throw new Error('workspace.read cancelled')

    // sha256 is always computed from disk content: edits to unmasked regions
    // still match, and only the masked credential itself becomes uneditable.
    const { text, redacted } = redactHighConfidenceSecrets(range.content.toString('utf-8'))
    return {
      workspaceId,
      path: requestedPath,
      encoding: 'utf-8',
      size: range.size,
      offset: range.offset,
      bytes: range.content.byteLength,
      truncated: range.truncated,
      content: text,
      sha256: range.sha256,
      contentRedacted: redacted,
      ...(redacted ? {
        redactionNotice: 'High-confidence credential material was masked as [REDACTED]. The sha256 covers the original file; masked regions cannot be used as oldText in workspace.edit.',
      } : {}),
    }
  },
}

export const workspaceEditTool: RegisteredTool = {
  name: 'workspace.edit',
  description: 'Apply bounded exact replacements or one unified diff to an existing workspace file after approval',
  actionRisk: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      expectedHash: { type: 'string' },
      replacements: { type: 'array' },
      unifiedDiff: { type: 'string' },
    },
    required: ['workspaceId', 'path', 'expectedHash'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('workspace.edit workspaceId must match the active workspace resource')
    }
    if (typeof input.path !== 'string' || typeof input.expectedHash !== 'string') {
      throw new Error('workspace.edit input is invalid')
    }
    const hasReplacements = input.replacements !== undefined
    const hasUnifiedDiff = input.unifiedDiff !== undefined
    if (hasReplacements === hasUnifiedDiff) {
      throw new Error('workspace.edit requires exactly one of replacements or unifiedDiff')
    }
    if (hasReplacements && !Array.isArray(input.replacements)) throw new Error('workspace.edit replacements must be an array')
    if (hasUnifiedDiff && typeof input.unifiedDiff !== 'string') throw new Error('workspace.edit unifiedDiff must be a string')
    if (context.signal.aborted) throw new Error('workspace.edit cancelled')
    const prepare = () => hasUnifiedDiff
      ? prepareWorkspaceUnifiedDiffEdit(context.workspaceRoot, input.path as string, input.expectedHash as string, input.unifiedDiff as string)
      : prepareWorkspaceEdit(context.workspaceRoot, input.path as string, input.expectedHash as string, input.replacements as WorkspaceExactReplacement[])
    let prepared = await prepare()
    await checkpointManager.initialize(context.workspaceRoot)
    const checkpoint = await checkpointManager.createCheckpoint({
      terminalId: `workspace-chat:${context.workspaceId}`,
      engine: 'manual',
      prompt: `workspace.edit ${prepared.path}`,
      cwd: context.workspaceRoot,
    })
    if (context.signal.aborted) throw new Error('workspace.edit cancelled')
    prepared = await prepare()
    await atomicReplaceWorkspaceFile(context.workspaceRoot, prepared)
    return {
      workspaceId: context.workspaceId,
      path: prepared.path,
      changedPaths: [prepared.path],
      previousHash: prepared.previousHash,
      sha256: prepared.nextHash,
      editMode: prepared.editMode,
      replacements: prepared.replacements,
      bytes: Buffer.byteLength(prepared.nextContent),
      checkpointId: checkpoint.id,
    }
  },
}

export const workspaceCreateTool: RegisteredTool = {
  name: 'workspace.create',
  description: 'Create a new UTF-8 text file inside the current workspace after approval',
  actionRisk: 'create',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['workspaceId', 'path', 'content'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('workspace.create workspaceId must match the active workspace resource')
    }
    if (typeof input.path !== 'string' || typeof input.content !== 'string') {
      throw new Error('workspace.create input is invalid')
    }
    if (Buffer.byteLength(input.content, 'utf-8') > MAX_WORKSPACE_EDIT_BYTES) {
      throw new Error(`workspace.create content exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
    }
    if (context.signal.aborted) throw new Error('workspace.create cancelled')
    await checkpointManager.initialize(context.workspaceRoot)
    const checkpoint = await checkpointManager.createCheckpoint({
      terminalId: `workspace-chat:${context.workspaceId}`,
      engine: 'manual',
      prompt: `workspace.create ${input.path}`,
      cwd: context.workspaceRoot,
    })
    if (context.signal.aborted) throw new Error('workspace.create cancelled')
    const created = await createWorkspaceFile(context.workspaceRoot, input.path, input.content)
    return {
      workspaceId: context.workspaceId,
      path: created.path,
      changedPaths: [created.path],
      sha256: created.sha256,
      bytes: created.bytes,
      checkpointId: checkpoint.id,
    }
  },
}

type WorkspaceListEntry = {
  path: string
  name: string
  type: 'file' | 'directory'
  depth: number
}

export const workspaceListTool: RegisteredTool = {
  name: 'workspace.list',
  description: 'List a bounded, non-sensitive file tree inside an explicitly selected workspace',
  actionRisk: 'list',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      depth: { type: 'number' },
      maxEntries: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const requestedPath = input.path ?? ''
    const depth = input.depth ?? DEFAULT_DEPTH
    const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.list workspaceId must match the active workspace resource')
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.list path must be a string')
    if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
      throw new Error(`workspace.list depth must be an integer between 0 and ${MAX_DEPTH}`)
    }
    if (typeof maxEntries !== 'number' || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_MAX_ENTRIES) {
      throw new Error(`workspace.list maxEntries must be an integer between 1 and ${MAX_MAX_ENTRIES}`)
    }
    if (context.signal.aborted) throw new Error('workspace.list cancelled')

    const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    if (target.kind !== 'directory') throw new Error('workspace.list path must be a directory')
    const rootPath = resolve(context.workspaceRoot, target.relativePath || '.')
    const entries: WorkspaceListEntry[] = []
    let truncated = false

    const walk = async (directoryPath: string, relativeDirectory: string, currentDepth: number): Promise<void> => {
      if (currentDepth > depth || truncated) return
      if (context.signal.aborted) throw new Error('workspace.list cancelled')
      const children = await readdir(directoryPath, { withFileTypes: true })
      children.sort((left, right) => {
        const leftDirectory = left.isDirectory() ? 0 : 1
        const rightDirectory = right.isDirectory() ? 0 : 1
        return leftDirectory - rightDirectory || left.name.localeCompare(right.name)
      })
      for (const child of children) {
        if (context.signal.aborted) throw new Error('workspace.list cancelled')
        if (child.isSymbolicLink()) continue
        if (!child.isDirectory() && !child.isFile()) continue
        const childPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
        if (isSensitivePath(childPath)) continue
        entries.push({
          path: childPath,
          name: child.name,
          type: child.isDirectory() ? 'directory' : 'file',
          depth: currentDepth,
        })
        if (entries.length > maxEntries) {
          truncated = true
          entries.pop()
          return
        }
        if (child.isDirectory() && currentDepth < depth) {
          await walk(join(directoryPath, child.name), childPath, currentDepth + 1)
          if (truncated) return
        }
      }
    }

    await walk(rootPath, target.relativePath, 1)
    return {
      workspaceId,
      path: target.relativePath,
      depth,
      entries,
      truncated,
    }
  },
}

const SEARCH_MAX_QUERY_CHARS = 256
const SEARCH_MAX_RESULTS = 50
const SEARCH_MAX_FILES = 2_000
const SEARCH_MAX_FILE_BYTES = 512 * 1024
const SEARCH_MAX_LINE_CHARS = 300
const SEARCH_MAX_DEPTH = 8
const SEARCH_SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'out', 'build', 'coverage', 'target', 'vendor', '__pycache__', '.venv', 'venv',
  // P4: command.run logs live under .janusX/logs (read them via the logPath
  // from the tool result, not via search) — keep build output out of code search.
  '.janusX',
])

type WorkspaceSearchMatch = {
  path: string
  line: number
  text: string
}

export const workspaceSearchTool: RegisteredTool = {
  name: 'workspace.search',
  description: 'Search UTF-8 text files in the workspace for a literal substring and return matching lines',
  actionRisk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      query: { type: 'string' },
      path: { type: 'string' },
      maxResults: { type: 'number' },
    },
    required: ['workspaceId', 'query'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const workspaceId = input.workspaceId
    const query = input.query
    const requestedPath = input.path ?? ''
    const maxResults = input.maxResults ?? SEARCH_MAX_RESULTS
    if (typeof workspaceId !== 'string' || workspaceId !== context.workspaceId) {
      throw new Error('workspace.search workspaceId must match the active workspace resource')
    }
    if (typeof query !== 'string' || !query.trim() || query.length > SEARCH_MAX_QUERY_CHARS) {
      throw new Error(`workspace.search query must be 1-${SEARCH_MAX_QUERY_CHARS} characters`)
    }
    if (typeof requestedPath !== 'string') throw new Error('workspace.search path must be a string')
    if (typeof maxResults !== 'number' || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > SEARCH_MAX_RESULTS) {
      throw new Error(`workspace.search maxResults must be an integer between 1 and ${SEARCH_MAX_RESULTS}`)
    }
    if (context.signal.aborted) throw new Error('workspace.search cancelled')

    const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
    if (target.kind !== 'directory') throw new Error('workspace.search path must be a directory')
    const rootPath = resolve(context.workspaceRoot, target.relativePath || '.')
    const needle = query.toLowerCase()
    const matches: WorkspaceSearchMatch[] = []
    let scannedFiles = 0
    let truncated = false

    const walk = async (directoryPath: string, relativeDirectory: string, depth: number): Promise<void> => {
      if (truncated || depth > SEARCH_MAX_DEPTH) return
      if (context.signal.aborted) throw new Error('workspace.search cancelled')
      const children = await readdir(directoryPath, { withFileTypes: true })
      children.sort((left, right) => left.name.localeCompare(right.name))
      for (const child of children) {
        if (truncated) return
        if (context.signal.aborted) throw new Error('workspace.search cancelled')
        if (child.isSymbolicLink()) continue
        const childRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
        if (isSensitivePath(childRelative)) continue
        if (child.isDirectory()) {
          if (SEARCH_SKIPPED_DIRECTORIES.has(child.name)) continue
          await walk(join(directoryPath, child.name), childRelative, depth + 1)
          continue
        }
        if (!child.isFile()) continue
        if (scannedFiles >= SEARCH_MAX_FILES) { truncated = true; return }
        scannedFiles++
        const filePath = join(directoryPath, child.name)
        try {
          if ((await stat(filePath)).size > SEARCH_MAX_FILE_BYTES) continue
          const content = await readFile(filePath)
          if (!isTextBuffer(content)) continue
          const lines = content.toString('utf-8').split('\n')
          for (const [index, line] of lines.entries()) {
            if (!line.toLowerCase().includes(needle)) continue
            matches.push({
              path: childRelative,
              line: index + 1,
              text: line.length > SEARCH_MAX_LINE_CHARS ? `${line.slice(0, SEARCH_MAX_LINE_CHARS)}…` : line,
            })
            if (matches.length >= maxResults) { truncated = true; break }
          }
        } catch {
          // Unreadable files are skipped, not fatal to the search.
        }
      }
    }

    await walk(rootPath, target.relativePath, 1)
    return {
      workspaceId,
      query,
      path: target.relativePath,
      matches,
      scannedFiles,
      truncated,
    }
  },
}

export function registerWorkspaceTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  registry.register(workspaceReadTool)
  registry.register(workspaceListTool)
  registry.register(workspaceEditTool)
  registry.register(workspaceCreateTool)
  registry.register(workspaceSearchTool)
  registeredRegistries.add(registry)
}
