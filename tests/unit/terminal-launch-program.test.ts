import { describe, expect, it } from 'vitest'
import {
  resolveTerminalLaunchCommand,
  resolveTerminalLaunchProgram,
} from '../../src/shared/terminalLaunch'

describe('resolveTerminalLaunchProgram', () => {
  it('returns direct CLI program for agent presets', () => {
    expect(resolveTerminalLaunchProgram('claude')).toEqual({ command: 'claude', args: [] })
    expect(resolveTerminalLaunchProgram('codex')).toEqual({ command: 'codex', args: [] })
    expect(resolveTerminalLaunchProgram('opencode')).toEqual({ command: 'opencode', args: [] })
    expect(resolveTerminalLaunchProgram('janus')).toEqual({ command: 'janus', args: ['tui'] })
  })

  it('composes the janus tui auto command', () => {
    expect(resolveTerminalLaunchCommand('janus')).toBe('janus tui')
  })

  it('returns undefined for shell preset', () => {
    expect(resolveTerminalLaunchProgram('shell')).toBeUndefined()
    expect(resolveTerminalLaunchCommand('shell')).toBeUndefined()
  })

  it('accepts custom command/args input', () => {
    expect(
      resolveTerminalLaunchProgram({ command: 'codex', args: ['--search'] }),
    ).toEqual({ command: 'codex', args: ['--search'] })
  })
})
