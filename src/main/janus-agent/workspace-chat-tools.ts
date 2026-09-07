import { z } from 'zod'
import type { ExecuteToolInput, ToolResult } from '../../shared/ipc/agent-runtime'
import type { ToolManifest } from './runtime/tool-manifest'
import { redactPolicyValue } from './runtime/policy-gate'
import { toolResultToModelValue } from './runtime/tool-result'

interface WorkspaceChatRuntime {
  executeFunctionCall(input: ExecuteToolInput, callerId?: string): Promise<ToolResult>
}

interface WorkspaceChatToolOptions {
  runtime: WorkspaceChatRuntime
  resources: Map<string, { sessionId: string; workspaceRoot: string; workspaceName: string }>
  callerId: string
  toolManifests?: ToolManifest[]
  onToolResult?: (result: ToolResult) => void
}

function withManifestDescriptions<T extends Record<string, { description: string }>>(tools: T, manifests: ToolManifest[] | undefined): T {
  if (!manifests?.length) return tools
  const descriptions = new Map(manifests.map((manifest) => [manifest.providerName, manifest.description]))
  return Object.fromEntries(Object.entries(tools).map(([providerName, tool]) => [
    providerName,
    descriptions.has(providerName) ? { ...tool, description: descriptions.get(providerName)! } : tool,
  ])) as T
}

/**
 * Convert a runtime result into a payload the model can keep reasoning about.
 * A user denial or a policy rejection is a normal, expected outcome — throwing
 * here would abort the whole streamText call and cut the reply off mid-stream,
 * so every non-completed status becomes structured data instead of an error.
 */
