# janus-agent 全量迁移彻底分离方案（JanusX 瘦身为壳）

> 状态：❌ 已作废（2026-09-08，范围纠偏）。
> 作废原因：用户明确范围是“agent 基本能力”，蓝图、知识库、圆桌编排、模型管理（LlmService/llm-core）**全部留在 JanusX**，不迁移。本文的 M1/M4/M5/M6（model/knowledge/blueprint/roundtable 进包）与该口径冲突，整份作废，仅保留 §1 盘点数据备查。
> 现行方案：`docs/idea/janus-agent-分离补齐与收敛实施方案.md`（已恢复为主文档）。
> 日期：2026-09-08
> 前置：`docs/idea/janus-agent-分离补齐与收敛实施方案.md`（P0/P2 已合入；P1 已取消；P3/P4/P5 被本文取代）
> 盘点依据：2026-09-08 全量文件清单 + `from 'electron'` 边界 grep（59 命中，agent 相关仅 12 文件）+ 各文件行数实测

## 0. 需求声明（用户原意，一字不改执行）

> JanusX 原本的 agent 能力，全部迁移到 janus-agentX 中；后续的工具更新等，都不在本库 JanusX 中维护了；彻底分离，模块化管理。

终态定义：

- **janus-agentX = 唯一真相源**：所有 agent 逻辑、全部工具实现、知识库、蓝图/维护、圆桌、模型层只在这里维护。此后任何工具新增/改名/改参只改 janus-agentX，发版后 JanusX 跟随升级依赖。
- **JanusX = 壳（host）**：只保留 Electron 进程接线（`ipcMain` thin handlers、BrowserWindow 扇出、单例装配、用户目录解析）、preload、渲染端、以及非 agent 业务域（office、notifications、terminal UI、language-service 等）。壳内**零 agent 逻辑、零工具实现**。
- 铁律：janus-agentX 全包 **`import electron` 零容忍**（类型 import 也不允许，用 ports 类型代替，如 `HostIpcEvent` 先例）。

## 1. 为什么彻底分离可行（边界实测结论）

agent 相关 59 处 electron 引用中，实质只有四类壳依赖，全部有现成解法：

| 壳依赖 | 出现位置 | 解法（已有先例） |
|---|---|---|
| `app.getPath('userData')` 取路径 | blueprint-paths、chat-store、roundtable store/service、knowledge external-mcp/workspace-identity、ConfigStore、ModelCatalogService、maintenance audit 目录 | 注入 `dataRoot/userDataDir`（blueprint-paths 已有 `dataRootOverride` 先例；`FilePolicyAuditStore(rootDir)` 先例） |
| `mainWindow.webContents.send` 发事件 | analyzer、maintenance/service | 注入事件扇出端口（`WorkspaceAgentRuntime onEvent` 先例） |
| `ipcMain` / `BrowserWindow` 接线 | `src/main/ipc/*-handlers.ts` | **永久留壳**，但压成透传层：参数校验 + 调包 + 回包，无业务逻辑 |
| `LlmService` 的 `session/proxy` | `LlmService.ts:60-68` | 代理应用留在壳内薄适配；provider/keys/目录进包 |

其余 ~1.7 万行（见 §3）全是纯 Node/纯逻辑，可整体搬迁。

## 2. 目标包结构（4 存量 + 5 新增）

| 包 | 内容 | 来源（行数实测） |
|---|---|---|
| `@janus-agent/agent-core`（存量） | loop/stream/runtime/policy/workspace 工具/checkpoint + 补 parsers、subagent-registry、todo 状态机 | 已有；新增 `agent/parsers/*`（230）、`subagent-run-registry.ts`（132） |
| `@janus-agent/chat-core`（存量） | session/prompt/events/chat-pure | 已有 |
| `@janus-agent/janus-agent`（存量） | `runChatTurn` facade | 已有 |
| `@janus-agent/cli`（存量） | CLI；`src/tools/` **移交**给 node-hosts（见 M2） | 已有 |
| `@janus-agent/model-core`（新增 M1） | provider 目录/keys/模型传输 + 配置存储 | `packages/llm-core/src`（整体搬，约 16 文件）+ `llm/LlmService.ts`（264，剥掉 proxy 应用）+ `ModelCatalogService.ts`（242）+ `ConfigStore.ts`（156）+ `ai-runtime.ts`（4） |
| `@janus-agent/node-hosts`（新增 M2–M3） | CommandHost/GitHost/ProjectHost 纯 Node 实现：同步+后台任务、git spawn、工程探测 | `cli/src/tools/{command,git}.ts`（P2 产物，移入）+ `project/runner/*`（1017）+ `project/detector/*`（279）+ `project/config/*`（965）+ `git/service.ts`（397）+ 后台任务管理器（替代 Runner.runAdhoc，见 M3） |
| `@janus-agent/knowledge-core`（新增 M4） | 全部知识服务 | `knowledge/*`（约 6900 行，见 §3 分批） |
| `@janus-agent/blueprint-core`（新增 M5） | 蓝图存储/分析/维护全套 | `janus/*` + `janus/maintenance/*`（约 4300 行） |
| `@janus-agent/roundtable-core`（新增 M6） | 圆桌运行时 | `roundtable/*`（763） |

