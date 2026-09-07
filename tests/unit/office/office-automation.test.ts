import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { buildOfficeAgentSession, mergeOfficeAgentEnv } from '../../../src/main/office/office-agent-policy'
import {
  configureCodexOfficeMcpText,
  configureOfficeRuleText,
  removeCodexOfficeMcpText,
  removeOfficeRuleBlock,
} from '../../../src/main/office/office-project-rules'

describe('Office agent automation policy', () => {
  it('prepares managed agent env while shell receives tool env without policy text', () => {
    const codex = buildOfficeAgentSession('codex', 'C:\\work', 'C:\\managed\\officecli.exe', 'C:\\app\\office-mcp.js', 'BASE')
    expect(codex.env).toMatchObject({ JANUSX_OFFICE_WORKSPACE: 'C:\\work', JANUSX_OFFICECLI_BINARY: 'C:\\managed\\officecli.exe' })
    expect(codex.env.JANUSX_OFFICE_POLICY).toContain('unrestricted shell/filesystem access can bypass')
    expect(codex.mode).toBe('policy-only')
    const shell = buildOfficeAgentSession('shell', 'C:\\work', 'C:\\managed\\officecli.exe', 'mcp.js')
    expect(shell.env.JANUSX_OFFICE_POLICY).toBeUndefined()
    expect(mergeOfficeAgentEnv({ KEEP: 'yes' }, codex).KEEP).toBe('yes')
  })

  it('degrades unverified engine config surfaces explicitly', () => {
    expect(buildOfficeAgentSession('claude', 'root', undefined, 'mcp').mode).toBe('policy-only')
    expect(buildOfficeAgentSession('opencode', 'root', undefined, 'mcp').limitation).toContain('no verified durable')
    expect(buildOfficeAgentSession('janus', 'root', undefined, 'mcp').limitation).toContain('janus has no verified durable')
  })

  it('prepares Office policy before PTY creation without terminal paste injection', () => {
    const source = readFileSync(new URL('../../../src/main/ipc/terminal-handlers.ts', import.meta.url), 'utf8')
    expect(source.indexOf('buildOfficeAgentSession(')).toBeLessThan(source.indexOf('terminalManager.create({'))
    expect(source).not.toContain('previewOfficeProjectRules(cwd)')
    expect(source).not.toContain('applyOfficeProjectRules(')
    expect(source).not.toContain("send('terminal:input'")
    expect(source).not.toContain('auto-submit')
  })

  it('round-trips marker-owned rules and Codex MCP config byte-for-byte around user text', () => {
    const userRules = '\uFEFFuser line\r\nunchanged'
    const configuredRules = configureOfficeRuleText(userRules)
    expect(configureOfficeRuleText(configuredRules)).toBe(configuredRules)
    expect(removeOfficeRuleBlock(configuredRules)).toBe(userRules)
    expect(configuredRules).not.toContain('C:\\')

    const userToml = '\uFEFF[features]\r\nhooks = true'
    const configuredToml = configureCodexOfficeMcpText(userToml)
    expect(configureCodexOfficeMcpText(configuredToml)).toBe(configuredToml)
    expect(removeCodexOfficeMcpText(configuredToml)).toBe(userToml)
    expect(configuredToml).toContain('command = "janusx-office-mcp"')
    expect(configuredToml).not.toContain('C:\\')
  })
})