export function createWorkspaceChatTools(options: WorkspaceChatToolOptions) {
  const execute = async (toolName: string, input: Record<string, unknown>) => {
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
    const resource = options.resources.get(workspaceId)
    if (!resource) {
      return { ok: false, status: 'failed', error: `Workspace "${workspaceId}" is not attached to this Chat` }
    }
    const preview = createToolPreview(toolName, input)
    const result = await options.runtime.executeFunctionCall({
      sessionId: resource.sessionId,
      call: {
        toolName,
        input: { ...input, workspaceId },
        evidenceConfidence: 'medium',
        ...(preview ? { preview } : {}),
      },
    }, options.callerId)
    options.onToolResult?.(result)
    return toolResultToModelValue(result)
  }

  const workspaceId = z.string().min(1).describe('The exact workspaceId from the attached workspace list.')

  const tools = {
    workspace_list: {
      description: 'List a bounded file tree in one attached workspace. Use this before reading when the exact path is unknown.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        depth: z.number().int().min(0).max(4).default(3),
        maxEntries: z.number().int().min(1).max(600).default(300),
      }),
      execute: (input: { workspaceId: string; path: string; depth: number; maxEntries: number }) => execute('workspace.list', input),
    },
    workspace_search: {
      description: 'Search workspace text files for a literal substring (case-insensitive) and get matching lines with paths and line numbers. Prefer this over walking the tree when looking for code, symbols, or text.',
      parameters: z.object({
        workspaceId,
        query: z.string().min(1).max(256),
        path: z.string().default(''),
        maxResults: z.number().int().min(1).max(50).default(30),
      }),
      execute: (input: { workspaceId: string; query: string; path: string; maxResults: number }) => execute('workspace.search', input),
    },
    workspace_read: {
      description: 'Read one UTF-8 text file and its SHA-256 hash from one attached workspace. Read immediately before editing.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        maxBytes: z.number().int().min(1).max(256 * 1024).default(128 * 1024),
      }),
      execute: (input: { workspaceId: string; path: string; offset: number; maxBytes: number }) => execute('workspace.read', input),
    },
    workspace_edit: {
      description: 'Edit one existing UTF-8 file with either exact, unambiguous replacements or a single-file unified diff. Requires the SHA-256 returned by workspace_read; the configured Agent permission mode controls approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/i),
        replacements: z.array(z.object({
          oldText: z.string().min(1),
          newText: z.string(),
        })).min(1).max(40).optional(),
        unifiedDiff: z.string().min(1).max(1024 * 1024).optional(),
      }).superRefine((value, context) => {
        if ((value.replacements === undefined) === (value.unifiedDiff === undefined)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of replacements or unifiedDiff' })
        }
      }),
      execute: (input: {
        workspaceId: string
        path: string
        expectedHash: string
        replacements?: Array<{ oldText: string; newText: string }>
        unifiedDiff?: string
      }) => execute('workspace.edit', input),
    },
    workspace_create: {
      description: 'Create one new UTF-8 text file in an attached workspace. The parent directory must exist and the file must not. The configured Agent permission mode controls approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().min(1).describe('Workspace-relative path of the new file, e.g. src/notes/test.md'),
        content: z.string().max(1024 * 1024),
      }),
      execute: (input: { workspaceId: string; path: string; content: string }) => execute('workspace.create', input),
    },
    project_detect: {
      description: 'Detect project types, scripts and candidate project directories in the attached workspace.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        depth: z.number().int().min(0).max(3).default(3),
        maxDirectories: z.number().int().min(1).max(100).default(80),
      }),
      execute: (input: { workspaceId: string; path: string; depth: number; maxDirectories: number }) => execute('project.detect', input),
    },
    project_generate_config: {
      description: 'Generate and validate a JanusX launch configuration proposal without writing it. Explicit user launch intent may override detected project type; use launch for an external script or custom executable.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        projectType: z.string().optional(),
        launch: z.object({
          name: z.string().min(1).optional(),
          program: z.string().min(1),
          args: z.array(z.string()).optional(),
          cwd: z.string().optional(),
          env: z.record(z.string()).optional(),
        }).optional(),
      }),
      execute: (input: {
        workspaceId: string
        path: string
        projectType?: string
        launch?: { name?: string; program: string; args?: string[]; cwd?: string; env?: Record<string, string> }
      }) => execute('project.generate-config', input),
    },
    project_apply_config: {
      description: 'Write a validated JanusX launch configuration to the workspace after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        config: z.record(z.unknown()),
      }),
      execute: (input: { workspaceId: string; path: string; config: Record<string, unknown> }) => execute('project.apply-config', input),
    },
    project_list_processes: {
      description: 'List project processes started and tracked by JanusX in one attached workspace.',
      parameters: z.object({ workspaceId }),
      execute: (input: { workspaceId: string }) => execute('project.list-processes', input),
    },
    project_process_output: {
      description: 'Read recent bounded output from one JanusX-managed project process (supports offsetLines pagination for background command.run jobs).',
      parameters: z.object({
        workspaceId,
        projectId: z.string().min(1),
        maxLines: z.number().int().min(1).max(1000).default(100),
        offsetLines: z.number().int().min(0).max(1000).default(0),
      }),
      execute: (input: { workspaceId: string; projectId: string; maxLines: number; offsetLines: number }) => execute('project.process-output', input),
    },
    project_start_process: {
      description: 'Start a saved JanusX launch configuration after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        configName: z.string().min(1).default('dev'),
      }),
      execute: (input: { workspaceId: string; path: string; configName: string }) => execute('project.start-process', input),
    },
    project_stop_process: {
      description: 'Stop one JanusX-managed project process after user approval. Obtain projectId from project_list_processes.',
      parameters: z.object({
        workspaceId,
        projectId: z.string().min(1),
      }),
      execute: (input: { workspaceId: string; projectId: string }) => execute('project.stop-process', input),
    },
    git_status: {
      description: 'Read the branch and working tree status for a Git repository in an attached workspace.',
      parameters: z.object({ workspaceId, path: z.string().default('') }),
      execute: (input: { workspaceId: string; path: string }) => execute('git.status', input),
    },
    git_log: {
      description: 'Read recent commits for a Git repository in an attached workspace.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        maxCount: z.number().int().min(1).max(100).default(20),
      }),
      execute: (input: { workspaceId: string; path: string; maxCount: number }) => execute('git.log', input),
    },
    git_diff: {
      description: 'Read a bounded unstaged or staged Git diff, optionally limited to one repository-relative file.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        file: z.string().min(1).optional(),
        staged: z.boolean().default(false),
        maxBytes: z.number().int().min(1).max(256 * 1024).default(128 * 1024),
      }),
      execute: (input: { workspaceId: string; path: string; file?: string; staged: boolean; maxBytes: number }) => execute('git.diff', input),
    },
    git_stage: {
      description: 'Stage selected repository-relative paths after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        paths: z.array(z.string().min(1)).min(1).max(100),
      }),
      execute: (input: { workspaceId: string; path: string; paths: string[] }) => execute('git.stage', input),
    },
    git_unstage: {
      description: 'Unstage selected repository-relative paths after user approval.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        paths: z.array(z.string().min(1)).min(1).max(100),
      }),
      execute: (input: { workspaceId: string; path: string; paths: string[] }) => execute('git.unstage', input),
    },
    git_commit: {
      description: 'Commit staged changes with the exact message supplied or approved by the user.',
      parameters: z.object({
        workspaceId,
        path: z.string().default(''),
        message: z.string().min(1).max(500),
      }),
      execute: (input: { workspaceId: string; path: string; message: string }) => execute('git.commit', input),
    },
    git_pull: {
      description: 'Pull from the configured Git remote after user approval.',
      parameters: z.object({ workspaceId, path: z.string().default('') }),
      execute: (input: { workspaceId: string; path: string }) => execute('git.pull', input),
    },
    git_push: {
      description: 'Push to the configured Git remote after user approval.',
      parameters: z.object({ workspaceId, path: z.string().default('') }),
      execute: (input: { workspaceId: string; path: string }) => execute('git.push', input),
    },
    command_run: {
      description: 'Run one program, package script, or workspace script with structured arguments in an attached workspace. Requires user approval and returns bounded stdout, stderr, exit code, timeout and truncation state. Sync default timeout 120s, max 600s; background jobs have no deadline unless timeoutMs is passed (max 600s) and report timedOut via project_process_output; pass background:true for long builds and poll with project_process_output(offsetLines). Optional env allowlist (NODE_ENV/CI/TERM/FORCE_COLOR/NO_COLOR/CLICOLOR/LANG/LC_*/LANGUAGE/TZ, max 32 entries; PATH/LD_PRELOAD and friends are rejected). Sync stdout/stderr are 8KB tail previews; page the full log at logPath with workspace_read.',
      parameters: z.object({
        workspaceId,
        cwd: z.string().default(''),
        program: z.string().min(1),
        args: z.array(z.string()).max(100).default([]),
        timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
        background: z.boolean().default(false),
        env: z.record(z.string()).default({}),
      }),
      execute: (input: { workspaceId: string; cwd: string; program: string; args: string[]; timeoutMs: number; background: boolean; env: Record<string, string> }) => execute('command.run', input),
    },
  }
  return withManifestDescriptions(tools, options.toolManifests)
}

