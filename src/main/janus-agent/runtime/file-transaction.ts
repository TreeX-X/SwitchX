import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { evaluateWorkspaceReadPolicy, isSensitivePath } from './policy-gate'
import {
  readWorkspaceFile,
  resolveWorkspaceCreationTarget,
  resolveWorkspaceTarget,
  sameWorkspaceFileIdentity,
  WorkspacePathGuardError,
} from './path-guard'

export const MAX_WORKSPACE_EDIT_BYTES = 1024 * 1024
export const MAX_WORKSPACE_REPLACEMENTS = 40

export interface WorkspaceExactReplacement {
  oldText: string
  newText: string
}

export interface PreparedWorkspaceEdit {
  path: string
  previousHash: string
  nextHash: string
  previousContent: string
  nextContent: string
  replacements: number
  editMode: 'replace_blocks' | 'unified_diff'
}

export class WorkspaceEditConflictError extends Error {
  readonly code = 'TARGET_CHANGED'
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEditConflictError'
  }
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function assertText(content: Buffer): string {
  if (!isUtf8(content) || content.some((byte) =>
    byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d),
  )) {
    throw new Error('workspace.edit only supports UTF-8 text files')
  }
  return content.toString('utf-8')
}

function applyExactReplacements(content: string, replacements: WorkspaceExactReplacement[]): string {
  if (replacements.length < 1 || replacements.length > MAX_WORKSPACE_REPLACEMENTS) {
    throw new Error(`workspace.edit requires between 1 and ${MAX_WORKSPACE_REPLACEMENTS} replacements`)
  }
  let next = content
  for (const [index, replacement] of replacements.entries()) {
    if (!replacement || typeof replacement.oldText !== 'string' || typeof replacement.newText !== 'string') {
      throw new Error(`workspace.edit replacement ${index + 1} is invalid`)
    }
    if (!replacement.oldText) throw new Error(`workspace.edit replacement ${index + 1} oldText must not be empty`)
    const first = next.indexOf(replacement.oldText)
    if (first < 0) throw new WorkspaceEditConflictError(`workspace.edit replacement ${index + 1} no longer matches the file`)
    if (next.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      throw new WorkspaceEditConflictError(`workspace.edit replacement ${index + 1} is ambiguous`)
    }
    next = `${next.slice(0, first)}${replacement.newText}${next.slice(first + replacement.oldText.length)}`
    if (Buffer.byteLength(next) > MAX_WORKSPACE_EDIT_BYTES) {
      throw new Error(`workspace.edit output exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
    }
  }
  return next
}

interface UnifiedDiffLine {
  kind: ' ' | '+' | '-'
  content: string
}

interface UnifiedDiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: UnifiedDiffLine[]
  newNoFinalNewline: boolean
}

interface ParsedUnifiedDiff {
  oldPath: string
  newPath: string
  metadataPaths: string[]
  hunks: UnifiedDiffHunk[]
}

function normalizeUnifiedDiffPath(value: string): string {
  const path = value.split('\t', 1)[0]?.trim()
  if (!path || path === '/dev/null') throw new Error('workspace.edit unifiedDiff must target an existing file')
  return path.replace(/^[ab]\//, '')
}

function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  if (typeof diff !== 'string' || diff.length === 0) throw new Error('workspace.edit unifiedDiff must not be empty')
  const lines = diff.split(/\r\n|\n|\r/)
  if (lines.at(-1) === '') lines.pop()
  let cursor = 0
  const metadataPaths: string[] = []
  if (lines[cursor]?.startsWith('diff --git ')) {
    const match = /^diff --git (.+) (.+)$/.exec(lines[cursor] ?? '')
    if (!match) throw new Error('workspace.edit unifiedDiff contains an invalid diff header')
    metadataPaths.push(normalizeUnifiedDiffPath(match[1]), normalizeUnifiedDiffPath(match[2]))
    cursor += 1
  }
  while (lines[cursor]?.startsWith('index ')) cursor += 1
  const oldHeader = lines[cursor]
  const newHeader = lines[cursor + 1]
  if (!oldHeader?.startsWith('--- ') || !newHeader?.startsWith('+++ ')) {
    throw new Error('workspace.edit unifiedDiff must begin with --- and +++ file headers')
  }
  const parsed: ParsedUnifiedDiff = {
    oldPath: normalizeUnifiedDiffPath(oldHeader.slice(4)),
    newPath: normalizeUnifiedDiffPath(newHeader.slice(4)),
    metadataPaths,
    hunks: [],
  }
  cursor += 2

  while (cursor < lines.length) {
    const header = lines[cursor]
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header ?? '')
    if (!match) throw new Error('workspace.edit unifiedDiff contains an invalid hunk header')
    const hunk: UnifiedDiffHunk = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? 1),
      lines: [],
      newNoFinalNewline: false,
    }
    cursor += 1
    while (cursor < lines.length && !lines[cursor]?.startsWith('@@ ')) {
      const line = lines[cursor] ?? ''
      if (line === '\\ No newline at end of file') {
        const previous = hunk.lines.at(-1)
        if (!previous) throw new Error('workspace.edit unifiedDiff has an invalid no-newline marker')
        if (previous.kind !== '-') hunk.newNoFinalNewline = true
        cursor += 1
        continue
      }
      const kind = line[0] as UnifiedDiffLine['kind']
      if (kind !== ' ' && kind !== '+' && kind !== '-') {
        throw new Error('workspace.edit unifiedDiff contains an invalid hunk line')
      }
      hunk.lines.push({ kind, content: line.slice(1) })
      cursor += 1
    }
    const oldLines = hunk.lines.filter((line) => line.kind !== '+').length
    const newLines = hunk.lines.filter((line) => line.kind !== '-').length
    if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
      throw new Error('workspace.edit unifiedDiff hunk line counts do not match its header')
    }
    parsed.hunks.push(hunk)
  }
  if (parsed.hunks.length === 0) throw new Error('workspace.edit unifiedDiff must contain at least one hunk')
  return parsed
}

function splitTextLines(content: string): { lines: string[]; eol: string; hasFinalNewline: boolean } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(content)
  const lines = content === '' ? [] : content.split(/\r\n|\n|\r/)
  if (hasFinalNewline) lines.pop()
  return { lines, eol, hasFinalNewline }
}

function applyUnifiedDiff(content: string, requestedPath: string, diff: string): { content: string; hunks: number } {
  const parsed = parseUnifiedDiff(diff)
  if ([parsed.oldPath, parsed.newPath, ...parsed.metadataPaths].some((path) => path !== requestedPath)) {
    throw new Error('workspace.edit unifiedDiff paths must match the requested path')
  }
  const source = splitTextLines(content)
  const nextLines: string[] = []
  let sourceIndex = 0
  let hasFinalNewline = source.hasFinalNewline

  for (const hunk of parsed.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    if (hunkStart < sourceIndex || hunkStart > source.lines.length) {
      throw new WorkspaceEditConflictError('workspace.edit unifiedDiff hunks overlap or do not match the file')
    }
    nextLines.push(...source.lines.slice(sourceIndex, hunkStart))
    sourceIndex = hunkStart
    let insertedLines = 0
    for (const line of hunk.lines) {
      if (line.kind === '+') {
        nextLines.push(line.content)
        insertedLines += 1
        continue
      }
      if (source.lines[sourceIndex] !== line.content) {
        throw new WorkspaceEditConflictError('workspace.edit unifiedDiff context no longer matches the file')
      }
      if (line.kind === ' ') {
        nextLines.push(source.lines[sourceIndex])
        insertedLines += 1
      }
      sourceIndex += 1
    }
    if (insertedLines !== hunk.newCount) throw new Error('workspace.edit unifiedDiff output count is invalid')
    const hunkTouchesSourceEnd = hunk.oldCount === 0
      ? hunk.oldStart === source.lines.length
      : hunk.oldStart + hunk.oldCount - 1 === source.lines.length
    if (hunkTouchesSourceEnd) {
      hasFinalNewline = hunk.newCount > 0 && !hunk.newNoFinalNewline
    }
  }
  nextLines.push(...source.lines.slice(sourceIndex))
  const next = nextLines.join(source.eol) + (nextLines.length > 0 && hasFinalNewline ? source.eol : '')
  if (next === content) throw new Error('workspace.edit does not change the file')
  if (Buffer.byteLength(next) > MAX_WORKSPACE_EDIT_BYTES) {
    throw new Error(`workspace.edit output exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
  }
  return { content: next, hunks: parsed.hunks.length }
}

async function prepareWorkspaceEditWithTransform(
  workspaceRoot: string,
  requestedPath: string,
  expectedHash: string,
  editMode: PreparedWorkspaceEdit['editMode'],
  transform: (content: string, path: string) => { content: string; operations: number },
): Promise<PreparedWorkspaceEdit> {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error('workspace.edit expectedHash must be a SHA-256 hash')
  const target = await resolveWorkspaceTarget(workspaceRoot, requestedPath)
  if (target.kind !== 'file') throw new Error('workspace.edit path must be a regular file')
  const content = await readWorkspaceFile(
    workspaceRoot,
    requestedPath,
    MAX_WORKSPACE_EDIT_BYTES,
    evaluateWorkspaceReadPolicy,
  )
  const previousHash = sha256(content)
  if (previousHash !== expectedHash.toLowerCase()) {
    throw new WorkspaceEditConflictError('workspace.edit expectedHash does not match the current file')
  }
  const previousContent = assertText(content)
  const result = transform(previousContent, target.relativePath)
  return {
    path: target.relativePath,
    previousHash,
    nextHash: sha256(result.content),
    previousContent,
    nextContent: result.content,
    replacements: result.operations,
    editMode,
  }
}

export async function prepareWorkspaceEdit(
  workspaceRoot: string,
  requestedPath: string,
  expectedHash: string,
  replacements: WorkspaceExactReplacement[],
): Promise<PreparedWorkspaceEdit> {
  return prepareWorkspaceEditWithTransform(
    workspaceRoot,
    requestedPath,
    expectedHash,
    'replace_blocks',
    (content) => ({ content: applyExactReplacements(content, replacements), operations: replacements.length }),
  )
}

export async function prepareWorkspaceUnifiedDiffEdit(
  workspaceRoot: string,
  requestedPath: string,
  expectedHash: string,
  unifiedDiff: string,
): Promise<PreparedWorkspaceEdit> {
  return prepareWorkspaceEditWithTransform(
    workspaceRoot,
    requestedPath,
    expectedHash,
    'unified_diff',
    (content, path) => {
      const result = applyUnifiedDiff(content, path, unifiedDiff)
      return { content: result.content, operations: result.hunks }
    },
  )
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}

export interface CreatedWorkspaceFile {
  path: string
  sha256: string
  bytes: number
}

export async function createWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  content: string,
): Promise<CreatedWorkspaceFile> {
  if (typeof content !== 'string') throw new Error('workspace.create content must be a string')
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MAX_WORKSPACE_EDIT_BYTES) {
    throw new Error(`workspace.create content exceeds ${MAX_WORKSPACE_EDIT_BYTES} bytes`)
  }
  const target = await resolveWorkspaceCreationTarget(workspaceRoot, requestedPath)
  if (isSensitivePath(target.relativePath)) {
    const error = new Error('Workspace target is a sensitive path')
    throw Object.assign(error, { code: 'SENSITIVE_PATH' })
  }
  // 'wx' fails if the target appeared between resolution and write (no overwrite path).
  const handle = await open(target.targetPath, 'wx', 0o644)
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return { path: target.relativePath, sha256: sha256(content), bytes }
}

