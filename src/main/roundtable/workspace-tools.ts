import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveWorkspaceTarget } from '../janus-agent/runtime/path-guard'
import { evaluateWorkspaceReadPolicy, isSensitivePath, redactHighConfidenceSecrets } from '../janus-agent/runtime/policy-gate'
import { janusWorkspaceFs } from '../janus-agent/environment/janus-workspace-fs'

export interface RoundtableWorkspaceToolContext { workspaceId: string; workspaceRoot: string; signal: AbortSignal }

export type RoundtableWorkspaceToolErrorCode =
  | 'WORKSPACE_TOOL_WORKSPACE_MISMATCH'
  | 'WORKSPACE_TOOL_CANCELLED'
  | 'WORKSPACE_TOOL_INVALID_RANGE'
  | 'WORKSPACE_TOOL_INVALID_LIST'

export class RoundtableWorkspaceToolError extends Error {
  readonly code: RoundtableWorkspaceToolErrorCode
  constructor(code: RoundtableWorkspaceToolErrorCode, message: string) {
    super(message)
    this.name = 'RoundtableWorkspaceToolError'
    this.code = code
  }
}

export interface RoundtableWorkspaceReadResult {
  workspaceId: string
  path: string
  offset: number
  size: number
  bytes: number
  truncated: boolean
  sha256: string
  content: string
  contentRedacted: boolean
  lineStart?: number
  lineEnd?: number
}

function countLines(text: string): number {
  if (!text) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

export async function executeRoundtableWorkspaceTool(name: 'workspace.list' | 'workspace.read' | 'workspace.readRange', input: Record<string, unknown>, context: RoundtableWorkspaceToolContext): Promise<unknown> {
  if (input.workspaceId !== context.workspaceId) throw new RoundtableWorkspaceToolError('WORKSPACE_TOOL_WORKSPACE_MISMATCH', 'workspace tool workspaceId mismatch')
  if (context.signal.aborted) throw new RoundtableWorkspaceToolError('WORKSPACE_TOOL_CANCELLED', 'workspace tool cancelled')
  const path = typeof input.path === 'string' ? input.path : ''
  if (name === 'workspace.read' || name === 'workspace.readRange') {
    const offset = Number(input.offset ?? 0)
    const maxBytes = Number(input.maxBytes ?? 128 * 1024)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) throw new RoundtableWorkspaceToolError('WORKSPACE_TOOL_INVALID_RANGE', 'Invalid workspace read range')
    const read = await janusWorkspaceFs.readWorkspaceTextRange(context.workspaceRoot, path, offset, maxBytes, evaluateWorkspaceReadPolicy)
    if (!read.ok) throw read.error
    const redacted = redactHighConfidenceSecrets(read.value.content.toString('utf8'))
    const result: RoundtableWorkspaceReadResult = { workspaceId: context.workspaceId, path, offset: read.value.offset, size: read.value.size, bytes: read.value.content.byteLength, truncated: read.value.truncated, sha256: read.value.sha256, content: redacted.text, contentRedacted: redacted.redacted }
    if (name === 'workspace.read') {
      const lines = countLines(redacted.text)
      if (lines > 0) { result.lineStart = 1; result.lineEnd = lines }
    } else if (offset === 0) {
      const lines = countLines(redacted.text)
      if (lines > 0) { result.lineStart = 1; result.lineEnd = lines }
    } else {
      // Byte-range reads need an absolute base line. Count newlines in the
      // prefix so evidenceRefs carry absolute line numbers. Prefix I/O is
      // bounded by the same 256KB tool budget via the offset itself; on any
      // failure leave line numbers undefined rather than guessing.
      try {
        const prefix = await janusWorkspaceFs.readWorkspaceTextRange(context.workspaceRoot, path, 0, offset, evaluateWorkspaceReadPolicy)
        if (prefix.ok) {
          const base = countLines(prefix.value.content.toString('utf8'))
          const lines = countLines(redacted.text)
          if (lines > 0) { result.lineStart = base + 1; result.lineEnd = base + lines }
        }
      } catch { /* line numbers stay undefined */ }
    }
    return result
  }
  const depth = Number(input.depth ?? 2)
  const maxEntries = Number(input.maxEntries ?? 200)
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 4 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) throw new RoundtableWorkspaceToolError('WORKSPACE_TOOL_INVALID_LIST', 'Invalid workspace list bounds')
  const target = await resolveWorkspaceTarget(context.workspaceRoot, path)
  if (target.kind !== 'directory') throw new RoundtableWorkspaceToolError('WORKSPACE_TOOL_INVALID_LIST', 'workspace.list path must be a directory')
  const entries: Array<{ path: string; name: string; type: 'file' | 'directory'; depth: number }> = []
  let truncated = false
  const walk = async (dir: string, relativeDir: string, currentDepth: number): Promise<void> => {
    if (currentDepth > depth || truncated) return
    if (context.signal.aborted) throw new RoundtableWorkspaceToolError('WORKSPACE_TOOL_CANCELLED', 'workspace.list cancelled')
    const children = await readdir(dir, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) continue
      const childPath = relativeDir ? `${relativeDir}/${child.name}` : child.name
      if (isSensitivePath(childPath)) continue
      entries.push({ path: childPath, name: child.name, type: child.isDirectory() ? 'directory' : 'file', depth: currentDepth })
      if (entries.length >= maxEntries) { truncated = true; return }
      if (child.isDirectory() && currentDepth < depth) await walk(join(dir, child.name), childPath, currentDepth + 1)
    }
  }
  await walk(join(context.workspaceRoot, target.relativePath), target.relativePath, 1)
  return { workspaceId: context.workspaceId, path: target.relativePath, depth, entries, truncated }
}
