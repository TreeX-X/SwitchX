import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  commit,
  getLog,
  getStatus,
  getWorkingDiff,
  pull,
  push,
  stage,
  unstage,
} from '../../../git/service'
import { isSensitivePath } from '../policy-gate'
import { resolveWorkspaceTarget } from '../path-guard'
import type { RegisteredTool, ToolRegistry } from '../registry'

const registeredRegistries = new WeakSet<ToolRegistry>()
const MAX_GIT_PATHS = 100
const MAX_STATUS_CHANGES = 500

function boundedStatus(status: Awaited<ReturnType<typeof getStatus>>) {
  return {
    ...status,
    changes: status.changes.slice(0, MAX_STATUS_CHANGES),
    truncated: status.changes.length > MAX_STATUS_CHANGES,
  }
}

function assertWorkspaceId(input: Record<string, unknown>, context: { workspaceId: string }, toolName: string): string {
  if (input.workspaceId !== context.workspaceId) {
    throw new Error(`${toolName} workspaceId must match the active workspace resource`)
  }
  return context.workspaceId
}

async function resolveRepository(
  input: Record<string, unknown>,
  context: { workspaceId: string; workspaceRoot: string },
  toolName: string,
) {
  const workspaceId = assertWorkspaceId(input, context, toolName)
  const requestedPath = input.path ?? ''
  if (typeof requestedPath !== 'string') throw new Error(`${toolName} path must be a string`)
  const target = await resolveWorkspaceTarget(context.workspaceRoot, requestedPath)
  if (target.kind !== 'directory') throw new Error(`${toolName} path must be a directory`)
  return {
    workspaceId,
    path: target.relativePath,
    repositoryPath: resolve(context.workspaceRoot, target.relativePath || '.'),
  }
}

function validateGitPaths(value: unknown, repositoryPath: string, toolName: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GIT_PATHS) {
    throw new Error(`${toolName} paths must contain between 1 and ${MAX_GIT_PATHS} entries`)
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0') || isAbsolute(item)) {
      throw new Error(`${toolName} contains an invalid path`)
    }
    const normalized = relative(repositoryPath, resolve(repositoryPath, item))
    if (!normalized || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error(`${toolName} path is outside the repository`)
    }
    if (isSensitivePath(normalized)) throw new Error(`${toolName} cannot access a sensitive path`)
    return normalized.replace(/\\/g, '/')
  })
}

export const gitStatusTool: RegisteredTool = {
  name: 'git.status',
  description: 'Read branch and working tree status for a Git repository inside the active workspace',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: { workspaceId: { type: 'string' }, path: { type: 'string' } },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.status')
    return { workspaceId: target.workspaceId, path: target.path, status: boundedStatus(await getStatus(target.repositoryPath)) }
  },
}

export const gitLogTool: RegisteredTool = {
  name: 'git.log',
  description: 'Read recent commits for a Git repository inside the active workspace',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      maxCount: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.log')
    const maxCount = input.maxCount ?? 20
    if (!Number.isSafeInteger(maxCount) || Number(maxCount) < 1 || Number(maxCount) > 100) {
      throw new Error('git.log maxCount must be an integer between 1 and 100')
    }
    return { workspaceId: target.workspaceId, path: target.path, commits: await getLog(target.repositoryPath, Number(maxCount)) }
  },
}

export const gitDiffTool: RegisteredTool = {
  name: 'git.diff',
  description: 'Read a bounded working tree or staged Git diff inside the active workspace',
  actionRisk: 'inspect',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      file: { type: 'string' },
      staged: { type: 'boolean' },
      maxBytes: { type: 'number' },
    },
    required: ['workspaceId'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.diff')
    const maxBytes = input.maxBytes ?? 128 * 1024
    if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1 || Number(maxBytes) > 256 * 1024) {
      throw new Error('git.diff maxBytes must be an integer between 1 and 262144')
    }
    const file = input.file === undefined ? undefined : validateGitPaths([input.file], target.repositoryPath, 'git.diff')[0]
    const diff = await getWorkingDiff(target.repositoryPath, {
      staged: input.staged === true,
      path: file,
      maxBytes: Number(maxBytes),
      signal: context.signal,
    })
    return { workspaceId: target.workspaceId, path: target.path, file, staged: input.staged === true, ...diff }
  },
}

function gitPathsTool(
  name: 'git.stage' | 'git.unstage',
  operation: (cwd: string, paths: string[]) => Promise<void>,
): RegisteredTool {
  return {
    name,
    description: `${name === 'git.stage' ? 'Stage' : 'Unstage'} selected paths in a Git repository inside the active workspace`,
    actionRisk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        path: { type: 'string' },
        paths: { type: 'array' },
      },
      required: ['workspaceId', 'paths'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const target = await resolveRepository(input, context, name)
      const paths = validateGitPaths(input.paths, target.repositoryPath, name)
      await operation(target.repositoryPath, paths)
      return { workspaceId: target.workspaceId, path: target.path, paths, status: boundedStatus(await getStatus(target.repositoryPath)) }
    },
  }
}

export const gitStageTool = gitPathsTool('git.stage', stage)
export const gitUnstageTool = gitPathsTool('git.unstage', unstage)

export const gitCommitTool: RegisteredTool = {
  name: 'git.commit',
  description: 'Commit the staged changes in a Git repository inside the active workspace',
  actionRisk: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string' },
      path: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['workspaceId', 'message'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    const target = await resolveRepository(input, context, 'git.commit')
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 500) {
      throw new Error('git.commit message must contain between 1 and 500 characters')
    }
    await commit(target.repositoryPath, input.message.trim())
    return { workspaceId: target.workspaceId, path: target.path, status: boundedStatus(await getStatus(target.repositoryPath)) }
  },
}

function gitRemoteTool(name: 'git.pull' | 'git.push', operation: (cwd: string, signal?: AbortSignal) => Promise<void>): RegisteredTool {
  return {
    name,
    description: `${name === 'git.pull' ? 'Pull from' : 'Push to'} the configured remote for a Git repository inside the active workspace`,
    actionRisk: 'network',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' }, path: { type: 'string' } },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    execute: async (input, context) => {
      const target = await resolveRepository(input, context, name)
      await operation(target.repositoryPath, context.signal)
      return { workspaceId: target.workspaceId, path: target.path, status: boundedStatus(await getStatus(target.repositoryPath)) }
    },
  }
}

export const gitPullTool = gitRemoteTool('git.pull', pull)
export const gitPushTool = gitRemoteTool('git.push', push)

export function registerGitTools(registry: ToolRegistry): void {
  if (registeredRegistries.has(registry)) return
  registry.register(gitStatusTool)
  registry.register(gitLogTool)
  registry.register(gitDiffTool)
  registry.register(gitStageTool)
  registry.register(gitUnstageTool)
  registry.register(gitCommitTool)
  registry.register(gitPullTool)
  registry.register(gitPushTool)
  registeredRegistries.add(registry)
}
