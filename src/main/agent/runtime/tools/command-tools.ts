import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { requiresCommandShell } from '../../../project/runner/runner'
import { getProjectRunner } from '../../../project/runner/service'
import { resolveWorkspaceTarget } from '@janus-agent/agent-core'
import type { RegisteredTool, ToolRegistry } from '@janus-agent/agent-core'

const registeredRegistries = new WeakSet<ToolRegistry>()
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_ARGUMENTS = 100
/** P4: sync stdout/stderr are tail previews only; the full log goes to logPath. */
const PREVIEW_BYTES = 8 * 1024
/** P4: bound the persisted log file so a spammy process cannot grow it without bound. */
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
const LOG_DIR = '.janusX/logs'
const WINDOWS_SHELL_META = /[&|<>^\r\n]/

/**
 * R4：command.run 按调用透传 env 的 allowlist（运维型非凭证键，大小写不敏感匹配）。
 * PATH/LD_PRELOAD/NODE_OPTIONS 等可劫持解析或注入代码的键一律不在名单内；
 * 名单外键直接拒绝（fail-closed），名单内值仍走 4096 字符/NUL 界。
 */
export const SAFE_COMMAND_ENV_KEYS = new Set([
  'NODE_ENV',
  'CI',
  'TERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'LANG',
  'LC_ALL',
  'LC_MESSAGES',
  'LANGUAGE',
  'TZ',
])
const MAX_COMMAND_ENV_ENTRIES = 32
const MAX_COMMAND_ENV_VALUE_CHARS = 4096
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function filterCommandEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('command.run env must be an object mapping names to strings')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_COMMAND_ENV_ENTRIES) {
    throw new Error(`command.run env must contain at most ${MAX_COMMAND_ENV_ENTRIES} entries`)
  }
  const env: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!ENV_NAME_PATTERN.test(key) || !SAFE_COMMAND_ENV_KEYS.has(key.toUpperCase())) {
      throw new Error(`command.run env key is not allowlisted: ${key}`)
    }
    if (typeof item !== 'string' || item.length > MAX_COMMAND_ENV_VALUE_CHARS || item.includes('\0')) {
      throw new Error(`command.run env value for ${key} must be a bounded string`)
    }
    env[key] = item
  }
  return env
}

export type CommandExecutionMode = 'direct' | 'windows-shell-shim'

/** Windows package-manager shims and .cmd/.bat files need cmd.exe compatibility. */
export function commandExecutionMode(program: string, platform: NodeJS.Platform = process.platform): CommandExecutionMode {
  return requiresCommandShell(program, platform) ? 'windows-shell-shim' : 'direct'
}

interface StreamCapture {
  /** Every byte seen, including bytes dropped from preview/file buffers. */
  totalBytes: number
  /** Tail ring (<= PREVIEW_BYTES) for the inline preview. */
  preview: Buffer[]
  previewBytes: number
  /** Head (<= MAX_LOG_FILE_BYTES) for the persisted log file. */
  file: Buffer[]
  fileBytes: number
  fileCapped: boolean
}

function createCapture(): StreamCapture {
  return { totalBytes: 0, preview: [], previewBytes: 0, file: [], fileBytes: 0, fileCapped: false }
}

/** P4: keep an 8KB tail preview in memory while counting every byte. */
function captureChunk(capture: StreamCapture, chunk: Buffer): void {
  capture.totalBytes += chunk.length
  capture.preview.push(chunk)
  capture.previewBytes += chunk.length
  while (capture.previewBytes > PREVIEW_BYTES && capture.preview.length > 0) {
    const excess = capture.previewBytes - PREVIEW_BYTES
    const first = capture.preview[0]
    if (first.length <= excess) {
      capture.preview.shift()
      capture.previewBytes -= first.length
    } else {
      capture.preview[0] = first.subarray(excess)
      capture.previewBytes -= excess
    }
  }
  if (!capture.fileCapped) {
    const room = MAX_LOG_FILE_BYTES - capture.fileBytes
    if (room <= 0) {
      capture.fileCapped = true
    } else if (chunk.length <= room) {
      capture.file.push(chunk)
      capture.fileBytes += chunk.length
    } else {
      capture.file.push(chunk.subarray(0, room))
      capture.fileBytes += room
      capture.fileCapped = true
    }
  }
}

