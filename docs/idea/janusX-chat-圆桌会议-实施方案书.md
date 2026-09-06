# JanusX Chat 圆桌会议：设计与实施记录

> 当前状态：圆桌视觉舞台、会议引擎（LangGraph.js＋真实模型）、持久化恢复、导出与中英文详情均已落地；桌面端到端真实模型验收仍待手动清单（§25）。
>
> 最近更新：2026-09-06（§37.8 提问反馈显示已确认、§38 多开阅读扩展；§3 为准）
>
> 文档用途：维护当前代码事实、已确认产品规则、待实施设计和验收条件。已被实现淘汰的早期布局方案不再保留。

## 1. 当前产品目标

圆桌会议是 Janus Island 的一种扩展视图。用户提出议题后，由固定职责的参与者进行结构化讨论，JanusX 负责主持、整理共享状态，并最终形成可追溯的结论、分歧、风险和行动项。

圆桌会议不是普通 Chat 中连续发送多次请求，也不是一个脱离 Island 的独立窗口。它需要同时容纳四种信息：

1. 左侧圆桌会议场景，用于表达参与者、发言状态和会议进程；
2. 共享羊皮纸，用于显示 JanusX 整理后、适合人阅读的结构化结果；
3. discussion-only Chat，用于显示讨论过程和接收用户补充。
4. Agent 工作卡片，用于在不打散 Chat 阅读节奏的前提下，显示每个 Agent 的任务状态、阶段结果和可展开详情。

## 2. 当前 UI 的实际实现

以下结论以 2026-08-31 的仓库代码为准。

### 2.1 入口与容器

- `JanusIslandExpandedShell` 在 Monitor、Chat 之外提供 Roundtable 页签。
- Roundtable 直接渲染在展开态 Janus Island 内部，没有新窗口、overlay 弹层或工作区 Pane。
- 外层 Island 当前最大尺寸约为 `900px × 460px`，圆桌内容必须在这个固定舞台内分配空间。
- 当前圆桌根组件是 `JanusRoundtablePane`，左侧场景由 `RoundtableStage` 独立负责。

相关实现：

- `src/renderer/src/components/janus/JanusIsland.tsx`
- `src/renderer/src/components/janus/JanusIslandExpandedShell.tsx`
- `src/renderer/src/components/janus/JanusRoundtablePane.tsx`
- `src/renderer/src/components/janus/RoundtableStage.tsx`
- `src/renderer/src/components/janus/styles/09-janus-roundtable-final.css`

### 2.2 当前布局（2026-09-04 校准）

桌面宽度下使用两列结构：

```text
┌──────────────────────────────┬──────────────────────┐
│                              │ discussion-only Chat │
│      左侧 3D 圆桌舞台        │ （用户消息＋Agent    │
│                              │  结果卡片内联）      │
└──────────────────────────────┴──────────────────────┘
      ＋右侧等高附属 Island（羊皮纸/agent-result 详情，按需出现）
```

- 左侧圆桌跨越完整高度。
- 中部默认只显示 Chat；Agent 结果卡片内联在对话流中（按时间排序），点击打开附属 Island 详情。
- 右侧 `janus-roundtable-state` Deck 在展开态圆桌视图下隐藏（CSS），仅保留数据结构。
- 点击圆桌中心羊皮卷后**直接打开**右侧等高附属 Island 承载完整羊皮纸（2026-08-31 决策，§10）；早期“右侧上方羊皮纸＋下方 Chat”的 stacked 上下布局已不再渲染。
- 小于 `760px` 时改为纵向堆叠，避免横向内容溢出。

这套布局已经替代早期“三栏并排”“右侧 stacked 羊皮纸”“底部整宽输入条”和“独立工作区嵌入”等方案。

### 2.3 左侧圆桌舞台

当前固定显示四个会议单位：

| 角色 | 显示名称 | 当前身份视觉 |
|---|---|---|
| 用户 | 提议人 | `teammate` |
| JanusX | 主持人 | `main` |
| Agent-1 | 议题解决者 | `coder` |
| Agent-2 | 议题完善者 | `evaluator` |

已实现的舞台交互：

- 动态、俯视、等距、低位四种视角；
- CSS 3D 圆桌、座席、身份核心与职责标签；
- 座席 Hover、Focus 和选中状态；
- 中心羊皮卷 Hover、Focus、打开和关闭状态；
- 羊皮卷光环在静止态与桌面平行，未升起时也能完整显示；
- 视角切换和羊皮卷开合动画；
- 基础键盘可访问语义，如 `aria-pressed`、`aria-label` 和 toolbar。
- 工作席位由运行时 `agent:queued/working` 事件驱动（含主持人 `janusx → host` 席位映射，§29）；live 卡只渲染真实事件，无合成占位。

### 2.4 当前功能边界（2026-09-04 重写；旧“视觉骨架”描述作废）

- `parchmentOpen`／附属模块状态由 `JanusIsland` 持有，`JanusRoundtablePane` 为受控组件。
- 四名参与者来自工作流模板（默认 `janusx/refiner-1/challenger-1`），经 IPC 连接真实 Runtime。
- `workingRole` 由 `working/queued` 事件派生（含 `janusx → host`），随发言者变化（§29）。
- discussion-only Chat 显示用户消息与内联 Agent 结果卡片；发送经 `start/advance` 启动或推进轮次。
- “开启下一轮”按钮支持空输入推进（§35）；`dispatchBusy` 防重提交，`advance(requestId)` 幂等键落盘。
- 共享羊皮纸消费 `projectParchment(roundtableState)`，显示 Host 草稿结论/决策/依据/风险/行动/待验证/冲突（§23）。
- 主进程具备完整圆桌编排（LangGraph.js）、JSONL＋sidecar 持久化、`roundtable:export` Markdown 导出（§24–§25、§30）。
- Agent 失败走 `agent:error` 并在对话框红色横幅展示原文，无静默 fallback（§31）。
- 结束会议保留 FINAL 终稿＋结束横幅（保存／开新议题），开新议题分阶段退出（§30、§33）。

## 3. 实施状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Roundtable 页签入口 | 已实现 | 位于展开态 Janus Island 顶部视图切换区 |
| 左侧 3D 圆桌舞台 | 已实现 | 四席、视角、标签、Hover/Focus/选中 |
| 中心羊皮卷开合 | 已实现 | 点击直接打开右侧等高附属 Island（不再是右侧 stacked 布局，§10 决策） |
| 中部对话与卡片内联 | 已实现 | 用户消息＋Agent 结果卡片按时间排序内联在 discussion-only Chat；右侧 Deck 在展开态隐藏 |
| 羊皮卷静止光环显示 | 已实现 | 光环不再穿入桌面导致下半圈缺失 |
| 共享羊皮纸真实内容 | 已实现基础版 | 羊皮纸消费 `projectParchment(roundtableState)`，优先展示 Host 草稿（结论/决策/依据/风险/行动/待验证/冲突＋DRAFT/FINAL），无草稿降级规则投影；中英文标题见 §32 |
| 通用附属 Island 与羊皮纸模块 | 已实现 | `JanusAuxiliaryIsland` 通用外壳（`actions` 插槽）＋羊皮纸/`agent-result` 双模块；同一时间单模块 |
| 真实讨论消息流 | 已实现 | Renderer 经 Roundtable IPC 启动/推进/结束；`user:message` 入日志，续写与恢复后消息流完整；Agent 经全局默认模型真实调用（§31） |
| Agent 发言状态联动 | 已实现 | `working/queued` 事件驱动席位（含 `janusx → host` 映射）；live 卡仅真实事件，无合成占位（§29） |
| Agent 工作预显与卡片化输出 | 已实现 | 工作事件投影、摘要卡片、真实 sections/evidence 结果正文；失败经红色横幅显错（§31） |
| 卡片详情附属 Island | 已实现基础版 | `agent-result` 模块展示 sections 与结构化 evidenceRefs（含 workspace-file 行号 `#Lx-y` + sha 短码、agent-card、event）＋同一 Agent 读取轨迹；中英文标题见 §32；变更版本事件仍待完成 |
| 用户显式开启轮次 | 已实现 | “开启下一轮”按钮经 `handleCenterSend('')` 空输入推进（§35）；Renderer `dispatchBusy` 防重提交，`advance(requestId)` 幂等键落盘；重复点击与重试有单测 |
| 结束终稿与开新议题 | 已实现 | 结束保留 FINAL 终稿＋横幅（保存 Markdown／开新议题，§30；复制按钮已移除）；开新议题分阶段退出（附属 240ms＋对话淡出，§33）；状态栏 ended 显示“会议已结束 · FINAL” |
| 圆桌编排与轮次推进 | 已实现基础版 | LangGraph.js、Agent Registry、RoundtableService、IPC 和 UI 生命周期已接入；Agent 经 `generateText`＋工作区只读工具真实调用，失败抛错不吞（§31） |
| 共享结构化状态 | 已实现 | 事实、事件 envelope、版本、幂等 reducer、羊皮纸投影器＋JSONL＋sidecar 持久化 |
| 会话恢复与持久化 | 已实现 | JSONL 轻快照 + context sidecar + `roundtable:restore`；`user:message` 入日志；checkpoint 迁移（v1）；崩溃 running 经 `markInterrupted` 降级可续；挂载按 localStorage sessionId 自动恢复 |
| 最终整理与 Markdown 导出 | 已实现基础版 | Markdown 生成（共享纯函数 + `roundtable:export` IPC）+ 结束横幅（保存／开新议题，终稿保留至显式开新议题）+ 羊皮纸详情 DRAFT/FINAL 导出按钮（`running` 禁用，失败/取消不丢会；详情导出失败有复制降级）；见 §28 需求、§30 实施 |
| 工作区资源绑定与静态快照 | 已实现基础版 | Service 与 Runtime 均按 `workspaceId` 解析注册表并忽略客户端路径，无解析器时仍做 realpath + 目录校验；非法 id、未注册、缺失目录均拒绝启动 |
| 工作区动态只读工具 | 已实现基础版 | `workspace.list/read/readRange` 经统一 policy（敏感排除、symlink 拒绝、secret 脱敏），四类工具事件、行号级 evidence、`WORKSPACE_TOOL_*` 错误码、取消与 30s 超时已落地；提示词明示 id 列表＋输入归一化（trim/id/名/路径，§31）；Deck 与卡片详情展示读取轨迹；写/命令/Git 无通道 |
| 工作区工具审批（写/命令/Git） | 未实现 | 保持禁止；读工具默认只读，写操作无通道 |

## 4. 已确认的产品规则

以下规则仍然有效，但除非在实施状态表中标记为“已实现”，否则不能当成当前能力。

### 4.1 角色职责

1. 用户是提议人，可以提出议题、补充约束、纠正事实和推进下一轮。
2. JanusX 是唯一主持人，维护共享结构化状态、归并重复观点并整理轮次结果。
3. Agent-1 是议题解决者，每轮既要回应已有审查问题，也要继续提出新方案或推进路径。
4. Agent-2 是议题完善者，检查方案的缺口、边界、风险和未验证假设。
5. MVP 使用一个用户、一个主持人、一个议题完善 Agent 和一个方案质疑 Agent 作为最小拓扑；用户和主持人仍各只有一个，但两类工作 Agent 都必须支持扩展数量。后续可注册不同编排流程，不得把 MVP 节点数量写死在主图中。

### 4.2 上下文与轮次

- 共享结构化状态是跨参与者的公共上下文；Agent 默认不直接读取其他 Agent 的完整原始发言。
- MVP 轮次顺序为 `Agent-1 -> Agent-2 -> JanusX`。
- 首次用户非空输入才创建会话并自动启动第 1 轮；首次输入前不得显示 Agent 工作状态。
- 每轮完成后停在 `awaiting-user`，用户必须通过明确的 `advance-round` 事件开启下一轮。
- `advance-round` 可以携带补充内容，也可以无文本推进；无文本表示沿用当前共享状态继续讨论，不产生空白用户消息。
- 未经证实的 Agent 观点必须标记为建议、疑点或待验证，不能直接升级为事实。
- 写工作区、运行命令和 Git 操作必须经过明确审批，不能由多个 Agent 自行并行修改。

### 4.3 会议结束

- 只有用户可以结束会议。
- JanusX 和 Agent 可以建议结束，但不能自行改变会议终止状态。
- 用户结束后，JanusX 需要执行一次最终整理，输出结论、分歧、依据、风险、行动项和引用索引。
- 导出失败不能删除会议历史或最终状态。
- 结束保留 FINAL 终稿并展示结束横幅（保存 Markdown／开新议题，§30）；只有显式“开新议题”才清空，且为分阶段退出（附属 Island 先收＋对话淡出，§33）。结束横幅无复制按钮（已移除）；羊皮纸详情导出失败时的复制降级保留。

## 5. 双层文档模型

圆桌文档采用“一个事实源、两个阅读层”的原则。

### 5.1 AI 读取层：圆桌记录

机器层负责完整、稳定和可追溯，建议使用事件记录加版本化快照：

- 会话、轮次、事件和状态版本；
- 用户需求与约束；
- 候选方案、支持理由和反对意见；
- 已确认、待验证、已否决和已解决事项；
- 参与者、模型、工作区范围和来源引用；
- 每次结构化变更的操作者与前后差异。

建议状态至少包含：`confirmed`、`proposal`、`concern`、`pending-validation`、`rejected`、`resolved`。

### 5.2 人类阅读层：共享羊皮纸

羊皮纸是机器事实源的可读投影，不是原始长对话的全文转写。默认结构为：

1. 主题与当前结论；
2. 已确认决策；
3. 关键依据；
4. 未决问题与风险；
5. 行动项；
6. 来源索引。

用户修正结论时，应产生新的确认或变更事件，再重新生成羊皮纸；不允许羊皮纸与机器事实源各自维护一套真相。

## 6. 新设计方向：右侧等高详细 Island

### 6.1 问题

当前“羊皮纸在上、Chat 在下”的形式适合快速浏览，但右侧列宽和半高区域不足以承载长结论、依据、来源索引或多个结构化章节。继续压缩字体、减少留白或扩大上方区域都会损害 Chat 的可用性。

因此保留当前上下布局作为默认简易视图，并为共享羊皮纸增加一个可逆的详细阅读模式。

### 6.2 目标形态

> 现状偏离（2026-09-04）：默认 stacked 上下布局已不再渲染。点击中心羊皮卷直接打开附属 Island（§10 决策）；中部为对话＋内联卡片，不再有“上方羊皮纸＋下方 Chat”常驻分区。下图保留为设计源意，`stacked` 态仅存于 `ParchmentLayout` 类型字面。

宽屏桌面环境中，用户从羊皮纸控件触发展开后，在主 Island 右侧生成一个与主 Island 等高的详细 Island：

```text
默认上下布局
┌──────────────────────────────┬──────────────────────┐
│       左侧 3D 圆桌           │ 共享羊皮纸（摘要）   │
│                              ├──────────────────────┤
│                              │ Chat                 │
└──────────────────────────────┴──────────────────────┘

详细阅读布局
┌──────────────────────────────────────────────┐  ┌──────────────────────────┐
│             原 Janus Island                  │  │ 共享羊皮纸详细 Island    │
│  左侧圆桌 + 右侧上下布局保持可见             │  │ 等高、独立滚动、完整内容 │
└──────────────────────────────────────────────┘  └──────────────────────────┘
```

详细 Island 是原 Island 的附属阅读面，不是新窗口、模态框或另一场会话。两侧读取同一份羊皮纸状态，不复制数据，也不创建第二个 Chat。

### 6.3 主体 Island 视觉一致性（硬约束）

额外扩展的 Island 必须与主体 Janus Island 属于同一套视觉系统，不能因为当前首个内容是羊皮纸，就把整个分体做成米色纸张、卷轴窗口或另一套应用外壳。

必须保持一致的外层特征：

- 复用主体 Island 的近黑背景、边框、圆角、内高光、投影和层级关系；
- 复用主体 Island 已有的 `--shell-*` 设计变量、字号层级、间距系统和控件状态，不在模块内复制硬编码主题；
- 分体 Island 的高度、顶部和底部边线、圆角半径及外阴影与展开态主体 Island 对齐；
- 分体展开、收回和焦点状态使用与主体 Island 相同的缓动语言和动效节奏；
- 标题栏、图标按钮、Tooltip、Focus ring 和禁用状态沿用主体 Island 组件规范；
- 两个 Island 之间保留清晰间距，但视觉上应像同一个 Janus 系统分出的两个工作面，而不是两个不同产品窗口。

羊皮纸的旧金、深褐、纸张纹理和衬线字体只用于附属 Island 的内容画布与羊皮纸专属控件。附属 Island 的外层 chrome 仍然保持 Janus Island 风格。未来加载其他功能模块时，内容层可以使用对应功能的局部语义，但不得改写通用外壳。

### 6.4 羊皮纸风格控件