JanusX 终态残留（agent 域）：`src/main/ipc/*` 透传 handlers、`llm/chat-orchestrator.ts` + `janus-agent-ports.ts`（壳适配器，永久保留）、`config/service.ts`（用户配置源，经 ports 供给）、各包的装配代码（`services.ts`/bootstrap）。

## 3. 源文件→包映射（含行数，按包分批）

### M1 model-core（约 2000 行，先行：它是所有 LLM 调用的地基）

- `packages/llm-core/src/**` → `model-core/src/`（整体搬，目录结构不变；包名 `@janus-agent/model-core`；JanusX 的 `file:packages/llm-core` 依赖改指包，`@janusx/llm-core` import 全仓替换）
- `llm/ModelCatalogService.ts`（242）：`cachePath` 已支持 options 注入，`app.getPath` 只做默认 → 搬，默认路径由壳传入
- `llm/ConfigStore.ts`（156）：`configPath` 构造器注入 → 搬
- `llm/LlmService.ts`（264）：拆两半——provider 解析/keys/请求构造进包；`session.defaultSession` 代理应用留壳薄函数 `applyProxyToElectronSession(config)`（仍在 JanusX，供装配调用）
- `llm/ai-runtime.ts`（4）、`development-config-sync.ts`（121）：前者随包，后者看内容归属（同步逻辑进包，触发点留壳），搬迁时定

### M2 node-hosts 之一：command + git（P2 产物移交，约 1100 行）

- `janus-agentX/packages/cli/src/tools/command.ts` + `git.ts` → `node-hosts/src/{command,git}.ts`（**移动不是复制**；CLI 改从包 import；JanusX 删 `agent/runtime/tools/{command,git}-tools.ts`，改注册包版本）
- 壳版独有语义对齐进包：Windows shim（两边已一致）、env allowlist（已一致）、8KB 预览 + `.janusX/logs`（已一致）
- JanusX 删文件后：`agent-runtime-handlers.ts` 的工具注册改调包的 `registerXxxTools`

### M3 node-hosts 之二：后台任务 + project.*（约 2700 行，最重的一批）

- 后台任务管理器（新增，`node-hosts/src/jobs/`）：替代 `ProjectRunner.runAdhoc` 的最小子集——detached spawn + 磁盘日志 + `projectId` + 超时 kill + `timedOut` + 退出快照 + `process-output` 分页读。CLI 的 `command.run background:true` 拒绝令同步解除；JanusX 的后台链路改调它。
- `project/runner/{runner,command-builder,task-runner}.ts`（1003）：任务执行核进包（`EventEmitter` 换端口回调）；Electron 相关（通知等）剥离留壳
- `project/detector/*`（279）+ `project/config/*`（965）：纯逻辑，整体搬
- `project/*-tools.ts`（`project.detect/generate/apply/list/start/stop/process-output`）：逻辑进包，JanusX 删本地版；`project.start-process` 的 LaunchConfig 存取经 dataRoot 端口
- `git/service.ts`（397）：如 node-hosts 的 git spawn 已覆盖其能力，删壳版；有独占语义先合入包

### M4 knowledge-core（约 6900 行，分 4 批）

