import { app } from 'electron'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import { access, mkdir, readFile, writeFile } from 'fs/promises'
import type { AgentEngine } from '../janus-runner/types'
import type { AgentHookBridgeEnv } from './agent-hook-bridge'

export const JANUSX_HOOK_COMMAND_MARKER = 'janusx-agent-hook-v2'
const JANUSX_LEGACY_HOOK_COMMAND_MARKERS = [
  'janusx-hook-v1',
  '--janusx-hook',
  'TerminalAgentNotificationCoordinator',
  'terminal-agent-notification',
  'aiCliCompletion',
]

type HookableEngine = AgentEngine
type JsonObject = Record<string, unknown>

interface HookCommandSpec {
  event: string
  matcher?: string
}

interface AgentHookConfigManagerOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  userDataDir?: string
  executablePath?: string
  appEntryArg?: string
  windowsHookScriptPath?: string
}

interface TerminalHookEnvInput {
  terminalId: string
  workspaceId: string
  engine: HookableEngine
}

export interface HookInstallResult {
  engine: HookableEngine
  installed: boolean
  path: string
}

const CLAUDE_HOOKS: HookCommandSpec[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt' },
  { event: 'Stop' },
  { event: 'StopFailure' },
  // Fires on CLI exit/clear/logout: closes a still-open turn before the pty dies.
  { event: 'SessionEnd' },
]

const CODEX_HOOKS: HookCommandSpec[] = [
  { event: 'UserPromptSubmit' },
  { event: 'PermissionRequest' },
  { event: 'Stop' },
]

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function getHooksObject(settings: JsonObject): JsonObject {
  const existing = getObject(settings.hooks)
  if (existing) return existing
  const hooks: JsonObject = {}
  settings.hooks = hooks
  return hooks
}

function isManagedHook(value: unknown): boolean {
  const hook = getObject(value)
  if (!hook) return false
  const command = hook.command
  if (typeof command !== 'string') return false
  return [JANUSX_HOOK_COMMAND_MARKER, ...JANUSX_LEGACY_HOOK_COMMAND_MARKERS].some((marker) =>
    command.includes(marker),
  )
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  try {
    const raw = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '')
    if (!raw.trim()) return {}
    const parsed = JSON.parse(raw) as unknown
    const object = getObject(parsed)
    if (!object) throw new Error(`${filePath} must contain a JSON object`)
    return object
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeJsonObject(filePath: string, object: JsonObject): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(object, null, 2)}\n`, 'utf8')
}

function removeManagedHookCommands(settings: JsonObject): void {
  const hooks = getObject(settings.hooks)
  if (!hooks) return

  for (const [event, rawEntries] of Object.entries(hooks)) {
    const cleanedEntries: unknown[] = []
    for (const rawEntry of toArray(rawEntries)) {
      const entry = getObject(rawEntry)
      if (!entry) {
        cleanedEntries.push(rawEntry)
        continue
      }

      const keptInner = toArray(entry.hooks).filter((hook) => !isManagedHook(hook))
      if (keptInner.length === 0) continue
      cleanedEntries.push({ ...entry, hooks: keptInner })
    }

    if (cleanedEntries.length === 0) {
      delete hooks[event]
    } else {
      hooks[event] = cleanedEntries
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
  }
}

function addHookCommand(settings: JsonObject, spec: HookCommandSpec, command: string): void {
  const hooks = getHooksObject(settings)
  const entries = toArray(hooks[spec.event])
  const entry: JsonObject = {
    hooks: [
      {
        type: 'command',
        command,
      },
    ],
  }

  if (spec.matcher) {
    entry.matcher = spec.matcher
  }

  hooks[spec.event] = [...entries, entry]
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildHookCommand(
  platform: NodeJS.Platform,
  executablePath: string,
  appEntryArg: string | undefined,
  source: HookableEngine,
  event: string,
  windowsHookScriptPath?: string,
): string {
  if (platform === 'win32' && windowsHookScriptPath) {
    const command = [
      '&',
      quotePowerShell(windowsHookScriptPath),
      '-Source',
      quotePowerShell(source),
      '-EventName',
      quotePowerShell(event),
      '-Marker',
      quotePowerShell(JANUSX_HOOK_COMMAND_MARKER),
    ].join(' ')

    // The hook script sets its own UTF-8 encoding internally, so the guard only
    // needs the Test-Path check. Avoid inline PowerShell variables ($utf8 etc.)
    // here: Claude Code/Codex run hook commands through bash, which expands $var
    // before powershell sees it, corrupting the command.
    const guardedCommand = [
      `if (-not (Test-Path -LiteralPath ${quotePowerShell(windowsHookScriptPath)})) { exit 0 }`,
      command,
    ].join('; ')

    return [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `"${guardedCommand.replace(/"/g, '`"')}"`,
    ].join(' ')
  }

  const args = [
    ...(appEntryArg ? [appEntryArg] : []),
    '--janusx-hook',
    '--source',
    source,
    '--event',
    event,
    '--janusx-hook-marker',
    JANUSX_HOOK_COMMAND_MARKER,
  ]

  if (platform === 'win32') {
    const command = ['&', quotePowerShell(executablePath), ...args.map(quotePowerShell)].join(' ')
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '`"')}"`
  }

  return [executablePath, ...args].map(quotePosix).join(' ')
}

