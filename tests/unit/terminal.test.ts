import { describe, it, expect, beforeEach } from 'vitest'

describe('Terminal Presets', () => {
  it('should return correct auto command for claude preset', async () => {
    const { getAutoCommand } = await import('../../src/main/terminal/presets')
    // Enter is injected separately after resize; command itself has no trailing newline.
    expect(getAutoCommand('claude')).toBe('claude')
  })

  it('should return the janus tui auto command and preset name', async () => {
    const { getAutoCommand, getPresetName } = await import('../../src/main/terminal/presets')
    expect(getAutoCommand('janus')).toBe('janus tui')
    expect(getPresetName('janus')).toBe('Janus')
  })

  it('should return undefined for shell preset', async () => {
    const { getAutoCommand } = await import('../../src/main/terminal/presets')
    expect(getAutoCommand('shell')).toBeUndefined()
  })

  it('should return correct preset name', async () => {
    const { getPresetName } = await import('../../src/main/terminal/presets')
    expect(getPresetName('claude')).toBe('Claude Code')
    expect(getPresetName('codex')).toBe('Codex')
    expect(getPresetName('shell')).toBe('普通终端')
  })

  it('should have all presets defined', async () => {
    const { PRESETS } = await import('../../src/main/terminal/presets')
    expect(PRESETS).toHaveProperty('shell')
    expect(PRESETS).toHaveProperty('claude')
    expect(PRESETS).toHaveProperty('codex')
    expect(PRESETS).toHaveProperty('opencode')
    expect(PRESETS).toHaveProperty('janus')
  })
})

describe('Default Shell', () => {
  it('should return a string for default shell', async () => {
    const { getDefaultShell } = await import('../../src/main/terminal/presets')
    const shell = getDefaultShell()
    expect(typeof shell).toBe('string')
    expect(shell.length).toBeGreaterThan(0)
  })

  it('should return shell name', async () => {
    const { getShellName } = await import('../../src/main/terminal/presets')
    expect(getShellName('/bin/bash')).toBe('Bash')
    expect(getShellName('/usr/bin/zsh')).toBe('Zsh')
    expect(getShellName('powershell.exe')).toBe('PowerShell')
  })
})