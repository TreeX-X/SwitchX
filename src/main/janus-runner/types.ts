import type { AgentEngine, AgentEvent } from '../../shared/ipc/janus-runner'
export type { AgentEngine, AgentEvent, AgentSpawnOptions } from '../../shared/ipc/janus-runner'

export interface StreamParser {
  parseLine(json: Record<string, unknown>): AgentEvent[]
  reset(): void
}

export interface StreamSession {
  id: string
  engine: AgentEngine
  process: import('child_process').ChildProcess
  parser: StreamParser
  abortController: AbortController
  timeout: ReturnType<typeof setTimeout> | null
  startedAt: string
  status: 'running' | 'done' | 'error' | 'cancelled'
}