function createEditPreview(path: string, value: unknown) {
  const replacements = Array.isArray(value) ? value : []
  const parts = replacements.map((replacement, index) => {
    const item = replacement && typeof replacement === 'object'
      ? replacement as { oldText?: unknown; newText?: unknown }
      : {}
    return [
      `Replacement ${index + 1}`,
      `- ${typeof item.oldText === 'string' ? item.oldText : ''}`,
      `+ ${typeof item.newText === 'string' ? item.newText : ''}`,
    ].join('\n')
  })
  const fullDetail = parts.join('\n\n')
  return {
    summary: `Edit ${path} with ${replacements.length} exact replacement${replacements.length === 1 ? '' : 's'}`,
    paths: [path],
    detail: fullDetail.slice(0, 4_000),
    truncated: fullDetail.length > 4_000,
  }
}

function createUnifiedDiffPreview(path: string, value: unknown) {
  const diff = typeof value === 'string' ? value : ''
  return {
    summary: `Edit ${path} with a unified diff`,
    paths: [path],
    detail: diff.slice(0, 4_000),
    truncated: diff.length > 4_000,
  }
}

function createCreatePreview(path: string, content: string) {
  return {
    summary: `Create ${path} (${Buffer.byteLength(content, 'utf-8')} bytes)`,
    paths: [path],
    detail: content.slice(0, 4_000),
    truncated: content.length > 4_000,
  }
}

