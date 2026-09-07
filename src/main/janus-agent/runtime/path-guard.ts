import { constants } from 'fs'
import { createHash } from 'node:crypto'
import { open, realpath, stat } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'

export type WorkspacePathReasonCode =
  | 'WORKSPACE_UNAVAILABLE'
  | 'ABSOLUTE_PATH'
  | 'PATH_TRAVERSAL'
  | 'TARGET_UNAVAILABLE'
  | 'OUTSIDE_WORKSPACE'
  | 'TARGET_NOT_REGULAR'
  | 'TARGET_CHANGED'
  | 'TARGET_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'INVALID_READ_LIMIT'

export interface TrustedWorkspaceTarget {
  relativePath: string
  kind: 'file' | 'directory'
}

export interface WorkspaceReadAuthorization {
  outcome: 'allow' | 'deny'
  reasonCode: string
}

export type WorkspaceReadAuthorizer = (
  target: TrustedWorkspaceTarget,
) => WorkspaceReadAuthorization | Promise<WorkspaceReadAuthorization>

const MAX_HASHED_RANGE_FILE_BYTES = 16 * 1024 * 1024

export interface WorkspaceFileRange {
  content: Buffer
  offset: number
  size: number
  sha256: string
  truncated: boolean
}

interface CanonicalWorkspaceTarget extends TrustedWorkspaceTarget {
  rootPath: string
  targetPath: string
}

export class WorkspacePathGuardError extends Error {
  constructor(readonly code: WorkspacePathReasonCode, message: string) {
    super(message)
    this.name = 'WorkspacePathGuardError'
  }
}

export class WorkspaceReadDeniedError extends Error {
  constructor(readonly code: string) {
    super(`Workspace read denied: ${code}`)
    this.name = 'WorkspaceReadDeniedError'
  }
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
  return isAbsolute(value) || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}

async function canonicalPath(value: string, code: WorkspacePathReasonCode): Promise<string> {
  try {
    return await realpath(value)
  } catch {
    throw new WorkspacePathGuardError(code, code === 'WORKSPACE_UNAVAILABLE'
      ? 'Workspace is unavailable'
      : 'Workspace target is unavailable')
  }
}

export async function resolveWorkspaceTarget(
  workspaceRoot: string,
  requestedPath: string,
): Promise<TrustedWorkspaceTarget> {
  const target = await resolveCanonicalWorkspaceTarget(workspaceRoot, requestedPath)
  return { relativePath: target.relativePath, kind: target.kind }
}

export interface TrustedWorkspaceCreationTarget {
  relativePath: string
  /** Canonical absolute path of the file to create (parent realpathed, leaf appended). */
  targetPath: string
}

/**
 * Resolve a path for a file that must NOT exist yet. The parent directory must
 * exist inside the workspace; the leaf is validated syntactically and appended
 * to the canonical parent, so symlinked parents cannot escape the root.
 */