> 现状偏离（2026-09-04）：默认布局的 `PanelRightOpen` 展开控件已不存在（无 stacked 分区可展开）；中心羊皮卷本身即入口。详细 Island 保留 `PanelRightClose` 返回（title “Collapse parchment”），header 新增 Download 导出按钮（`running` 禁用，§30）与行内状态；28px 级黄铜描边规范不变。

控件放在共享羊皮纸右上角，使用图标而不是带文字的圆角按钮：

- 默认布局使用 Lucide `PanelRightOpen`，Tooltip 为“展开羊皮纸”；
- 详细 Island 使用 `PanelRightClose`，Tooltip 为“返回上下布局”；
- 控件外观采用小型黄铜铰链或蜡封底座：深褐底、旧金描边、轻微内阴影；
- 尺寸建议 `28px × 28px`，圆角不超过 `4px`；
- Hover 只增强边缘高光，不使用霓虹、强发光或大幅缩放；
- Focus 必须有清晰的键盘轮廓，按钮提供 `aria-expanded` 和 `aria-controls`。

这个控件表达的是“展开阅读面”，不应设计成普通窗口的最大化按钮，也不应使用文字胶囊破坏羊皮纸语义。

### 6.5 交互状态

建议将羊皮纸 UI 明确建模为两个正交状态：

```ts
type ParchmentVisibility = 'closed' | 'open'
type ParchmentLayout = 'stacked' | 'detail-island'
```

状态规则：

1. 点击圆桌中心羊皮卷：`closed <-> open`。
2. 羊皮纸打开后点击展开控件：`stacked -> detail-island`。
3. 点击详细 Island 的返回控件：`detail-island -> stacked`，羊皮纸仍保持 `open`。
4. 按 `Escape` 时优先关闭详细 Island 并返回上下布局；再次按下才交给 Island 原有收起逻辑。
5. 往返布局时保留当前章节、滚动位置、展开折叠项和文本选择上下文。
6. 切换 Monitor、Chat、Roundtable 后再返回时，当前布局是否恢复由后续产品决策确定；首版建议在本次 Island 展开生命周期内恢复。

### 6.6 详细 Island 内容

> 已落地增补（2026-09-04）：header 导出当前纪要按钮（DRAFT 水印／FINAL，`running` 禁用，失败行内提示＋复制降级，§30）；标题/章节/空态/来源全部随应用语言切换（§32）。

详细 Island 优先解决阅读空间，而不是增加新的操作密度。建议包含：

- 固定的文档标题、状态和最近更新时间；
- 可收起的章节导航；
- 结论、决策、依据、风险、行动项和来源索引；
- 独立纵向滚动区域；
- 当前轮次更新时的轻量变更标记；
- 返回上下布局控件。

Chat 输入、模型选择、会议推进和结束操作仍留在主 Island，避免两个 Island 同时出现命令入口。

### 6.7 通用附属 Island 模块化设计

分体 Island 不能写成 `JanusRoundtableDetailIsland` 的一次性页面。推荐拆成“通用附属 Island 外壳 + 功能模块”两层：

```text
JanusAuxiliaryIslandHost
  -> JanusAuxiliaryIsland（通用外壳、几何、动效、可访问性）
      -> JanusRoundtableParchmentModule（首个内容模块）
      -> 未来的其他功能模块
```

通用外壳负责：

- 与主体 Island 一致的外观和设计 token；
- 右侧展开、组合居中、等高约束和响应式降级；
- 通用标题栏、关闭/返回控件、Focus 管理、`Escape` 和过渡动画；
- 模块挂载、切换和卸载生命周期；
- 单一附属 Island 实例管理。MVP 同一时间只打开一个模块，禁止继续向右级联第三个 Island。

功能模块负责：

- 模块标题、图标、ARIA 标签和局部操作；
- 自己的内容渲染、滚动位置和业务状态；
- 与所属功能 controller 的数据连接；
- 局部内容风格，但不能覆盖通用 Island 外壳。

建议使用描述对象或注册表，而不是在 Host 中堆叠功能条件分支：

```ts
type JanusAuxiliaryModuleType =
  | 'roundtable-parchment'
  | 'knowledge-detail'
  | 'runtime-detail'
  | 'office-preview'

interface JanusAuxiliaryModuleDescriptor {
  id: string
  type: JanusAuxiliaryModuleType
  title: string
  ariaLabel: string
  preferredWidth?: number
  minWidth?: number
}
```

上述未来模块名称用于定义扩展边界，不代表这些功能已经确定或实现。新增模块时应只注册 descriptor 和内容组件，不复制定位、外壳 CSS、关闭逻辑或响应式规则。

### 6.8 推荐实现方法

当前 `.janus-island-shell` 是固定定位容器，`.janus-island` 已允许 `overflow: visible`。建议按以下边界实现：

1. 将 `parchmentOpen` 和新的 `parchmentLayout` 从 `JanusRoundtablePane` 本地状态提升到 `JanusIsland` 或 `JanusIslandExpandedShell`，由能够同时控制主 Island 与附属 Island 的层级持有。
2. `JanusRoundtablePane` 改为受控组件，只接收状态、切换回调和共享羊皮纸内容。
3. 在 `.janus-island` 的同级渲染通用 `JanusAuxiliaryIslandHost`；羊皮纸通过 `JanusRoundtableParchmentModule` 挂载，不要把详细内容塞进现有右列，也不要使用 Portal 创建脱离 Island 的浮层。
4. 为 `.janus-island-shell` 增加 `data-auxiliary-open` 和当前模块标识；`data-parchment-layout="detail-island"` 只描述圆桌内部状态，组合几何由通用 Host 计算。
5. 详细 Island 高度使用 `height: 100%` 与主 Island 严格同步；宽度建议 `clamp(420px, 36vw, 620px)`，两者间距建议 `10px`。
6. 打开详细 Island 时，整个双 Island 组合应重新居中或向左平移，不能简单从当前中心向右溢出屏幕。
7. 主 Island 最小可用宽度建议不低于 `640px`；详细 Island 最小阅读宽度建议不低于 `420px`。
8. 内容状态保持单一实例。布局切换只改变承载位置，不能复制羊皮纸数据或重新请求内容。
9. 外壳样式抽成主体与附属 Island 共同消费的 token/primitive，禁止复制主体 Island 的完整 CSS 后单独维护。
10. 动画采用约 `280ms` 的位置与宽度过渡，表现为一个 Janus 工作面从主体右侧分出；`prefers-reduced-motion` 下直接切换。

不建议直接把主 `.janus-island-shell` 宽度硬加上详情宽度。当前 shell 以 `left: 50% + translateX(-50%)` 居中，直接增加宽度会同时改变原 Island 内部布局并造成右侧越界。应把主 Island 和详细 Island 视为一个组合几何单元。

### 6.9 响应式边界

- 可用宽度足够时：显示右侧等高详细 Island。
- 宽度不足以同时保证主 Island `640px` 和详情 `420px` 时：进入单 Island 的“羊皮纸专注视图”，详细内容占据原 Island 主体，返回按钮恢复上下布局。
- 不允许通过页面横向滚动访问被裁切的详细 Island。
- 移动端不生成右侧附属 Island，直接使用专注视图。

### 6.10 验收条件

> 部分条目已被后续决策替代（2026-09-04）：“默认上下布局不变”“返回上下布局”“返回后恢复章节滚动”中的 stacked 语义不再适用（直达附属 Island）；其余等高/同 token/不重挂载/单模块/`Escape`/响应式/`prefers-reduced-motion` 均有效。

- 默认上下布局和现有羊皮卷开合行为不变；
- 展开后确实出现一个与主 Island 等高的右侧阅读面；
- 附属 Island 的背景、边框、圆角、阴影、标题栏和动效与主体 Island 使用同一套 token 和 primitive；
- 羊皮纸风格只影响内容画布，不把附属 Island 外壳变成另一套窗口风格；
- 主 Island、圆桌动画和 Chat 不被重新挂载，输入草稿不丢失；
- 返回上下布局后恢复原章节和滚动位置；
- `Escape`、键盘 Focus、Tooltip 和 `aria-expanded` 行为正确；
- 1280、1440、1920 宽度下不越出视口；
- 窄屏自动进入专注视图，不出现水平滚动；
- 详细 Island 只承载阅读，不重复 Chat 或会议命令；
- Host 可以在不复制外壳、定位和关闭逻辑的前提下挂载第二种测试模块；
- 同一时间最多存在一个附属模块，不出现多级 Island 连锁展开；
- `prefers-reduced-motion` 下无强制位移动画。

### 6.11 Agent 工作预显与卡片化输出（后续对话默认交互）

这是基于 3D 原型需要固化的对话交互，不是普通 Chat 的换肤。目标是让用户始终知道“谁正在工作”，同时避免长输出把讨论流淹没。

#### 交互原则

1. **工作前预显**：调度器确认任务后，立即在左侧 3D 席位将对应 Agent 标记为 `queued`/`working`，显示工作阶段、简短任务名和开始时间。多个 Agent 排队时按实际执行顺序显示，不虚构并行状态；未开始的 Agent 不得显示为工作中。
2. **工作中联动**：`workingRole` 必须来自运行时事件，而不是组件常量。当前工作席位使用 active-speaking/working 视觉状态，Chat 只追加一条轻量事件（如“CODER 正在分析”），不插入半成品长文本。
3. **结果卡片**：Agent 完成、失败、等待审批或需要用户输入时，输出写入一张 `AgentResultCard`，Chat 中只显示卡片摘要（Agent、状态、标题、时间、要点计数、是否需要操作）。完整 Markdown、工具调用、引用和错误堆栈不直接平铺到 Chat。
4. **点击查看详情**：点击卡片后，使用现有 `JanusAuxiliaryIslandHost` 打开右侧等高附属 Island；详情面板显示该卡片的完整内容并独立滚动。详情是同一结果对象的阅读投影，不复制消息、不创建第二个 Chat，也不重新执行 Agent。
5. **返回与上下文保持**：关闭详情或按 `Escape` 回到原布局，保留卡片选中态、详情章节和滚动位置；新结果到达时不强制抢焦点，除非该卡片标记为 `requiresUserAction`。
6. **状态可追溯**：卡片状态必须能回溯到圆桌记录中的事件和版本。未经验证的内容显示 `proposal`、`concern` 或 `pending-validation` 标签，不得因卡片展示而升级为事实。

#### 建议数据契约

```ts
type AgentWorkState = 'queued' | 'working' | 'completed' | 'failed' | 'awaiting-input' | 'cancelled'

type AgentResultCard = {
  id: string
  sessionId: string
  roundId: string
  agentId: string
  role: 'main' | 'coder' | 'evaluator' | string
  title: string
  status: AgentWorkState
  summary: string
  sections: Array<{ id: string; title: string; markdown: string }>
  evidenceRefs: RoundtableEvidenceRef[] // 结构化联合引用（workspace-file/agent-card/event），非 string[]
  requiresUserAction: boolean
  createdAt: string
  updatedAt: string
  sourceEventIds: string[]
}
```

> 已落地勘误（2026-09-04）：`RoundtableStage` 实际接收 `workingRole: RoundtableRole | null`（单席位，非 `workingAgents` 数组）；运行时实际发布 `agent:queued/working/result/error`＋轮次/会话/工具/host 事件，`agent:awaiting-input` 尚未有发送方；`AgentWorkRail` 未独立实现（队列表达并入 live 卡）。

运行时至少发布 `agent:queued`、`agent:working`、`agent:result`、`agent:error`、`agent:awaiting-input` 五类事件。UI 只订阅事件并更新投影；持久化层保存事件和卡片，不保存与卡片重复的第二份正文。

#### 组件与状态边界

- `JanusRoundtablePane` 继续负责圆桌、Chat 输入和卡片列表的组合，不负责生成 Agent 内容。
- `RoundtableStage` 接收 `participants` 与 `workingAgents`，只负责左侧席位的状态表达。
- 新增 `AgentWorkRail`（可先作为 Stage 内部区域）负责显示队列、工作中席位和最近完成项；窄屏时折叠为顶部紧凑状态条。
- 新增 `AgentResultCard` 负责摘要、状态徽章、更新时间和点击回调；卡片正文不得在 Chat 中展开。
- `JanusAuxiliaryIslandHost` 增加 `agent-result` descriptor，复用现有外壳；`AgentResultDetail` 仅负责详情阅读和章节导航。
- 同一时间最多打开一个详情 Island；切换卡片只替换详情数据，不重新挂载主 Island、3D 场景或输入框。

#### 实施拆分与验收

1. **事件与类型**：建立上述事件和 `AgentResultCard` 类型，使用本地 fixture 驱动 UI；验收为状态转换可测试、事件带 `sessionId/roundId` 且可去重。
2. **左侧预显**：把 `workingRole` 改为事件派生的 `workingAgents`，实现 queued/working/completed/failed 的席位样式和无障碍标签；验收为每次调度先出现预显，结束后准确归档，不能出现“幽灵工作中”。
3. **卡片投影**：将 `postDebateBubble` 的 Agent 长文本改为结果卡片摘要，保留用户消息和主持人轮次提示；验收为长 Markdown 不进入 Chat 平铺区，卡片可键盘聚焦和激活。
4. **详情 Island**：注册 `agent-result` 模块并接入点击、返回、`Escape`、独立滚动和窄屏专注视图；验收为详情与卡片内容一致、不会重复执行、不会丢失 Chat 草稿。
5. **真实引擎接线**：将 fixture 替换为圆桌运行时事件，接入失败恢复、审批和持久化；验收为刷新/恢复后卡片状态和详情可追溯，导出的 Markdown 与卡片正文来源一致。

该交互在真实运行时接入前均标记为“部分实现/占位数据”。原型中的 `debate-bubble` 可保留用于用户消息和系统事件，但不再作为 Agent 长结果的最终呈现形式。

### 6.12 用户显式开启轮次（会议生命周期约束）

每一轮讨论都必须由用户人为开启。输入框发送和“开始下一轮”是同一个推进动作的两种入口：首次输入负责创建会议并自动开始第 1 轮，之后用户可以补充文字后开启下一轮，也可以不输入任何内容直接让 Agent 基于当前共享状态继续讨论和优化。

#### 生命周期

```text
idle
  -- 用户首次提交非空需求 --> round-1/running
round-N/awaiting-user
  -- 用户输入补充内容并点击开启 --> round-(N+1)/running
round-N/awaiting-user
  -- 不输入内容、直接点击开启 --> round-(N+1)/running
round-N/running
  -- Agent-1 -> Agent-2 -> JanusX 完成 --> round-N/awaiting-user
```

- `idle` 阶段不显示工作 Agent、工作卡片或“正在讨论”状态；可以显示空圆桌和输入控件。
- 用户首次提交非空需求后，系统原子地创建 `session`、写入用户议题并启动第 1 轮，随后才显示左侧 Agent 工作预显。
- 每轮完成后必须停在 `awaiting-user`，不得自动开始下一轮；JanusX 可以给出建议，但不能替用户点击开启。
- 开启下一轮时先记录可选的用户补充事件；空输入表示“沿用当前共享状态并继续优化”，不是一条空消息，也不应在 Chat 中生成空白气泡。
- 轮次开启按钮在运行中禁用，避免重复点击创建重复轮次；请求幂等键使用 `sessionId + nextRoundNumber`。
- 会议结束是独立的用户操作。结束后不再显示开启下一轮，仅允许查看卡片、共享羊皮纸和导出结果。

#### UI 约束

- 首次输入前：不显示 Agent 工作预显，不显示结果卡片列表中的占位卡，不自动播放 Agent 发言动画。
- 第 1 轮启动后：左侧席位按事件显示 queued/working；右侧 Chat 仅显示用户议题、轮次提示和卡片摘要。
- 轮次等待用户时：输入框旁显示明确的“开启下一轮”图标按钮；按钮在文本为空时仍可用，并提供 Tooltip 说明“沿用当前方案继续讨论”。
- 文本非空时按钮语义变为“补充并开启下一轮”，发送快捷键不得绕过轮次确认规则。
- 移动端和专注视图沿用同一生命周期，不因布局切换自动推进轮次。

#### 事件与验收补充

新增 `session:created`、`round:started`、`round:awaiting-user`、`round:ended` 事件；`round:started` 必须包含 `trigger: 'initial-input' | 'user-advance'` 与 `userInput?: string`。验收要求：

1. 首次输入前无 Agent 工作状态；首次非空提交只启动一次第 1 轮。
2. Agent 完成一轮后不会自行启动下一轮，必须等待用户操作。
3. 空输入开启下一轮成功，且不会产生空白用户消息。
4. 带补充内容开启下一轮时，补充内容在该轮上下文中可追溯。
5. 快速重复点击、刷新恢复和网络重试不会生成重复轮次。

## 7. 下一步实施顺序

