# janus-agent 分离补齐与收敛实施方案

> 状态：现行主文档（2026-09-08 范围纠偏后恢复）。
> 口径（用户声明）：迁移的是 **agent 基本能力**——对话循环、runtime、文件/命令/git 等底层工具、模型传输、会话预算；**蓝图、知识库、圆桌编排、模型管理（LlmService/llm-core）全部留在 JanusX**；janus-agent 以 CLI 形态充分展开，底层能力被 JanusX 接入使用。
> 历史记录：P0 ✅ / P2 ✅ / P6-1 ✅ / P6-2 ✅ / P3′ ✅（第1+2批）/ P5 ✅ / P3′-3 ✅（2026-09-08 已合入）；P1 ❌ 已取消；《全量迁移彻底分离方案》❌ 已作废；P4/P6-3 待排（用户明确 P4 暂缓，先稳定）。
> 进展：P0 ✅ 2026-09-08 — janus-agentX 描述/Scope/Non-goals/pending P5 落字，`npm run typecheck` 4 包 0 错误，`npm run test` 133 通过（11+9+109+4）
> 进展：P2 ✅ 2026-09-08 — CLI `command.run` + `git.*` 纯 Node 实现 + 15 用例，`project.*` 驻壳书面化（决策反转记录见 §3 P2）
> 日期：2026-09-08
> 前置分析：janus-agent 能力迁移完整性分析（2026-09-08，见 §1 结论表）
> 范围：JanusX 仓（`C:\Users\Tree\Desktop\git\JanusX`）+ 兄弟仓 janus-agentX（`C:\Users\Tree\Desktop\git\janus-agentX`，`file:../janus-agentX` 本地依赖）
> 约束：遵循 `engineeringX`（最小改动、可追溯、实际验证、不声称未跑过的检查）；每阶段独立可合入，任一阶段变红即停修
> 参考：
> - `janus-agentX/packages/agent-core/src/main/agent/PORTS.md`（端口契约，唯一的正式分离文档）
> - `janus-agentX/README.md` + 各包 `package.json`
> - janus-agentX 提交 `ed5dc9e`（Phase1）/ `46d07b9`（Phase2）/ `e037e69`（Phase3）/ `adaf1a9`（Phase4）/ `7f38208`（范围收缩）
> - `docs/idea/janus-agent-capability-plan.md` §9（knowledge 只读工具）、§5（`todo_write`）
> - `docs/idea/蓝图维护节点完整接入janus-agent与审批精简方案.md` §3（维护链路与 janus-chat 同构要求）

## 1. 现状结论（本方案的输入，不重复论证）

| # | 能力面 | 状态 | 证据 |
|---|---|---|---|
| 1 | 对话 loop / stream / steering（R6-full） | ✅ 已迁移 | `JanusX/src/main/agent/loop/janus-agent-loop.ts` 与包内版 hash 一致（`B1B5D3D3…`，14408 字节） |
| 2 | runtime：policy / path-guard / registry / manifest / result / transaction | ✅ 已迁移 | `agent-core/src/index.ts:49-80` barrel 导出 |
| 3 | workspace 读写 5 工具 + chat 层 21 工具名契约 | ✅ 已迁移 | `agent-core/tests/tools-contract.test.ts:10-45` |
| 4 | checkpoint / workspace-fs / atomic-file | ✅ 已迁移 | 包内文件存在且 JanusX chat 链路经包调用 |
| 5 | `ChatSessionRuntime` / system-prompt / agent-event / chat-pure / `runChatTurn` | ✅ 已迁移 | 双仓三文件 diff 仅 import 深度 + interface 导出（`Compare-Object` 实测，行数一致 268/268、369/369） |
| 6 | command / git 工具实现 | ✅ 唯一实现在 `@janus-agent/node-hosts`（CLI 在用；壳接入延期） | 工具名契约不变；壳版 `command/git-tools.ts` 保留至 Runner 解耦（P6 记录原因） |
| 7 | CLI 的工具能力 | ✅ workspace + command + git + 后台任务（project job 三件套） | `session-tools.test.ts` 17 工具接线断言；知识仍无（有意，P4 为壳内特性） |
| 8 | 蓝图维护 `maintenance/service.ts` | ❌ 仍走本地实现 | `JanusX/src/main/janus/maintenance/service.ts:15-29` 全 import 本地 `../../agent/*`、`../../llm/*` |
| 9 | P5 十文件 + P3′-3 shared 类型 | ✅ 全部定案（留壳/双份，见 P5/P3′-3） | 终端契约簇不符合进包标准；shared 删文件会污染 renderer bundle |
| 10 | `package.json` 范围声明 | ✅ 已修正（P0） | 描述/ Scope/Non-goals 与实际一致；pending P5 已记录 |
| 11 | `todo_write` / knowledge 只读 5 工具（capability-plan §5/§9） | ❌ 两边都没落地 | 双仓 grep 无实现 |
| 12 | 本地实现与包拷贝双源并存 | ➡️ P3′ 删除本地，不再同步 | P1 parity 已取消；终态 JanusX 本地只留壳适配器 + 驻壳模块 |