- 批 1（纯逻辑，约 900）：`search/{bm25,tokenizer,embedding-provider}.ts`、`constants.ts`、`contracts.ts`、`deterministic-extractor.ts`（661）、`retention-classifier.ts`（112）
- 批 2（读写服务，约 1500）：`search-service.ts`、`context-service.ts`、`recall-service.ts`（734）、`contract-service.ts`、`truth-service.ts`（232）、`workspace-identity.ts`（144，`app`→dataRoot 端口）
- 批 3（写入管线，约 2300）：`observation-service.ts`（981）、`agent-turn-recorder.ts`（390）、`extract-service.ts`（730）、`llm-stage.ts`（81，LLM 调用经 model 端口）、`review-service.ts`（562）、`operations-service.ts`（184）
- 批 4（编排与出口，约 2200）：`processing-queue.ts`（721，定时器经时钟端口以便测试）、`audit-service.ts`、`diagnostics-service.ts`、`knowledge-mcp-tools.ts`（223，工具定义进包；stdio 服务端入口留壳 `out/main/knowledge-mcp.js`，逻辑调包）、`external-mcp.ts`（192，`app`→端口）、`index.ts`
- ports（参考 agent-core PORTS.md 另起 `knowledge-core/PORTS.md`）：`dataRoot`、`llmGenerate`/`llmEmbed`、`eventSink`、`clock`、` HeavyJobQueue`（如需）
- knowledge 工具（capability-plan §9 的 5 只读工具）：实现放在 knowledge-core，JanusX/CLI 经 registry 注册（关旧方案 P4 落位争议，以此为准）
- `todo_write`（capability-plan §5）：纯状态机进 agent-core，存储/渲染接线留壳（关旧方案 P4，以此为准）

### M5 blueprint-core（约 4300 行，分 3 批）

- 批 1（存储，约 1400）：`blueprint-paths.ts`（47，`dataRootOverride` 转正式端口）、`blueprint-persistence.ts`、`blueprint-factory.ts`、`blueprint-migration.ts`、`requirement-candidates.ts`、`chat-store.ts`（117，`app`→端口）
- 批 2（store + 分析，约 1900）：`blueprint-store.ts`（1075）、`analyzer.ts`（831，`webContents.send`→事件端口）
- 批 3（维护，约 1900）：`maintenance/changeset.ts`（795，纯逻辑先行）、`maintenance/blueprint-tools.ts`、`maintenance/service.ts`（1005，`app`→audit 目录端口、`mainWindow`→事件端口、LLM 经 model 端口）
- JanusX 删对应本地文件；`janus-handlers.ts` 压成透传

### M6 roundtable-core（763 行，一批）

- `roundtable/{agent-registry,runtime,service,store,workspace-tools}.ts`：`app`→端口，LLM 经 model 端口，事件经扇出端口；JanusX `roundtable-handlers.ts` 压成透传

### M7 agent-core 补齐 + 遗留决策（约 800 行）

- `agent/parsers/*`（230）、`subagent-run-registry.ts`（132，`BrowserWindow` 类型→`HostWindow` 端口类型，仿 `HostIpcEvent`）进 agent-core
- `agent/cli-resolver.ts`（176）：归 node-hosts（路径解析是宿主能力）或留壳，搬迁时按调用方定
- `agent/stream-manager.ts`（约 260）：**决策点**——它编排的是外部 CLI 子进程（claude/codex）+ 桌面终端，不是 janus-agent 本体。建议留壳（桌面终端 concern），parsers 已进包；如坚持全迁，则 spawn/pty 经端口进 node-hosts，另起 M-slot
- `agent/types.ts`：有包内对等物则删，无则并入

### M8 收尾

- JanusX agent 域删文件确认：`agent/{loop,stream,runtime/checkpoint/environment}`（P3′ 第 1 批，早于 M2–M6 即可做）、`llm/{workspace-chat-tools,chat-session-runtime,system-prompt-builder,chat-agent-events}.ts`（re-export 转包或删）、重复 `shared/*` 类型
- 单测归位：纯逻辑单测随模块进包；JanusX 只留 twin/透传测试
- 文档：每包一个 `PORTS.md`；根 README 包表更新；旧方案文档标 superseded
- `verify` 全链 + 打包检查（`check-package-boundary` 应仍过：包走 `file:` 进 bundle，与今日 chat 链路同理）

## 4. 迁移 mechanics（每批统一动作，违者打回）