1. [已完成] 抽取主体与附属 Island 共用的视觉 token 和外壳 primitive，锁定一致性基线。
2. [已完成] 实现通用 `JanusAuxiliaryIsland` 模块契约，并挂载羊皮纸模块。
3. [已完成] 实现纯 UI 状态：`stacked <-> detail-island`，用占位羊皮纸内容验证几何和往返行为。
4. [已完成] 将羊皮纸状态提升到 `JanusIsland`，保证 Chat 不因布局切换重新挂载。
5. [已完成] 完成宽屏双 Island、窄屏专注视图和键盘交互测试。
6. [已完成（内存）] 定义共享结构化状态的数据模型和羊皮纸投影器。
7. [已完成] 定义 Agent 工作事件与 `AgentResultCard` 投影，完成 Renderer 事件订阅、摘要卡片、`agent-result` 详情 Island 和真实结果章节/证据展示；JSONL 持久化已落地（§24）。
8. [已完成] 用户显式开启轮次：首次非空输入启动第 1 轮，后续支持空输入（§35）或补充输入开启下一轮，幂等与防重复提交已落地。
9. [已完成] LangGraph.js Runtime 与 Agent Registry 真实 Agent（默认模型 `generateText`＋只读工具）已接线；`refiner/challenger` 集合与 fan-out/join 由工作流模板驱动。
10. [已完成] `workingRole` 接入真实运行时事件（含 `janusx → host`，§29）；live 卡仅真实事件，无合成占位。
11. [已完成] 失败经 `agent:error`＋对话框红色横幅显错（§31）；结束保留 FINAL＋横幅＋分阶段退出（§30、§33）；卡片与轮次事件写入圆桌记录。
12. [已完成] JSONL 事件/快照存储与恢复、事实生成、`roundtable:export`、工作区只读工具、最终整理（Host 草稿＋终稿）、导出文件保存 UI（结束横幅＋详情按钮，§30）均已落地。

UI 扩展与会议引擎应分阶段实施。右侧详细 Island 可以先使用真实结构的占位数据完成交互验证，但文档中必须持续标记其数据链路尚未实现。

## 8. 多智能体编排框架选型

### 8.1 结论

JanusX 建议采用 **LangGraph 作为编排内核**，而不是直接使用 CrewAI、MetaGPT 或 Swarms 作为产品的总控制器。JanusX 的核心难点是可恢复状态机、用户控制的轮次闸门、事件追踪、审批、取消、超时、重试和 UI 实时投影；LangGraph 的 StateGraph、checkpoint、interrupt/resume、streaming 和 subgraph 能直接表达这些边界。

框架本身不会自动带来更好的调度。LangGraph 负责“状态如何合法流转”，JanusX Runtime 负责队列、并发、模型路由、超时和观测。

### 8.2 候选框架对比

| 框架 | 优势 | 主要限制 | JanusX 定位 |
|---|---|---|---|
| LangGraph（JS/TS 或 Python） | 显式状态图、检查点、人工中断/恢复、流式事件、条件分支、子图和可测试性强 | 抽象层较低，需自行设计队列、模型路由和观测 | 首选编排内核 |
| CrewAI | Role/Task/Crew 抽象清晰，上手快，适合固定流程 PoC | 复杂暂停、恢复、幂等和产品级事件语义需要额外包裹 | 快速实验或 Agent 适配器 |
| MetaGPT | SOP、角色协作和软件工程流程经验丰富 | 约束较强、默认流程偏重，动态扩展和低延迟交互改造成本高 | 借鉴角色/SOP，不直接接管运行时 |
| Swarms | 提供多种 swarm 编排模式，适合探索并行协作 | 产品级生命周期、检查点和稳定契约需自行建设 | 并行策略参考或实验适配器 |

### 8.3 推荐运行时架构

```text
Renderer (React) <-> Electron IPC <-> Janus Orchestrator Service
                                      - LangGraph StateGraph
                                      - Round Scheduler / Queue / Cancellation
                                      - Agent Registry + Model Router
                                      - Event Journal + Checkpoint Store
                                      - Approval / Workspace Policy Gateway
                                      <-> AI SDK / MCP / CLI adapters
```

- UI 不直接依赖 LangGraph 类型，只消费 JanusX 自己定义的 session、round、agent、card 事件。
- `await-user` 是图中的显式 interrupt/等待节点；首次非空输入启动第 1 轮，之后每轮结束都暂停，只有 `advance-round` 才 resume。
- MVP 默认按“完善 Agent 集合 -> 质疑 Agent 集合 -> JanusX 汇总”执行。集合内可以串行或并行，最终必须在主持人节点统一归并；流程顺序、并发策略和汇聚规则由编排模板声明，而不是由 UI 假设。
- Agent 通过 registry 声明 schema、能力、模型偏好、超时和工具权限，新增 Agent 不应修改主图控制流。
- 通过 bounded queue、并发上限、取消令牌、节点 timeout、指数退避和幂等 `runId` 保证响应及时且不重复执行。
- 长任务放入 Node worker 或独立 service，避免阻塞 Electron 渲染和窗口响应。

### 8.3.1 可扩展拓扑与流程模板

“一用户 + 三 Agent”只表示 MVP 的最小可运行单位，不是长期固定编排。编排内核从第一天就必须支持可配置拓扑：

- **参与者基数**：`user` 和 `host` 在 MVP 及后续版本保持单例；`refiner`（方案完善/建设型）和 `challenger`（问题/风险质疑型）都是可扩展集合，数量可以是 `1..N`。
- **角色与实例分离**：角色定义能力和输入输出契约，实例定义模型、提示词、工具权限、并发额度和超时。同一角色可以创建多个实例，也可以在不同流程中复用。
- **流程模板注册**：使用 `WorkflowTemplate`/`GraphTemplate` descriptor 注册流程，不在 `JanusRoundtablePane` 或主图中硬编码 Agent-1、Agent-2。模板至少声明节点、边、fan-out、join、失败策略、终止条件和版本。
- **动态 fan-out/join**：根据当前会话配置生成多个完善 Agent 和质疑 Agent 节点；每个分支结果必须带 `agentId`/`role`/`roundId`，由 join 节点按策略归并、去重和标注冲突。
- **流程可替换**：MVP 的默认模板可以是 `refiners -> challengers -> host-synthesis`；后续可增加“先检索后讨论”“多阶段审查”“投票/仲裁”“用户确认后执行”等模板，UI 只渲染事件和状态，不感知具体图结构。
- **版本与兼容**：会话创建时锁定 `workflowId`、`workflowVersion` 和参与者快照；流程升级不改变历史会话的解释方式，恢复时使用原版本或显式迁移。

建议契约：

```ts
type ParticipantSpec = {
  role: 'host' | 'refiner' | 'challenger' | string
  min: number
  max: number
  instances: Array<{ id: string; model?: string; capabilities: string[] }>
}

type WorkflowTemplate = {
  id: string
  version: string
  participants: ParticipantSpec[]
  stages: Array<{ id: string; role: string; fanOut?: string; join?: string }>
  termination: 'user-only' | string
}
```

第一阶段 PoC 也必须用配置生成至少 1 个和 2 个 `refiner`、1 个和 2 个 `challenger` 两种拓扑，证明 fan-out、join、卡片排序、失败分支和主持人汇总不依赖固定数量。

### 8.4 分阶段落地

1. 先定义可扩展 `WorkflowTemplate`、参与者集合和事件契约；用内存 checkpointer + fixture 图验证轮次闸门、动态 fan-out/join、卡片投影和 `await-user` 恢复。
2. 在 Node/TypeScript 侧接入 LangGraph.js，保留 Provider adapter，避免业务节点绑定单一模型 SDK。
3. 接入持久化 checkpoint、事件日志、取消/超时/重试和 IPC streaming，再替换 fixture Agent。
4. 对独立子任务增加并行 subgraph；以首 token 时间、轮次完成时间、失败恢复率和重复执行率评估调度。
5. 其他框架只能通过 `AgentAdapter`/`SubgraphAdapter` 接入，事件必须映射回 JanusX 统一契约。

当前选型状态：**建议采用 LangGraph.js + JanusX Runtime 外壳，待 PoC 后冻结依赖版本**。

## 9. 文档维护规则

- 代码事实优先于旧讨论记录；每次 UI 或引擎改动后同步更新第 2、3 节。
- 已实现、部分实现、待实施和已移除必须明确区分。
- 被当前实现淘汰的布局方案直接删除，不继续累积历史描述。
- 新设计先记录目标、状态、交互、实现边界和验收条件，再进入编码。
- 产品规则不等于代码能力；未通过代码与测试验证的项目不能标记为已实现。

## 10. 最新决策记录

### 2026-09-01 / 后续对话交互基线

- 后续圆桌对话采用“左侧 Agent 工作预显 + Chat 结果卡片 + 右侧附属 Island 详情”的交互基线。
- Agent 开始工作前必须先发布队列/工作状态并在左侧席位可见；工作状态由运行时事件驱动，不再使用固定 `workingRole`。
- Agent 长输出不直接平铺到 Chat，统一落为可追溯的 `AgentResultCard`；Chat 只保留摘要和状态。
- 卡片点击打开 `agent-result` 附属 Island，详情与卡片共享同一数据对象，支持独立滚动、返回和 `Escape`，不重复执行任务。
- 会议轮次由用户显式推进：首次非空输入才创建并启动第 1 轮；每轮结束后停在等待状态，后续可用空输入让 Agent 自主优化，或输入补充想法后开启下一轮。
- 该方案先以 fixture 验证 UI，再接入真实圆桌事件、审批、恢复和持久化；在真实数据链路完成前不得标记为已实现。

### 2026-09-01 / 多智能体编排框架选型

- 推荐 LangGraph.js 作为状态编排内核，JanusX 自建 Runtime 负责队列、并发、模型路由、取消、超时、重试和 IPC。
- 不让 CrewAI、MetaGPT 或 Swarms 直接成为产品事实源；需要试用时通过适配器接入并映射统一事件契约。
- 选型依据是 JanusX 对显式轮次闸门、interrupt/resume、checkpoint、streaming、可追溯事件和灵活扩展的要求。
- 先完成小型 PoC，再冻结依赖版本；PoC 未验证恢复、取消和响应指标前，不扩散到 UI 数据模型。
- MVP 的一用户三 Agent 只是最小拓扑；完善型 Agent 与质疑型 Agent 均按集合建模并支持 `1..N` 扩展。
- 编排流程通过带版本的 `WorkflowTemplate` 注册，支持动态 fan-out/join 和多种后续流程；不得在主图、UI 或持久化结构中写死 Agent 数量。
- 第一阶段 PoC 已落地 `src/shared/roundtable` 类型契约、`src/main/roundtable/runtime.ts` LangGraph.js 运行时和 `tests/unit/roundtable-runtime.test.ts`；已验证 2 个完善 Agent + 2 个质疑 Agent、用户轮次闸门、空输入推进和单 Agent 失败保留结果。
- 下一阶段已新增 `src/main/roundtable/agent-registry.ts`，Runtime 可接收动态注册的 Agent 集合；已通过 4 项定向单元测试。真实模型适配、IPC streaming、checkpoint 持久化、取消/超时策略仍未接入。

### 2026-08-31 / 当前实现校准

- 文档状态从“需求研讨中，未进入实现”修正为“视觉舞台已实现，会议引擎重构中”。
- 当前布局确认为左侧完整 3D 圆桌，右侧共享羊皮纸在上、discussion-only Chat 在下。
- 当前羊皮纸默认关闭，由圆桌中心羊皮卷控制开合。
- 当前圆桌消息、Agent 状态、共享文档、编排、持久化和导出均未连接真实运行时。
- 删除已被代码淘汰的三栏、独立窗口、工作区嵌入和底部整宽输入条方案描述。

### 2026-08-31 / 右侧详细 Island 新方向

- 保留现有上下布局作为快速浏览模式。
- 共享羊皮纸新增符合羊皮纸视觉语言的展开控件。
- 用户需要详细阅读时，在主 Island 右侧生成等高的附属 Island，显示完整羊皮纸内容。
- 附属 Island 必须复用主体 Island 的外层视觉系统；羊皮纸风格只用于内容画布和专属控件。
- 分体能力按通用附属 Island Host 和可注册功能模块设计，羊皮纸只是首个模块，后续可以承载其他功能界面。
- MVP 同一时间只允许一个附属模块，避免形成连续级联的多重 Island。
- 用户可以通过返回控件或 `Escape` 回到上下布局，阅读位置和内容状态不得丢失。
- 宽度不足时使用单 Island 专注视图，避免压缩主圆桌和 Chat 到不可用尺寸。
- 当前状态：UI 交互已实现并接入圆桌；真实会议数据仍未接入，羊皮纸内容继续使用占位投影。

### 2026-08-31 / 附属 Island 首次落地

- `JanusIsland` 持有羊皮纸开合与附属模块状态，`JanusRoundtablePane` 改为受控组件。
- 通用外壳位于 `JanusAuxiliaryIsland.tsx`，羊皮纸内容位于 `JanusRoundtableParchment.tsx`，后续模块通过 descriptor 注册挂载。
- 宽屏显示主 Island 右侧等高阅读面；窄屏自动切换为单 Island 专注视图，不产生横向滚动。
- 返回控件和 `Escape` 关闭附属面并恢复上下布局，羊皮纸保持打开；同一时间仅允许一个附属模块。
- 关闭附属 Island 后清除羊皮纸激活状态，主体恢复为圆桌与 Chat 的原始布局。
- 圆桌主体移除羊皮纸内容面板及展开/收缩按钮，仅保留中心羊皮纸交互。
- 点击中心羊皮纸后直接打开右侧等高附属 Island，附属面板承载完整羊皮纸内容。
- 附属 Island 保留羊皮纸顶部标题和状态字样，不再显示第二个展开/收缩控件。

## 11. 2026-09-02 实测问题与修复记录

本次结合实际代码和原型复核，确认此前“已实现”描述存在偏差：

- Roundtable Chat 的消息列表由 `work.cards` 反推，用户输入没有写入任何消息状态。首次发送后输入框清空，重渲染时用户消息消失，因此右侧看不到用户消息卡片。
- `JanusRoundtablePane` 将 Agent 结果卡片放在中部 Chat 下方，右侧状态栏只保留羊皮纸展开按钮；同时样式末尾存在 `display: none !important`，导致右侧工作区即使收到结果也不可见。
- `roundtableMessages` 只包含 Agent 摘要，不包含用户消息，无法满足“用户提议 + Agent 结果”可追溯的讨论流。
- 原型右侧 Agent 卡片强调状态、标题、摘要和点击展开；原实现卡片过于扁平，摘要单行截断，层级与右侧工作区职责不一致。

本次修复：

- 在 `JanusRoundtablePane` 增加用户消息投影，非空发送先记录用户消息，再调用 `start/advance`；用户消息与 Agent 摘要按时间排序并去重显示。
- 将 Agent 结果卡片移入右侧 Agent Work Deck，空状态、结果计数、状态标签和多行摘要均可见；点击卡片继续打开 `agent-result` 详情 Island。
- 调整卡片视觉为原型风格的深色档案面板：细边框、状态色、标题/摘要层级、悬停和键盘焦点反馈。
- 覆盖冲突的隐藏规则，确保右侧工作区在 Roundtable 视图中稳定显示。

仍需后续验证：真实模型事件流、会话恢复后的用户消息持久化、端到端浏览器交互截图，以及 `advance-round` 幂等性测试。当前用户消息投影属于 Renderer 本地状态，尚未写入 Roundtable JSONL 事件日志。
### 2026-09-02 / Agent 输出呈现优化

补充实测问题：Agent 卡片摘要曾被转换为 assistant 消息，因此完整 Agent 回复直接展开在 Chat；同时 `modelNotice` 将内部 `workingRole` 字段（如 Agent-1）渲染到输入框底部，造成内部实现信息泄漏。

已调整为：Chat 只显示用户提议；Agent 工作中/已完成状态统一显示在右侧小型工作卡片，卡片点击后才打开附属 Island 查看完整 sections/evidence。Roundtable Chat 不再传递 `modelNotice`，内部 Agent 角色字段不再出现在底部。

### 2026-09-02 / 白字状态泄漏修复

实测发现 Roundtable 仍把 workingRole 拼接为 Chat 的 modelNotice，导致输入框底部显示 Agent-1/Agent-2，且 Agent 工作状态未形成卡片。现已彻底移除该 notice 传递；运行阶段无事件时也按默认 MVP Agent 集合生成 working 小卡片，结果完成后由事件卡片替换。Agent 详细输出仅通过点击卡片打开附属 Island。

### 2026-09-02 / Roundtable 中部布局重构

实测确认此前卡片栏与 Chat 以横向 flex 兄弟节点渲染，导致卡片占据整个右侧并挤压对话区；会议操作按钮使用 absolute 定位覆盖 Chat。现已改为中部纵向结构：Chat 占据主高度，Agent 卡片在 Chat 内下方左对齐，用户消息保持 Chat 原有右对齐；“开启下一轮/结束会议”改为独立底部操作行，不再覆盖对话内容。
### 2026-09-02 / 卡片与操作区顺序修正