function resolveAppEntryArg(explicitAppEntryArg: string | undefined): string | undefined {
  if (explicitAppEntryArg !== undefined) {
    return explicitAppEntryArg
  }

  if (app.isPackaged) {
    return undefined
  }

  const appPath = app.getAppPath()
  if (appPath) {
    return appPath
  }

  const argvEntry = process.argv[1]
  return argvEntry && isAbsolute(argvEntry) ? argvEntry : undefined
}

async function installJsonHooks(
  filePath: string,
  specs: HookCommandSpec[],
  platform: NodeJS.Platform,
  executablePath: string,
  appEntryArg: string | undefined,
  source: HookableEngine,
  windowsHookScriptPath?: string,
): Promise<HookInstallResult> {
  const settings = await readJsonObject(filePath)

  removeManagedHookCommands(settings)
  for (const spec of specs) {
    addHookCommand(
      settings,
      spec,
      buildHookCommand(platform, executablePath, appEntryArg, source, spec.event, windowsHookScriptPath),
    )
  }

  await writeJsonObject(filePath, settings)
  return { engine: source, installed: true, path: filePath }
}

async function uninstallJsonHooks(filePath: string, engine: HookableEngine): Promise<HookInstallResult> {
  const settings = await readJsonObject(filePath)
  removeManagedHookCommands(settings)
  await writeJsonObject(filePath, settings)
  return { engine, installed: false, path: filePath }
}

function mergeWslenv(existing: string | undefined, keys: string[]): string {
  const current = existing?.split(':').filter(Boolean) ?? []
  const merged = [...current]
  for (const key of keys) {
    if (!merged.includes(key)) merged.push(key)
  }
  return merged.join(':')
}

function buildOpencodePlugin(): string {
  return `const TARGET_EVENTS = new Set(["session.created", "session.updated", "session.status", "session.idle", "session.error", "permission.asked"]);

function env(name) {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function extractMessage(event) {
  if (!event || typeof event !== "object") return undefined;
  const properties = event.properties && typeof event.properties === "object" ? event.properties : {};
  const candidates = [event.message, event.error, event.reason, properties.message, properties.error, properties.reason];
  return candidates.find((value) => typeof value === "string" && value.trim());
}

function extractSessionId(event) {
  if (!event || typeof event !== "object") return undefined;
  const properties = event.properties && typeof event.properties === "object" ? event.properties : {};
  const session = properties.session && typeof properties.session === "object" ? properties.session : {};
  const candidates = [event.sessionID, event.sessionId, event.session_id, properties.sessionID, properties.sessionId, properties.session_id, session.id, session.sessionID, session.sessionId];
  return candidates.find((value) => typeof value === "string" && value.trim());
}

async function postToJanusX(event, directory) {
  const port = env("JANUSX_HOOK_PORT");
  const token = env("JANUSX_HOOK_TOKEN");
  if (!port || !token || !event || !TARGET_EVENTS.has(event.type)) return;

  await fetch("http://127.0.0.1:" + port + "/api/agent-hook", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "opencode",
      event: event.type,
      terminalId: env("JANUSX_HOOK_TERMINAL_ID"),
      workspaceId: env("JANUSX_HOOK_WORKSPACE_ID"),
      sessionId: extractSessionId(event),
      cwd: directory,
      message: extractMessage(event),
      timestamp: new Date().toISOString(),
      raw: event,
    }),
  }).catch(() => {});
}

export const JanusXNotifyPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    await postToJanusX(event, directory);
  },
});
`
}