关键机制提醒（影响所有阶段的验证顺序）：`@janus-agent/*` 各包 `main/exports` 指向 `dist`（已确认 agent-core `package.json:6-13`），JanusX 经 `file:../janus-agentX` 引用的是**构建产物**。因此：改 janus-agentX 的 `src` 后，必须先在 janus-agentX 跑 `npm run build`，再回 JanusX 验证，否则测的是旧 `dist`。

## 2. 目标与非目标（2026-09-08 口径锁定）

进 janus-agentX 的（agent 基本能力，此后只在这里维护）：

1. 对话循环/流/steering、runtime（policy/path/registry/manifest/result/transaction/audit）、checkpoint、workspace 文件工具、chat 会话预算/prompt/事件、`runChatTurn` facade、模型传输（CLI 侧 providers + transport）。
2. 底层工具实现：`command.run`、`git.*`（已在 CLI 包内，见 P2；下一步抽成 `node-hosts` 包供 JanusX 接入，见 P6）。
3. 纯 agent 注册表/解析器：`subagent-run-registry`、`parsers/*`（见 P5）。

永久留在 JanusX 的（产品能力 + 壳，不是“暂不迁”）：

- 蓝图全套（含维护 service：**代码留壳**，但改调包内 loop——消费底层能力，见 P3′ 第 2 批）。
- 知识库全套（含 knowledge 工具、`todo_write`：代码留壳，见 P4）。
- 圆桌编排全套（代码留壳；如需 loop 能力经包调用，不搬代码）。
- 模型管理（LlmService/llm-core/ConfigStore/ModelCatalog）、project Runner + `project.*` 工具、`stream-manager`/`cli-resolver`/桌面终端、全部 IPC handlers、渲染端。

非目标（明确不做）：

- 不把知识/蓝图/圆桌/模型管理的实现迁入包内。
- 不引入 `shell.run`、不做容器隔离（沿用既有安全决策）。
- 不一次性删除 JanusX 本地重复文件；删除只发生在对应消费方切包完成后（P3′）。

## 3. 分阶段实施

### P0 文档收敛（只改 3 个文件，零代码风险，最先做）

目标：范围声明与实际一致，关闭 #10，并为 #9 留下书面决策位。

前置：无。

文件清单（全在 janus-agentX 仓）：

1. `package.json:5`（根描述）
2. `README.md:12-23`（Scope + Packages 表）
3. `packages/agent-core/src/main/agent/PORTS.md`（追加一节）

步骤：

1. 根 `package.json` 描述改为实际范围，删掉 `knowledge, roundtable and blueprint maintenance`，例如：
   `agent loop, runtime, LLM orchestration helpers and workspace tools, with standalone janus CLI`（措辞可调，但必须与文件清单一致）。
