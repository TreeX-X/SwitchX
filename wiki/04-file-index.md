# File Index

Last analyzed: 2026-09-06

Use this as a lookup table before opening source.

## Root

| File | Function |
|---|---|
| `package.json` | root scripts, strict-unused/package-boundary/i18n gates, dependencies, workspace declaration, bin entries (`janusx-office`, `janusx-office-mcp`) |
| `electron.vite.config.ts` | main/preload/renderer build entries and renderer alias |
| `tsconfig.json` | strict TS config, renderer alias, `ai` package path aliases |
| `electron-builder.yml` | explicit runtime package allowlist |
| `eslint.config.js` | ESLint flat config with TypeScript and React hooks rules |
| `vitest.config.ts` | root unit test config |
| `i18next-parser.config.ts` | i18n extraction config |
| `scripts/check-package-boundary.mjs` | fail-closed verification for Builder patterns and required outputs |
| `scripts/check-packaged-runtime.mjs` | verify packaged runtime files (also `--portable`) |
| `scripts/i18n-generate-types.mjs` | generate i18n TypeScript types |
| `scripts/i18n-check.mjs` | i18n key completeness check |
| `scripts/update-openrouter-model-registry.mjs` | fetch and update OpenRouter models |
| `AGENTS.md`, `.codex/config.toml`, `.codex/agents/`, `.codex/skills/` | project-specific Codex workflow, routing, subagent, and skill rules |

## Main Process

| File / Directory | Function |
|---|---|
| `src/main/index.ts` | compact Electron lifecycle coordinator |
| `src/main/bootstrap/session.ts`, `services.ts` | Chromium/CSP setup and application service graph |
| `src/main/windows/` | renderer loading, main/editor window construction, and window IPC |
| `src/main/ipc/register.ts` | ordered application IPC composition with window-scoped getters |
| `src/main/config/service.ts` | global config persistence in `userData/janusx/config.json` |
| `src/main/workspace/types.ts` | workspace/global config types |
| `src/main/ipc/handlers.ts` | workspace and file tree handlers, workspace watcher disposal |
| `src/main/ipc/file-handlers.ts` | file read/write/stat/sourceFiles handlers |
| `src/main/ipc/git-handlers.ts` | git IPC |
| `src/main/ipc/terminal-handlers.ts` | terminal IPC plus checkpoint queue, terminal-close Janus hook, host-window cleanup |
| `src/main/ipc/project-handlers.ts` | project detection/config/run/list/get/schemas IPC |
| `src/main/ipc/agent-handlers.ts` | Agent CLI process start/cancel/list IPC |
| `src/main/ipc/agent-runtime-handlers.ts` | agent runtime session/tool/approval IPC |
| `src/main/ipc/checkpoint-handlers.ts` | checkpoint create/finalize/restore/list/diff/delete IPC |
| `src/main/ipc/llm-handlers.ts` | LLM provider/chat/stream/model-catalog IPC |
| `src/main/ipc/janus-handlers.ts` | Blueprint and Janus analysis IPC |
| `src/main/ipc/janus-chat-handlers.ts` | Janus chat load/save IPC |
| `src/main/ipc/knowledge-handlers.ts` | Knowledge workbench, settings, and explicit maintenance IPC |
| `src/main/ipc/office-handlers.ts` | guarded Office artifact, CLI, watcher, and export IPC |
| `src/main/ipc/browser-handlers.ts` | browser surface lifecycle IPC |
| `src/main/ipc/language-handlers.ts` | language get/set IPC (i18n) |
| `src/main/ipc/language-service-handlers.ts` | clangd go-to-definition IPC |
| `src/main/ipc/language-service-installer-handlers.ts` | managed language-service binary install/remove/status IPC (window-authorized) |
| `src/main/ipc/roundtable-handlers.ts` | roundtable start/advance/end/state/restore/export IPC + event fan-out |
| `src/main/ipc/subagent-run-handlers.ts` | Subagent run lifecycle and event IPC |
| `src/main/ipc/runtime-telemetry-handlers.ts` | runtime telemetry IPC |
| `src/main/ipc/settings-handlers.ts` | notification settings + Feishu control status IPC |
| `src/main/shutdown/AppShutdown.ts` | coordinated bounded application shutdown |