function buildWindowsHookScript(): string {
  return `param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Alias("Event")][Parameter(Mandatory = $true)][string]$EventName,
  [string]$Marker = "${JANUSX_HOOK_COMMAND_MARKER}"
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8NoBom
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

function Write-Diagnostic($Status, $Detail) {
  try {
    $diagnosticPath = Join-Path $PSScriptRoot "janusx-agent-hook-last.json"
    $diagnostic = [ordered]@{
      source = $Source
      event = $EventName
      status = $Status
      detail = $Detail
      hasPort = -not [string]::IsNullOrWhiteSpace($env:JANUSX_HOOK_PORT)
      hasToken = -not [string]::IsNullOrWhiteSpace($env:JANUSX_HOOK_TOKEN)
      terminalId = $env:JANUSX_HOOK_TERMINAL_ID
      workspaceId = $env:JANUSX_HOOK_WORKSPACE_ID
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }
    $diagnostic | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $diagnosticPath -Encoding UTF8
  } catch {
  }
}

function Get-FirstString($Value, [string[]]$Names) {
  if ($null -eq $Value -or $Value -is [string]) { return $null }
  $propertyNames = $Value.PSObject.Properties.Name
  foreach ($name in $Names) {
    if ($propertyNames -contains $name) {
      $candidate = $Value.$name
      if ($candidate -is [string] -and -not [string]::IsNullOrWhiteSpace($candidate)) {
        return $candidate
      }
    }
  }
  return $null
}

try {
  $port = $env:JANUSX_HOOK_PORT
  $token = $env:JANUSX_HOOK_TOKEN
  if ([string]::IsNullOrWhiteSpace($port) -or [string]::IsNullOrWhiteSpace($token)) {
    Write-Diagnostic "missing-env" "JANUSX_HOOK_PORT or JANUSX_HOOK_TOKEN is empty"
    exit 0
  }

  $stdinRaw = [Console]::In.ReadToEnd()
  $rawValue = $null
  if (-not [string]::IsNullOrWhiteSpace($stdinRaw)) {
    try {
      $rawValue = $stdinRaw | ConvertFrom-Json
    } catch {
      $rawValue = $stdinRaw
    }
  }

  $message = Get-FirstString $rawValue @("message", "prompt", "notification", "reason", "last_assistant_message")
  if (-not $message -and $null -ne $rawValue -and $rawValue -isnot [string]) {
    $propertyNames = $rawValue.PSObject.Properties.Name
    if ($propertyNames -contains "tool_input") {
      $message = Get-FirstString $rawValue.tool_input @("prompt", "description", "task")
    }
  }

  $sessionId = Get-FirstString $rawValue @("session_id", "sessionId")
  $payload = [ordered]@{
    source = $Source
    event = $EventName
    terminalId = $env:JANUSX_HOOK_TERMINAL_ID
    workspaceId = $env:JANUSX_HOOK_WORKSPACE_ID
    sessionId = $sessionId
    cwd = (Get-Location).Path
    message = $message
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    raw = $rawValue
  }

  $json = $payload | ConvertTo-Json -Depth 32 -Compress
  $bodyBytes = $utf8NoBom.GetBytes($json)
  $headers = @{ Authorization = "Bearer $token" }
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/agent-hook" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bodyBytes | Out-Null
  Write-Diagnostic "posted" "ok"
} catch {
  Write-Diagnostic "error" $_.Exception.Message
}

exit 0
`
}

export class AgentHookConfigManager {
  private readonly platform: NodeJS.Platform
  private readonly homeDir: string
  private readonly userDataDir: string
  private readonly executablePath: string
  private readonly appEntryArg?: string
  private readonly configuredWindowsHookScriptPath?: string

  constructor(options: AgentHookConfigManagerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.homeDir = options.homeDir ?? homedir()
    this.userDataDir = options.userDataDir ?? join(app.getPath('userData'), 'janusx')
    this.executablePath = options.executablePath ?? process.execPath
    this.appEntryArg = resolveAppEntryArg(options.appEntryArg)
    this.configuredWindowsHookScriptPath = options.windowsHookScriptPath
  }

  async ensureInstalled(engine: HookableEngine): Promise<HookInstallResult> {
    if (engine === 'claude') {
      const windowsHookScriptPath = await this.ensureHookClientScript()
      return installJsonHooks(
        this.getClaudeSettingsPath(),
        CLAUDE_HOOKS,
        this.platform,
        this.executablePath,
        this.appEntryArg,
        engine,
        windowsHookScriptPath,
      )
    }

    if (engine === 'codex') {
      const windowsHookScriptPath = await this.ensureHookClientScript()
      const result = await installJsonHooks(
        this.getCodexHooksPath(),
        CODEX_HOOKS,
        this.platform,
        this.executablePath,
        this.appEntryArg,
        engine,
        windowsHookScriptPath,
      )
      return result
    }

    await this.ensureOpencodePlugin()
    return { engine, installed: true, path: this.getOpencodeConfigDir() }
  }