2. `README.md`：
   - Scope 段追加一句：`project / command / git tool implementations stay in the JanusX shell and cross host-tool-ports; the janus CLI ships workspace tools only`。
   - Packages 表 `agent-core` 行删掉易误解的 `workspace tools` 泛化，明确为 `workspace.{read,list,search,edit,create} + chat-tool adapters + name contract`。
3. `PORTS.md` 追加 `## Non-goals（永久驻壳，明确不迁）`，逐条列出：knowledge 服务实现、LlmService/ai-runtime/ModelCatalog/Config、Electron IPC + preload、渲染端、subprocess runner（`src/main/janus-runner/`，README 已有半句，收拢到此处）、roundtable、blueprint service 实现、§P5 待决策的 10 个文件（标 `pending P5`）。
4. 10 个文件在 PORTS.md 中先记为 `pending P5`，不提前定性。

验证（janus-agentX 根目录）：

```powershell
npm run typecheck
npm run test
```

验收：三个文件的声明与 §1 表 #1–#5、#10 一致；`7f38208` 删除的 10 个文件在 PORTS.md 有 `pending P5` 记录，无悬空。

回退：纯文档改动，`git revert` 即可。

### P1 跨仓一致性检查脚本（❌ 已取消，2026-09-08 方向变更）

取消原因：不再维护双源并存，改为删除 JanusX 本地实现、全部直连 `janus-agentX`（见 P3′）。parity 脚本的前提（长期双源）已不存在，不再实施。本节保留为记录，不删。

方向变更后本阶段整段作废，实施路径见 P3′（本地实现移除）。原步骤正文删除，保留标题备查。

### P2 host 工具落位（关 #6、#7；2026-09-08 决策反转：不再是纯声明）

目标：CLI 具备 `command.run` + `git.*` 真实能力；`project.*` 永久驻壳并书面化。

决策记录（2026-09-08，原 B 路线被推翻）：三组工具性质不同，不一刀切——`project.*`（Runner 进程托管）驻壳；`command.run` / `git.*` 为纯 Node 可实现，CLI 必须具备（否则连 `npm run build`、`git commit` 都做不了）。实现放在 **CLI 包内**（`packages/cli/src/tools/`），不进 `agent-core`（core 保持无 `child_process` 策略）。

文件清单（janus-agentX 仓）：

1. `packages/cli/src/tools/command.ts`（新增）：`command.run`，`actionRisk: 'external-command'`，与壳版同 inputSchema；单程序 + cwd 越狱拦截 + `timeoutMs`（默认 120s/上限 600s）+ env allowlist（同 12 键）+ 8KB 尾预览 + 全量落 `.janusX/logs/cmd-*.log` + Windows shim；`background:true` 前景拒绝（CLI 无 Runner，无 `project.process-output` 可 poll，拒绝文案模型可读）。
2. `packages/cli/src/tools/git.ts`（新增）：9 工具，Names/schemas/risks 与壳版一致（status/log/diff `inspect`；stage/unstage/commit `write`；pull/push `network`），直调 `git` 二进制，输出有界；非仓库 fail-closed。
3. `packages/cli/src/session.ts`：`create` 中 `registerWorkspaceTools` 后加两行注册（模型工具清单来自 registry，注册即自动暴露，无需改 prompts）。
4. `packages/agent-core/src/index.ts`：补 `isSensitivePath` + `RegisteredTool` 类型导出（两行，CLI 复用壳同款路径/敏感判定）。
5. `packages/cli/tests/command-tools.test.ts` + `git-tools.test.ts`（新增 15 用例）。
6. `README.md` Scope + `PORTS.md` Non-goals/seam 表：CLI 为 workspace + command + git；`project.*` 驻壳。

