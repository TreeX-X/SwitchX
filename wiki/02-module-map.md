# Module Map

Last analyzed: 2026-09-06

## Main Process Modules

| Module | Primary Files | Responsibility |
|---|---|---|
| App shell | `src/main/index.ts`, `src/main/bootstrap/`, `src/main/windows/`, `src/main/ipc/register.ts` | Electron lifecycle, service graph, window creation, and IPC composition |
| Workspace config | `src/main/config/service.ts`, `src/main/workspace/types.ts` | global config, recent workspaces, CLI registrations |
| Workspace/files IPC | `src/main/ipc/handlers.ts`, `src/main/ipc/file-handlers.ts` | workspace persistence, file tree, file content operations |
| Terminal backend | `src/main/terminal/manager.ts`, `src/main/terminal/presets.ts`, `src/main/terminal/diagnostics.ts` | pty lifecycle, default shells, preset metadata, diagnostics |
| Terminal IPC | `src/main/ipc/terminal-handlers.ts` | create/kill/input/resize/warmup/replay terminals, connect terminals to checkpoints and Janus analysis |
| Browser surface | `src/main/browser/surface-manager.ts`, `src/main/ipc/browser-handlers.ts` | embedded browser pane/window lifecycle, URL normalization, tab state |
| Roundtable | `src/main/roundtable/service.ts`, `runtime.ts`, `store.ts`, `agent-registry.ts`, `workspace-tools.ts`, `src/main/ipc/roundtable-handlers.ts` | staged multi-agent deliberation, workspace evidence binding, parchment export, restore consistency |
| Language service | `src/main/language-service/clangd-client.ts`, `src/main/language-service/clangd-manager.ts`, `src/main/language-service/registry.ts`, `src/main/ipc/language-service-handlers.ts`, `src/main/ipc/language-service-installer-handlers.ts` | clangd LSP client/manager/registry + managed binary install for go-to-definition |
| Git | `src/main/git/service.ts`, `src/main/ipc/git-handlers.ts` | status/log/stage/commit/push/pull/diff/fileBaseline |
| Agent CLI streaming | `src/main/agent/stream-manager.ts`, `src/main/agent/cli-resolver.ts`, `src/main/agent/parsers/*`, `src/main/ipc/agent-handlers.ts` | spawn Claude/Codex/OpenCode CLIs, parse JSON events, manage concurrency/cancel |
| Agent runtime | `@janus-agent/agent-core` (policy/path/registry/manifest/result/transaction/audit) + `src/main/agent/runtime/shell-runtime.ts` (shell assembly: runtime singleton + authorizer) + `src/main/agent/runtime/tools/{command,git,project}-tools.ts` (shell impls) + `src/main/ipc/agent-runtime-handlers.ts` | workspace-scoped tool execution with policy gate, path guard, file transactions |
| Janus agent loop | `@janus-agent/agent-core` (`loop/`, `stream/`) | structured agent loop with Vercel AI SDK streaming, before/after tool hooks |
| Agent environment | `@janus-agent/agent-core` (`environment/janus-workspace-fs.ts`) | workspace filesystem access, evidence context, text buffer detection |
| Checkpoint | `@janus-agent/agent-core` (`checkpoint/*`) + `src/main/ipc/checkpoint-handlers.ts` | workspace snapshots, blob store, diffs, restore, conflicts |
| Project runtime | `src/main/project/*`, `src/main/ipc/project-handlers.ts` | detect project type, manage `.janusX/janusX.launch.json`, build commands, run/stop processes, port extraction |
| LLM | `src/main/llm/*`, `src/main/ipc/llm-handlers.ts` | provider config, model catalog, connection test, chat orchestration, workspace chat tools, development config sync |
| Chat orchestration | `src/main/llm/chat-orchestrator.ts` (shell adapter), `src/main/llm/ai-runtime.ts`, `@janus-agent/janus-agent` (`runChatTurn`), `@janus-agent/chat-core` (session/prompt/events), `@janus-agent/agent-core` (chat-tools) | chat message/stream management, tool trace, workspace mutation intent, AI SDK runtime |
| Model catalog | `src/main/llm/ModelCatalogService.ts` | model registry access, OpenRouter model normalization |
| Janus Blueprint | `src/main/janus/*`, `src/main/ipc/janus-handlers.ts` | Blueprint CRUD, node focus/bind, commit-diff analysis, candidate requirements, factory, migration, persistence |
| Blueprint maintenance | `src/main/janus/maintenance/*`, `src/main/janus/maintenance/service.ts` | change-set operations, reverse operations, blueprint tools, `BlueprintMaintenanceService` |
| Janus chat | `src/main/janus/chat-store.ts`, `src/main/ipc/janus-chat-handlers.ts` | Janus chat conversation persistence, load/save |
| Companion gateway | `src/main/companion/*` | Feishu remote control: gateway, binding, session state, action tokens, audit, dedupe, terminal control |
| Remote notifications | `src/main/remote-notifications/*`, `src/main/remote-notifications/feishu-inbound/*` | Feishu provider, inbound router/runtime, dispatcher, delivery store, secret redaction |
| Knowledge | `src/main/knowledge/*`, `src/main/ipc/knowledge-handlers.ts` | observations, search (BM25/tokenizer/embeddings), context, recall, review, truth, extraction, retention, operations, MCP, agent turn recorder, queue-owned pipeline, external MCP |
| Knowledge pipeline | `src/main/knowledge/processing-queue.ts`, `llm-stage.ts`, `deterministic-extractor.ts`, `diagnostics-service.ts`, `workspace-identity.ts`, `external-mcp.ts` | per-workspace cursors + failure ledger, batch-50 LLM stage, deterministic extract, diagnostics, external terminal MCP registration |
| Office | `src/main/office/*`, `src/main/ipc/office-handlers.ts` | guarded Office CLI installation (`officecli-manager.ts` pinned 1.0.135), artifacts, watchers, previews, exports, broker, skills, project rules |
| Subagent runs | `src/main/agent/subagent-run-registry.ts`, `src/main/ipc/subagent-run-handlers.ts` | Subagent run tracking, process lifecycle, and renderer events |
| Runtime telemetry | `src/main/runtime-telemetry/history.ts`, `src/main/ipc/runtime-telemetry-handlers.ts` | terminal model/context telemetry history |
| Notifications | `src/main/notifications/*`, `src/main/ipc/settings-handlers.ts` | Agent hooks (bridge/client/config/coordinator/diagnostics), remote notification delivery, desktop toast windows, notifier policy |
| Coordinated shutdown | `src/main/shutdown/AppShutdown.ts` | bounded cleanup across chat, analysis, terminals, Agents, projects, Office, companion, remote notifications, browser, clangd, watchers, and windows |