再次实测确认，卡片位于 Chat 组件之后时会落到整个对话框最底部（晚于 Chat 自带输入区）。现已调整 JSX 顺序和 flex order：Agent 卡片区位于对话流上方并左对齐，Chat 消息及输入区位于中部，会议推进/结束控件位于最底部独立操作行。
<!-- Document role: implementation plan and ongoing implementation record. -->

## 12. 2026-09-02 / MVP 验证与双层数据模型校准

### 当前结论

- 圆桌 Runtime MVP 已完成 PoC 级跑通：用户输入、首轮启动、Agent 编排、轮次等待、用户推进、结束会议和基础事件记录均已接入。
- Agent 工作卡片、对话流、附属 Island、Chat/圆桌视图保持和工作区添加反馈已完成基础 UI 实现。
- 该版本仍不能标记为完整产品 MVP：真实模型适配、完整恢复、取消/超时、最终整理和导出文件 UI 仍未全部验证。

### 双层数据模型核对

设计要求是维护两份数据：

1. **Agent 公有池（机器读取层）**：完整、结构化、可追溯，供 Agent 读取事实、来源、状态和历史变更。
2. **人类羊皮纸（人类阅读层）**：由 JanusX 主持人整理后的简洁文本，只展示结论、确认决策、关键依据、主要风险和下一步行动。

当前实现仍存在偏差：`RoundtableState.facts` 是机器读取层，但 `projectParchment()` 只是按事实类型分类，`JanusRoundtableParchment` 又将分类后的事实逐条展开。因此羊皮纸目前是“结构化事实投影”，还不是独立的人类可读总结。

### 后续实施方案

- 保留 `RoundtableState.facts` 作为 Agent 公有池，不将其直接作为羊皮纸正文。
- 增加主持人整理步骤，生成独立的 `HumanReadableParchment` 内容。
- 羊皮纸正文默认只显示简洁结论、决策、依据、风险和行动项。
- 来源索引、原始 Agent 输出、状态和证据引用改为可展开的追溯信息。
- 在测试中分别验证公有池完整性和羊皮纸可读性，禁止以“事实分类完成”替代“主持人整理完成”。

### 实施状态

| 能力 | 状态 | 说明 |
|---|---|---|
| 圆桌 Runtime 生命周期 | 已完成 PoC | 已验证启动、轮次闸门、推进和结束 |
| Agent 结果卡片 | 已实现 | 支持状态、摘要、详情 Island |
| Agent 公有事实池 | 已实现基础版 | 结构化事实和来源可追溯 |
| 人类可读羊皮纸 | 已实现基础版 | Host 每轮生成独立草稿（`host:synthesis` 事件入日志），结束时生成终稿；正文取草稿结论/决策/依据/风险/行动/待验证/冲突，DRAFT/FINAL 标记随状态切换；无草稿时降级为规则投影 |
| 最终整理与导出 | 部分实现 | 有 Markdown 导出路径，完整整理和文件保存 UI 待完善 |
## 13. 2026-09-02 / 工作区上下文接入计划

当前核对确认：添加工作区目前只对普通 Janus Chat 生效，尚未接入圆桌 Runtime。普通 Chat 会保存 `conversation.attachedWorkspaceIds` 并创建 workspace session；圆桌 Agent 只收到用户输入和前序卡片摘要，不接收工作区路径、文件内容或工具，因此目前不能宣称 Agent 能围绕需求与工作区进行讨论。

### 分阶段实施计划

1. **会话数据契约**：扩展 `roundtable:start/advance` 携带 `workspaceResources`，并在 `RoundtableState` 保存资源快照，验证事件日志和恢复状态可还原。
2. **只读工作区上下文**：复用安全 workspace session，为 Agent 提供结构摘要、文件索引和用户指定文件；默认禁止写文件、命令和 Git 修改。
3. **共享公有事实池**：让 Refiner、Challenger、Host 读取同一版本的工作区事实，引用记录路径、行号或事件 ID，并区分 confirmed/proposal/concern/pending-validation。
4. **人类可读羊皮纸**：新增独立 `HumanReadableParchment`，由 Host 整理结论、决策、依据、风险和行动；原始输出、状态和来源改为可展开追溯信息。
5. **恢复与端到端验收**：覆盖绑定工作区、Agent 读取文件、多轮讨论、卡片详情、羊皮纸草稿、结束和导出，并增加超时、取消、重复事件和大仓库测试。

### 实施状态

| 能力 | 状态 | 下一步 |
|---|---|---|
| 普通 Chat 添加工作区 | 已实现 | 保持现有行为 |
| 圆桌绑定工作区资源 | 未实现 | 阶段 1：扩展 IPC 与状态契约 |
| 圆桌 Agent 只读工作区 | 未实现 | 阶段 2：复用安全读取适配器 |
| 多 Agent 共享工作区公有池 | 未实现 | 阶段 3：上下文版本与来源追踪 |
| 人类可读羊皮纸 | 待实现 | 阶段 4：主持人整理模型 |
| 恢复与完整端到端验收 | 部分实现 | 阶段 5：补齐测试与真实链路 |

## 16. 2026-09-02 / 阶段 3 实施记录：共享公有事实池

### 已完成

- 启动时读取到的工作区文件路径会生成共享 `evidence` 事实，进入 `RoundtableState.facts`。
- 所有 Refiner、Challenger、Host Agent 使用同一份工作区上下文和共享事实列表。
- Agent 输入新增 `priorFacts`，不再只依赖前序卡片摘要。
- 结果卡片的 `evidenceRefs` 同时记录工作区文件路径和前序卡片 ID，支持追溯。
- 共享事实保留 `confirmed/proposal/concern/pending-validation` 等状态语义，供后续主持人整理使用。
- `RoundtableState.getState()` 和 hydrate 快照复制工作区资源、上下文文件和事实，避免跨轮次引用丢失。

### 阶段 3 边界

当前公有池使用的是启动时的只读文件快照；Agent 仍不能在讨论中动态调用读取工具，也没有实现事实冲突合并策略和行号级来源定位。这些能力将在后续工具接入与主持人整理阶段补齐。

### 状态

| 能力 | 状态 |
|---|---|
| 工作区证据进入共享事实池 | 已实现基础版 |
| 多 Agent 读取同一份事实 | 已实现 |
| 结果卡片引用工作区文件 | 已实现基础版 |
| 事实状态语义 | 已实现基础版 |
| 讨论中动态读取文件 | 待后续实现 |
| 冲突合并与行号级来源 | 待后续实现 |

## 17. 2026-09-02 / 阶段 4 实施记录：人类可读羊皮纸基础版

### 已完成

- 新增独立 `HumanReadableParchment` 模型，与 `RoundtableState.facts` 机器事实池分离。
- `projectParchment()` 同时生成完整结构化投影和简洁的人类阅读投影。
- 羊皮纸正文只展示结论、确认决策、关键依据、主要风险/问题和下一步行动，每类最多 5 条。
- 原始状态标签和完整事实对象不再默认铺满羊皮纸正文。
- 来源索引保留在末尾作为追溯信息；会议未结束时标记为草稿。
- 羊皮纸内容仍会随每轮状态更新，结束会议后自动变为非草稿状态。

### 阶段 4 边界

当前整理逻辑是本地规则投影，不是 Host Agent 的语义归纳。后续需要让 Host 生成真正的综合结论、合并冲突观点，并将原始 Agent 输出和证据引用放入可展开详情。

### 状态

| 能力 | 状态 |
|---|---|
| 机器事实池与人类投影分离 | 已实现 |
| 简洁羊皮纸正文 | 已实现基础版 |
| 草稿/最终状态标记 | 已实现 |
| 来源追溯保留 | 已实现基础版 |
| Host 语义归纳 | 待后续实现 |
| 冲突观点合并 | 待后续实现 |

## 18. 2026-09-02 / 阶段 5 实施记录：恢复一致性与验收基线

### 已完成

- Runtime hydrate 对旧快照提供默认值兼容，缺失工作区字段时不会破坏恢复。
- 恢复时复制工作区资源、上下文文件、事实池和事件索引，避免引用共享数组造成状态污染。
- 增加工作区快照恢复测试，验证资源、文件索引和事实池在 hydrate 前后一致。
- 阶段 1 至 4 的核心圆桌 Runtime 单元测试继续通过。

### 当前剩余工作

- 取消、超时和并发读取策略仍需接入 Runtime。
- 真实模型下的动态文件读取工具和权限审批仍未完成。
- 端到端“绑定工作区 → Agent 读取 → 多轮讨论 → 羊皮纸 → 导出”仍需在桌面环境验证。

### 阶段状态

阶段 5 已完成“恢复一致性基础”和测试基线，完整产品 MVP 仍待真实模型、动态工具和桌面端到端验收完成。

## 15. 2026-09-02 / 阶段 2 实施记录：只读工作区上下文

### 已完成

- 圆桌启动时会读取绑定工作区的文本文件，生成受限大小的只读上下文快照。
- 复用 `JanusWorkspaceFs.collectTextEvidence()`，自动跳过 `.git`、`node_modules`、构建产物和敏感路径。
- 上下文限制为最多 40 个文件、单文件 12KB、总上下文 96KB，避免大仓库阻塞会议。
- Runtime 将工作区证据上下文传递给每个 Refiner、Challenger 和 Host Agent。
- Agent 提示词会同时包含工作区路径、文件内容摘要和前序 Agent 结果。
- 无法读取的工作区不会阻塞圆桌，会以“无可读证据”继续运行。

### 阶段 2 边界

本阶段实现的是启动时只读上下文快照，不是动态工具调用。Agent 暂时不能在讨论中自行再次读取文件，也不能写文件、执行命令或修改 Git；这些属于后续权限与工具接入工作。

### 状态

| 能力 | 状态 |
|---|---|
| 读取工作区文本文件 | 已实现基础版 |
| 排除敏感目录和非文本文件 | 已实现 |
| 上下文大小限制 | 已实现 |
| Agent 接收工作区证据 | 已实现基础版 |
| 讨论中动态读取文件 | 阶段 3 待实现 |
| 写入、命令和 Git 操作 | 禁止，待后续审批设计 |

## 14. 2026-09-02 / 阶段 1 实施记录：圆桌绑定工作区资源

### 已完成

- 新增 `RoundtableWorkspaceResource` 契约，统一记录 `workspaceId`、`workspaceName`、`workspacePath`。
- `roundtable:start` 支持传入 `{ prompt, workspaceResources }`，并保留字符串输入兼容。
- 圆桌 Renderer 从当前 `resourceController.resources` 生成工作区资源快照后再启动会话。
- `RoundtableState` 保存会话级 `workspaceResources` 快照；后续轮次沿用该快照，不随 UI 临时变化漂移。
- Runtime 的 Agent 输入契约携带工作区资源，当前模型提示词会明确列出只读工作区路径。
- IPC、Preload、Main Service、Runtime 和共享类型已完成贯通。
- 既有圆桌 Runtime 与状态单元测试通过。

### 阶段 1 边界

本阶段只完成“资源绑定和上下文传递”，尚未实现文件读取工具、工作区内容摘要、权限审批或写操作。Agent 当前知道绑定了哪些工作区路径，但还不能因此读取项目文件；这些能力属于阶段 2。

### 状态

| 能力 | 状态 |
|---|---|
| 圆桌启动携带工作区资源 | 已实现 |
| 圆桌状态保存资源快照 | 已实现 |
| 后续轮次复用资源快照 | 已实现 |
| Agent 接收工作区路径上下文 | 已实现基础版 |
| Agent 读取工作区文件 | 阶段 2 待实现 |
| 工作区权限与只读策略 | 阶段 2 待实现 |

## 19. 2026-09-03 / 代码 Review 记录与整改计划

本节基于当前仓库实现、已有单元测试和前述阶段记录整理。结论是：圆桌 Runtime 已具备 PoC 级生命周期和工作区静态上下文能力，但尚未达到“安全、可追溯、可动态核验、可恢复的产品 MVP”标准。本次 Review 不把 UI 已接通或测试桩通过等同于真实模型和桌面端到端能力已完成。

### 19.1 Review 发现的问题与风险

1. **工作区路径信任边界不足（高）**
   - Renderer 当前可将 `workspacePath` 随圆桌 IPC 传入，Main Runtime 直接交给 `collectTextEvidence()`。
   - 缺少“workspaceId 必须来自主进程已注册工作区”的强校验，也没有在读取前统一执行 realpath、目录边界和符号链接检查。
   - 风险是错误或伪造 IPC 可能读取未授权目录；现有维护扫描用授权回调不能直接视为圆桌的只读授权策略。

2. **启动上下文过重且重复保存（中高）**
   - `RoundtableRuntime.start()` 最多读取 40 个文件、总计 96KB，并把原始上下文同时放进 Runtime 状态及每个 Agent 的输入。
   - 多轮事件快照和 JSONL 日志可能重复保存大字符串，启动大仓库时也会阻塞首轮。

3. **公有事实的来源契约不完整（高）**
   - 工作区文件目前以 `kind: evidence`、`status: confirmed` 和路径字符串进入 `RoundtableState.facts`，但没有文件 hash、行范围、mtime/version 或对应 source event。
   - 卡片 `evidenceRefs` 混合工作区路径与卡片 ID，引用类型不明确；未经验证的 Agent 推测也可能被 Host 结果提升为 confirmed。

4. **事实写入责任重复（中）**
   - Runtime 在 `agent:result` 事件处理中调用 `addFact()`；`RoundtableService.createRuntime()` 的事件监听器也会再次调用。
   - 相同 ID 虽会覆盖，但 version 可能重复递增，事件日志表达的变更次数与真实变更不一致。

5. **羊皮纸仍是规则投影，不是 Host 整理（高）**
   - `projectHumanReadableParchment()` 主要按 fact kind/status 分类并截取条目，尚不能合并冲突观点、区分结论与建议，也不能生成真正清晰的自然语言总结。
   - 因此“Agent 公有池”和“人类羊皮纸”虽已分出模型，语义生产链仍未分离完成。

6. **讨论中的动态读取尚未实现（高）**
   - Agent 只能收到启动时快照，不能在 Challenger 提问后读取指定文件、行范围或重新核验变更，也没有动态证据事件。
   - 这仍是工作区参与圆桌讨论的关键缺口。

7. **Renderer 状态源存在丢失风险（中）**
   - `JanusRoundtablePane` 内部持有 `roundtableState`、`work`、用户消息和乐观运行状态。当前 Chat/圆桌同时挂载可避免普通切换丢失，但 Island 被卸载或重建时仍可能丢失。
   - 用户消息尚未统一写入圆桌事件日志，恢复后无法保证完整讨论流。

8. **测试未覆盖真实边界（中高）**
   - 现有测试主要验证 Runtime/reducer/store/hydrate；部分工作区测试使用不存在的 `C:/project`，不能证明真实扫描、敏感目录排除和越权拦截。
   - 动态工具、多 Agent 共享上下文、Host synthesis、取消/超时/并发和桌面端到端均缺少验收测试。

### 19.2 优化原则与方案

- **先收紧边界，再扩展能力**：所有圆桌读取必须由 Main 根据 `workspaceId` 解析注册资源，Renderer 不再拥有最终路径决定权；统一 realpath、目录边界、只读 policy 和超时取消。
- **证据引用化**：状态中长期保存文件摘要、hash、版本和引用，不保存每轮重复的完整原文；Agent 按需获取受限片段。
- **单一事实归一化入口**：由 Runtime reducer（或独立 fact service）负责事实去重、状态升级和 version 递增，Service 只转发事件。
- **两层输出严格分离**：公有池保留完整结构化事实与来源；Host 生成独立 `HumanReadableParchment` 草稿/最终稿，正文只面向人类，来源折叠追溯。
- **持久化优先于视图状态**：圆桌 session、用户消息、工具调用和 Host 草稿写入事件日志；Renderer 仅订阅快照，挂载时按 sessionId restore。
- **真实工作区驱动测试**：测试必须创建临时目录和文件，验证成功、拒绝、过大、缺失、变更和恢复等实际行为。

### 19.3 重新整理后的实施计划

#### 阶段 A：安全边界与数据契约修复（下一阶段）

- Main 进程建立 `workspaceId -> registered realpath` 解析和圆桌专用只读授权策略。
- 对启动快照和未来工具调用统一做 realpath、边界、敏感路径和 symlink 校验。
- 新增结构化 `WorkspaceEvidenceRef`：`workspaceId`、相对路径、可选行范围、sha256、capturedAt、sourceEventId、workspaceVersion。
- 区分 `workspaceFileRef`、`agentCardRef`、`eventRef`，兼容旧快照并保证旧事实不会被错误升级。
- 合并 Runtime/Service 的重复 `addFact()` 责任，补充幂等和 version 测试。

#### 阶段 B：动态只读工具