关键机制（实施中实证，可复用）：审批零成本——`attachApprovalListener` 是通用事件转发，新工具自动走终端 y/N 或 Ink 审批卡；`AUTO_RUN_ALLOWED` 安全编译放行同样自动生效。测试注意：`preview` 在 call 层（`call.preview`）而非 input 内，否则 `PREVIEW_REQUIRED` 失败且无审批事件（调试记录 2026-09-08）。

验证（janus-agentX 根目录）：

```powershell
npm run typecheck
npm run build
npm run test
```

验收：`typecheck` 4 包 0 错误；CLI 新增 15 用例全绿（含审批放行实测）；git 无二进制环境整文件 skip；文档三处（README Scope、PORTS、§1 #6/#7）一致。

回退：未动 JanusX 仓；janus-agentX 侧 `git revert`（新增文件删除 + `session.ts` 两行注册还原 + barrel 两行还原）。

遗留（有意不做）：CLI `command.run` 仅前台；工具级 `timeoutMs` 受会话级 `--timeout-ms`（默认 120s）封顶，长构建需同步调高；`project.*` 在 CLI 侧模型不可见（如未来需要，另起小方案）。

### P3 维护链路切包（关 #8，核心代码改动）

目标：`maintenance/service.ts` 与 janus-chat 同源，均跑包内实现；本地 `agent/loop`、`llm/workspace-chat-tools`、`llm/chat-session-runtime` 不再有除壳适配器外的第二消费者。

前置：P1（切包前后用 parity 脚本证明语义同源）。

文件清单（JanusX 仓为主，janus-agentX 仓按需补导出）：

1. `src/main/janus/maintenance/service.ts`（import 改道，约 `:15-29` 区）
2. `src/main/janus/maintenance/blueprint-tools.ts:4`（纯类型 import `JanusAgentTool ... from '../../agent/loop'` → `from '@janus-agent/agent-core'`，barrel 已导出该类型）
3. `tests/unit/blueprint-maintenance-*.test.ts`（回归，行为不变）
4. 缺导出才动：`janus-agentX/packages/agent-core/src/index.ts`、`chat-core/src/index.ts`（先核对，见步骤 1）

步骤：

1. 先核对 barrel 已导出维护链路所需的全部符号（已实测，均在）：
   - `agent-core/src/index.ts`：`runJanusAgentLoop`、`AgentSteeringPort`（`:7`）、`createJanusRuntimeReadOnlyToolsForResources`（`:29-34`）、`createVercelModelTools`/`createVercelStream`（`:21-26`）、`toAgentStreamEvent`（`:41`）、`createWorkspaceChatTools`/`createToolPreview`（`:90-93`）、`createToolManifests`（`:52`）。
   - `chat-core/src/index.ts`：`ChatSessionRuntime`（`:4`）。
   - 缺哪个才补 barrel，绝不为了切包顺手加新能力。
2. `service.ts` 改道（只换 import 源，不改调用语义）：
   - `:18-26` 的 `from '../../agent/loop'` → `from '@janus-agent/agent-core'`；
   - `:27` 的 `from '../../agent/stream'` → `from '@janus-agent/agent-core'`；
   - `:28` 的 `from '../../llm/workspace-chat-tools'` → `from '@janus-agent/agent-core'`；
   - `:29` 的 `from '../../llm/chat-session-runtime'` → `from '@janus-agent/chat-core'`；
   - `:15-17` 的 `janusWorkspaceFs`、`workspaceAgentRuntime`、`createToolManifests`：前两者是壳单例保持不动，`createToolManifests` 可随手并入包 import（行为同一文件），改后删除无用本地 import（`engineeringX` 自查项：无残留引用）。
   - `blueprint-tools.ts:4` 的类型 import 同步改道（纯类型，无运行时影响）。
3. 在 janus-agentX 跑 `npm run build`（§1 机制提醒：JanusX 消费 `dist`），再回 JanusX 验证。
4. 跑 P1 parity 脚本确认切包前后语义源一致。