function executeCommand(
    program: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
    env: Record<string, string>,
  ): Promise<{
  exitCode: number | null
  /** Tail preview (<= 8KB), not the full stream: read logPath for earlier lines. */
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutFull: Buffer
  stderrFull: Buffer
  logTruncated: boolean
  timedOut: boolean
  outputTruncated: boolean
  executionMode: CommandExecutionMode
}> {
  return new Promise((resolve, reject) => {
    const executionMode = commandExecutionMode(program)
    const useShell = executionMode === 'windows-shell-shim'
    if (useShell && args.some((arg) => WINDOWS_SHELL_META.test(arg))) {
      reject(new Error('command.run shell-backed arguments contain unsupported metacharacters'))
      return
    }

    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = createCapture()
    const stderr = createCapture()
    let timedOut = false
    let aborted = false
    let settled = false

    child.stdout.on('data', (chunk: Buffer) => captureChunk(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => captureChunk(stderr, chunk))
    const stop = () => child.kill()
    const abort = () => { aborted = true; stop() }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (aborted) {
        reject(new Error('command.run cancelled'))
        return
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout.preview).toString('utf-8'),
        stderr: Buffer.concat(stderr.preview).toString('utf-8'),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutFull: Buffer.concat(stdout.file),
        stderrFull: Buffer.concat(stderr.file),
        logTruncated: stdout.fileCapped || stderr.fileCapped,
        timedOut,
        outputTruncated: stdout.totalBytes > stdout.previewBytes || stderr.totalBytes > stderr.previewBytes,
        executionMode,
      })
    })
  })
}

