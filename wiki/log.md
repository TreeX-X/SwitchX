# Wiki Log

## 2026-09-08

- Agent engine separation (P3′): deleted 28 local implementations (`agent/loop/*`, `agent/stream/*`, `agent/runtime/*` except `shell-runtime.ts` + shell `command/git/project-tools`, `agent/checkpoint/*`, `agent/environment/*`, `llm/{workspace-chat-tools,chat-session-runtime,system-prompt-builder,chat-agent-events}.ts`) — single source is now `@janus-agent/agent-core/chat-core` (+ `node-hosts` for CLI command/git/jobs). Shell keeps `shell-runtime.ts` assembly, maintenance/blueprint/knowledge/roundtable code, and 18 moved unit tests now run in-package; indexes 02/04 repointed.
- Found and fixed two real divergences during the move: package `CheckpointEngine` was narrower than the shell union (aligned to `'claude'|'codex'|'opencode'|'shell'|'manual'|'janus'|'pi'`), and package `createVercelStream` requires an explicit `streamTextFn` (maintenance now passes shell `streamText`).

## 2026-09-06

- Bumped wiki baseline from v0.8.0 (2026-08-17) to v0.8.2: `package.json` 0.8.2, preload 24 typed domains, 205 unit specs, 7 E2E specs.
- Promoted Roundtable from unlisted to first-class subsystem: `src/main/roundtable/` (service/runtime/store/agent-registry/workspace-tools), `src/shared/roundtable/` (events/state/export/parchment/workflow-template/host-synthesis), `roundtable:*` IPC + `registerRoundtableHandlers`, renderer `JanusRoundtablePane` / `RoundtableStage` / `JanusRoundtableParchment` / `roundtableExport` — added to README, 01, 02, 03 (deliberation flow), 04.
- Promoted Knowledge Phase 3-5 from log-only to main pages: queue-owned pipeline (`processing-queue.ts` cursors/failure ledger, `llm-stage.ts` batch 50, `deterministic-extractor.ts`, `diagnostics-service.ts`, `workspace-identity.ts`, `embedding-provider.ts`), `knowledge:extract` removal note, external MCP (`external-mcp.ts`, `knowledge:external-mcp:*`), `sortInboxCandidates` ordering, `knowledge-pipeline` E2E.
- Documented Language Service installer (`registry.ts` + `language-service-installer-handlers.ts`, window-authorized) and OfficeCLI pin (`officecli-manager.ts` 1.0.135); documented Janus reasoning region (`janusReasoning.ts` 4000-char UI-only buffer + `ThinkingRegion.tsx`, token cleanup, context-budget handoff).
- Fixed stale counts: `20+` → `24` IPC domains, `120+` → `205` unit specs, `5+` → `7` E2E specs; added maintenance triggers + `rg` checks for roundtable/knowledge-queue/installer drift.

## 2026-09-05

- P0 recall quality: wiki title-term overlap (`titleTerm`) and slug (`slugMatch`) score parts in `lexicalExplanation`; long wiki pages served as query-centered excerpts (`excerptAroundQuery`, 1500 chars) in `context-service` so one page can't eat the shared budget; wiki docs inherit file/observation provenance + workspace path from linked facts (also fixes path-scoped wiki discovery); `fact_get` gains reverse `referencingPages`.
- Documented ranking parts and excerpts in `03-runtime-flows.md`.

- Settings auto-registers the knowledge MCP server into external terminals: new `external-mcp` service (Cursor / VS Code / Claude Code JSON merge, corrupt-file backup, build-status gate), two IPC channels + preload/fallback, and an "外部终端 MCP 接入" section in the Knowledge settings tab (entry path, copy launch command, per-client connect buttons).
- `docs/idea/janus-todo-write-plan.md` fused with the janus-agent knowledge-MCP bridge design (§9: in-process `knowledge-tools.ts`, workspace-scoped read-only tools) and renamed to `janus-agent-capability-plan.md`.
- Knowledge MCP two-stage read: wired the Wiki → settled-fact bridge (`CandidateWikiPatch.sourceFactIds`, model-proposed and filtered to known truth like `supersedes`, unioned into `pages-index` on approval); MCP grows from two to five read-only tools — `wiki_list` (slug index), `wiki_get` (page + `maxChars` budget + resolved `linkedFacts`), `fact_get` (full provenance by id); fixed `failure()` swallowing string errors; documented the chain in `03-runtime-flows.md`.