export async function atomicReplaceWorkspaceFile(
  workspaceRoot: string,
  prepared: PreparedWorkspaceEdit,
): Promise<void> {
  const rootPath = await realpath(workspaceRoot)
  const targetPath = await realpath(resolve(rootPath, prepared.path.split('/').join(sep)))
  if (isOutsideRoot(relative(rootPath, targetPath))) {
    throw new WorkspacePathGuardError('OUTSIDE_WORKSPACE', 'Workspace target is outside the workspace')
  }
  const targetHandle = await open(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let targetHandleClosed = false
  let temporaryPath = ''
  try {
    const openedStat = await targetHandle.stat({ bigint: true })
    if (!openedStat.isFile()) throw new WorkspaceEditConflictError('workspace.edit target is no longer a regular file')
    if (openedStat.size > BigInt(MAX_WORKSPACE_EDIT_BYTES)) {
      throw new WorkspaceEditConflictError('workspace.edit target changed beyond the edit size limit')
    }
    const currentContent = await targetHandle.readFile()
    if (sha256(currentContent) !== prepared.previousHash) {
      throw new WorkspaceEditConflictError('workspace.edit target changed before write')
    }

    const parentPath = dirname(targetPath)
    if (await realpath(parentPath) !== parentPath) {
      throw new WorkspaceEditConflictError('workspace.edit parent directory changed before write')
    }
    temporaryPath = resolve(parentPath, `.janusx-edit-${randomUUID()}.tmp`)
    const temporaryHandle = await open(temporaryPath, 'wx', Number(openedStat.mode & 0o777n))
    try {
      await temporaryHandle.writeFile(prepared.nextContent, 'utf-8')
      await temporaryHandle.sync()
    } finally {
      await temporaryHandle.close()
    }

    const freshStat = await stat(targetPath, { bigint: true })
    if (!sameWorkspaceFileIdentity(openedStat, freshStat)) {
      throw new WorkspaceEditConflictError('workspace.edit target changed before replacement')
    }
    // Windows does not allow replacing a file while this process still holds it open.
    await targetHandle.close()
    targetHandleClosed = true
    await rename(temporaryPath, targetPath)
    temporaryPath = ''
  } finally {
    if (!targetHandleClosed) await targetHandle.close().catch(() => undefined)
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
  }
}