## Main Process Services

| File / Directory | Function |
|---|---|
| `src/main/terminal/manager.ts` | node-pty instance lifecycle; ConPTY bundling helper |
| `src/main/terminal/presets.ts` | main-side terminal preset config and default shell helpers |
| `src/main/terminal/diagnostics.ts` | terminal diagnostics |
| `src/main/terminal/types.ts` | terminal backend types |
| `src/main/browser/surface-manager.ts` | `BrowserSurfaceManager` - browser pane/window lifecycle, URL normalization |
| `src/main/language-service/clangd-client.ts` | `ClangdClient` LSP client, `LspMessageBuffer`, definition normalization |
| `src/main/language-service/clangd-manager.ts` | `ClangdManager` singleton, `isPathWithinWorkspace` |
| `src/main/language-service/registry.ts` | language-service descriptors (`getDescriptor`/`getAllDescriptors`) for installer |
| `src/main/office/officecli-manager.ts` | OfficeCLI probe: pinned `SUPPORTED_VERSION` 1.0.135, capability check, manual guidance |
| `src/main/git/service.ts` | git operations: status/log/stage/unstage/commit/push/pull/diff/fileBaseline |
| `src/main/project/detector/detector.ts` | project type detection from feature files and manifests |
| `src/main/project/config/project-config.ts` | launch config create/validate |
| `src/main/project/config/project-schemas.ts` | project type schemas |
| `src/main/project/runner/runner.ts` | `ProjectRunner` - process spawn, lifecycle events |
| `src/main/project/runner/command-builder.ts` | build launch commands from config |
| `src/main/project/runner/service.ts` | project run service |
| `src/main/project/runner/task-runner.ts` | individual task lifecycle |
| `src/main/project/utils/port-extractor.ts` | parse dev server port from process output |
| `src/main/notifications/*` | Agent hooks (bridge/client/config/coordinator/diagnostics/types), `AgentNotifier`, desktop toast window |

## Agent Modules