- Knowledge workbench refinements: Inbox cards are fixed-height (216px) with title 3-line / summary 2-line ellipsis and single-line tags; full content stays in the inspector with hover tooltips.
- Inspector close control unified with Blueprint `.bp-panel-close` (28px ghost button + Lucide X); the workbench header keeps the single red traffic light.
- Knowledge graph reworked to an Obsidian-style settled-knowledge map: truth-only adapter (facts, wiki pages, stored edges, shared concept/file entities; review proposals stay in the Inbox), dark-core ring dots sized 10–22px by connection degree with floating captions, deterministic force-spread layout with persisted drags, hover neighborhood highlight, click-to-focus (toggle) with distant nodes hidden, double-click zoom, dark controls/minimap, stage-consistent canvas background, and explicit no-edges guidance.
- Documented the graph canvas contract in `03-runtime-flows.md` (scope, rendering, interaction, inspector integration).
- i18n additions: `graph.canvas.noEdges`, refreshed canvas hint, settled-knowledge empty state (both languages, types in sync).

## 2026-08-17

- Full wiki rewrite to reflect v0.8.0 project state (was v0.5.0 baseline).
- Documented new main-process subsystems: Agent Runtime (`src/main/agent/runtime/`), Janus Agent Loop (`src/main/agent/loop/`), Companion Gateway (`src/main/companion/`), Remote Notifications (`src/main/remote-notifications/`), Browser Surface (`src/main/browser/`), Language Service (`src/main/language-service/`), Blueprint Maintenance (`src/main/janus/maintenance/`), Janus Chat Store, Chat Orchestration, Model Catalog, Development Config Sync.
- Documented new IPC domains: `agentRuntime`, `browser`, `janusChat`, `languageService` — preload now exposes 20+ typed domain APIs.
- Documented new shared contracts: `agent-runtime.ts`, `browser.ts`, `janus-chat.ts`, `language-service.ts`, `maintenance-types.ts`, `relations.ts`, `knowledge-card.ts`, `knowledge-settings.ts`, `terminalPaste.ts`, `workspace-sidebar.ts`, `subAgentRun.ts`.
- Documented new renderer modules: i18n framework, right-tools dock, Quick Notes, Workbench Switcher, FileExplorer tool, browser surface UI, blueprint graph controller, adaptive edge geometry, canvas navigation, blueprint maintenance panel, editor find/tabs/definition, DesktopToastApp.
- Documented new LLM modules: `chat-orchestrator.ts`, `ai-runtime.ts`, `workspace-chat-tools.ts`, `ModelCatalogService.ts`, `development-config-sync.ts`.
- Documented new knowledge modules: BM25 search, tokenizer, recall service, retention classifier, agent turn recorder, knowledge MCP.
- Updated commands table with i18n pipeline (`i18n:extract`, `i18n:types`, `i18n:check`, `i18n`), models update, and expanded verify gate.
- Updated file index to cover all current source files across main, renderer, shared, and packages.
- Updated module map with all new main-process, renderer, and shared modules.
- Updated runtime flows: agent runtime, Janus agent loop, browser surface, companion gateway, language service, blueprint maintenance, Janus chat persistence.
- Updated maintenance page with new update triggers and pending decisions for new subsystems.
- Updated architecture optimization plan with post-v0.5 evolution table documenting 30+ new subsystems.
- Updated data persistence table with policy audit, companion audit, remote delivery store, and Janus chat store locations.
- Updated test coverage table with companion, remote notification, browser, language service, editor, blueprint maintenance, and i18n test areas.

## 2026-07-17

- Closed the Phase 1-5 modular-monolith architecture optimization at commit `c6bc283`.
- Recorded repository cleanup and package isolation: dead tracked paths removed, historical screenshots archived outside `out/`, and fail-closed Electron runtime packaging enforced.
- Documented the completed IPC boundary: shared contracts and fixed typed preload APIs now cover every renderer-accessible domain; generic bridges and channel allowlists were removed.
- Documented main-process composition boundaries under `bootstrap/`, `windows/`, and `ipc/register.ts`; `src/main/index.ts` is now a lifecycle coordinator.
- Documented renderer feature boundaries for Workspace bootstrap/actions, Terminal lifecycle, and Blueprint layout/analysis.
- Recorded the unified Windows release gate: both type checks and test suites, strict-unused, production build, package-boundary validation, and built-Electron Workspace/Terminal/Project smoke.
- Replaced stale Wiki gaps with four non-blocking pending decisions: `design/` ownership, Knowledge auto-prune scheduling, Project lifecycle event consumption, and explicit root workspace dependency confirmation.
- Isolated `npm run dev` under `%APPDATA%/JanusX-Dev`, allowing the packaged workbench and hot-reload development app to run concurrently while each remains single-instance.

## 2026-06-30

- Created initial Agent-facing JanusX wiki.
- Added project quickstart, architecture map, module map, runtime flows, file index, and maintenance rules.
- Added `AGENTS.md` quickstart pointer to `wiki/README.md`.
