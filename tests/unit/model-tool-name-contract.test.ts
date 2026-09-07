/**
 * @file Model tool-name contract (shell side of the Phase2 split).
 * @description Mirrors janus-agentX packages/agent-core/tests/tools-contract.test.ts.
 * These providerNames are a cross-repo API consumed by chat prompts and the
 * blueprint BLUEPRINT_READ_ONLY_MODEL_TOOLS whitelist. Renames must ship in
 * both repos in the same release, otherwise blueprint tools silently vanish.
 */
import { describe, expect, it } from 'vitest'
import { createWorkspaceChatTools } from '../../src/main/llm/workspace-chat-tools'

const ALL_MODEL_TOOLS = [
  'workspace_list', 'workspace_search', 'workspace_read', 'workspace_edit', 'workspace_create',
  'project_detect', 'project_generate_config', 'project_apply_config',
  'project_list_processes', 'project_process_output',
  'project_start_process', 'project_stop_process',
  'git_status', 'git_log', 'git_diff', 'git_stage', 'git_unstage',
  'git_commit', 'git_pull', 'git_push',
  'command_run',
]

const BLUEPRINT_READ_ONLY_MODEL_TOOLS = [
  'workspace_list', 'workspace_search', 'workspace_read',
  'project_detect', 'project_list_processes', 'project_process_output',
  'git_status', 'git_log', 'git_diff',
]

describe('model tool-name contract (shell)', () => {
  it('exposes exactly the 21 documented model tools', () => {
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: async () => ({ status: 'completed' }) as never },
      resources: new Map(),
      callerId: 'contract-test',
    })
    expect(Object.keys(tools).sort()).toEqual([...ALL_MODEL_TOOLS].sort())
  })

  it('keeps every blueprint read-only tool available', () => {
    const tools = createWorkspaceChatTools({
      runtime: { executeFunctionCall: async () => ({ status: 'completed' }) as never },
      resources: new Map(),
      callerId: 'contract-test',
    })
    const names = new Set(Object.keys(tools))
    for (const name of BLUEPRINT_READ_ONLY_MODEL_TOOLS) {
      expect(names.has(name), `blueprint tool missing: ${name}`).toBe(true)
    }
  })
})
