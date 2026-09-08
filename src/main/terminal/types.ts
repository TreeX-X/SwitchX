import type { IPty } from 'node-pty'

export type TerminalPreset = 'shell' | 'claude' | 'codex' | 'opencode' | 'janus'

export interface TerminalConfig {
  id: string
  workspaceId: string
  cwd: string
  shell: string
  /** When set, spawn this program directly instead of a shell. */
  program?: string
  programArgs?: string[]
  cols?: number
  rows?: number
  env?: Record<string, string>
}

export interface TerminalInstance {
  id: string
  pty: IPty
  config: TerminalConfig
  status: 'idle' | 'running' | 'exited'
  createdAt: number
  outputBuffer: string
  outputSeq: number
  lastCols?: number
  lastRows?: number
}

export interface TerminalPresetConfig {
  name: string
  preset: TerminalPreset
  command?: string
  args?: string[]
  description: string
}