export async function resolveWorkspaceCreationTarget(
  workspaceRoot: string,
  requestedPath: string,
): Promise<TrustedWorkspaceCreationTarget> {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
  if (isAbsoluteOnAnyPlatform(requestedPath)) {
    throw new WorkspacePathGuardError('ABSOLUTE_PATH', 'Absolute paths are not allowed')
  }
  const segments = requestedPath.split(/[\\/]+/).filter(Boolean)
  if (segments.includes('..')) {
    throw new WorkspacePathGuardError('PATH_TRAVERSAL', 'Parent path traversal is not allowed')
  }
  const leaf = segments.at(-1)
  if (!leaf || leaf === '.' || /[<>:"|?*]/.test(leaf) || leaf.endsWith('.') || leaf.endsWith(' ')) {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace file name is invalid')
  }

  const parent = segments.slice(0, -1).join('/')
  const parentTarget = await resolveCanonicalWorkspaceTarget(workspaceRoot, parent)
  if (parentTarget.kind !== 'directory') {
    throw new WorkspacePathGuardError('TARGET_NOT_REGULAR', 'Workspace parent is not a directory')
  }
  const targetPath = resolve(parentTarget.targetPath, leaf)
  try {
    await stat(targetPath)
    throw new WorkspacePathGuardError('TARGET_EXISTS', 'Workspace target already exists')
  } catch (error) {
    if (error instanceof WorkspacePathGuardError) throw error
  }
  return {
    relativePath: parentTarget.relativePath ? `${parentTarget.relativePath}/${leaf}` : leaf,
    targetPath,
  }
}

async function resolveCanonicalWorkspaceTarget(
  workspaceRoot: string,
  requestedPath: string,
): Promise<CanonicalWorkspaceTarget> {
  if (!workspaceRoot) {
    throw new WorkspacePathGuardError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable')
  }
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
  if (isAbsoluteOnAnyPlatform(requestedPath)) {
    throw new WorkspacePathGuardError('ABSOLUTE_PATH', 'Absolute paths are not allowed')
  }

  const pathSegments = requestedPath.split(/[\\/]+/)
  if (pathSegments.includes('..')) {
    throw new WorkspacePathGuardError('PATH_TRAVERSAL', 'Parent path traversal is not allowed')
  }

  const rootPath = await canonicalPath(workspaceRoot, 'WORKSPACE_UNAVAILABLE')
  try {
    if (!(await stat(rootPath)).isDirectory()) {
      throw new WorkspacePathGuardError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable')
    }
  } catch (error) {
    if (error instanceof WorkspacePathGuardError) throw error
    throw new WorkspacePathGuardError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable')
  }
  const targetPath = await canonicalPath(
    resolve(rootPath, pathSegments.filter(Boolean).join(sep) || '.'),
    'TARGET_UNAVAILABLE',
  )
  const relativePath = relative(rootPath, targetPath)
  if (isOutsideRoot(relativePath)) {
    throw new WorkspacePathGuardError('OUTSIDE_WORKSPACE', 'Workspace target is outside the workspace')
  }

  let targetStat
  try {
    targetStat = await stat(targetPath)
  } catch {
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace target is unavailable')
  }
  const kind = targetStat.isFile() ? 'file' : targetStat.isDirectory() ? 'directory' : undefined
  if (!kind) {
    throw new WorkspacePathGuardError('TARGET_NOT_REGULAR', 'Workspace target is not a regular file or directory')
  }

  return {
    rootPath,
    targetPath,
    relativePath: relativePath.split(sep).join('/'),
    kind,
  }
}

function hasStableIdentity(value: { dev: bigint; ino: bigint }): boolean {
  return value.ino !== 0n
}

export function sameWorkspaceFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return hasStableIdentity(left) && hasStableIdentity(right)
    && left.ino === right.ino
    && (left.dev === 0n || right.dev === 0n || left.dev === right.dev)
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) return Buffer.concat(chunks, total)
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  throw new WorkspacePathGuardError('FILE_TOO_LARGE', 'Workspace file exceeds the read limit')
}