function createConfigPreview(path: string, value: unknown) {
  const detail = JSON.stringify(redactPolicyValue(value), null, 2)
  return {
    summary: 'Apply JanusX launch configuration' + (path ? ' in ' + path : ''),
    paths: [path ? path + '/.janusX/janusX.launch.json' : '.janusX/janusX.launch.json'],
    detail: detail.slice(0, 4_000),
    truncated: detail.length > 4_000,
  }
}

function createProcessPreview(action: 'Start' | 'Stop', target: string, configName: string) {
  return {
    summary: action + ' JanusX-managed project process',
    paths: [target],
    detail: configName ? 'Configuration: ' + configName : undefined,
    truncated: false,
  }
}

function createGitPreview(action: string, path: string, detail?: string) {
  const fullDetail = detail ?? ''
  return {
    summary: `${action} in Git repository${path ? ` ${path}` : ''}`,
    paths: [path],
    detail: detail === undefined ? undefined : fullDetail.slice(0, 4_000),
    truncated: fullDetail.length > 4_000,
  }
}

function createGitPathsPreview(action: string, repositoryPath: string, value: unknown) {
  const paths = Array.isArray(value) ? value.map(String) : []
  const detail = JSON.stringify(paths)
  return {
    summary: `${action} in Git repository${repositoryPath ? ` ${repositoryPath}` : ''}`,
    paths: paths.slice(0, 20),
    detail: detail.slice(0, 4_000),
    truncated: paths.length > 20 || detail.length > 4_000,
  }
}

function createCommandPreview(input: Record<string, unknown>) {
  const program = String(input.program ?? '')
  const args = Array.isArray(input.args) ? input.args.map(String) : []
  const cwd = String(input.cwd ?? '')
  // R4：env 进审批预览（经 redactPolicyValue，凭证形值显示脱敏），审批人可见覆盖了哪些变量。
  const detail = JSON.stringify(redactPolicyValue({ program, args, cwd, timeoutMs: input.timeoutMs, background: input.background ?? false, env: input.env ?? {} }), null, 2)
  return {
    summary: `Run ${program || 'workspace command'}${input.background === true ? ' in background' : ''}`,
    paths: [cwd],
    detail: detail.slice(0, 4_000),
    truncated: detail.length > 4_000,
  }
}

export function createToolPreview(toolName: string, input: Record<string, unknown>) {
  const path = String(input.path ?? '')
  switch (toolName) {
    case 'workspace.edit': return input.unifiedDiff === undefined
      ? createEditPreview(path, input.replacements)
      : createUnifiedDiffPreview(path, input.unifiedDiff)
    case 'workspace.create': return createCreatePreview(path, String(input.content ?? ''))
    case 'project.apply-config': return createConfigPreview(path, input.config)
    case 'project.start-process': return createProcessPreview('Start', path, String(input.configName ?? 'dev'))
    case 'project.stop-process': return createProcessPreview('Stop', String(input.projectId ?? ''), '')
    case 'git.stage': return createGitPathsPreview('Stage selected paths', path, input.paths)
    case 'git.unstage': return createGitPathsPreview('Unstage selected paths', path, input.paths)
    case 'git.commit': return createGitPreview('Commit staged changes', path, String(input.message ?? ''))
    case 'git.pull': return createGitPreview('Pull remote changes', path)
    case 'git.push': return createGitPreview('Push local commits', path)
    case 'command.run': return createCommandPreview(input)
    default: return undefined
  }
}