## Renderer Modules

| Module | Primary Files | Responsibility |
|---|---|---|
| App shell | `src/renderer/src/App.tsx`, `main.tsx`, `styles/globals.css` | top-level layout, providers, and global styles |
| Workspace state/actions | `stores/workspace.ts`, `features/workspace/*`, `types/index.ts`, `types/project.ts` | active workspace, bootstrap, file-tree actions, terminals, and pane tree |
| App state | `stores/app.ts` | selected panels, load state, Blueprint/Janus runtime flags, agent events |
| Terminal UI | `components/TerminalArea.tsx`, `CLITerminal.tsx`, `TerminalSelector.tsx`, `features/terminal/useTerminalLifecycle.ts`, `lib/workspace-pane.ts`, `lib/terminal-*.ts` | terminal panes, tabs, drag split, xterm component, lifecycle, output scheduler, scrollbar sync, viewport resize, geometry, TUI wheel, file reference, input transaction, sidebar visual, scroll intent |
| Browser UI | `components/browser/BrowserSurface.tsx`, `components/browser/StandaloneBrowser.tsx`, `stores/browser.ts`, `services/browser.ts` | embedded browser pane and standalone window, URL bar, tab state |
| File/editor UI | `components/FileEditor.tsx`, `components/StandaloneFileEditor.tsx`, `components/FileViewerContent.tsx`, `components/viewers/*`, `stores/editor.ts`, `lib/editor-*.ts`, `lib/monaco-*.ts` | Monaco/Markdown/HTML/Image/Binary viewers, editor find, warmup, definition, theme, file classification/presentation/utils |
| File tree | `components/file-tree/FileTreeItem.tsx`, `components/file-tree/FileTreeContextMenu.tsx`, `features/workspace/file-tree.ts`, `components/FileExplorerTool.tsx` | file tree rendering, context menu, lazy loading, source file scanning |
| Sidebar/status/titlebar | `components/Sidebar.tsx`, `StatusBar.tsx`, `Titlebar.tsx` | shell navigation, top controls, workspace switcher |
| Right tools dock | `components/right-tools/*`, `stores/right-tools.ts`, `right-tools/*` | dockable tool panels, rail, tabs, host, layout |
| Project launcher | `components/ProjectLauncher.tsx`, `ProjectSettings.tsx`, `ProjectRunningList.tsx`, `ProjectConfigForm/*`, `ProjectTypeSelector.tsx`, `ProjectLaunchAssistant.tsx`, `services/project.ts`, `services/workspace-launch-assistant.ts` | typed detect/configure/run client, lifecycle-safe actions, guarded polling, launch assistant |
| Knowledge workbench | `components/knowledge/*`, `services/knowledge.ts`, `services/knowledge-settings.ts` | typed workbench/search/context/review/truth/feedback/settings client with isolated read fallbacks, graph canvas (`KnowledgeGraphCanvas.tsx`, `knowledgeGraph.ts`), processing status |
| Roundtable UI | `components/janus/JanusRoundtablePane.tsx`, `RoundtableStage.tsx`, `JanusRoundtableParchment.tsx`, `roundtableExport.ts` | deliberation composer/controls, camera/hover stage, human-readable parchment export |
| LLM config/chat | `components/LlmConfigModal.tsx`, `services/llm.ts` | provider CRUD, test, chat, streaming chat subscription |
| Blueprint UI | `components/blueprint/*`, `features/blueprint/*`, `stores/blueprint.ts`, `stores/blueprint-maintenance.ts`, `services/blueprint.ts` | React Flow views/store, layout derivation, adaptive edge geometry, canvas navigation, graph controller, analysis actions, maintenance panel, audit details, workbench |
| Janus island/chat | `components/janus/*` | titlebar island, eye, identity core, expanded UI, chat pane/provider, conversations, reasoning region (`janusReasoning.ts` + `ThinkingRegion.tsx`), tool call card, project candidate, resources, runtime state, streaming printer, island gesture, knowledge peek, roundtable pane/stage/parchment |
| Quick notes | `components/note/*`, `stores/note.ts` | quick note editor, behavior, export |
| Checkpoint UI | `components/CheckpointPanel.tsx`, `stores/checkpoint.ts` | checkpoint list, diff, restore |
| Git UI | `components/GitPanel.tsx`, `stores/git.ts` | git status/action panel |
| Office UI | `components/office/*`, `stores/office.ts`, `services/office.ts` | office file list, preview panel/frame, prompt preview, setup gate, discovery, resize |
| Notifications UI | `components/AgentNotificationHost.tsx`, `components/NotificationSettingsPanel.tsx`, `components/DesktopToastApp.tsx`, `services/notification-settings.ts` | agent notification host, Feishu settings, desktop toast |
| Settings UI | `components/AppSettingsModal.tsx`, `components/GeneralSettingsPanel.tsx` | app settings, general settings |
| UI components | `components/ui/*` | HoldToConfirm, QuantumTopologyPreview, RefreshIconButton, Select, WorkbenchIcon |
| Floating panel | `components/FloatingPanel.tsx`, `components/Panel.tsx` | floating panel and panel containers |
| i18n | `src/renderer/src/i18n/*` | i18next config, language detector, useI18n hook, type generation, en/zh-CN locale bundles |
| Chat content | `components/chat/ChatContent.tsx` | shared chat content renderer |

