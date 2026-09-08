# Start Here

Last analyzed: 2026-09-06

## Project Identity

JanusX is a desktop workspace manager for AI-assisted development. It combines:

- multi-workspace navigation with file tree, editor tabs, and browser panes,
- multiple terminal sessions and panes with drag-to-split,
- Claude/Codex/OpenCode/shell terminal presets,
- Agent CLI process streaming (Claude/Codex/OpenCode),
- Janus Agent Runtime with workspace tools (read/edit/create/search), git tools, project tools, and command execution,
- checkpoint snapshots and restore,
- project detection and launch management with process runner,
- LLM provider configuration, model catalog, and chat orchestration,
- Janus chat with persisted conversations, reasoning region (bounded buffer, UI-only), and roundtable deliberation (multi-agent staged workflow with workspace evidence, parchment export, restore consistency);
- Janus island chat/roundtable surfaces (`JanusIsland`, `RoundtableStage`, `JanusRoundtableParchment`, `ThinkingRegion`);
- Janus Blueprint planning, analysis, and controlled maintenance (change-set operations),
- Knowledge workbench (observations, search, context, review, truth, feedback) with queue-owned pipeline (deterministic + LLM stages, per-workspace cursors, failure ledger), weighted recall, external MCP registration for Cursor/VS Code/Claude Code;
- Language service (clangd LSP for go-to-definition) with managed binary installer;
- Office tooling (CLI with `officecli-manager`, artifacts, watchers, previews, exports, launcher/MCP binaries);
- Companion gateway for Feishu remote terminal control,
- Remote notifications (Feishu provider, inbound router, delivery store),
- Browser surface management (embedded panes and standalone windows),
- i18n (en, zh-CN) with extraction, type generation, and completeness check.

`package.json` identifies the app as `janusx` version `0.8.2`.

## Commands

Use these root commands:

| Command | Purpose |
|---|---|
| `npm run dev` | build `@janusx/llm-core`, then start Electron dev server |
| `npm run build` | build `@janusx/llm-core`, then Electron production build |
| `npm run build:llm-core` | build workspace package |
| `npm run preview` | electron-vite preview |
| `npm run test:unit` | run root Vitest tests |
| `npm run test:e2e` | run Playwright browser E2E (island + editor specs) |
| `npm run test:e2e:island` | browser-only Janus Island interaction spec |
| `npm run test:e2e:desktop` | built-Electron Workspace/Terminal/Project smoke |
| `npm run test:llm-core` | run `packages/llm-core` tests |
| `npm run typecheck` | TypeScript check for root `src` |
| `npm run typecheck:llm-core` | TypeScript check for LLM package |
| `npm run typecheck:strict-unused` | no-emit unused-symbol regression check |
| `npm run lint` | ESLint on `src` |
| `npm run check:package-boundary` | fail-closed Electron package input/output validation |
| `npm run check:packaged-runtime` | verify packaged runtime files |
| `npm run check:portable-runtime` | verify portable runtime files |
| `npm run i18n:extract` | extract i18n keys from source |
| `npm run i18n:types` | generate i18n TypeScript types |
| `npm run i18n:check` | check i18n key completeness |
| `npm run i18n` | run extract + types + check in sequence |
| `npm run models:update:openrouter` | update OpenRouter model registry from API |
| `npm run verify` | unified release gate: type checks, tests, strict-unused, build, package boundary, i18n check, lint, and desktop smoke |
| `npm run package:win/mac/linux` | build distributable packages |

## File Operation Constraints

Use normal file tools by default. If a direct source read fails, is garbled, or the file is known to have encoding/encryption issues, fall back to `rg` and precise replacements. Avoid whole-file rewrites of affected encoded source.

Safe examples:

```bash
rg -n "registerLlmHandlers" src/main
rg -n "export function|export class|ipcMain.handle" src/main/ipc
```

## Repo Layout Snapshot