验证（先 janus-agentX，后 JanusX）：

```powershell
# janus-agentX 根目录
npm run typecheck
npm run build
npm run test
```

```powershell
# JanusX 根目录
node scripts/check-janus-agent-parity.mjs
npm run typecheck
npm run test:unit -- --run tests/unit/blueprint-maintenance-service.test.ts tests/unit/blueprint-maintenance-tools.test.ts tests/unit/agent/janus-agent-loop.test.ts tests/unit/llm/janus-agent-ports.test.ts tests/unit/llm/chat-session-runtime.test.ts
npm run lint
```

验收：维护单测全绿且无快照外行为变更；`service.ts`、`blueprint-tools.ts` 无 `../../agent/loop`、`../../llm/workspace-chat-tools`、`../../llm/chat-session-runtime` 残留 import；parity 脚本绿；手工走一遍维护链路（开对话 → 追问 → 整理提案），事件与此前一致。

回退：单文件 import 还原（改动面即回退面）；若已合入，用 `git revert`。

### P3′ 本地实现移除（✅ 第 1+2 批已合入 2026-09-08；第 3 批延期）

目标：JanusX 删掉与包重复的本地实现，全部直连 `@janus-agent/*`；删完即不存在双源，无需 parity。

实施记录（2026-09-08，Batch A→D 一次性合入，原分批计划执行中被纠正两处）：

- **实际顺序**：先改消费方（Batch A 壳适配器 + Batch B 维护改道）→ 再搬单测（Batch C）→ 最后删文件（Batch D）。原文档“第 1 批无运行时消费者”写错了——维护链路当时仍在用本地 loop，正确顺序是先改道后删。
- **删文件 28 个**：`agent/loop/*`（4）、`agent/stream/*`（4）、`agent/runtime/{runtime,registry,tool-manifest,tool-result,policy-gate,path-guard,policy-audit-store,file-transaction,renderer-authorization}.ts`（9）、`runtime/tools/workspace-tools.ts`、`agent/checkpoint/*`（5）、`agent/environment/janus-workspace-fs.ts`、`llm/{workspace-chat-tools,chat-session-runtime,system-prompt-builder,chat-agent-events}.ts`（4）；空目录 loop/stream/checkpoint/environment 已移除。
- **未删（纠正原计划）**：`main/lib/atomic-file.ts`——被 config/blueprint-store/chat-store/knowledge×4 等驻壳模块直引，属壳基础设施，永久保留；`runtime/tools/{command,git,project}-tools.ts`（壳实现，Runner 纠缠，见 P6）；`shared/*` 类型（第 3 批延期：renderer 广泛引用，需单独一批，见下）。
- **新增壳装配**：`agent/runtime/shell-runtime.ts`（永久保留）——包内 `createAgentRuntime` + 文件审计单例 + 鉴权器；`chat-orchestrator`、维护、handlers 改调它。审计路径经实测与旧版字节一致。
- **单测搬迁 18 文件**进 agent-core/chat-core（补 vitest 显式 import、修 2 处 move bug）；留守 5 文件改道（3 壳工具测试 + chat-agent-events + 2 mock 改道 shell-runtime/包）。
- **挖出 2 个真分歧并对齐到包**：包内 `CheckpointEngine` 比壳窄（已按壳 union 补齐）；包内 `createVercelStream` 要求显式 `streamTextFn`（维护侧已显式传入）。另发现包内 `shared/maintenance-types.ts` 与壳有 73 行 drift——维护代码留壳，暂不处理，待维护域动刀时再对。
- **验证**：JanusX `typecheck` 0 错误；`lint` 0 错误；受影响域 143+29+10 等全绿；janus-agentX 全包 158+24（后补 jobs 队列修复）全绿；wiki 02/04 索引 + log 已更新。

前置：P0、P2（已合入）。P3（维护切包）已并入执行完毕，不再单独实施。