export const commandRunTool: RegisteredTool = {
  name: 'command.run',
  description: 'Run one approved program with structured arguments in a directory inside the active workspace (sync default timeout 120s, max 600s; background jobs have no deadline unless timeoutMs is passed, max 600s, and report timedOut via project.process-output; pass background:true for long builds and poll with project.process-output; optional env allowlist NODE_ENV/CI/TERM/FORCE_COLOR/NO_COLOR/CLICOLOR/LANG/LC_*/LANGUAGE/TZ, max 32 entries; sync stdout/stderr are 8KB tail previews, page the full log at logPath with workspace.read)',
  actionRisk: 'external-command',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      cwd: { type: 'string' },
      program: { type: 'string' },
      args: { type: 'array' },
      timeoutMs: { type: 'number' },
      background: { type: 'boolean' },
      env: { type: 'object' },
    },
    required: ['workspaceId', 'program'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    if (input.workspaceId !== context.workspaceId) {
      throw new Error('command.run workspaceId must match the active workspace resource')
    }
    const requestedCwd = input.cwd ?? ''
    if (typeof requestedCwd !== 'string') throw new Error('command.run cwd must be a string')
    const cwdTarget = await resolveWorkspaceTarget(context.workspaceRoot, requestedCwd)
    if (cwdTarget.kind !== 'directory') throw new Error('command.run cwd must be a directory')

    if (typeof input.program !== 'string' || !input.program.trim() || input.program.includes('\0') || isAbsolute(input.program)) {
      throw new Error('command.run program must be a command name or workspace-relative executable path')
    }
    const args = input.args ?? []
    if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
      throw new Error(`command.run args must contain at most ${MAX_ARGUMENTS} bounded strings`)
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1_000 || Number(timeoutMs) > MAX_TIMEOUT_MS) {
      throw new Error(`command.run timeoutMs must be an integer between 1000 and ${MAX_TIMEOUT_MS}`)
    }
    const background = input.background ?? false
    if (typeof background !== 'boolean') throw new Error('command.run background must be a boolean')
    // R4：env 在工具边界一次性 allowlist 校验；P5 安全编译 verdict 不受其影响
    //（名单内均为无提权能力的运维键，PATH/LD_PRELOAD/NODE_OPTIONS 永不放行）。
    const env = filterCommandEnv(input.env)

    let program = input.program.trim()
    if (/[\\/]/.test(program)) {
      const programTarget = await resolveWorkspaceTarget(context.workspaceRoot, join(cwdTarget.relativePath, program))
      if (programTarget.kind !== 'file') throw new Error('command.run program path must be a regular workspace file')
      program = join(context.workspaceRoot, programTarget.relativePath)
    }
    const cwd = join(context.workspaceRoot, cwdTarget.relativePath)
    if (background) {
      // R3：后台超时显式 opt-in（缺席即无截止，保持 P3 历史行为）；同步路径的默认值不透传，避免 120s 后误杀常驻任务。
      const backgroundTimeoutMs = input.timeoutMs === undefined ? undefined : Number(timeoutMs)
      const { projectId, handle, logPath: absLogPath } = await getProjectRunner().runAdhoc({
        cwd,
        program,
        args: args as string[],
        label: `${String(input.program)} ${(args as string[]).join(' ')}`.trim().slice(0, 120),
        ...(backgroundTimeoutMs === undefined ? {} : { timeoutMs: backgroundTimeoutMs }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      })
      // P4尾巴：logPath 转工作区相对路径，模型可用 workspace.read 翻页；转义失败则省略。
      let logPath: string | undefined
      if (absLogPath) {
        const relation = relative(resolve(context.workspaceRoot), resolve(absLogPath))
        if (relation && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) {
          logPath = relation.split(sep).join('/')
        }
      }
      return {
        workspaceId: context.workspaceId,
        cwd: cwdTarget.relativePath,
        program: input.program,
        args,
        background: true,
        projectId,
        pid: handle.pid,
        name: handle.config.name,
        ...(backgroundTimeoutMs === undefined ? {} : { timeoutMs: backgroundTimeoutMs }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
        ...(logPath ? { logPath } : {}),
      }
    }
    const startedAt = Date.now()
    const result = await executeCommand(program, args as string[], cwd, Number(timeoutMs), context.signal, env)
    const wallTimeMs = Date.now() - startedAt
    const totalBytes = result.stdoutBytes + result.stderrBytes
    // P4: persist the full log inside the workspace so the model can page it
    // with workspace.read. A log write failure must not fail the command: the
    // tail preview is still returned and logPath is left undefined.
    let logPath: string | undefined
    try {
      await mkdir(join(context.workspaceRoot, LOG_DIR), { recursive: true })
      const name = `cmd-${Date.now()}-${randomUUID().slice(0, 8)}.log`
      const header = [
        `# command.run ${String(input.program)} ${(args as string[]).join(' ')}`.trimEnd(),
        `# cwd: ${cwdTarget.relativePath || '.'}`,
        `# exitCode: ${String(result.exitCode)} timedOut: ${String(result.timedOut)} wallTimeMs: ${wallTimeMs}`,
        `--- stdout (${result.stdoutBytes} bytes) ---`,
      ].join('\n')
      const middle = `\n--- stderr (${result.stderrBytes} bytes) ---\n`
      await writeFile(
        join(context.workspaceRoot, LOG_DIR, name),
        Buffer.concat([Buffer.from(`${header}\n`, 'utf-8'), result.stdoutFull, Buffer.from(middle, 'utf-8'), result.stderrFull]),
      )
      logPath = `${LOG_DIR}/${name}`
    } catch {
      logPath = undefined
    }
    return {
      workspaceId: context.workspaceId,
      cwd: cwdTarget.relativePath,
      program: input.program,
      args,
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      executionMode: result.executionMode,
      totalBytes,
      wallTimeMs,
      logTruncated: result.logTruncated,
      ...(Object.keys(env).length === 0 ? {} : { env }),
      ...(logPath ? { logPath } : {}),
    }
  },
}

export function registerCommandTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  registry.register(commandRunTool)
  registeredRegistries.add(registry)
}