- 提供 `workspace.list`、`workspace.read`、`workspace.readRange` 三个只读工具，统一经过阶段 A 的 policy。
- 工具调用、拒绝、超时和取消都生成事件；结果带 hash、路径、行范围和来源 ID。
- Agent 结果只能引用结构化 evidence ref，不能把未经读取的路径当作 confirmed 事实。
- 对文件不存在、超限、并发读取和工作区变更定义稳定错误码与降级行为。

#### 阶段 C：Host 语义整理与羊皮纸

- 定义 Host synthesis 输入/输出 schema，明确结论、已确认决策、待验证事项、冲突观点、风险和行动项。
- Host 生成独立草稿；用户结束会议后再生成最终稿。公有事实池始终保留全部历史和来源。
- 羊皮纸正文默认简洁，原始 Agent 输出、状态和证据仅作为可展开追溯信息。
- 增加冲突观点合并、来源缺失和 Host 失败时的降级测试。

#### 阶段 D：状态、持久化与恢复

- 将 roundtable store 提升为稳定状态源，Renderer 挂载/重建时按 sessionId 恢复。
- 用户消息、推进、结束、工具调用和 Host 草稿全部进入事件日志。
- 将大上下文移出频繁快照，使用摘要 hash/version 和独立证据缓存；增加 checkpoint 版本迁移。
- 覆盖切换 Chat/圆桌、刷新、进程重启、中断恢复和并发事件顺序。

#### 阶段 E：端到端验收与 MVP 门禁

- 验收链路：绑定工作区 → 输入需求 → Agent 动态读取 → Refiner 提案 → Challenger 核验 → Host 整理 → 卡片详情/羊皮纸 → 多轮推进 → 恢复 → 结束 → 导出。
- 必测边界：越权路径、敏感目录、符号链接、文件缺失、大仓库、读取超时、取消、重复事件、恢复中断和并发。
- 只有真实模型、真实临时工作区和桌面端到端链路全部通过，才将 MVP 标记为完成。

### 19.4 当前状态总表

| 能力 | 当前判断 | 处理阶段 |
|---|---|---|
| Runtime 生命周期与基础轮次 | 已完成（真实模型） | Agent 经默认模型真实调用，失败显错，回归见 10 文件 69 单测 |
| 工作区资源绑定与静态快照 | 已完成 | registry 解析（Service＋Runtime 双层）、快照预算、sidecar 瘦身 |
| 多 Agent 共享事实池 | 已完成 | 结构化 evidence ref、行号回填、Host 确认门禁 |
| Agent 讨论中动态读取 | 已完成基础版 | `list/read/readRange`＋四事件＋归一化＋NOT_ATTACHED 可恢复错误；写/命令/Git 无通道 |
| Host 语义整理羊皮纸 | 已实现（确定性归纳） | 冲突配对、草稿/终稿、降级投影见 §23；LLM 语义重写仍待后续 |
| 会话/用户消息稳定恢复 | 已完成（§24） | 用户消息入日志、checkpoint 迁移、中断降级、挂载恢复、幂等落盘 |
| 取消、超时、并发和错误降级 | 已完成基础版 | 超时可配置（1–120s）、取消内部可用（无 UI 入口）、并发追加有单测、失败经横幅显错；桌面 E2E 待补 |
| 桌面端到端真实模型验收 | 部分完成 | 真实模型＋真实工作区全链路已在 dev 跑通（§31 起）；§25 手动清单尚未逐项打勾 |
| 完整产品 MVP | 未正式关闭 | 自动化门禁通过；待 §25 手动清单逐项打勾 |

本 Review 的结论和计划替代此前“阶段 1–5 已完成即可视为 MVP”的宽松表述；后续每完成一个阶段，必须同步更新本节状态、边界和验收证据。

## 20. 2026-09-03 / 阶段 A 实施记录：安全边界与数据契约修复

### 已完成

- 圆桌启动资源由 Main 进程根据 `workspaceId` 从 `userData/janusx/workspaces` 注册表解析，Renderer 提供的 `workspacePath` 不再作为最终授权依据；未注册或无效 workspace 会拒绝启动。
- 注册路径经过现有 `realpath` 和目录检查，实际读取继续复用 workspace path guard、敏感路径排除和只读扫描策略。
- 新增结构化 `RoundtableEvidenceRef`：区分 `workspace-file`、`agent-card`、`event` 引用；工作区文件引用记录 workspaceId、相对路径、sha256、capturedAt、workspaceVersion 和来源事件。
- 新增 `workspace:evidence-captured` 事件；工作区证据事实关联来源事件，不再使用无来源的路径字符串作为唯一追溯信息。
- fact 写入责任收敛到 Runtime，Service 仅负责事件持久化和广播，避免重复 version 递增。
- `RoundtableRuntime.hydrate()` 对旧快照缺失的 `workspaceEvidenceRefs` 提供默认值，保留旧 `workspaceContextFiles` 兼容读取。
- Renderer Agent 详情改为消费联合引用并显示可读的 workspace/card/event 标识。

### 验证

- `tests/unit/roundtable-runtime.test.ts`（6）+ `roundtable-state.test.ts`（2）+ `roundtable-store.test.ts`（1）+ `roundtable-agent-work-projection.test.ts`（2）+ `companion-workspace-registry.test.ts`（2）
- 2026-09-03 实测共 13 个测试通过（文档此前误写为 10 个，已更正）。
- 圆桌动态工作区工具（`src/main/roundtable/workspace-tools.ts`）暂无专项单元测试；仅有通用 `tests/unit/agent/workspace-tools.test.ts` 覆盖另一套 Agent 工具，不可替代。

### 阶段 A 边界与剩余风险

- 当前启动阶段仍生成受限大小的上下文快照；工作区全量原文仍随每次 `store.append` 写入 JSONL 快照，存在重复保存与大仓库首轮阻塞风险。
- `RoundtableRuntime.start()` 仍直接信任传入的 `workspacePath`，registry 强校验只落在 `RoundtableService.start()`；直调 Runtime 可绕过，未达到“Renderer 不再拥有最终路径决定权”。
- 工作区证据目前以启动快照为基础，`lineStart/lineEnd` 已在类型中预留但从未填充；未经动态读取的 Agent 观点仍可能经 Host 路径被标记为 confirmed，缺少升级门禁。
- 阶段 A 完成后进入阶段 B：动态只读工具接入与真实临时工作区越权测试。
- 2026-09-03 工作区实测：阶段 B 地基已在工作区出现（`executeRoundtableWorkspaceTool` + `workspace:tool-started/completed/failed/cancelled` 事件 + Service 侧 LLM `workspace_list/read/read_range` 接线），但未提交、无专项测试、无 UI 呈现，仍按“部分实现（工作区未提交）”处理，不视为阶段 B 完成。

## 21. 2026-09-03 / 工作区实测校准与下一步（阶段 B 收尾）

### 本次校准方法

- 直读 `src/main/roundtable/runtime.ts`、`service.ts`、`workspace-tools.ts`、`store.ts`、`src/shared/roundtable/events.ts|state.ts|parchment.ts`、`src/renderer/src/components/janus/JanusRoundtablePane.tsx|JanusIsland.tsx|AgentResultCard.tsx|agentWorkProjection.ts`。
- 运行 `npx vitest run` 5 个圆桌相关单测文件：13/13 通过。
- 运行 `npx tsc --noEmit`：仅 2 个与圆桌无关的既有错误（`handlers.ts` 缺 `shell`、`electron-api-fallback.ts` 缺 `onPrepareQuit`）。

### 与文档的偏差修正（本次已写入）

1. §3“用户显式开启轮次：未实现”已过时：`JanusRoundtablePane` 已有“开启下一轮”按钮 + 空输入 `advance('')`，Runtime 与单测覆盖空输入推进，改为“部分实现”。
2. §3“工作区工具与审批：未实现”已过时：只读 `workspace.list/read/readRange` 地基已在工作区实现，改为“部分实现（工作区未提交）”，并拆分“写/命令/Git 审批：未实现”。
3. §20“共 10 个测试通过”错误：实测为 13 个，已更正并列出文件级计数；同时注明圆桌 `workspace-tools` 无专项测试。
4. §20“动态工具属于阶段 B（未来）”已过时：工具事件与 LLM 接线已在工作区存在，改为“阶段 B 地基已在工作区出现，但未提交、无测试、无 UI，不视为完成”。

### 当前事实快照（工作区含未提交）

- 生命周期/轮次闸门/空输入推进/失败保留/事实生成：PoC 完成，有单测。
- 阶段 A：registry 解析（仅 Service 层）、结构化 evidence ref、`evidence-captured` 事件、fact 收敛到 Runtime、hydrate 兼容：工作区完成但未提交。
- 阶段 B：`workspace.list`（depth 0–4、maxEntries 1–1000、跳过 symlink/敏感路径）、`workspace.read/readRange`（offset/maxBytes 校验、UTF-8 检查、secret redact、sha256 回传）、工具四事件、取消信号骨架、LLM 三工具接线：工作区已实现地基；缺专项测试、缺 UI 呈现、缺超时触发、缺行号 evidence 填充、缺错误码矩阵文档。
- 阶段 C（Host 语义整理）：未开始，`projectHumanReadableParchment()` 仍是规则分类截断（每类 5 条），无冲突合并、无草稿/终稿分离。
- 阶段 D（状态/持久化）：`userMessages` 仍是 Renderer 本地状态未入 JSONL；`store.append` 每次存全量 state（含 96KB 上下文）；`store.load` 取最后快照而非事件重放；Island 卸载即丢状态。
- 阶段 E：无桌面端到端真实模型验收；`tests/e2e/tmp-halo-*` 临时文件堆积（11 个），需清理。

### 下一步实施（只做阶段 B 收尾，不开 C/D）

1. 提交前加固 Runtime 信任边界：`Runtime.start()` 内对每个 resource 做 registry 二次解析或显式 `resolveWorkspaceTarget` 边界校验，拒绝未注册 `workspaceId`；补“伪造 workspacePath + 合法 id”“越权 id”“symlink 逃逸”三个单测（真实临时目录）。
2. 为 `src/main/roundtable/workspace-tools.ts` 补专项单测：真实临时工作区覆盖 list 越界/depth 截断、read 缺失/超限/非文本、readRange offset 合法性、敏感路径跳过、取消信号、并发读取；错误码收敛为 `WORKSPACE_TOOL_*` 并写入文档。
3. 填充行号级 evidence：工具成功时回填 `relativePath + sha256 + lineStart/lineEnd + sourceEventId`，卡片 `evidenceRefs` 只接受结构化 ref；禁止把未经工具读取的路径标为 confirmed（Host 结果默认 `pending-validation`，除非引用有效 tool evidence）。
4. 瘦身启动快照：状态中只保留文件摘要/manifest（path + sha256 + version），全量原文移入独立证据缓存或按需 `readRange`；`store.append` 改为事件 + 轻快照，避免每次复制 96KB。
5. UI 最小呈现（不做大改）：Agent 卡片详情展示工具调用轨迹（toolName/path/状态/errorCode），失败/拒绝可点击展开；`agentWorkProjection` 订阅 `workspace:tool-*` 并在 Deck 显示“读取中/失败”轻态。
6. 清理与提交：将 `tests/e2e/tmp-halo-*` 移出或删除，提交 `workspace-tools.ts` + roundtable 修改 + 本文档 §3/§20/§21，提交信息注明“阶段 B 地基（未含 C/D）”。

### 验收门（阶段 B 可关闭的条件）

- `npx vitest run` 圆桌 5 文件 + 新增 workspace-tools 专项全部通过，且覆盖越权/敏感/缺失/超限/取消。
- 真实临时工作区演示：绑定 → 启动快照 → Agent `workspace.read` 指定文件 → 卡片引用可追溯 → 羊皮纸来源索引可定位到文件+hash。
- JSONL 单事件体积不再随上下文线性膨胀；重复 `advance` 不产生重复轮次。
- 上述通过后，再开阶段 C（Host 语义整理），不得跳步。

## 22. 2026-09-03 / 阶段 B 收尾 Review 记录

### 实施内容（对照 §21 逐项关闭）

1. **信任边界**：`RoundtableRuntime` 新增 `resolveWorkspace` 注入（`runtime.ts`），`start()` 对每个 resource 做 id 格式校验 + 注册解析 + `realpath` 目录确认，客户端路径直接丢弃；无解析器时仍做本地目录边界校验。`RoundtableService` 注入基于 `userData/janusx/workspaces` 的解析器，形成双层校验。
2. **错误码**：`workspace-tools.ts` 新增 `RoundtableWorkspaceToolError`（`WORKSPACE_TOOL_WORKSPACE_MISMATCH/CANCELLED/INVALID_RANGE/INVALID_LIST`），底层 path-guard/policy 错误码（`SENSITIVE_PATH`、`TARGET_UNAVAILABLE` 等）原样透出；`Runtime` 侧补充 `WORKSPACE_TOOL_INVALID_WORKSPACE_ID/NOT_ATTACHED/TIMEOUT`。
3. **行号 evidence + 确认门禁**：`RoundtableEvidenceRef` 新增 `origin: 'snapshot' | 'tool'`；`workspace.read` 回填 `lineStart: 1`，`readRange` 经前缀读取推导绝对行号；`tool-completed` 证据自动打 `sourceEventId`；Host 结果无工具证据时落 `pending-validation`，有 `origin:'tool'` + sha256 时才 `confirmed`。
4. **快照瘦身**：`store.append` 将 `workspaceContext` 移入 `roundtable-context-<sessionId>.txt` sidecar（同 hash 跳过重写），JSONL 仅存轻快照；`load` 自动回贴，旧全量行兼容。
5. **UI 轨迹**：`agentWorkProjection` 新增 `toolCalls` 并订阅四类工具事件；Deck 新增 `WORKSPACE READS` 区（最近 5 条，失败可展开 errorCode）；卡片详情 evidence 显示 `#Lx-y` 行号 + sha 短码，并附同一 Agent 读取轨迹。
6. **清理**：删除 `tests/e2e/tmp-halo-*` 11 个临时文件。

### 验证证据

- `npx vitest run` 7 文件共 **36/36 通过**：runtime 6、workspace-tools 新增 12、workspace-trust 新增 7、store 3、projection 4、state 2、workspace-registry 2。
- 既有 `roundtable-runtime.test.ts` 两处按新语义更新：hydrate 改用真实临时目录；fixture Host 事实期望由 `confirmed` 改为 `pending-validation`。
- `npx tsc --noEmit`：仅 2 个与圆桌无关的既有错误（`handlers.ts` 缺 `shell`、`electron-api-fallback.ts` 缺 `onPrepareQuit`），本次修改未新增类型错误。

### 本次 Review 发现的剩余风险（转阶段 C/D）

1. 超时默认 30s 且不可经 IPC 配置；`cancel()` 暂无 UI 入口，仅运行时内部使用。
2. `readRange` 行号依赖前缀二次读取，大 offset 文件有额外 I/O；失败时行号留空，详情仅显示路径 + hash。
3. 快照原文仍全量进 LLM 提示词（96KB 上限），大仓库首轮阻塞问题未根治，需阶段 D 做 manifest 化 + 按需读取。
4. `userMessages` 仍是 Renderer 本地状态，未入 JSONL；Island 卸载即丢，属阶段 D。
5. 阶段 C 未开始：羊皮纸仍是规则投影，无 Host 语义归纳与冲突合并。

### 状态

阶段 B 视为**收尾完成**，可进入阶段 C（Host 语义整理）。完整产品 MVP 仍需 C/D/E。

## 23. 2026-09-03 / 阶段 C 实施记录：Host 语义整理与羊皮纸

### 设计（两层输出严格分离）

- 公有事实池（`RoundtableState.facts`）保持完整结构化历史；Host 归纳结果存为独立 `HostSynthesis` 草稿序列（`state.hostDrafts`），经 `host:synthesis` 事件入日志。
- 合成器为纯函数 `synthesizeHostDraft()`（`src/shared/roundtable/host-synthesis.ts`），无模型调用：结论取最新 Host 卡片首句（终稿提示词已要求首句即结论），决策去重、待验证/风险/行动分类截取、concern↔proposal 关键词配对生成 open 冲突（上限 5，中英双分词：英文停用词过滤 + 中文二元字串）。
- 缺来源事实不阻塞合成，仅贡献空来源链接；空状态返回兜底结论。
- 每轮 `awaiting-user` 后自动记一笔草稿（`final: false`），`end()` 先记终稿（`final: true`）再结束；合成失败只丢弃该笔草稿，不影响轮次闸门与事实池。
- 羊皮纸优先取最新草稿（含 DRAFT/FINAL 标记、待验证、冲突），无草稿时降级为原规则投影；`exportMarkdown` 结论优先取草稿并增设 Conflicts 节。

### 实施内容