原则（engineeringX：删前必对齐）：

1. **先对齐后删**：每批删除前 diff 本地 vs 包内，差异只允许是 import 深度；若本地有包没有的语义修复，先合入包（janus-agentX 改 src → `npm run build`），再删本地。以包为 authoritative。
2. **先改消费方后删文件**：引用方全部改道并验证通过，才删文件；删后 grep 旧路径零命中（测试 import 一并搬）。
3. **单测跟模块走**：被删模块的纯逻辑单测搬进 janus-agentX 对应包；JanusX 只留壳适配测试（twin test `janus-agent-ports.test.ts` 永久保留）。
4. **永不删**：`chat-orchestrator.ts`（壳适配器）、`janus-agent-ports.ts`、knowledge/IPC/渲染端、P5 判定的驻壳模块。

分批清单（执行结果，见上文实施记录；仅第 3 批剩余）：

- ~~第 1 批/第 2 批~~ ✅ 已合入（28 文件删 + 18 单测搬迁 + 消费方改道）。
- 第 3 批（shared 类型，延期）：`src/shared/*` 与包内重复的类型文件。renderer 广泛引用，需单独一批：逐个确认包内版本为超集 → 引用方改道 → 删除。本轮未做。
- 已知待对齐点（删除前必须消掉）：~~`chat-session-runtime.ts` 的 `ModelInfo` 来源~~ ✅ 已随文件删除而消除（消费方统一用包内版本）；`shared/maintenance-types.ts` 73 行 drift（维护留壳，暂不处理）。

验证（每批相同，先 janus-agentX 后 JanusX）：

```powershell
# janus-agentX 根目录（有包侧改动时）
npm run typecheck
npm run build
npm run test
```

```powershell
# JanusX 根目录
npm run typecheck
npm run test:unit -- --run tests/unit/agent/ tests/unit/llm/ tests/unit/blueprint-maintenance-service.test.ts tests/unit/blueprint-maintenance-tools.test.ts
npm run lint
```

验收（每批）：`typecheck` 0 错误；相关单测全绿；被删路径 grep 零命中（不含历史文档）；`verify` 全链路过一遍；包侧有改动时 janus-agentX 全包绿。

回退：按批 `git revert`（批内含"消费方改道 + 删文件 + 单测搬迁"，原子合入、原子回退）。

### P4 knowledge 只读工具与 `todo_write` 落位（关 #11 的一半，位置决策）

目标：capability-plan §9/§5 的两项能力有确定的**实现位置**和最小闭环，不再出现"以为在包里实际没有"。

前置：P2（host/CLI 边界已书面化）、P3（维护链路已同源，避免新工具接两套 loop）。

决策（本方案给定，实施时不再摇摆）：

- knowledge 只读 5 工具（`knowledge.search` / `wiki_list` / `wiki_get` / `fact_get` / 可选 `context`）：实现放 JanusX 仓 `src/main/agent/runtime/tools/knowledge-tools.ts`（capability-plan §9.1 原址），因其直调 `knowledgeContextService` / `knowledgeTruthService` 单例；包内**不复制实现**，只复用既有 `ToolRegistry` 注册机制与 `actionRisk: 'read'` 模式。待 P3 完成后，`agent-runtime-handlers.ts` 的注册行保持壳侧。
- `todo_write`：实现放 JanusX 仓（capability-plan §5 原址：`chat-todo-store` / `chat-todo-tool` + 渲染端），因其依赖 `chat-orchestrator` 的注入点与渲染端状态；包内不新增 todo 概念。如未来 CLI 需要 todo，再把**纯状态机**（validate + 单 in_progress 约束）下沉为包内无依赖模块，届时另起小方案。

步骤：

