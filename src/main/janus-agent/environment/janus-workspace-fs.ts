import { isUtf8 } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '../../lib/atomic-file'
import { readWorkspaceFile, readWorkspaceFileRange, type WorkspaceFileRange, type WorkspaceReadAuthorizer } from '../runtime/path-guard'
import { isSensitivePath } from '../runtime/policy-gate'
import type { BlueprintEvidenceManifest } from '../../../shared/janus/maintenance-types'

export type JanusResult<T> = { ok: true; value: T } | { ok: false; error: Error }

export interface WorkspaceEvidenceContext {
  context: string
  manifest: BlueprintEvidenceManifest
}

export interface WorkspaceContextOptions {
  maxFiles?: number
  maxFileBytes?: number
  maxContextBytes?: number
  extensions?: ReadonlySet<string>
  excludedDirectories?: ReadonlySet<string>
}

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.css', '.html', '.xml'])
const DEFAULT_EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'release', 'coverage', '.cache'])

function failure(error: unknown): { ok: false; error: Error } {
  return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
}

export function isTextBuffer(content: Buffer): boolean {
  return isUtf8(content) && !content.some((byte) =>
    byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d),
  )
}

async function gitIgnoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set()
  return new Promise((resolveIgnored) => {
    let output = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolveIgnored(new Set(output.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/'))))
    }
    let command
    try { command = spawn('git', ['check-ignore', '--no-index', '--stdin', '-z'], { cwd: root, windowsHide: true }) }
    catch { finish(); return }
    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    command.on('error', finish)
    command.on('close', finish)
    command.stdin.end(`${paths.join('\0')}\0`)
  })
}

async function gitEvidence(root: string, paths: string[]): Promise<{ gitHead?: string; states: Map<string, BlueprintEvidenceManifest['files'][number]['sourceState']> }> {
  const states = new Map<string, BlueprintEvidenceManifest['files'][number]['sourceState']>()
  const gitHead = await new Promise<string | undefined>((resolveHead) => {
    let output = ''
    const command = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })
    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    command.on('error', () => resolveHead(undefined))
    command.on('close', (code) => resolveHead(code === 0 ? output.trim() || undefined : undefined))
  })
  if (!paths.length) return { gitHead, states }
  await new Promise<void>((resolveStates) => {
    let output = ''
    const command = spawn('git', ['status', '--porcelain=v1', '--no-renames', '-z', '--', ...paths], { cwd: root, windowsHide: true })
    command.stdout.setEncoding('utf8')
    command.stdout.on('data', (chunk: string) => { output += chunk })
    const finish = () => {
      for (const record of output.split('\0').filter(Boolean)) {
        const path = record.slice(3).replaceAll('\\', '/')
        const indexState = record[0]
        const worktreeState = record[1]
        states.set(path, indexState === '?' ? 'untracked' : indexState !== ' ' ? 'staged' : worktreeState !== ' ' ? 'unstaged' : 'committed')
      }
      resolveStates()
    }
    command.on('error', finish)
    command.on('close', finish)
    command.stdin.end()
  })
  return { gitHead, states }
}