| File / Directory | Function |
|---|---|
| `src/main/agent/stream-manager.ts` | `AgentStreamManager` - spawn/parse/cancel CLI sessions |
| `src/main/agent/cli-resolver.ts` | resolve Claude/Codex/OpenCode CLI paths |
| `src/main/agent/types.ts` | agent event/session types |
| `src/main/agent/subagent-run-registry.ts` | `SubAgentRunRegistry` - subagent run tracking |
| `src/main/agent/parsers/claude-parser.ts` | parse Claude CLI JSON events |
| `src/main/agent/parsers/codex-parser.ts` | parse Codex CLI JSON events |
| `src/main/agent/parsers/opencode-parser.ts` | parse OpenCode CLI JSON events |
| `src/main/agent/parsers/index.ts` | parser registry |
| `src/main/agent/runtime/shell-runtime.ts` | shell assembly: `workspaceAgentRuntime` singleton (file audit) + `authorizeRendererAction` |
| `@janus-agent/agent-core:main/agent/environment/janus-workspace-fs.ts` | `JanusWorkspaceFs` - workspace filesystem, evidence context (moved from `src/main/agent/`) |
| `@janus-agent/agent-core:main/agent/loop/janus-agent-loop.ts` | `JanusAgentLoopConfig` - structured agent loop with before/after tool hooks (moved) |
| `@janus-agent/agent-core:main/agent/loop/vercel-stream-adapter.ts` | Vercel AI SDK stream/message adaptation, `createVercelStream` (moved; `streamTextFn` now required) |
| `@janus-agent/agent-core:main/agent/loop/runtime-tool-adapter.ts` | bridge `ToolRegistry` tools to `JanusAgentTool` with resource scoping (moved) |
| `@janus-agent/agent-core:main/agent/runtime/runtime.ts` | `WorkspaceAgentRuntime` - session lifecycle, tool execution, events (moved; shell singleton lives in `shell-runtime.ts`) |
| `@janus-agent/agent-core:main/agent/runtime/registry.ts` | `ToolRegistry` - tool registration, input validation (moved) |
| `@janus-agent/agent-core:main/agent/runtime/path-guard.ts` | workspace path validation, trusted targets, read authorization (moved) |
| `@janus-agent/agent-core:main/agent/runtime/policy-gate.ts` | sensitive-path detection, secret redaction, policy evaluation, approval decisions (moved) |
| `@janus-agent/agent-core:main/agent/runtime/policy-audit-store.ts` | `FilePolicyAuditStore` - persistent audit trail (moved; default dir replicates shell layout) |
| `@janus-agent/agent-core:main/agent/runtime/file-transaction.ts` | workspace edit preparation, conflict detection, sha256 (moved) |
| `@janus-agent/agent-core:main/agent/runtime/renderer-authorization.ts` | authorize renderer-initiated actions (moved; factory form, shell default in `shell-runtime.ts`) |
| `@janus-agent/agent-core:main/agent/runtime/tool-result.ts` | convert tool results to model-compatible values (moved) |
| `@janus-agent/agent-core:main/agent/runtime/tools/workspace-tools.ts` | read, edit, create, list, search (moved) |
| `src/main/agent/runtime/tools/git-tools.ts` | status, log, diff, stage, unstage, commit, pull, push |
| `src/main/agent/runtime/tools/project-tools.ts` | detect, generateConfig, applyConfig, listProcesses, startProcess, processOutput, stopProcess |
| `src/main/agent/runtime/tools/command-tools.ts` | command execution |
| `@janus-agent/agent-core:main/agent/checkpoint/checkpoint-manager.ts` | checkpoint lifecycle, snapshot, restore (moved) |
| `@janus-agent/agent-core:main/agent/checkpoint/blob-store.ts` | content-addressed blob storage (moved) |
| `@janus-agent/agent-core:main/agent/checkpoint/diff-engine.ts` | unified diff and merge conflict helpers (moved) |
| `@janus-agent/agent-core:main/agent/checkpoint/git-adapter.ts` | git helpers for checkpoints (moved) |
| `@janus-agent/agent-core:main/agent/checkpoint/types.ts` | checkpoint types (moved) |

## Roundtable

| File / Directory | Function |
|---|---|
| `src/main/roundtable/service.ts` | `RoundtableService` - session lifecycle, `resolveRegisteredWorkspace`, fail-loud agents |
| `src/main/roundtable/runtime.ts` | staged deliberation runtime |
| `src/main/roundtable/store.ts` | session persistence + restore |
| `src/main/roundtable/agent-registry.ts` | participant registry from workflow template |
| `src/main/roundtable/workspace-tools.ts` | read-only `workspace.list/read/readRange` for agents |
| `src/shared/roundtable/events.ts`, `state.ts` | event envelopes, state model, migration, `markInterrupted` |
| `src/shared/roundtable/export.ts`, `parchment.ts` | parchment markdown export |
| `src/shared/roundtable/workflow-template.ts`, `host-synthesis.ts` | default workflow participants, host synthesis |
| `src/shared/ipc/roundtable.ts` | `roundtable:*` channels + `RoundtableAPI` contract |
| `src/renderer/src/components/janus/JanusRoundtablePane.tsx` | deliberation composer/controls |
| `src/renderer/src/components/janus/RoundtableStage.tsx` | stage camera/hover/empty-advance |
| `src/renderer/src/components/janus/JanusRoundtableParchment.tsx`, `roundtableExport.ts` | readable parchment view + export helper |
| `src/renderer/src/components/janus/janusReasoning.ts`, `ThinkingRegion.tsx` | UI-only bounded reasoning buffer (4000 chars) + display |

