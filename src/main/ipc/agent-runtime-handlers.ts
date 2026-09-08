import type { BrowserWindow, IpcMain } from 'electron'
import { AGENT_RUNTIME_CHANNELS, type ApprovalResult, type CreateAgentSessionInput, type ExecuteToolInput, type AgentApprovalMode } from '../../shared/ipc/agent-runtime'
import { configService } from '../config/service'
import { workspaceAgentRuntime } from '../agent/runtime/shell-runtime'
import { registerWorkspaceTools } from '@janus-agent/agent-core'
import { registerProjectTools } from '../agent/runtime/tools/project-tools'
import { registerGitTools } from '../agent/runtime/tools/git-tools'
import { registerCommandTools } from '../agent/runtime/tools/command-tools'
import type { ResolveWorkspaceRoot } from '../office/office-workspace-guard'

let registered = false
let getMainWindow: () => BrowserWindow | null = () => null

export function registerAgentRuntimeHandlers(windowGetter: () => BrowserWindow | null, ipcMain: IpcMain, resolveWorkspaceRoot?: ResolveWorkspaceRoot): void {
  getMainWindow = windowGetter
  // Office guard resolves `undefined` for unknown workspaces; the core port
  // uses `null` for the same case (fail-closed on both sides).
  if (resolveWorkspaceRoot) workspaceAgentRuntime.setWorkspaceResolver((id) => resolveWorkspaceRoot(id).then((root) => root ?? null))
  if (registered) return
  registerWorkspaceTools(workspaceAgentRuntime.registry)
  registerProjectTools(workspaceAgentRuntime.registry)
  registerGitTools(workspaceAgentRuntime.registry)
  registerCommandTools(workspaceAgentRuntime.registry)
  registered = true
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.createSession, async (event, input: CreateAgentSessionInput) => workspaceAgentRuntime.createSession({ ...input, approvalMode: input.approvalMode ?? await configService.getAgentApprovalMode(), safeCompileAutoAllow: input.safeCompileAutoAllow ?? await configService.getSafeCompileAutoAllow() }, `renderer:${event.sender.id}`))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.executeTool, (event, input: ExecuteToolInput) => workspaceAgentRuntime.executeTool(input, `renderer:${event.sender.id}`))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.cancelSession, (_event, sessionId: string) => workspaceAgentRuntime.cancelSession(sessionId))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.resolveApproval, (event, input: ApprovalResult) => workspaceAgentRuntime.resolveApproval(input, `renderer:${event.sender.id}`))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.getSession, (_event, sessionId: string) => workspaceAgentRuntime.getSession(sessionId))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.setApprovalMode, (event, input: { sessionId: string; mode: AgentApprovalMode }) => workspaceAgentRuntime.setApprovalMode(input.sessionId, input.mode, `renderer:${event.sender.id}`))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.queryPolicyAudit, (_event, query) => workspaceAgentRuntime.queryPolicyAudit(query))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.executeFunctionCall, (event, input: ExecuteToolInput) => workspaceAgentRuntime.executeFunctionCall(input, `renderer:${event.sender.id}`))
  ipcMain.handle(AGENT_RUNTIME_CHANNELS.executePlannerStep, (event, input: ExecuteToolInput) => workspaceAgentRuntime.executePlannerStep(input, `renderer:${event.sender.id}`))
  workspaceAgentRuntime.onEvent((event) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(AGENT_RUNTIME_CHANNELS.event, event)
  })
}