## Shared Modules

| File | Purpose |
|---|---|
| `src/shared/ipc/workspace.ts` | Workspace/File/FileTree channel constants, DTOs, result/event types, and preload domain API contract |
| `src/shared/ipc/terminal.ts` | Terminal command/event constants, payload/result types, and preload domain API contract |
| `src/shared/ipc/project.ts` | Project command constants, clone-safe DTOs/results, and preload domain API contract |
| `src/shared/ipc/browser.ts` | Browser invoke/event channel constants, surface/tab state DTOs, and preload API contract |
| `src/shared/ipc/knowledge.ts` | Knowledge/Settings command constants, clone-safe DTOs/results, and preload domain API contract |
| `src/shared/ipc/agent-runtime.ts` | Agent Runtime channels, session/tool/policy/approval types, and preload API contract |
| `src/shared/ipc/janus-chat.ts` | Janus chat channels, message/conversation DTOs, and preload API contract |
| `src/shared/ipc/language-service.ts` | Language service channels, definition request/result, and preload API contract |
| `src/shared/ipc/agent.ts` | Agent CLI + SubAgentRun channels, DTOs, and preload API contracts |
| `src/shared/ipc/roundtable.ts`, `src/shared/roundtable/` | Roundtable channels (`start/advance/end/state/restore/export/event`) plus `events/state/export/parchment/workflow-template/host-synthesis` models |
| `src/shared/ipc/checkpoint.ts`, `git.ts`, `llm.ts`, `settings.ts`, `system.ts` | Remaining fixed domain contracts and preload APIs |
| `src/shared/janus/types.ts` | canonical Blueprint/Janus models |
| `src/shared/janus/relations.ts` | Blueprint relation types, cycle detection, invariant assertions, sanitize |
| `src/shared/janus/maintenance-types.ts` | Blueprint maintenance operations, change-sets, audit records, tasks, workspace bindings |
| `src/shared/janus/persona.ts` | Janus system persona exposed through preload as `janusPersona` |
| `src/shared/office.ts` | structured-clone-safe Office request/result and artifact models |
| `src/shared/knowledge.ts` | canonical Knowledge entities and structured-clone-safe extensible values |
| `src/shared/knowledge-card.ts` | KnowledgeCard types, filtering, sorting |
| `src/shared/knowledge-settings.ts` | Knowledge settings types |
| `src/shared/terminalLaunch.ts` | canonical terminal presets: `shell`, `claude`, `codex`, `opencode`; builds auto commands |
| `src/shared/terminalPaste.ts` | terminal paste models |
| `src/shared/notifications.ts` | notification settings type/defaults/normalization |
| `src/shared/subAgentRun.ts` | SubAgentRun DTOs |
| `src/shared/workspace-sidebar.ts` | workspace sidebar types |

## LLM Core Package

| Path | Purpose |
|---|---|
| `packages/llm-core/src/core/types.ts` | provider/auth/model/config interfaces |
| `packages/llm-core/src/core/ExtensionRegistry.ts` | provider registry singleton |
| `packages/llm-core/src/core/ProviderFactory.ts` | adapter resolution, model creation/cache, validation |
| `packages/llm-core/src/adapters/openai-compatible` | OpenAI-compatible API key provider |
| `packages/llm-core/src/adapters/vertex-ai` | Google Vertex AI provider |
| `packages/llm-core/src/registry/loader.ts` | metadata loader for providers |
| `packages/llm-core/src/registry/model-registry.ts` | model registry with OpenRouter generated, legacy overrides, and custom overrides |
| `packages/llm-core/src/registry/model-normalize.ts` | model entry normalization |
| `packages/llm-core/src/registry/model-types.ts` | model registry types |
| `packages/llm-core/src/utils/*` | validation, proxy, errors, AI SDK stream compatibility |