## Companion and Remote Notifications

| File / Directory | Function |
|---|---|
| `src/main/companion/gateway.ts` | `CompanionGateway` - request routing, command dispatch |
| `src/main/companion/binding-store.ts` | `CompanionBindingStore` - Feishu session to terminal mapping |
| `src/main/companion/session-state.ts` | `CompanionSessionState` - engine type, terminal metadata |
| `src/main/companion/action-token.ts` | `CompanionActionTokens` - card action token verification |
| `src/main/companion/audit-store.ts` | `CompanionAuditStore` - audit records |
| `src/main/companion/dedupe.ts` | `CompanionDedupe` - event deduplication |
| `src/main/companion/terminal-control.ts` | `MainProcessTerminalControl` - terminal I/O abstraction |
| `src/main/companion/terminal-creation-rollback.ts` | cleanup on failed terminal creation |
| `src/main/companion/workspace-registry.ts` | registered workspace metadata |
| `src/main/companion/contracts.ts` | provider type, request context, commands, results, policies |
| `src/main/companion/index.ts` | public re-exports |
| `src/main/remote-notifications/dispatcher.ts` | `RemoteNotificationDispatcher` singleton |
| `src/main/remote-notifications/delivery-store.ts` | `RemoteDeliveryStore` - delivery record persistence |
| `src/main/remote-notifications/secret-redaction.ts` | `redactErrorText` |
| `src/main/remote-notifications/types.ts` | notification type/severity, provider/send interfaces |
| `src/main/remote-notifications/providers/feishu-provider.ts` | `FeishuRemoteNotificationProvider`, `buildFeishuCard`, `buildFeishuTerminalDiscoveryCard` |
| `src/main/remote-notifications/feishu-inbound/runtime.ts` | `FeishuInboundRuntime` singleton |
| `src/main/remote-notifications/feishu-inbound/router.ts` | `FeishuInboundRouter`, `parseCommand` |
| `src/main/remote-notifications/feishu-inbound/normalize.ts` | normalize Feishu messages and card actions |
| `src/main/remote-notifications/feishu-inbound/client.ts` | `FeishuInboundClient` |
| `src/main/remote-notifications/feishu-inbound/sdk-channel.ts` | `createFeishuSdkChannel` |
| `src/main/remote-notifications/feishu-inbound/types.ts` | Feishu inbound message/card-action types |

## LLM Modules

| File | Function |
|---|---|
| `src/main/llm/ConfigStore.ts` | `LlmConfigStore` - provider config persistence |
| `src/main/llm/LlmService.ts` | `LlmService` - adapter registration, proxy setup, model creation, provider CRUD |
| `src/main/llm/ModelCatalogService.ts` | `ModelCatalogService` - model registry access, OpenRouter normalization |
| `src/main/llm/chat-orchestrator.ts` | chat message/stream management, tool trace, workspace mutation intent, abort |
| `src/main/llm/ai-runtime.ts` | Vercel AI SDK model resolution |
| `@janus-agent/agent-core:main/agent/chat-tools/workspace-chat-tools.ts` | `createWorkspaceChatTools`, `createToolPreview` (moved from `src/main/llm/`) |
| `src/main/llm/development-config-sync.ts` | `synchronizeInstalledLlmConfig`, `getDevelopmentLlmSyncStatus` |

## Janus and Blueprint