1. 按 capability-plan §9.1 在 JanusX 新增 `src/main/agent/runtime/tools/knowledge-tools.ts` + `agent-runtime-handlers.ts` 加一行注册 + 作用域 fail-closed（照 `workspace.read` 模式）。
2. 单测 `tests/unit/agent/knowledge-tools.test.ts`（仿 `command-tools.test.ts`）：5 工具注册成功、跨 workspaceId 拒绝、`wiki_get` 缺页进 `isError`、`fact_get` 幽灵 id 进 `isError`（capability-plan §9.3 原样）。
3. `todo_write` 按 capability-plan §5–§8 实施（9 文件 + 2 单测，不在此复述步骤号，以该文档为准）。
4. PORTS.md 追加两行：knowledge 工具 = shell-side plugin（实现位）/ todo = shell-side（实现位），关闭"落位不明"。

验证（JanusX 根目录）：

```powershell
npm run typecheck
npm run test:unit -- --run tests/unit/agent/
npm run lint
```

验收：capability-plan §6（todo 6 条）与 §9.3（knowledge 3 条）验收全过；PORTS.md 落位声明与实现一致。

回退：两能力各自独立文件 + 一行注册，还原对应文件与注册行即可；互不牵连。

### P5 终态收敛 ✅ 2026-09-08（定案，无代码改动）

结论：10 个文件**全部留壳**（推翻原“parsers/subagent 进包”初值，理由见下）。PORTS.md `pending P5` 已替换为 `Resolved P5`，无悬空。

定案依据（消费方实测）：`agent/types.ts` + `shared/ipc/agent.ts` + `shared/subAgentRun.ts` + `subagent-run-registry.ts` 是一个桌面外部-agent（终端/子代理）契约簇——preload、renderer（stores/组件/electron.d.ts）、terminal/agent/subagent-run handlers、5 个 notifications 模块、`office-agent-policy`、`remote-notifications/types`、`knowledge/agent-turn-recorder` 全在消费。`parsers/*` 唯一消费方是留壳的 `stream-manager`，包内零消费方，搬过去是死代码 + 类型污染。`cli-resolver`/`stream-manager` 属桌面终端 concern。以上均非 janus-agent 基本能力，不符合进包标准。

### P3′-3 shared 类型 ✅ 2026-09-08（定案：永久双份，理由见下）

结论：`src/shared/*` 与包内拷贝**永久共存**，不删除本地文件。preload + renderer + main 三方全在消费本地 shared；包的 `exports` 只暴露 barrel（会带入 `node:` 内建模块），renderer 改道即污染浏览器 bundle。纯类型双份是标准契约镜像做法，由 `tools-contract.test.ts` + CheckpointEngine 对齐先例锁住关键一致性。已知 drift：`maintenance-types` 73 行（维护留壳，包内拷贝暂无消费方，动维护域时再对；其余 `agent-runtime`/`project`/`knowledge` 0 diff，`llm` 2 行 benign）。

### P6 CLI 展开 + 壳接入底层能力（P6-1/P6-2 ✅ 2026-09-08；P6-3 待排）

目标：CLI 从"能对话+读写文件"长成完整 coding agent；`node-hosts` 成为工具唯一实现。

已合入（2026-09-08，实测）：

1. **`node-hosts` 包**（新增 `@janus-agent/node-hosts`）：`command.run`（同步 + 后台）、`git.*`（8）、后台任务 `project.list-processes/process-output/stop-process`；`JobManager`（一会话一实例，`close()` dispose）：detached 式 spawn（unref，CLI 可退出）+ `.janusX/logs/bg-*.log` + opt-in 超时 SIGTERM→SIGKILL + 退出快照（20 个）+ offset 分页。工具名/schemas/risks 与壳版一致，`background:true` 超时缺席即无截止（壳 R3 语义）。
2. **CLI 切换**：`session.ts` 改注册包版本 + 持有 JobManager（`close()` 清理）；`cli/src/tools/`、`cli/tests/{command,git}-tools.test.ts` 删除（移入包内）；新增 `session-tools.test.ts`（17 工具接线断言）。
3. **验证**：`typecheck` 5 包 0 错误；`build` 5 包成功；`test` 158 通过 0 失败（11+9+110+4+24）；审批/安全编译放行实测依旧。
4. **壳接入延期（记录原因）**：JanusX 壳的 `command/git-tools` 本轮未删——壳后台链路绑 Runner（`process-output` 读 Runner 快照），与 node-hosts jobs 的 `projectId` 命名空间不互通，整体替换属 M3 量级。壳接入条件：node-hosts 覆盖 Runner 语义或双读适配，另起方案。