1. 契约：`HostSynthesis/HostSynthesisConflict`、`state.hostDrafts`、`host:synthesis` 事件、`HumanReadableParchment.pending/conflicts`。
2. 接线：reducer 按（roundNumber, final）幂等写入；Runtime `getState/hydrate` 深拷贝；`store` 经现有 sidecar 机制持久化草稿（草稿体量小，无需特殊处理）。
3. 渲染：详情羊皮纸新增 PENDING VALIDATION、CONFLICTS 章节，标题栏显示 DRAFT/FINAL。
4. 边界：当前为确定性归纳 + 去重配对，非 LLM 语义重写；真实模型下结论首句来自 Host 模型输出，结构仍由合成器保证。

### 验证证据

- 新增 `tests/unit/roundtable-host-synthesis.test.ts` 9 项：空草稿、结论首句、中英冲突配对、冲突上限、缺来源、去重分流、每轮草稿+终稿、reducer 幂等、hydrate 保留。
- `roundtable-state.test.ts` +2：无草稿降级默认值、有草稿优先结论/待验证/冲突且事实池 intact。
- 全量圆桌 8 文件 **47/47 通过**（36 + 9 + 2）；`tsc` 仍仅 2 个无关既有错误；eslint 0 errors。
- C1/C2/C3 三次分段 review：C1 去掉非空断言与重复停用词；C2 修正 `end()` sessionId 收窄；C3 确认详情视图默认折叠不受新章节影响。

### 剩余风险（转阶段 D）

1. 冲突配对是关键词启发式，长难句/隐喻冲突可能漏配或误配，需真实讨论复核阈值（当前 ≥2 关键词）。
2. `userMessages` 仍未入事件日志；草稿虽已入日志但恢复后用户消息流仍不完整。
3. 超时不可配置、`cancel()` 无 UI 入口（阶段 B 遗留）。

### 状态

阶段 C 视为**收尾完成**。下一步阶段 D（状态、持久化与恢复）。

## 24. 2026-09-03 / 阶段 D 实施记录：状态、持久化与恢复

### 设计（持久化优先于视图状态）

- 会话、用户消息、推进、结束、工具调用、Host 草稿全部进入事件日志；Renderer 仅订阅快照，挂载时按 sessionId 恢复。
- 新增 `user:message` 事件与 `state.userMessages`：`start()` 在首轮前记录议题，`advance()` 仅非空补充入日志，空推进不产生空白消息。
- `migrateRoundtableState`（checkpoint v1）为旧快照补齐缺失字段；`markInterrupted` 将崩溃残留的 running 快照降级为可续 awaiting-user，不伪造历史。
- Renderer：sessionId 落 localStorage，挂载无状态时自动 `restore`；用户消息改由 state 派生 + 乐观输入经 `reconcilePendingUserMessages` 对账（content, roundNumber 唯一）；`user:message` 事件先于 round-trip 到达，讨论流保持即时。

### 实施内容

1. 契约：`RoundtableUserMessage`、`user:message` 事件、`userMessages`（必填）、`ROUNDTABLE_CHECKPOINT_VERSION`。
2. 接线：Runtime 收发用户消息、hydrate 深拷贝；`service.restore` 经迁移 + 中断降级后重建 Runtime（无副作用，不重跑 Agent）。
3. 渲染：Pane 挂载恢复、消息派生、running 阶段误发不再留乐观残影；工具调用轨迹仍为内存投影（恢复后仅卡片证据可追溯，调用过程史不重建）。
4. Store：验证事件有序返回与并发追加不丢行；sidecar 机制不变（草稿随轻快照持久化）。

### 验证证据

- 新增/扩展单测：reducer 去重（同 eventId/同 messageId）、迁移（缺字段/null）、中断降级、start/advance/空推进消息记录、hydrate 保留、store 有序 + 并发 3 行、乐观对账（含同文不同轮不误删）。
- 全量圆桌 8 文件 **55/55 通过**；`tsc` 无新增圆桌错误（其余为工作区其他未提交改动及 2 个既有错误）；renderer 改动经 `tsc` 覆盖（本工程无组件单测基建）。
- D1/D2/D3 三次分段 review：D1 确认 reducer 引用语义；D2 确认并发追加原子性风险可接受（小行单 write）；D3 将 running 误发的乐观消息改为不入队。

### 剩余风险（转阶段 E）

1. 工具调用过程史、queued/working 瞬态不恢复；恢复后 Deck 仅从卡片重建结果态。
2. 超时不可经 IPC 配置、`cancel()` 无 UI 入口（B 遗留）；冲突启发式待真实复核（C 遗留）。
3. 桌面端到端真实模型验收仍未做；`advance` 重复点击防抖仍缺（快速双击可能建两轮，幂等键未落盘）。

### 状态

阶段 D 视为**收尾完成**。下一步阶段 E（端到端验收与 MVP 门禁）：真实模型 + 真实工作区全链路、越权/敏感/symlink/缺失/大仓库/超时/取消/重复事件/恢复中断/并发矩阵，以及 `advance` 幂等落盘。

## 25. 2026-09-03 / 阶段 E 实施记录：端到端验收与 MVP 门禁

### 实施内容（自动化可达部分）

1. **advance 幂等落盘**：`advance(input, requestId)`，`state.advanceKeys` 记录 requestId→轮次并随快照持久化；运行中同 key 重试返回当前状态（不抛错、不建轮），异 key 仍抛错；Renderer 侧 `dispatchBusy` 禁止 start/advance/end 重复提交，每次 advance 配唯一 requestId。
2. **超时可配置**：`roundtable:start` 支持 `toolTimeoutMs`（ intake 校验 1s–120s），Service 透传 Runtime；超时机制抽为可测 `withTimeout`（挂起任务按码拒绝、快任务直通、计时器清理）。
3. **导出纯函数化**：`exportRoundtableMarkdown(state)` 移入共享层，Service 只做委托，全链路可无 Electron 单测。
4. **全链路集成测试**（`roundtable-lifecycle.test.ts`）：真实临时工作区绑定 → 启动快照 → Agent 动态 `read` → 提案/核验/整理 → 卡片详情证据 → 补充推进 → store 落盘/恢复 → 结束终稿 → 导出 Markdown；另覆盖大仓库预算（60 文件→≤40 快照、总上下文≤96KB）与无草稿降级导出。
5. **边界矩阵现状**：越权/敏感/symlink/缺失/取消/重复事件/恢复中断/并发/大仓库/超时机制均有真目录单测；真实模型与桌面 E2E 不在自动化范围，转手动清单。

### E2 自检抓出的真 bug（已修）

1. `tool-completed` 去重键缺 `origin` 与行号：Agent 动态读取同文件会吞掉启动快照 ref。现去重键为 workspaceId + 路径 + sha + origin + 行号，快照与工具证据共存（集成测试双断言锁定）。
2. 冲突配对误用卡片标题：自动标题（"refiner result"）共享 "result" 一词，导致任意两卡误配。现关键词只取正文、无关键词才回退标题，并加回归单测。

### 验证证据

- 全量圆桌 9 文件 **62/62 通过**（55 + 幂等/超时 2 + 集成 3 + 冲突回归 2）。
- `tsc`：圆桌/IPC/preload 相关零错误；全量剩余错误均为工作区其他未提交改动及 2 个既有错误。
- eslint：改动文件 0 errors。

### 手动验收清单（真实模型 + 桌面，自动化未覆盖）

1. 添加工作区 → 提议题 → 首轮三卡出现，Deck 显示 WORKSPACE READS。
2. 点卡片开详情：sections/evidence（含 `#Lx-y`）可读；失败读取可展开 errorCode。
3. 空输入“开启下一轮”无空白气泡；带补充推进后羊皮纸更新。
4. 结束会议 → 羊皮纸变 FINAL → 导出 Markdown 含结论/冲突/来源。
5. 刷新或重启后圆桌自动恢复上次会话（含用户消息与草稿）。
6. 进程崩溃模拟（任务管理器杀掉）：重启恢复后停在可续 awaiting-user，不卡 running。
7. 双击“开启下一轮”只建一轮；弱网重试不丢补充、不重轮。

### MVP 裁决

自动化门禁已全部通过；按 §19“完整产品 MVP 需真实模型与桌面端到端”规则，**MVP 不正式关闭**，待上述手动清单逐项打勾。当前为“代码级 MVP 就绪（automated MVP-ready），发布前须完成手动验收”。

> 跟进（2026-09-04）：真实模型＋真实工作区全链路已在 dev 跑通（Vertex，§31 起）；圆桌单测 10 文件 69/69 通过；手动清单仍未逐项打勾，裁决不变。

## 26. 2026-09-03 / 羊皮纸详情视觉统一

- 问题：羊皮纸附属 Island 使用米色纸张 + 衬线 + 金色描边的独立风格，与卡片详情（深色档案面板）并置时跳脱。
- 决策：详情羊皮纸改与 `agent-result` 共用视觉语言——`JanusRoundtableParchment` 详情分支直接渲染 `janus-agent-result-detail` 结构（eyebrow/DRAFT/FINAL、标题、结论摘要、章节、来源索引证据盒）；纸张主题 CSS 整块移除，仅保留内联摘要分支的旧规则（当前唯一调用点恒为 detailed）。
- 章节与之前一致：已确认决策、关键依据、未决与风险、待验证、冲突、下一步行动；结论仍取 Host 草稿。
- 验证：`tsc` 相关零错误，eslint 干净；以目视验收为准（与卡片详情并排对比）。

## 27. 2026-09-03 / 发送即显用户消息

- 问题：发送后 `handleSend` 先强制滚到底部，工作卡片时间戳更新、排在用户消息之后，自动滚动把视口钉在底部——用户先看到卡片，自己的消息被顶出可视区。
- 修复（仅 discussionOnly 圆桌对话，普通 Chat 不动）：发送时不再预滚到底，改记锚点时间；消息渲染后的 layout effect 将视口定位到刚发出的用户消息顶部，之后到达的卡片改为新消息 badge 提示，不再抢夺视口；running 阶段误发无新消息时锚点自动失效。
- 验证：`tsc` 相关零错误，eslint 干净；以桌面目视验收为准（发送后首屏应为用户消息，卡片在下方）。

## 28. 2026-09-04 / 结束导出缺口确认与羊皮纸 mid-meeting 导出需求

### 28.1 代码事实确认：结束会议确实没有文档下载机制

经直读代码确认（`JanusRoundtablePane.tsx:176-195`、`roundtable-handlers.ts:29`、`service.ts:77-79`、`export.ts:8`、`JanusRoundtableParchment.tsx`、`JanusAuxiliaryIsland.tsx`），现状如下：

1. **导出链路是死链**：`roundtable:export`（`service.exportMarkdown` → `exportRoundtableMarkdown` 纯函数）已实现，但 Renderer 全仓零调用（仅 `preload/index.ts:228` 暴露 + `electron-api-fallback.ts:203` 占位）。`JanusRoundtablePane`、`JanusIsland`、`JanusRoundtableParchment` 均未调用。
2. **`handleEnd` 直接丢弃终稿**：`handleEnd` 调用 `roundtable.end(sessionId)` 后不读取返回的终稿 state、不调用 `export`、不弹保存框，直接 `setRoundtableState(null)` + 清空 `work/pendingInputs/optimisticRun` + 删除 localStorage session 键。用户既看不到 FINAL 羊皮纸，也拿不到文件。
3. **违反既有产品规则**：§4.3 要求“用户结束后 JanusX 执行最终整理”且“导出失败不能删除会议历史”；当前是“结束即清空，不做已结束会话的持久化恢复”（§3），导出失败/成功都删，且 §25 手动清单第 4 项“结束会议 → 羊皮纸变 FINAL → 导出 Markdown”在当前 `handleEnd` 路径下不可能通过。
4. **羊皮纸详情无任何导出入口**：`JanusAuxiliaryIsland` 标题栏只有一个 `PanelRightClose` 返回按钮；`JanusRoundtableParchment(detailed)` 只有章节渲染，无 toolbar、无导出按钮、无复制/保存。§6.11 明确“详细 Island 只承载阅读，不重复 Chat 或会议命令”——导出属于阅读面的文档操作，不违反该约束，但当前连文档操作也没有。
5. **可复用的保存模式已存在**：`note/quick-note-export.ts:39-46` 已确立标准模式 `dialog.saveFile({defaultName, extension})` → `file.save(path, content)`；圆桌导出应复用同一模式，而非另起保存通道。

结论：这不是“文案缺失”，而是“结束链路缺一步 + 详情阅读面缺一个按钮”。§3“最终整理与 Markdown 导出：部分实现”表述仍有效，但需明确拆分为“Markdown 生成已就绪（纯函数+IPC），文件保存 UI（含结束弹窗与 mid-meeting 导出）未实现”。

### 28.2 用户需求分析与完善

用户原始需求两条：

- A. 结束会议应弹出文档下载；
- B. 羊皮纸详细界面在会议不结束时即可导出。

完善后的理解：

1. **A 不是“多加一个弹窗”，而是修复结束语义**：结束 = 生成终稿（已有 `end()` 写 `final:true` 草稿）→ 向用户呈现终稿 → 提供保存/复制/稍后找回三选一 → 再清空对话框。当前跳过了中间两步。修复时必须保留终稿 state 直到用户明确离开，否则 FINAL 永远不可见。
2. **B 不是“提前结束”，而是 DRAFT 快照导出**：mid-meeting 导出导的是当前轮的草稿投影（`humanReadable.draft === true`），文件名与内容必须带 DRAFT 水印（轮次、时间、草稿声明），与终稿 FINAL 明确区分，避免用户把半成品当结论外发。
3. **两个入口共享同一导出源**：都调用 `roundtable:export(sessionId)`（或直接对当前 `roundtableState` 调共享 `exportRoundtableMarkdown` 做预览），差异只在触发时机与默认文件名：`{议题}-round{轮次}-DRAFT-{日期}.md` vs `{议题}-FINAL-{日期}.md`。
4. **running 阶段必须禁用导出**：Agent 正在写卡片、Host 草稿尚未落盘时导出会拿到撕裂快照。规则为 `running` 禁用两个导出入口（Tooltip 说明“本轮讨论中，待完成后再导出”）；`awaiting-user` 与 `ended(终稿保留期内)` 允许导出。`idle` 无内容时隐藏入口。
5. **导出失败不丢会**：沿用 §4.3——保存取消/失败只提示，不清空、不关闭详情 Island、不删除 session。结束流程中若保存失败/用户选“稍后”，终稿仍保留在内存 + JSONL 可恢复，直到用户明确开新议题或关闭。

### 28.3 产品规则补充（并入 §4.3）

1. 结束会议流程为：`end()` → 保留终稿 state 并展示 FINAL 羊皮纸 → 弹出“会议已结束，是否保存纪要？”（保存 Markdown / 暂不保存）。选保存则走保存框；任选一项后才允许清空开新议题。（2026-09-04 修订：结束横幅的“复制”按钮已移除，基本用不到；羊皮纸详情导出失败时的复制降级保留。）
2. Mid-meeting 导出不改变会议状态：不推进轮次、不结束、不写新事件；仅对当前 state 做只读快照导出，内容头必须含 `> DRAFT — 第 N 轮 / 导出时间 / 终稿以结束会议为准`。
3. 文件名默认：`roundtable-{议题前12字过滤非法字符}-r{N}-{DRAFT|FINAL}-{yyyyMMdd-HHmm}.md`；保存框允许用户改名；取消保存视为 `canceled`，不报错。
4. 空内容保护：第 1 轮未完成、无任何卡片/事实时，mid-meeting 导出仍允许但内容为占位结论 + “讨论尚未产生结论”提示，不得伪造结论。
5. 剪贴板为必备降级：保存框不可用/写盘失败时，提供“复制 Markdown”按钮，保证用户总能带走内容。

### 28.4 交互设计

**入口 1 — 结束导出弹窗（`JanusRoundtablePane.handleEnd` 后）：**

```text
[结束会议] → end() 成功 → 终稿保留，对话区顶部出现 FINAL 横幅
  ┌─────────────────────────────────────┐
  │ 会议已结束 · FINAL 纪要已生成        │
  │ [保存 Markdown] [开新议题]           │
  └─────────────────────────────────────┘
```

- 不用原生 `confirm`，用圆桌对话区内横幅 + 附属 Island 自动切到羊皮纸 FINAL，保证用户先看到结论再决定。
- “开新议题”分阶段退出后清空（删 localStorage 键、清 state/work/pending，§33）；“保存”不清空。（“复制”按钮已移除，见 §4.3。）

**入口 2 — 羊皮纸详情导出按钮（附属 Island 内）：**

- 位置：`JanusAuxiliaryIsland` header 右侧（返回按钮左侧）新增图标按钮 `Download`（Lucide），Tooltip“导出当前纪要（Markdown）”；`aria-label="导出羊皮纸 Markdown"`。仅 `roundtable-parchment` 模块显示，`agent-result` 模块不显示。
- 行为：点击 → `roundtable.export(sessionId)` 取 Markdown → `dialog.saveFile` → `file.save`；成功 Toast/状态提示，失败行内提示 + 提供复制降级。`running` 时禁用（`disabled + Tooltip`），`awaiting-user` 可用，终稿保留期显示“导出 FINAL”。
- 样式约束：沿用 `janus-auxiliary-close` 同尺寸图标按钮（28px 级），黄铜/旧金语义仅限羊皮纸内容画布，外壳 chrome 保持 Janus 深色规范（§6.3）。

