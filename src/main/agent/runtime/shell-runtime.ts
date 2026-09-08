/**
 * @file JanusX shell-owned agent assembly (stays in the shell permanently).
 * @description All agent logic lives in `@janus-agent/agent-core`; this module
 * only assembles shell policy: the shared runtime singleton on the file-backed
 * policy audit store (same location as before:
 * `<userData>/janusx/knowledge/audit/workspace-policy.jsonl`) and the
 * renderer-action authorizer on the same store. The workspace resolver is
 * injected by `registerAgentRuntimeHandlers`, as before.
 */
import {
  createAgentRuntime,
  createRendererActionAuthorizer,
  FilePolicyAuditStore,
} from '@janus-agent/agent-core'
import type { RendererActionAuthorizer } from '@janus-agent/agent-core'

export type { RendererActionAuthorizer }

const auditStore = new FilePolicyAuditStore()

/** Shell runtime singleton (resolver injected by registerAgentRuntimeHandlers). */
export const workspaceAgentRuntime = createAgentRuntime({ auditStore })

/** Default renderer-action authorizer (persistent audit, same as before). */
export const authorizeRendererAction: RendererActionAuthorizer = createRendererActionAuthorizer(auditStore)