export class JanusWorkspaceFs {
  async readText(path: string, maxBytes = 1024 * 1024): Promise<JanusResult<{ content: string; size: number; mtime: number }>> {
    try {
      const info = await fs.stat(path)
      if (!info.isFile()) throw new Error('Path is not a regular file')
      if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`)
      const buffer = await fs.readFile(path)
      if (!isTextBuffer(buffer)) throw new Error('File is not UTF-8 text')
      return { ok: true, value: { content: buffer.toString('utf8'), size: info.size, mtime: info.mtimeMs } }
    } catch (error) { return failure(error) }
  }

  async readBinary(path: string, maxBytes = 16 * 1024 * 1024): Promise<JanusResult<{ buffer: Buffer; size: number; mtime: number }>> {
    try {
      const info = await fs.stat(path)
      if (!info.isFile()) throw new Error('Path is not a regular file')
      if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`)
      return { ok: true, value: { buffer: await fs.readFile(path), size: info.size, mtime: info.mtimeMs } }
    } catch (error) { return failure(error) }
  }

  async stat(path: string): Promise<JanusResult<{ size: number; mtime: number; isFile: boolean }>> {
    try {
      const info = await fs.stat(path)
      return { ok: true, value: { size: info.size, mtime: info.mtimeMs, isFile: info.isFile() } }
    } catch (error) { return failure(error) }
  }

  async writeText(path: string, content: string): Promise<JanusResult<void>> {
    try {
      await writeFileAtomic(path, content)
      return { ok: true, value: undefined }
    } catch (error) { return failure(error) }
  }

  async readWorkspaceText(
    workspaceRoot: string,
    requestedPath: string,
    maxBytes: number,
    authorize: WorkspaceReadAuthorizer,
  ): Promise<JanusResult<Buffer>> {
    try {
      const content = await readWorkspaceFile(workspaceRoot, requestedPath, maxBytes, authorize)
      if (!isTextBuffer(content)) throw new Error('Workspace file is not UTF-8 text')
      return { ok: true, value: content }
    } catch (error) { return failure(error) }
  }

  async readWorkspaceTextRange(
    workspaceRoot: string,
    requestedPath: string,
    offset: number,
    maxBytes: number,
    authorize: WorkspaceReadAuthorizer,
  ): Promise<JanusResult<WorkspaceFileRange>> {
    try {
      const read = await readWorkspaceFileRange(workspaceRoot, requestedPath, offset, maxBytes, authorize)
      let start = 0
      while (start < read.content.length && (read.content[start] & 0xc0) === 0x80) start += 1
      let end = read.content.length
      while (end > start && !isTextBuffer(read.content.subarray(start, end))) end -= 1
      if (end < read.content.length - 3 || (end === start && read.content.length > 0)) {
        throw new Error('Workspace file is not UTF-8 text')
      }
      const content = read.content.subarray(start, end)
      return {
        ok: true,
        value: {
          ...read,
          content,
          offset: read.offset + start,
          truncated: read.truncated || start > 0 || end < read.content.length,
        },
      }
    } catch (error) { return failure(error) }
  }

  async collectTextContext(root: string, signal: AbortSignal, options: WorkspaceContextOptions = {}): Promise<JanusResult<string>> {
    const result = await this.collectTextEvidence(root, '', signal, options)
    return result.ok ? { ok: true, value: result.value.context } : result
  }

  async collectTextEvidence(root: string, workspaceId: string, signal: AbortSignal, options: WorkspaceContextOptions = {}): Promise<JanusResult<WorkspaceEvidenceContext>> {
    try {
      const normalizedRoot = await fs.realpath(resolve(root))
      const maxFiles = options.maxFiles ?? 100
      const maxFileBytes = options.maxFileBytes ?? 24 * 1024
      const maxContextBytes = options.maxContextBytes ?? 240 * 1024
      const extensions = options.extensions ?? DEFAULT_EXTENSIONS
      const excludedDirectories = options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES
      const candidates: Array<{ relativePath: string }> = []
      const visit = async (directory: string): Promise<void> => {
        if (signal.aborted || candidates.length >= maxFiles) return
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (signal.aborted || candidates.length >= maxFiles) return
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
          const absolute = resolve(directory, entry.name)
          if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${sep}`)) continue
          const relativePath = relative(normalizedRoot, absolute).replaceAll('\\', '/')
          if (isSensitivePath(relativePath)) continue
          if (entry.isDirectory()) {
            if (!excludedDirectories.has(entry.name)) await visit(absolute)
            continue
          }
          if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue
          candidates.push({ relativePath })
        }
      }
      await visit(normalizedRoot)
      const ignored = await gitIgnoredPaths(normalizedRoot, candidates.map((item) => item.relativePath))
      const git = await gitEvidence(normalizedRoot, candidates.map((item) => item.relativePath))
      const chunks: string[] = []
      const files: BlueprintEvidenceManifest['files'] = []
      let bytes = 0
      for (const candidate of candidates) {
        if (signal.aborted || bytes >= maxContextBytes) break
        if (ignored.has(candidate.relativePath)) continue
        const buffer = await readWorkspaceFile(
          normalizedRoot,
          candidate.relativePath,
          maxFileBytes,
          () => ({ outcome: 'allow', reasonCode: 'MAINTENANCE_SCAN' }),
        ).catch(() => null)
        if (!buffer || !isTextBuffer(buffer)) continue
        const chunk = `\n--- ${candidate.relativePath} ---\n${buffer.toString('utf8')}`
        const chunkBytes = Buffer.byteLength(chunk)
        if (bytes + chunkBytes > maxContextBytes) break
        chunks.push(chunk)
        bytes += chunkBytes
        files.push({
          path: candidate.relativePath,
          sha256: createHash('sha256').update(buffer).digest('hex'),
          role: 'critical',
          sourceState: git.states.get(candidate.relativePath) ?? (git.gitHead ? 'committed' : 'untracked'),
          supportsOperationIds: [],
        })
      }
      const fingerprintInput = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
      const workspaceRootFingerprint = createHash('sha256').update(JSON.stringify([workspaceId, fingerprintInput])).digest('hex')
      return { ok: true, value: { context: chunks.join(''), manifest: { workspaceId, workspaceRootFingerprint, gitHead: git.gitHead, files } } }
    } catch (error) { return failure(error) }
  }
}

export const janusWorkspaceFs = new JanusWorkspaceFs()