async function readStableWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  maxBytes: number,
  authorize: WorkspaceReadAuthorizer,
): Promise<Buffer | null> {
  const target = await resolveCanonicalWorkspaceTarget(workspaceRoot, requestedPath)
  if (target.kind !== 'file') {
    throw new WorkspacePathGuardError('TARGET_NOT_REGULAR', 'Workspace target is not a regular file')
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    handle = await open(target.targetPath, constants.O_RDONLY | noFollow)
    const openedStat = await handle.stat({ bigint: true })
    if (openedStat.size > BigInt(maxBytes)) {
      throw new WorkspacePathGuardError('FILE_TOO_LARGE', 'Workspace file exceeds the read limit')
    }
    if (!openedStat.isFile() || !hasStableIdentity(openedStat)) return null

    const freshTarget = await resolveCanonicalWorkspaceTarget(workspaceRoot, requestedPath)
    if (freshTarget.kind !== 'file') return null
    const freshStat = await stat(freshTarget.targetPath, { bigint: true })
    if (!sameWorkspaceFileIdentity(openedStat, freshStat)) return null

    const authorization = await authorize({
      relativePath: freshTarget.relativePath,
      kind: freshTarget.kind,
    })
    if (!authorization || authorization.outcome !== 'allow') {
      throw new WorkspaceReadDeniedError(authorization?.reasonCode || 'READ_NOT_AUTHORIZED')
    }
    return await readBounded(handle, maxBytes)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function hashOpenFile(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
    if (bytesRead === 0) throw new WorkspacePathGuardError('TARGET_CHANGED', 'Workspace target changed while reading')
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  return hash.digest('hex')
}

async function readStableWorkspaceFileRange(
  workspaceRoot: string,
  requestedPath: string,
  offset: number,
  maxBytes: number,
  authorize: WorkspaceReadAuthorizer,
): Promise<WorkspaceFileRange | null> {
  const target = await resolveCanonicalWorkspaceTarget(workspaceRoot, requestedPath)
  if (target.kind !== 'file') {
    throw new WorkspacePathGuardError('TARGET_NOT_REGULAR', 'Workspace target is not a regular file')
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    handle = await open(target.targetPath, constants.O_RDONLY | noFollow)
    const openedStat = await handle.stat({ bigint: true })
    if (!openedStat.isFile() || !hasStableIdentity(openedStat)) return null
    const size = Number(openedStat.size)
    if (!Number.isSafeInteger(size)) throw new WorkspacePathGuardError('FILE_TOO_LARGE', 'Workspace file is too large to read safely')
    if (size > MAX_HASHED_RANGE_FILE_BYTES) throw new WorkspacePathGuardError('FILE_TOO_LARGE', 'Workspace file exceeds the bounded range read limit')

    const freshTarget = await resolveCanonicalWorkspaceTarget(workspaceRoot, requestedPath)
    if (freshTarget.kind !== 'file') return null
    const freshStat = await stat(freshTarget.targetPath, { bigint: true })
    if (!sameWorkspaceFileIdentity(openedStat, freshStat)) return null

    const authorization = await authorize({ relativePath: freshTarget.relativePath, kind: freshTarget.kind })
    if (!authorization || authorization.outcome !== 'allow') {
      throw new WorkspaceReadDeniedError(authorization?.reasonCode || 'READ_NOT_AUTHORIZED')
    }

    const bytes = Math.min(maxBytes, Math.max(0, size - offset))
    const content = Buffer.allocUnsafe(bytes)
    for (let readOffset = 0; readOffset < bytes;) {
      const { bytesRead } = await handle.read(content, readOffset, bytes - readOffset, offset + readOffset)
      if (bytesRead === 0) return null
      readOffset += bytesRead
    }
    const sha256 = await hashOpenFile(handle, size)
    const finalTarget = await resolveCanonicalWorkspaceTarget(workspaceRoot, requestedPath)
    if (finalTarget.kind !== 'file') return null
    const finalStat = await stat(finalTarget.targetPath, { bigint: true })
    if (!sameWorkspaceFileIdentity(openedStat, finalStat) || Number(finalStat.size) !== size) return null
    return { content, offset, size, sha256, truncated: offset + bytes < size }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
  maxBytes: number,
  authorize: WorkspaceReadAuthorizer,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspacePathGuardError('INVALID_READ_LIMIT', 'Workspace file read limit is invalid')
  }

  try {
    // Atomic saves replace the target identity briefly. Retry once from canonical resolution.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await readStableWorkspaceFile(workspaceRoot, requestedPath, maxBytes, authorize)
      if (content !== null) return content
    }
    throw new WorkspacePathGuardError('TARGET_CHANGED', 'Workspace target changed during authorization')
  } catch (error) {
    if (error instanceof WorkspacePathGuardError || error instanceof WorkspaceReadDeniedError) throw error
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace file is unavailable')
  }
}

export async function readWorkspaceFileRange(
  workspaceRoot: string,
  requestedPath: string,
  offset: number,
  maxBytes: number,
  authorize: WorkspaceReadAuthorizer,
): Promise<WorkspaceFileRange> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspacePathGuardError('INVALID_READ_LIMIT', 'Workspace file read range is invalid')
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = await readStableWorkspaceFileRange(workspaceRoot, requestedPath, offset, maxBytes, authorize)
      if (read !== null) return read
    }
    throw new WorkspacePathGuardError('TARGET_CHANGED', 'Workspace target changed during authorization')
  } catch (error) {
    if (error instanceof WorkspacePathGuardError || error instanceof WorkspaceReadDeniedError) throw error
    throw new WorkspacePathGuardError('TARGET_UNAVAILABLE', 'Workspace file is unavailable')
  }
}