| File | Function |
|---|---|
| `src/shared/janus/persona.ts` | Janus system persona |
| `src/shared/janus/types.ts` | canonical Blueprint/Janus models |
| `src/shared/janus/relations.ts` | relation types, cycle detection, invariant assertions, sanitize |
| `src/shared/janus/maintenance-types.ts` | maintenance operations, change-sets, audit, tasks, intent groups, digests, agent events, dismiss/steer DTOs |
| `src/main/janus/types.ts` | compatibility re-export for shared Blueprint/Janus models |
| `src/main/janus/blueprint-store.ts` | Blueprint persistence, migration, CRUD, node updates, candidates |
| `src/main/janus/blueprint-factory.ts` | `makeNode`, `makeFeatureItem`, `nowIso` |
| `src/main/janus/blueprint-migration.ts` | Blueprint migration logic |
| `src/main/janus/blueprint-paths.ts` | Blueprint file path resolution |
| `src/main/janus/blueprint-persistence.ts` | Blueprint read/write persistence |
| `src/main/janus/analyzer.ts` | commit-diff segmentation, LLM analysis, result merge/apply |
| `src/main/janus/requirement-candidates.ts` | `candidateKey`, `resolveSuggestedParentId` |
| `src/main/janus/chat-store.ts` | `JanusChatStore` - conversation persistence singleton |
| `src/main/janus/maintenance/service.ts` | `BlueprintMaintenanceService` - LLM-driven maintenance singleton |
| `src/main/janus/maintenance/changeset.ts` | change-set operations, reverse operations, `scopeNodeIds`, `applyOperations`, `buildReverseOperations`, `groupMaintenanceOperations`, `resolveOperationRisk`, `buildGroupDigest`, `expandGroupSelection` |
| `src/main/janus/maintenance/blueprint-tools.ts` | `createJanusBlueprintTools`, `blueprintReadModelTool`, `blueprintNodeContext` |

## Knowledge

| File | Function |
|---|---|
| `src/shared/knowledge.ts` | canonical Knowledge entities and structured-clone-safe extensible values |
| `src/shared/knowledge-card.ts` | KnowledgeCard types, filtering, sorting |
| `src/shared/knowledge-settings.ts` | Knowledge settings types |
| `src/shared/ipc/knowledge.ts` | public Knowledge/Settings IPC contract including explicit auto-prune maintenance |
| `src/main/ipc/knowledge-handlers.ts` | public Knowledge handlers plus internal maintenance registration |
| `src/main/knowledge/contracts.ts` | Knowledge contract definitions |
| `src/main/knowledge/contract-service.ts` | contract service |
| `src/main/knowledge/observation-service.ts` | observation CRUD |
| `src/main/knowledge/search-service.ts` | search service |
| `src/main/knowledge/search/bm25.ts` | BM25 search implementation |
| `src/main/knowledge/search/tokenizer.ts` | text tokenizer |
| `src/main/knowledge/context-service.ts` | context assembly |
| `src/main/knowledge/recall-service.ts` | recall service |
| `src/main/knowledge/review-service.ts` | review service |
| `src/main/knowledge/truth-service.ts` | truth service |
| `src/main/knowledge/extract-service.ts` | extraction service (queue-driven; no direct `knowledge:extract` IPC) |
| `src/main/knowledge/processing-queue.ts` | queue-owned pipeline: cursors, failure ledger, `SerialQueue`, `processNow` |
| `src/main/knowledge/llm-stage.ts` | LLM sedimentation stage (batch 50, mode-gated) |
| `src/main/knowledge/deterministic-extractor.ts` | deterministic observation → candidate extraction |
| `src/main/knowledge/diagnostics-service.ts` | pipeline diagnostics counters |
| `src/main/knowledge/workspace-identity.ts` | per-workspace knowledge index identity |
| `src/main/knowledge/search/embedding-provider.ts` | embedding provider beside BM25 |
| `src/main/knowledge/external-mcp.ts` | Cursor/VS Code/Claude Code MCP registration (`janusx-knowledge` key merge + backup) |
| `src/main/knowledge/retention-classifier.ts` | observation retention scoring |
| `src/main/knowledge/operations-service.ts` | bulk operations |
| `src/main/knowledge/audit-service.ts` | audit service |
| `src/main/knowledge/agent-turn-recorder.ts` | agent interaction context capture |
| `src/main/knowledge/knowledge-mcp.ts` | Knowledge MCP server |
| `src/main/knowledge/knowledge-mcp-tools.ts` | Knowledge MCP tools: knowledge_search/context plus two-stage read (wiki_list, wiki_get, fact_get) |
| `src/main/knowledge/index.ts` | public re-exports |
| `src/main/knowledge/constants.ts` | knowledge constants |
| `src/renderer/src/services/knowledge.ts` | sole typed renderer Knowledge client with isolated workbench fallbacks |
| `src/renderer/src/services/knowledge-settings.ts` | typed Knowledge Settings client |