1. **整体搬迁，逐行负责**：文件原样拷入包内镜像路径，只改三类行——electron import→端口、跨包相对 import→包 import、单例→构造器/工厂注入。禁止顺手重构。
2. **端口五件套**（按需取用，不臆造）：`dataRoot`、`eventSink`、`modelTransport`（复用 `streamTextFn` 形态 + `llmGenerate`）、`keyStore`、`clock`。新端口必须记入对应包的 `PORTS.md`。
3. **单测跟模块走**：搬文件必须同时搬/补单测；搬迁批的验收含 janus-agentX 全包绿 + JanusX 相关域绿。
4. **构建顺序铁律**：改包 src → janus-agentX `npm run build`（JanusX 消费 `dist`）→ 回 JanusX 验证。违者测到旧构建。
5. **原子合入**：一批 = “包内新增 + JanusX 改道 + 本地删除 + 单测搬迁”，一次合入，一次可 revert。不允许“两边各留一份长期并存”（P1 已取消的原因）。
6. **命名契约冻结**：工具名、IPC 通道名、事件名搬迁期冻结；改名必须双仓同发（`tools-contract.test.ts` 门禁保留并扩展到新工具）。

## 5. 阶段顺序与依赖

```text
M1 model-core ─┬─→ M2 node-hosts(cmd/git) ─→ M3 node-hosts(jobs/project)
               │         ↓（CLI 改用包版本，删 cli/src/tools）
               ├─→ M4 knowledge-core（4 批，可与 M2/M3 并行）
               ├─→ M5 blueprint-core（3 批；maintenance 需 model-core 就绪）
               ├─→ M6 roundtable-core（需 model-core 就绪）
               └─→ M7 agent-core 补齐（含 stream-manager 决策）
M8 收尾（删文件确认、单测归位、文档、verify+打包）
```

P0/P2 已合入计入 M2 前置完成。M4/M5/M6 之间无依赖，可并行开工（不同包、无共享文件）。

## 6. 验证总表（每批通用）

| 位置 | 命令 | 期望 |
|---|---|---|
| janus-agentX 根 | `npm run typecheck` | 0 错误 |
| janus-agentX 根 | `npm run build` | 成功（改 src 后必跑） |
| janus-agentX 根 | `npm run test` | 全绿 |
| JanusX 根 | `npm run typecheck` | 0 错误 |
| JanusX 根 | `npm run test:unit -- --run <本批相关域>` | 全绿 |
| JanusX 根 | `npm run lint` | 改动文件 0 错误 |
| JanusX 根 | `npm run verify`（M8 及大批） | 全链绿 |
| 打包 | `check-package-boundary`（M8） | 过 |

铁律：不声称未跑过的检查；验收前真实执行并记录结果。

## 7. 风险与控制

| 风险 | 控制 |
|---|---|
| 总量 ~1.7 万行，一次搬崩 | M1–M8 拆 15+ 原子批，每批独立合入回退；先小（M1/M7）后大（M4/M5） |
| 搬迁期行为漂移无人发现 | 单测跟模块走 + twin/透传测试留壳；每批手工链路抽查（chat/维护/知识/圆桌各一） |
| 改包忘 build 测到旧 dist | §4 第 4 条铁律；CI 如有条件加 build-then-test 顺序门 |
| 工具名/IPC/事件名误改致静默失效 | §4 第 6 条冻结 + contract 测试扩展 |
| knowledge 存储语义变化（路径/格式） | 存储路径与文件格式搬迁期冻结，只换代码位置；dataRoot 默认值与壳今日行为字节一致 |
| LlmService 代理语义丢失 | proxy 应用函数留壳并保留单测；包内 model-core 不感知 Electron session |
| 范围蔓延（顺手重构/加能力） | §4 第 1 条；超范围先改本文档 |

## 8. 决策点（开工前或搬迁时拍板，留记录）

1. `stream-manager` + `cli-resolver` + 桌面终端 handlers：建议留壳（外部 CLI 编排属桌面终端 concern）；全迁则进 node-hosts 另起 slot。
2. `project.*` 在 CLI 是否可见：默认不可见（无 Runner 语义）；如 CLI 要 `project.detect` 等只读能力，M3 时开放子集。
3. knowledge 定时/队列语义：`processing-queue` 时钟端口化（可测）vs 直接沿用；默认端口化。
4. 包粒度：knowledge-core 是否拆 `knowledge-search` 子包——默认不拆，超 8000 行再议。
5. 版本策略：janus-agentX 各包独立版本号 vs 同步版本——默认同步（`0.x` 阶段），1.0 前再议。
