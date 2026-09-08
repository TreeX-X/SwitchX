import type { FileAPI, FileTreeAPI, WorkspaceAPI } from '../../../shared/ipc/workspace'
import type { LanguageServiceAPI } from '../../../shared/ipc/language-service'
import type { TerminalAPI } from '../../../shared/ipc/terminal'
import type { ProjectAPI } from '../../../shared/ipc/project'
import type { BrowserAPI } from '../../../shared/ipc/browser'
import type { KnowledgeAPI } from '../../../shared/ipc/knowledge'
import type { JanusAPI } from '../../../shared/ipc/janus'
import type { OfficeAPI } from '../../../shared/office'
import type { AgentAPI, SubAgentRunAPI } from '../../../shared/ipc/janus-runner'
import type { AgentRuntimeAPI } from '../../../shared/ipc/agent-runtime'
import type { CheckpointAPI } from '../../../shared/ipc/checkpoint'
import type { GitAPI } from '../../../shared/ipc/git'
import type { LlmAPI } from '../../../shared/ipc/llm'
import type { JanusChatAPI } from '../../../shared/ipc/janus-chat'
import type { RoundtableAPI } from '../../../shared/ipc/roundtable'
import type { AgentSettingsAPI, NotificationSettingsAPI } from '../../../shared/ipc/settings'
import type { DesktopToastAPI, DialogAPI, SystemAPI, WindowAPI } from '../../../shared/ipc/system'

interface ElectronAPI {
  /*-- 同步平台信息，构造 xterm windowsPty 用 --*/
  platform: NodeJS.Platform
  windowsBuild?: number
  workspace: WorkspaceAPI
  fileTree: FileTreeAPI
  file: FileAPI
  languageService: LanguageServiceAPI
  terminal: TerminalAPI
  project: ProjectAPI
  browser: BrowserAPI
  knowledge: KnowledgeAPI
  janus: JanusAPI
  office: OfficeAPI
  llm: LlmAPI
  janusChat?: JanusChatAPI
  roundtable: RoundtableAPI
  agent: AgentAPI
  agentRuntime: AgentRuntimeAPI
  checkpoint: CheckpointAPI
  git: GitAPI
  notificationSettings: NotificationSettingsAPI
  agentSettings: AgentSettingsAPI
  subAgentRun: SubAgentRunAPI
  dialog: DialogAPI
  window: WindowAPI
  system: SystemAPI
  desktopToast: DesktopToastAPI
  janusPersona: string
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}

export {}