## Shared IPC Contracts

| File | Function |
|---|---|
| `src/shared/ipc/workspace.ts` | typed Workspace/File/FileTree constants, DTOs, results, events, and preload domain APIs |
| `src/shared/ipc/terminal.ts` | typed Terminal commands/events, payloads/results, and preload domain API |
| `src/shared/ipc/project.ts` | typed Project commands, clone-safe DTOs/results, and preload domain API |
| `src/shared/ipc/browser.ts` | typed Browser invoke/event channels, surface/tab state, and preload API |
| `src/shared/ipc/knowledge.ts` | typed public Knowledge/Settings commands, clone-safe DTOs/results, and preload domain API |
| `src/shared/ipc/agent-runtime.ts` | typed Agent Runtime channels, session/tool/policy/approval types, and preload API |
| `src/shared/ipc/janus-chat.ts` | typed Janus Chat channels, message/conversation DTOs, and preload API |
| `src/shared/ipc/language-service.ts` | typed Language Service channels, definition request/result, and preload API |
| `src/shared/ipc/agent.ts` | Agent + SubAgentRun channels, DTOs, and preload APIs |
| `src/shared/ipc/roundtable.ts` | Roundtable channels, state/event DTOs, and preload API |
| `src/shared/roundtable/*` | roundtable events/state/export/parchment/workflow-template/host-synthesis models |
| `src/shared/ipc/checkpoint.ts`, `git.ts`, `llm.ts`, `settings.ts`, `system.ts` | remaining fixed domain contracts, clone-safe DTOs, events, and preload APIs |
| `src/shared/janus/types.ts`, `src/shared/ipc/janus.ts` | shared Blueprint/Janus models plus typed command/event API |
| `src/preload/index.ts` | fixed typed adapters for all public renderer domains; no generic bridge |
| `src/renderer/src/types/electron.d.ts` | renderer declaration of the exposed preload API |

## Renderer Feature Boundaries

| File / Directory | Function |
|---|---|
| `src/renderer/src/features/workspace/actions.ts` | shared workspace selection, file-tree refresh, and mutation actions |
| `src/renderer/src/features/workspace/file-tree.ts` | file-tree loading and scanning |
| `src/renderer/src/features/workspace/useWorkspaceBootstrap.ts` | application workspace initialization and refresh lifecycle |
| `src/renderer/src/features/terminal/useTerminalLifecycle.ts` | terminal event subscription and cleanup boundary |
| `src/renderer/src/features/blueprint/canvas-layout.ts` | pure Blueprint graph layout derivation |
| `src/renderer/src/features/blueprint/canvas-navigation.ts` | canvas pan/zoom/focus navigation |
| `src/renderer/src/features/blueprint/adaptive-edge-geometry.ts` | adaptive edge routing |
| `src/renderer/src/features/blueprint/useBlueprintAnalysisActions.ts` | Blueprint analysis, apply, and candidate action orchestration |
| `src/renderer/src/features/blueprint/useBlueprintGraphController.ts` | graph state and node interaction controller |

## Renderer Stores and Services