| Path | Purpose |
|---|---|
| `src/main` | Electron lifecycle, bootstrap services, windows, IPC composition, and domain services |
| `src/preload` | preload bridge exposing fixed typed domain APIs to renderer |
| `src/renderer/src` | React renderer app, stores, services, UI components, i18n, hooks |
| `src/shared` | pure cross-process models, terminal metadata, notifications, Office DTOs, knowledge, janus, roundtable (`events/state/export/parchment/workflow-template/host-synthesis`), and typed IPC contracts |
| `src/main/roundtable` | multi-agent deliberation service/runtime/store with workspace evidence binding |
| `packages/llm-core` | separate TypeScript workspace package for Provider abstraction/adapters |
| `tests/unit` | root unit and contract coverage (205 specs) for all IPC domains, agent runtime, roundtable, companion, remote notifications, browser, language service + installer, blueprint maintenance, knowledge pipeline, office, terminal, project, workspace, editor, and i18n |
| `tests/e2e` | Playwright E2E: desktop smoke, island interaction, editor definition/find/tabs, blueprint capsule, knowledge pipeline |
| `packages/llm-core/tests` | LLM core tests |
| `scripts` | build helpers: package-boundary check, packaged-runtime check, i18n type generation, i18n check, OpenRouter model update |
| `design` | HTML prototypes, icon docs, visual assets |
| `.codex` | WorkflowX Codex configuration, subagent definitions, and skills |
| `wiki` | this Agent-facing project map |
| `resources` | Electron app icons and platform resources |

## Development Risk Notes

- Packaged JanusX uses its existing application profile, while `npm run dev` uses `%APPDATA%/JanusX-Dev`. They can run concurrently, but their application settings and cached workspace metadata are intentionally isolated.
- `BlueprintCanvas.tsx` and `TerminalArea.tsx` remain large cohesive views, but Blueprint layout/analysis/graph-controller and Terminal lifecycle responsibilities now live under `src/renderer/src/features/`. Split further only when responsibilities actually diverge.
- Canonical Blueprint/Janus models live in `src/shared/janus/types.ts`; `src/main/janus/types.ts` is a compatibility re-export and must not become the renderer contract owner again.
- Blueprint maintenance types live in `src/shared/janus/maintenance-types.ts`; relation invariants live in `src/shared/janus/relations.ts`.
- Terminal checkpoints are coupled to `terminal:submit-line` and terminal lifecycle in `src/main/ipc/terminal-handlers.ts`.
- Runtime data is split between workspace `.janusX` folders and Electron `userData/janusx`.
- Agent Runtime lives in `@janus-agent/agent-core` (policy gate, path guard, registry, loop/stream, checkpoint, workspace tools); the shell only assembles it (`src/main/agent/runtime/shell-runtime.ts`: file-audit singleton + renderer authorizer).
- Companion gateway binds Feishu sessions to terminals via `CompanionBindingStore`; terminal creation rollback ensures cleanup on failure.
- Janus chat conversations are persisted via `JanusChatStore` in `userData/janusx/`; reasoning text (`janusReasoning.ts`, 4000-char bounded buffer) is UI-only and never enters streamed text.
- Roundtable sessions bind workspace resources via `resolveRegisteredWorkspace`; agents get read-only workspace tools (`workspace.list/read/readRange`) and fail loudly on error; export is human-readable markdown parchment.
- Knowledge processing is queue-owned (`processing-queue.ts` per-workspace cursors + failure ledger, `llm-stage.ts` batch limit 50, `deterministic-extractor.ts`); `knowledge:extract` direct IPC is removed — LLM enhancement runs only via the queue.
- External MCP registration (`external-mcp.ts`) merges only the `janusx-knowledge` key into Cursor/VS Code/Claude Code configs; corrupt JSON is backed up before rewrite.
- Language service binaries are managed installs (`language-service-installer-handlers.ts` + `language-service/registry.ts`); OfficeCLI probing is pinned (`officecli-manager.ts`, `SUPPORTED_VERSION`).
- i18n locale files must stay in sync; run `npm run i18n` before committing UI text changes.