### 28.5 实现边界与验收

实现（不扩大范围）：

1. Renderer 新增 `exportRoundtableMarkdown(sessionId)` 封装：`export` → `saveFile` → `file.save`，复用 `quick-note-export` 模式；文件名由 `roundtableState.userInput + roundNumber + draft` 生成。
2. `handleEnd` 改为保留终稿：`const final = await end(sessionId)` 后 `updateState({...final, phase:'ended'})` 并展示结束横幅，不立即 `setRoundtableState(null)`；新增“开新议题”才执行现有清空逻辑。`end()` 抛错时不清空、行内提示重试。
3. `JanusAuxiliaryIsland` header 加可选 `actions` 插槽，羊皮纸模块注入导出按钮；`JanusRoundtableParchment` 不直接调 IPC（保持纯渲染），导出逻辑由 Island 层持有 sessionId 触发。
4. 单测：`exportRoundtableMarkdown` DRAFT/FINAL 文件名与水印行；`handleEnd` 语义需桌面手动验收（现有工程无组件单测基建，参考 §24 说明）。

验收：

- awaiting-user 时点详情导出 → 存盘 `.md` 含 DRAFT 头 + 当前轮结论；会议继续，不推进轮次。
- running 时导出按钮禁用，Tooltip 正确。
- 结束会议 → 看到 FINAL 羊皮纸 + 保存/复制/开新议题；保存取消不丢终稿；保存成功文件含 Conflicts 与来源索引。
- 导出失败（写盘错）→ 错误提示 + 复制降级可用，会话不丢失（§4.3）。
- 通过后回写 §3“最终整理与 Markdown 导出”为“已实现基础版（含结束弹窗 + 详情 DRAFT 导出）”，并勾选 §25 手动清单第 4 项。

## 29. 2026-09-04 / 对话框工作状态与残留卡片 bug 修复

### 现象

- 对话框先显示“解决者”→“完善者”，之后本应显示“主持人”工作中，却又显示“解决者”，然后一次性弹出全部结果。
- 结果卡应为 3 张（解决者/完善者/主持人），实际显示 5 张，末尾残留两张“解决者”“完善者”占位卡。

### 根因（`JanusRoundtablePane.tsx`，已修复）

1. **乐观占位复活**：`activeAgentIds = workingAgents.length ? workingAgents : optimisticRun ? ['refiner-1','challenger-1'] : []`。`optimisticRun` 从发送持续到整轮结束，因此每当 `workingAgents` 为空的瞬间（challenger 结果 → host queued/working 的交接间隙，以及终轮快照先于事件到达的竞态），UI 都会把旧的解决者/完善者占位重新搬出来——交接期盖掉主持人，终轮后则以 `new Date()` 时间戳排在 3 张真实卡片之后，形成“5 张 + 末尾两张残留”。
2. **主持人映射缺失**：运行时 host 的 agentId 是 `janusx`（见 `defaultRoundtableWorkflow`），但占位标题硬编码 `refiner-1 ? 解决者 : 完善者`，`workingRole` 只认 `refiner-1/challenger-1`。host 工作时标题错显示为“完善者”、3D 座席 `workingRole` 为 `null`（主持人席位不亮）。
3. **useMemo 依赖数组身份**：`activeAgentIds` 每 render 都是新数组，memo 恒失效，每 render 刷新占位时间戳，占位在按时间排序的对话框里永远沉底。

### 修复

- 新增 `describeLiveAgent` / `toWorkingRole`：`janusx|host*` → 主持人/host 席位，`challenger*` → 完善者/agent-2，`refiner*` → 解决者/agent-1。
- 占位仅覆盖两段间隙：发送→首个真实事件（乐观，且 `hasSeenWorkEvent` 为 false 时才允许）与级间交接（`working` 为空但 `queued` 非空时显示 queued，如已排队的 `janusx`，状态为 `queued`）。
- `updateState` 收到 `awaiting-user/ended` 快照即清 `optimisticRun`（与事件流双保险，任一先到都不留幻影）。
- memo 改按 `liveAgentKey/workingKey` 字符串值依赖，不再每 render 刷新时间戳。

### 验证