| File | Function |
|---|---|
| `src/renderer/src/stores/app.ts` | app state, selected panels, load state, agent events |
| `src/renderer/src/stores/workspace.ts` | workspace state, terminals, pane tree |
| `src/renderer/src/stores/blueprint.ts` | Blueprint Zustand state |
| `src/renderer/src/stores/blueprint-maintenance.ts` | Blueprint maintenance Zustand state |
| `src/renderer/src/stores/browser.ts` | browser surface Zustand state |
| `src/renderer/src/stores/checkpoint.ts` | checkpoint state/actions |
| `src/renderer/src/stores/editor.ts` | editor tab state |
| `src/renderer/src/stores/git.ts` | git state/actions |
| `src/renderer/src/stores/note.ts` | quick note state |
| `src/renderer/src/stores/office.ts` | office state |
| `src/renderer/src/stores/right-tools.ts` | right tools dock state |
| `src/renderer/src/stores/subagent-run.ts` | subagent run state |
| `src/renderer/src/services/blueprint.ts` | sole typed renderer Blueprint/Janus client |
| `src/renderer/src/services/browser.ts` | typed browser surface client |
| `src/renderer/src/services/knowledge.ts` | sole typed Knowledge client |
| `src/renderer/src/services/knowledge-settings.ts` | typed Knowledge Settings client |
| `src/renderer/src/services/llm.ts` | renderer provider/chat/stream wrapper |
| `src/renderer/src/services/notification-settings.ts` | typed notification settings client |
| `src/renderer/src/services/office.ts` | typed Office client |
| `src/renderer/src/services/project.ts` | typed project detect/configure/run client |
| `src/renderer/src/services/workspace-launch-assistant.ts` | workspace launch assistant |

## Tests

| Area | Files |
|---|---|
| Root workspace/config | `tests/unit/workspace.test.ts`, `application-profile.test.ts` |
| Roundtable | `tests/unit/roundtable-*.test.ts` (workspace restore consistency, export, fail-loud agents) |
| Workspace IPC contract | `tests/unit/workspace-ipc-contract.test.ts` |
| Terminal | `tests/unit/terminal-*.test.ts` (10+ specs) |
| Package boundary | `tests/unit/package-boundary.test.ts` |
| Project config/IPC/service | `tests/unit/project-*.test.ts` |
| Knowledge IPC and workbench | `tests/unit/knowledge-ipc-contract.test.ts`, `tests/unit/knowledge/*.test.ts` |
| Knowledge pipeline desktop | `tests/e2e/knowledge-pipeline.spec.ts` |
| Blueprint/Janus IPC, maintenance, canvas | `tests/unit/blueprint-*.test.ts` (10+ specs) |
| Agent runtime, tools, policy, loop | `tests/unit/agent/*.test.ts` (15+ specs) |
| Companion gateway | `tests/unit/companion-*.test.ts` (5 specs) |
| Remote notifications | `tests/unit/remote-notification-dispatcher.test.ts` |
| Browser surface | `tests/unit/browser-*.test.ts` |
| Language service | `tests/unit/clangd-language-service.test.ts` |
| Editor | `tests/unit/editor-*.test.ts`, `monaco-theme.test.ts` |
| Notifications | `tests/unit/agent-notifier.test.ts`, `agent-hook-*.test.ts` |
| Office | `tests/unit/office/*.test.ts` (10+ specs) |
| Runtime telemetry | `tests/unit/runtime-telemetry*.test.ts` |
| App shutdown | `tests/unit/app-shutdown.test.ts` |
| i18n/development config | `tests/unit/development-llm-config-sync.test.ts`, `llm-proxy-refresh.test.ts` |
| Right tools | `tests/unit/right-tool-*.test.ts` |
| Notes | `tests/unit/note/*.test.ts` |
| Built desktop critical path | `tests/e2e/desktop-smoke.spec.ts` |
| Editor E2E | `tests/e2e/editor-definition.spec.ts`, `editor-find-widget.spec.ts`, `editor-window-tabs.spec.ts` |
| Blueprint capsule E2E | `tests/e2e/blueprint-janus-capsule.spec.ts` |
| Island browser interaction | `tests/e2e/island-interaction.spec.ts` |
| LLM core | `packages/llm-core/tests/*.test.ts` |
| Windows release gate | `package.json` (`npm run verify`) |