  async uninstall(engine: HookableEngine): Promise<HookInstallResult> {
    if (engine === 'claude') {
      return uninstallJsonHooks(this.getClaudeSettingsPath(), engine)
    }

    if (engine === 'codex') {
      return uninstallJsonHooks(this.getCodexHooksPath(), engine)
    }

    return { engine, installed: false, path: this.getOpencodeConfigDir() }
  }

  async isInstalled(engine: HookableEngine): Promise<boolean> {
    if (engine === 'opencode') {
      return Promise.all([
        access(join(this.getOpencodeConfigDir(), 'opencode.json')),
        access(join(this.getOpencodeConfigDir(), 'janusx-agent-hook-marker.json')),
      ]).then(() => true, () => false)
    }

    if (this.platform === 'win32') {
      try {
        await access(this.getWindowsHookScriptPath())
      } catch {
        return false
      }
    }

    try {
      const specs = engine === 'claude' ? CLAUDE_HOOKS : CODEX_HOOKS
      const settings = await readJsonObject(engine === 'claude' ? this.getClaudeSettingsPath() : this.getCodexHooksPath())
      return specs.every((spec) => {
        const commands = toArray(getObject(settings.hooks)?.[spec.event])
          .flatMap((entry) => toArray(getObject(entry)?.hooks))
          .map((hook) => getObject(hook)?.command)
          .filter((command): command is string => typeof command === 'string')
        return commands.includes(buildHookCommand(
          this.platform,
          this.executablePath,
          this.appEntryArg,
          engine,
          spec.event,
          this.platform === 'win32' ? this.getWindowsHookScriptPath() : undefined,
        ))
      })
    } catch {
      return false
    }
  }

  buildTerminalEnv(input: TerminalHookEnvInput, bridgeEnv: AgentHookBridgeEnv): Record<string, string> {
    const env: Record<string, string> = {
      ...bridgeEnv,
      JANUSX_HOOK_TERMINAL_ID: input.terminalId,
      JANUSX_HOOK_WORKSPACE_ID: input.workspaceId,
      JANUSX_HOOK_ENGINE: input.engine,
    }

    if (input.engine === 'opencode') {
      env.OPENCODE_CONFIG_DIR = this.getOpencodeConfigDir()
    }

    if (this.platform === 'win32') {
      const forwarded = [
        'JANUSX_HOOK_PORT',
        'JANUSX_HOOK_TOKEN',
        'JANUSX_HOOK_TERMINAL_ID',
        'JANUSX_HOOK_WORKSPACE_ID',
        'JANUSX_HOOK_ENGINE',
      ]
      if (input.engine === 'opencode') forwarded.push('OPENCODE_CONFIG_DIR/p')
      env.WSLENV = mergeWslenv(process.env.WSLENV, forwarded)
    }

    return env
  }

  getClaudeSettingsPath(): string {
    return join(this.homeDir, '.claude', 'settings.json')
  }

  getCodexHooksPath(): string {
    return join(this.homeDir, '.codex', 'hooks.json')
  }

  getOpencodeConfigDir(): string {
    return join(this.userDataDir, 'hooks', 'opencode')
  }

  getWindowsHookScriptPath(): string {
    return this.configuredWindowsHookScriptPath ?? join(this.homeDir, '.janusx', 'hooks', 'janusx-agent-hook.ps1')
  }

  private async ensureHookClientScript(): Promise<string | undefined> {
    if (this.platform !== 'win32') return undefined

    const scriptPath = this.getWindowsHookScriptPath()
    await mkdir(dirname(scriptPath), { recursive: true })
    await writeFile(scriptPath, buildWindowsHookScript(), 'utf8')
    return scriptPath
  }

  private async ensureOpencodePlugin(): Promise<void> {
    const configDir = this.getOpencodeConfigDir()
    const pluginDir = join(configDir, 'plugins')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(configDir, 'opencode.json'),
      `${JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(configDir, 'janusx-agent-hook-marker.json'),
      `${JSON.stringify({ owner: 'JanusX', marker: JANUSX_HOOK_COMMAND_MARKER }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(join(pluginDir, 'janusx-notify.js'), buildOpencodePlugin(), 'utf8')
  }
}
