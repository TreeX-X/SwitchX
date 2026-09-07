import { delimiter } from 'path'
import type { AgentEngine } from '../janus-runner/types'
import { OFFICE_PROJECT_POLICY } from './office-project-rules'

export interface OfficeAgentSession {
  env: Record<string, string>
  mode: 'managed' | 'policy-only'
  limitation?: string
}

export function buildOfficeAgentSession(
  engine: AgentEngine | 'shell',
  workspaceRoot: string,
  binaryPath: string | undefined,
  mcpEntry: string,
  currentPath = process.env.PATH ?? '',
  adapterConfigured = false,
): OfficeAgentSession {
  const binaryDir = binaryPath ? binaryPath.replace(/[\\/][^\\/]+$/, '') : undefined
  const env: Record<string, string> = {
    JANUSX_OFFICE_WORKSPACE: workspaceRoot,
    JANUSX_OFFICE_MCP_ENTRY: mcpEntry,
  }
  if (engine !== 'shell') env.JANUSX_OFFICE_POLICY = OFFICE_PROJECT_POLICY
  if (binaryPath && binaryDir) {
    env.JANUSX_OFFICECLI_BINARY = binaryPath
    env.PATH = currentPath ? `${binaryDir}${delimiter}${currentPath}` : binaryDir
  }
  if (engine === 'shell' || (engine === 'codex' && adapterConfigured)) return { env, mode: 'managed' }
  return {
    env,
    mode: 'policy-only',
    limitation: engine === 'codex'
      ? 'Codex Office project configuration has not been explicitly applied.'
      : `${engine} has no verified durable Office MCP project-config adapter in this build.`,
  }
}

export function mergeOfficeAgentEnv(
  existing: Record<string, string> | undefined,
  session: OfficeAgentSession,
): Record<string, string> {
  const merged = { ...(existing ?? {}), ...session.env }
  if (process.platform === 'win32') {
    const current = (existing?.WSLENV ?? process.env.WSLENV ?? '').split(':').filter(Boolean)
    for (const key of ['JANUSX_OFFICE_WORKSPACE/p', 'JANUSX_OFFICE_MCP_ENTRY/p', 'JANUSX_OFFICECLI_BINARY/p', 'JANUSX_OFFICE_POLICY']) {
      if (session.env[key.replace('/p', '')] && !current.includes(key)) current.push(key)
    }
    merged.WSLENV = current.join(':')
  }
  return merged
}