剩余 P6-3（另起小方案）：slash 命令/会话 UX 对齐。明确不做：`project.*` 整体留壳（工程探测、launch 配置、托管进程属 JanusX 系统级能力，不进 CLI）。

原步骤（已执行完毕，保留备查；第 1 条中“JanusX 删本地版”一项未执行，转入上文第 4 条延期记录）：

1. ~~JanusX 删 `agent/runtime/tools/{command,git}-tools.ts`，改注册包版本~~（延期：Runner 纠缠，见上文）；其余（建包、移动、CLI 改道）已执行。
2. CLI 后台任务已执行（JobManager + 3 project job 工具 + 解除拒绝）。
3. 后续展开项见上文“剩余 P6-3”。

原验证/验收（实际执行）：janus-agentX `typecheck`/`build`/`test` 全绿（158 通过）；JanusX 本轮零改动，无需验证；`cli/src/tools/` 已删空；工具名契约测试仍绿。

## 4. 验证总表（各阶段通用命令）

| 位置 | 命令 | 期望 |
|---|---|---|
| janus-agentX 根 | `npm run typecheck` | 0 错误（全 workspaces） |
| janus-agentX 根 | `npm run build` | 成功（改 src 后必跑，JanusX 消费 `dist`） |
| janus-agentX 根 | `npm run test` | 全绿（改 src 后必跑） |
| JanusX 根 | `npm run typecheck` | 0 错误 |
| JanusX 根 | `npm run test:unit -- --run <本阶段指定文件>` | 全绿 |
| JanusX 根 | `npm run lint` | 改动文件 0 错误 |
| JanusX 根 | `npm run i18n:check` | 仅渲染文案有改动时跑 |

铁律：不声称未跑过的检查；阶段验收前必须真实执行上表对应行并记录结果（含失败与处理）。

## 5. 风险与控制

| 风险 | 控制 |
|---|---|
| 改包 `src` 忘 `build`，JanusX 测到旧 `dist` | P3′/P5/P6 凡动包必先 `npm run build`（§1 机制提醒） |
| P3 切包改坏维护链路 | 只换 import 源不改调用；维护单测 + 手工链路双验收；回退面=单文件 |
| P5 垫片改动 export 面（如本地非导出 interface 在包内导出了） | `typecheck:strict-unused` + 全量相关单测；垫片与删除分两步走 |
| 跨仓提交顺序错乱（包与壳需同 release） | 工具名契约已有双仓测试锁定（`tools-contract.test.ts:1-6` 注释）；改名类操作必须双仓同发 |
| 范围蔓延（顺手迁知识/蓝图/圆桌实现等） | §2 口径硬约束；超范围改动必须先改本文档再实施 |

## 6. 实施顺序与依赖

```text
P0 ✅ → P2 ✅ → P6-1 ✅（node-hosts）→ P6-2 ✅（CLI 后台任务）→ P3′ ✅（第1+2批）→ P5 ✅ → P3′-3 ✅（shared 永久双份）
P1 ❌ 已取消；P4 ⏸ 用户明确暂缓（先稳定）；P6-3 待排
P1 ❌ 已取消（双源将消失，无需 parity）
```

每阶段合入后更新本文档状态行（`P0 ✅ 2026-XX-XX` 形式），未合入阶段保持草案；任一阶段发现 §1 结论有误，先修正 §1 再继续。