- 事件序列仿真（reducer + 新门控）：optimistic → refiner → challenger → `janusx`(queued/working 显示主持人）→ 3 卡 + 零占位 → awaiting-user 干净，无复活。
- `tsc` 零错误；eslint 改动文件 0 errors（仅既有中文文案 warnings）；`roundtable-agent-work-projection / runtime / state` 24/24 通过。
- 桌面目视待复核：首轮应依次点亮解决者→完善者→主持人席位，对话框全程 3 张结果卡，无末尾残留。

## 30. 2026-09-04 / 导出功能实施记录（§28 落地）

### 实施内容

1. **导出封装**（新增 `src/renderer/src/components/janus/roundtableExport.ts`）：`buildRoundtableFilename`（`roundtable-{议题12字}-r{N}-{DRAFT|FINAL}-{yyyyMMdd-HHmm}.md`，非 ended 一律 DRAFT）、`withDraftWatermark`（`> DRAFT — 第 N 轮 · 时间 · 终稿以结束会议为准` 头）、`fetchRoundtableMarkdown`（`roundtable:export`）、`saveMarkdownViaDialog`（`dialog.saveFile` → `file.save`，复用 quick-note 模式）、`copyTextToClipboard`（clipboard + execCommand 双降级）。
2. **结束横幅**（`JanusRoundtablePane`）：`handleEnd` 改为保留终稿（`updateState({...final, phase:'ended'})` + 自动打开羊皮纸 FINAL），对话框顶部出现横幅［保存 Markdown｜复制｜开新议题］；只有“开新议题”执行原清空逻辑。`end()` 失败不清空并行内提示。状态栏 ended 显示“会议已结束 · FINAL”。
3. **详情导出按钮**（`JanusAuxiliaryIsland` 新增 `actions` 插槽 + `JanusIsland` 注入）：仅 `roundtable-parchment` 模块显示 Download 图标按钮（`agent-result` 不显示）；`running` 禁用（Tooltip 说明等本轮完成），`idle` 隐藏；行内状态（Saved/Copied/Save canceled/失败），失败时出现 Copy 降级按钮。`JanusRoundtableParchment` 保持纯渲染，导出逻辑由 Island 层持 sessionId 触发。
4. **样式**：`09-janus-roundtable-final.css` 追加结束横幅；`10-janus-auxiliary-island.css` 追加 26px 导出按钮/状态（与收起控件同 chrome）。

### 验证证据

- 新增 `tests/unit/roundtable-export.test.ts` 5 项：DRAFT/FINAL 文件名、非法字符过滤、空议题回退、时间戳格式、水印行。
- 全量圆桌 9 文件 **67/67 通过**（62 + 5）；`tsc` 零错误；eslint 改动文件 0 errors（仅与文件既有中文文案同类的 i18n warnings）。
- 桌面目视待验收（§28 验收清单）：awaiting-user 详情导出 DRAFT 不推进轮次；running 禁用；结束见 FINAL 横幅；取消/失败不丢终稿。

## 31. 2026-09-04 / 静默 fallback 改显性失败（圆桌空转排查）

### 现象

- 已设全局默认模型（Vertex AI / gemini-3.6-flash，测试可用）且绑定工作区，首轮三张卡仍是 `refiner reviewed "..." with 0 prior results` 式空话，详情无实质内容。

### 已排除

1. 无默认模型（`getDefaultModel()` 返回 null）：用户已设置默认 Provider，排除。
2. 模型 ID 推断错误：`VertexAIAdapter.getDefaultModel` 取 `settings.modelId`（gemini-3.6-flash），与用户配置一致，排除（注意 `OpenAICompatibleAdapter.getDefaultModel` 是按 baseURL 硬推断、不读 `modelId`，非 Vertex 用户仍有此坑，待修）。
3. 工作区未绑定：用户已绑定，启动快照 + 动态 `workspace_read` 路径正常。

### 根因

- `RoundtableService.createRuntime` 的 Agent `run()` 内 `try { ... } catch { return fallback }` 把**所有**模型侧失败（调用抛错、空回复）吞成一句假装完成的卡片，不发 `agent:error`，`work.errors` 也无处渲染——失败和成功长得一样，无法定位。
- 剩余嫌疑（需一次显错运行确认）：Vertex `generateText` 带 tools + maxSteps 调用抛错，或模型 6 步内只调工具无文本。

### 修复（已实施，未做桌面验证）

1. `service.ts`：删除静默 fallback；无默认模型 / 模型创建失败 / `generateText` 抛错 / 空文本一律抛带上下文的 Error（agentId + provider/model），由 `runtime.runAgent` 记 `agent:error`，本轮其余 Agent 继续。
2. `JanusRoundtablePane`：对话框新增红色失败横幅（`role="alert"`，单错默认展开），`updateState` 从快照合并 `errors` 防事件丢失。
3. 待用户重启应用后重开一轮，把横幅原文贴回，再定点修模型调用。

### 后续（用户回传原始报错后定位）

- 原始报错：`Invalid arguments for tool workspace_list ... "Workspace is not attached to this roundtable"`，refiner/challenger/host 三 Agent 同错。
- 根因：提示词只列工作区 NAME + PATH，从不给 ID，模型只能猜（如传了工作区名 `JanusX`）；而 `workspaceId` schema 上的 `.refine()` 把猜错变成框架级 `AI_InvalidToolArgumentsError`——本版 AI SDK（`ai@3.4.33`，经查无 `toolCallRepair` 选项）对此直接抛错，整个 Agent 死亡，而非变成可重试的 tool-result 错误。
- 修复（已实施）：① 提示词改列 `- id/name/path` 并要求原文复制 ID；② tool 入参 `workspaceId` 去掉 `.refine()`（留 `min(1)` + describe 指引），归属校验只留在 `runtime.executeWorkspaceTool`（其抛错是可恢复的 tool-result，模型可纠正重试）；③ 无绑定工作区时不传 tools；④ NOT_ATTACHED 错误信息附带有效 id 列表。
- 验证：`tsc` 零错误，eslint 干净，runtime/lifecycle/trust/state 27/27 通过。待用户重启 dev 重测。

### 再后续（模型仍传名字：" JanusX" 带前导空格）

- 现象：输入后先闪一下“解决者＋完善者”双占位才进入正常解决者 working；且 refiner 仍传 `workspaceId: " JanusX"`（注意前导空格），只剩这一处报错。
- 分析：① 模型犟：光靠提示词和 describe 约束不住，必须做归一化兜底；② 双占位闪屏是发送→首个真实事件间隙的乐观占位，旧逻辑瞬间即显；③ 另提醒：renderer 热更新会自动生效，但 `service.ts` 改动在主进程，**不重启 `npm run dev` 不生效**——上轮报错也可能仍是旧主进程跑出来的。
- 修复（已实施）：① `service.ts` 新增 `normalizeWorkspaceId`（trim → 精确 id → 大小写无关 id/名 → 路径后缀），包在 `bindWorkspaceTool` 里，`" JanusX"` 按名命中真实 id；无绑定工作区时不传 tools；② 乐观占位延迟 400ms 出现（首个真实事件先到则直接跳过闪屏，按轮次重 arm）；③ NOT_ATTACHED 信息已带有效 id 列表。
- 验证：`tsc` 零错误，eslint 干净，5 文件 32/32 通过。待用户重启 dev 重测：预期解决者先 workspace_list 再读文档给真方案，无闪屏、无报错。

### 再后续（双占位闪屏＋"test" 下两 Agent 空结果失败）

- 现象 1：输入后仍快速闪过两个命名卡。原因：乐观占位延迟 400ms 治标不治本——`collectTextEvidence` 等启动开销常超 400ms，占位仍会出现几秒，且两人名并行展示本就违背串行事实。
- 现象 2：发 `test` 后解决者/完善者报错、主持人正常。推断：无意义输入下模型把 6 步全花在调工具上、没写正文，触发“空结果”失败；主持人提示词要求首句即结论故不受影响。
- 修复（已实施）：① 显示机制改彻底——删掉合成命名占位，live 卡只由真实 `working/queued` 事件驱动；首事件前只显示“第 N 轮讨论中”状态文案＋Deck 空态；`optimisticRun` 仅保留给状态文案。② 机制兜底——提示词限工具 2-3 次且必须写正文；空文本时自动用 `result.response.messages` 续问一次（禁工具、只让写结论）；仍空才报“换更具体议题重试”。
- 验证：`tsc` 零错误，eslint 0 errors，5 文件 32/32 通过。待用户重启 dev，用真实议题（非 `test`）重测；如仍有红横幅，贴新原文。

### 再后续（旧主进程导致的 refine 报错复现）

- 现象：三 Agent 报 `Invalid arguments for tool workspace_read ... Type validation failed ... path: [workspaceId] ... Workspace is not attached`，传的仍是名 `JanusX`。
- 分析：全仓 grep 证实当前代码已无该 `.refine()`——此 zod 错误形状（`code: custom / path: [workspaceId]`）在新代码里**不可能产生**。结论：运行中的主进程是 refine 移除之前的旧版本（renderer 热更新会自动生效，主进程必须重启）。另：`resolveStartResources` 的同名报错与此无关（启动期注册解析，非工具参数校验）。
- 修复（已实施）：① `createRuntime` 加终端标记行 `[roundtable] runtime created (fail-loud + workspaceId normalization active)`，跑 `npm run dev` 的终端里看到它＝新代码；② 机制侧归一化已就绪，重启后 `"JanusX"` 按名自动命中真实 id，不再致命。
- 验证：`tsc`/eslint 干净，lifecycle/runtime 13/13 通过。待用户彻底重启 dev（Ctrl+C → 确认 electron 进程退出 → 重跑）后重测。

## 32. 2026-09-04 / 详情标题中英文显示控制

- 范围：羊皮纸详情（`JanusRoundtableParchment` 眉题/六章节/空态/来源/占位分支/终稿态）与卡片详情（`JanusIsland` 内 agent-result 眉题＋六状态/证据/读取轨迹/来源/更新时间/空态）及附属模块标题，全部改走 `t('janus:roundtable.…')`，随应用语言切换。模型生成的卡片标题/正文属数据内容，不翻译。
- 新增 `janus.json` 中英 `roundtable` 节（52 键）：`auxiliary/parchment/cardDetail/export` 四组；英文沿用原硬编码文案，中文新译。
- 流水线：`i18n:extract` 因仓库配置写死 `$lng` 字面目录已不可用（误产物已删、locale 已从 git 完整恢复），改手动加键；`i18n:types` 重生成（1433 键），`i18n:check` 11 命名空间同步通过。
- 验证：`tsc` 零错误；两文件 eslint 0 warnings（原中文硬编码 warnings 随之消除）。Pane 工具栏/结束横幅/错误横幅的中文仍为硬编码，不在本次范围，后续批次再迁。
- 桌面目视待验收：切换语言后两详情标题同步变化。

## 33. 2026-09-04 / 开新议题分阶段退出动效

- 问题：结束后点“开新议题”，附属 Island 与主对话框同一帧闪成空态，无过渡。
- 机制：`JanusRoundtablePane` 新增 `dismissing` 态 + 300ms 定时；点击后先经新增 `onRequestAuxiliaryClose`（Island 的 `requestCloseAuxiliary`，经 ExpandedShell 透传）播放附属 240ms 退出动画，同时主对话框加 `janus-roundtable-panel--leaving` 做 220ms 淡出下沉；300ms 后才真正清空 state/work/pending 并上报 `null`（此时 Island 的 null-effect 已无事可做，不会抢拍）。3D 舞台保持不动——房间还在，只是纸和对话归位。
- 防护：退出中按钮禁用防连点；定时器卸载时清理；`prefers-reduced-motion` 下无位移。
- 验证：`tsc` 零错误，eslint 无新增（仅既有中文文案 warnings），12/12 单测通过。桌面目视：先收附属 Island，再淡对话框，无闪烁。

## 34. 2026-09-04 / 新信息提示触发与位置优化

- 问题 1（误提示）：滚动 effect 依赖数组身份，圆桌每 render 重建消息数组导致每 render 触发——底部被持续拽走、非底部误弹提示；且圆桌卡片到达根本不在依赖里，该提示时不提示。
- 问题 2（遮挡）：提示用相对整窗的 `absolute bottom: 52px`，盖在输入框上，且随输入框高度错位。
- 修复：① 依赖改内容签名（消息数/末条 id/时间戳/流长度＋卡片 id/更新时间），真有新内容才动；在底部自动跟随（含卡片到达），拉起后有更新才弹提示。② 提示移入消息列表末尾，`sticky bottom: 10px` 贴底居中，恒位于输入框上方，不占输入区。
- 验证：`tsc`/eslint 干净。桌面目视：底部看直播无提示自动跟随；拉起后有卡片/消息到达才出现小 pill，点之回到底部。

## 35. 2026-09-04 / 顶部控件悬浮态与空输入开启下一轮

- 缺陷 1（真 bug）：`handleCenterSend` 首行 `if (!trimmed …) return` 把“开启下一轮”（`handleCenterSend('')`）直接拦截，按钮点死。修复：空输入是合法推进（沿用共享状态），仅新开会议要求非空；空推进不产生乐观气泡/空白消息（与 `advance()` 的非空才入日志一致），失败回滚兼顾无气泡场景。
- 优化 2：顶部 `开启下一轮/结束会议` 原无任何 `:hover/:active/:focus-visible/:disabled`，现补橙金悬浮高亮＋按压缩进＋键盘轮廓＋禁用态；两按钮加 Tooltip（空输入语义/终稿说明），结束横幅按钮同享。
- 验证：`tsc` 零错误，eslint 无新增，12/12 通过。桌面目视：悬浮高亮；空点开启下一轮直接进下一轮讨论。

## 36. 2026-09-04 / 全文档工程校准记录

本次逐节对照代码（工作区干净，基线 `f560645`；圆桌单测 10 文件 69/69 通过），修正已偏离的描述，历史决策记录原样保留：

1. 页眉：状态/最近更新/工作区提示重写（引擎、持久化、导出、i18n 均已落地）。
2. §2.2：stacked 上下布局已不再渲染，改写为实际布局（中部对话＋内联卡片＋按需附属 Island；右侧 Deck 展开态隐藏）。
3. §2.3：增补事件驱动席位（含 host 映射、无合成占位）。
4. §2.4：旧“视觉骨架”九条作废，重写为当前边界。
5. §3：`中心羊皮卷/右侧布局/羊皮纸/消息流/发言联动/卡片/轮次/结束/编排/状态/持久化/导出/工具` 十余行状态与说明校准；结束行去掉已移除的复制按钮。
6. §4.3：增补终稿保留＋分阶段退出＋复制移除。
7. §6.2/6.4/6.6/6.10：标注 stacked 假设作废处与实际控件（直达附属、无 PanelRightOpen、header 导出按钮、语言切换）。
8. §6.11：`evidenceRefs` 改结构化联合引用；`workingRole` 单席位；`agent:awaiting-input` 无发送方；`AgentWorkRail` 未独立实现。
9. §7：12 项全部标已完成（原 7/9/10/11/12 的“待完成”关闭）。
10. §19.4：九行结论按现状重写（动态读取/恢复/MVP 门禁等）。
11. §25：跟进真实链路跑通，裁决不变（手动清单未打勾）。
12. §28.4：结束横幅图去掉复制按钮。

仍待后续：LLM 语义重写羊皮纸（§19.4）、取消 UI 入口、桌面端到端手动清单（§25）、Pane 工具栏中文迁 i18n（§32 范围外）。

## 37. 2026-09-05 / 用户目标讨论模式：主持人维护公共池的增量式讨论（待实施）

> 来源：用户本轮声明的想要效果，原样落档；与当前实现（§4.2、`refiner → challenger → host` 单次串行）的差异见本节末尾。状态：**待实施**，不得视为已实现。

### 37.1 目标流程

```text
用户提需求 → 开启会议 → Janus主持人先整理
  → agent-1 结合工作区提出方案想法 → Janus主持人整理到公共池
  → agent-2 读取公共池，发现问题，提出完善方向或反向提问 → Janus主持人整理到公共池
  → 本轮停在 awaiting-user
下一轮（用户开启）：
  - 无新输入 → agent-1 → agent-2 继续围绕公共池展开
  - 有新需求/需求调整 → 主持人先调整公共池，再由 agent-1 → agent-2 围绕调完后的池展开
```

### 37.2 角色职责（目标）

1. 用户是提议人：提需求、补约束、纠正事实、推进下一轮、结束会议。
2. JanusX 是唯一主持人：每次发言前后都做整理，维护公共池（新增/修改/确认/驳回），是池的唯一写入口。
3. agent-1 是议题解决者：结合工作区证据提方案想法，输入以公共池为准，用户方案视为 Base。
4. agent-2 是议题完善者：只读公共池 + agent-1 本轮增量，输出完善方向、风险或反向提问，不另起新方案。

### 37.3 公共池语义（目标）

- 池是跨轮次的权威共享状态，条目至少含 `id / 类型（需求/方案/风险/问题） / 状态（新增/确认/待验证/已解决/已驳回） / 内容 / 来源`。
- Agent 不直接写池，只能引用池 id 提 delta；主持人负责归并去重与状态流转。
- 用户新需求 → 池新增；需求调整 → 池修改对应条目；空推进 → 池不动。

### 37.4 高效增量约束（目标）

- 禁止重述用户原文与池已有内容，只写增量。
- agent-1：限量补充点 + 实现细节 + 边界 case；agent-2：Top N 风险 + 修复建议或反问。
- 输出限条数/字数，卡片默认只看 delta，主持结论置顶。

### 37.5 与现状的差距（分析结论）

1. 顺序缺失：现状一轮内主持人只在最后出现一次，缺少 `主持前置整理 + 两次中间整理`。
2. 池是全文转储：现状 `facts` 存整篇卡片原文且只 append，主持合成是关键词规则函数，无更新/合并语义。
3. Agent 无围绕池约束：提示词无"以池为准、引用 id、只写 delta"要求，无新需求继续时仅一句 `Continue from shared state`。
4. 用户输入无分类：`advance` 非空直接进下一轮，主持人未先调池。

### 37.6 首轮问答机制（目标，2026-09-05 补充）

1. 首轮不强制输出完整方案：成员对当前输入有疑问时，可先给简单方案方向 + 附带问题，问题可多个。
2. agent-1、agent-2 均可提问；提问视为正常增量输出，与方案补充同等对待。
3. 主持人收集全轮问题，去重归并后写入公共池（类型为问题、状态为待用户回答），并在轮次结束时统一反馈给用户。
4. 用户通过对话输入回答问题：回答进入下一轮时主持人先调池（标记已解决/转需求/转方案约束），再由 agent-1 → agent-2 围绕更新后的池展开。
5. 无问题时才推进到完整方案；有未答关键问题时，下一轮优先围绕问题澄清，不强行收敛结论。
6. 后续轮次的新增需求、需求变更同样适用问答机制：成员对不清楚点可直接提问，主持人入池并反馈，用户对话回答后调池再继续。

### 37.7 终稿羊皮纸结构（目标，2026-09-05 补充）

终稿羊皮纸是主持人基于公共池的最终整理，默认结构：

1. 确定的需求：经用户确认的需求条目（去重后为准，不含已驳回/已替代项）。
2. 相关文件：工作区相关文件引用（路径 + 行号/hash 可追溯）。
3. 详细实施方案计划：Todo 形式的-step 计划，每项可执行、可验收。

已确认（2026-09-05 用户拍板）：

- Todo 粒度为模块级任务：每条对应一个模块的可交付变更，含验收标准，不拆到函数级。
- 相关文件 = 方案实现涉及的文件 + 依赖文件：要改的文件与只读依赖的依据文件都列，注明变更/依赖关系与行号/hash 追溯。

### 37.8 提问反馈显示（目标，2026-09-06 确认）

前提：用户不一定打开卡片，提问不得只藏在卡片 `summary` 里。提问是一级信息，与卡片点开率解耦。

已确认（2026-09-06 用户拍板）：双通道，同一数据源，各解决一个问题。

```text
[Chat 流，按时间] 用户议题 → 卡片摘要 → ★主持人文本气泡"本轮待你回答(N)"★
[输入框上方，常驻] ┌ 待回答 N · Q1/Q2摘要… [去回答][详情] ┐ ← 不随滚动消失
```

1. 主持人气泡（文本，不是卡片）：轮末由 host 事件驱动，列出编号问题（`Qn + 提问人 + 一句话背景`，不只抛问题）；无问题时不渲染；超 5 个只列 Top5 + `…等N个详见羊皮纸待验证节`；气泡进 Chat 流，保证刷新/恢复后历史可追溯。
2. 常驻待答条（`awaiting-user` 且有未答问题时显示，位置复用结束横幅模式 §28.4）：显示 `待回答 N` + 前 2 题标题，不随滚动消失；点击滚动到气泡或把引用模板填入输入框；输入框 placeholder 同步换成 `回答 Q1… 或补充想法开启下一轮`；点某题预填 `Q1：`，用户也可自由文本回答，host 侧模糊匹配回填。
3. 卡片只做辅助：含问题的卡片打 `含提问 N` 徽标，不作为主通道。
4. 不用 Toast/弹窗（看过即消失），不自动弹附属 Island 抢焦点；含问题卡片可标 `requiresUserAction=true` 做弱提示（§6.11.5 例外允许范围）。
5. 下轮仍未答的关键问题继续置顶计数，不强行收敛（§37.6.5）。

实施要点：

- 数据：`HostSynthesis` 加 `questions: {id,text,fromAgentId,roundNumber}[]`；`question` 类 fact 以 `pending-validation` 表示待答，答完转 `resolved`；含问题卡片 `requiresUserAction=true`。
- 引擎：host-merge2 去重归并（按语义 id，不沿用关键词启发式）；`advance` 非空时 host-intake 先做问答匹配再继续。
- 渲染：Pane 加 `HostQuestionsBanner`（仿结束横幅）+ Chat 加 `host-questions` 文本消息（从 `hostDrafts` 派生，不写新事件防重复）。

示例气泡文案：

> JanusX · 第N轮待确认（2）
> Q1（解决者问）：登录态过期后是跳登录页还是静默续期？这决定 token 刷新方案。
> Q2（完善者问）：批量导入上限 500 还是 5000？影响分页与超时设计。
> 直接在下面回答即可，无问题也可直接点「开启下一轮」。

### 37.9 P0 实施记录（2026-09-06，进行中）

- P0-1 数据契约（已落地）：`Fact.kind` 加 `requirement/solution`；`HostSynthesis.questions` + `RoundtableQuestion`；`host:pool-update` 事件与幂等 reducer（未知 id 非 add 忽略，set-status 只改状态+合并来源）；旧快照迁移补 `questions: []`；合成器从 `question` 类 fact 派生问题（去重/上限 20，resolved→answered）。
- P0-2 编排骨架（已落地，圆桌 11 文件 78 单测 + `tsc` 通过）：`WorkflowStage.hostMode`（intake/merge/synthesis，缺省 synthesis，老模板零改动）；默认模板升 `1.1.0`，stage 为 `host-intake → refiners → host-merge-1 → challengers → host-synthesis`，同一 `janusx` 一轮跑三次；intake 有新输入时先确定性写 `requirement` 池条目（模型失败也不丢），空推进整段静默跳过；中间 host 卡同 id 覆盖，轮末仍是 3 张卡；service 侧 host 按 stage 出不同提示词。
- 已知代价：一轮 3 次 host 模型调用，P0-3 视延迟/成本决定是否把 intake 收敛为纯确定性。
- P0-3 池优先与确定性归并（已落地，圆桌 11 文件 83 单测 + `tsc`/eslint 通过）：service 侧 refiner/challenger 提示词改池优先（读池、引 id、只写 delta、用户需求为 Base，问题归入 `Questions:` 节）；提示词内共享事实改为带 id/kind/status 的池序列化（近 30 条、单条 200 字截断）；`harvestQuestionTexts` 确定性收割（`Questions:` 节 + `?/？` 结尾行，去重/上限 10，单发标记只剥一次）；merge 收割本轮 refiner、synthesis 收割本轮 challenger，落盘先于模型调用、复问按归一化去重。
- P1 问答显示与决议闭环（已落地，圆桌 11 文件 85 单测 + `tsc` 通过，桌面目视待验收）：引擎侧 `harvestAnsweredTexts` 收割 intake 主持卡 `Answered:` 节，逐行归一化匹配开放池问题后 `set-status resolved`（未命中忽略，幻觉零决议；幂等），intake 提示词加 Answered 引用约定；渲染侧 Chat 流内主持人文本气泡（Q编号+Top5+羊皮纸指引，随内容签名参与滚动/badge），`awaiting-user` 时输入框上常驻待答横幅 + placeholder 换成回答指引；点问题预填引用模板延期（需提升 composer 受控状态，另起 P1b）。
- 桌面目视待验收（§25 清单外加）：首轮有问题 → 气泡+横幅出现；回答后下一轮 → 对应问题消失、计数减少；无问题轮次 → 横幅气泡均不渲染。

### 37.10 提问详情 Island 与流程化对话框（2026-09-06 确认+落地）

已确认（2026-09-06 用户拍板）：提问进右侧详情，详情与卡片详情同视觉语言；对话框只讲流程，不铺全文。

1. 新附属模块 `roundtable-questions`（`JanusRoundtableQuestions`）：待回答全文（Q编号+更新时间）与已解决（近 10 条）两节，复用 `agent-result-detail` 画布；标题/眉题/空态走 `janus:roundtable.questions.*` 中英双语（`i18n:types` 1522 键、`i18n:check` 同步通过）。
2. 对话框流程化：气泡只剩 `JanusX · 第N轮 · 待确认X · 已解决Y` + 一句说明 + 查看详情按钮，全文搬进详情；横幅保留计数+前两题短标题，加详情按钮。
3. 入口：气泡按钮与横幅按钮都经 `JanusIsland → ExpandedShell → Pane/JanusChat` 打开详情（`setAuxiliaryModule('roundtable-questions')`，单模块约束不变，与羊皮纸/卡片详情互斥）；`Escape`/关闭/新议题清空行为与现有详情一致。
4. 验证：`tsc` 零错误，eslint 0 errors，圆桌 85 单测通过；桌面目视待验收（详情与池同源、切换卡片详情互斥、窄屏行为）。

## 38. 羊皮纸多开阅读（扩展功能，待实施）

> 来源：2026-09-06 用户趣味显示想法。状态：**待实施的扩展功能**，不得视为已实现；默认仍为单附属模块（§6.7 单实例、`JanusIsland.tsx:82` 的 `auxiliaryModule: T | null` 约束不变），多开为显式 opt-in。

### 38.1 目标形态

长羊皮纸按章节分面、多 Island 并排摆开，各面独立滚动，同一数据源：

```text
┌────────────┐  ┌───────────┐  ┌───────────┐
│ 主 Island  │  │ 羊皮纸-面A │  │ 羊皮纸-面B │
│ 圆桌+对话  │  │ 结论/决策  │  │ 证据/行动  │
└────────────┘  └───────────┘  └───────────┘
```

两类多开都属本扩展范围：(a) 同一份羊皮纸分章节多面；(b) 羊皮纸 + agent-result 同时开。默认仍单开，多开只在用户显式操作（如章节标题的"在新面中打开"、详情内"分面对比"）时触发。

### 38.2 约束（沿用 §6.3/§6.10）

1. 外壳仍复用 `JanusAuxiliaryIsland` 同一套 chrome/token，多面只是 Host 下的实例数组，不复制外壳 CSS；羊皮纸风格只限内容画布。
2. 内容零复制：多面读同一份 `projectParchment(state)`，切换面只换 `sectionAnchor`，不重请求、不重挂载主 Island/3D/输入框（草稿不丢）。
3. 上限建议 3 面（含首面）；超出时复用最旧面并提示，不无限向右级联。
4. `Escape` 按 LIFO 先收最新面；全部收回才交 Island 原有逻辑；`prefers-reduced-motion` 下直接切换。
5. 窄屏/移动端禁用多开，降级为单面 + 章节内锚点跳转；任何宽度下不允许横向滚动裁切。
6. 组合几何仍整体居中/左移，不从当前中心向右溢出（§6.8 第 6 条对 N 面同样有效）。

### 38.3 实施边界（不动默认路径）

1. `JanusIsland.tsx:82` 的 `auxiliaryModule: T | null` 扩展为 `openModules: Array<{type, sectionAnchor?, nonce}>`（默认长度 ≤1，老行为零回归）；`data-auxiliary-module` 旁加 `data-auxiliary-count` 供几何/CSS 消费。
2. `JanusAuxiliaryIslandHost` 改为 map 渲染多实例，各面独立 `closing`/`Focus`/`滚动位`；关闭任一面保留其余面的章节与滚动。
3. 章节锚点：`JanusRoundtableParchment` detailed 分节加 `id`（结论/决策/依据/待验证/冲突/行动/来源），多开入参只带 `sectionAnchor + 高亮`。
4. 可选增强（非必需）：面间"同步滚动跟随"开关，默认关。

### 38.4 验收

- 默认点击行为不变（仍单面）；只有显式多开操作才出现第二面。
- 双面/三面在 1440/1920 下不越视口，等高对齐；窄屏自动降级无横向滚动。
- 关闭任一面，主 Island、对话草稿、其余面滚动位无损。
- `Escape` 顺序正确；同一时间不超过上限；多面内容同源一致（改轮后同刷）。
