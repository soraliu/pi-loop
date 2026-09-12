# pi-loop 规格书（SPEC）

> 状态：v1.0（M0 基线）｜ 权威性：本文件与用户当面对质性指令是仅有的两个权威。计划（docs/plans/）是本文件的论证，冲突以本文件为准。

## 1. 定位

pi-loop 是一个 pi extension。用户指派**任意**任务后，它自主完成：研究方法设计 → 提示词生成 → subagent 调度 → 结果评估与迭代 → 方法论沉淀；且对"方法设计流程"本身具备自我迭代能力（带证据的 keep/rollback）。

**不是**：不是 benchmark 跑分器（那是前身 loop-engineer 的场景）；不是通用 agent 框架（宿主永远是 pi + pi-subagents）。

## 2. 用户故事

1. 我在 pi 会话里说"用 loop 研究 X 并产出报告"→ agent 调 `loop_task` → 我拿到结果与运行报告（含每轮迭代原因）。
2. 我敲 `/loop --effort high 实现 Y，验收: npm test` → 机器断言驱动迭代循环 → 通过后交付。
3. 我敲 `/loop-cases` / `/loop-methods` → 看到历史案例与方法论档案（分数轨迹、修订历史）。
4. 任务完成后无需我操作 → 案例自动入档；累积后 meta 循环提出方法论修订（A/B 验证后生效，git 可审计可回滚）。

## 3. 术语

| 术语 | 定义 |
|---|---|
| **ResearchPlan** | 方法设计器的输出：结构化 JSON（分解步骤、每步 subagent 角色+提示词、验证标准、预算、上下文包） |
| **Run** | 一次 loop_task 执行（1 个 plan × N 轮迭代 × 若干 subagent；含 transcript 引用与遥测） |
| **MethodologyLibrary** | 方法论库：多个**方法条目**（可检索的结构化策略资产，git 版本化） |
| **Case** | 案例档案：task、检索到的方法、最终 plan、结果、评分、教训 |
| **EffortLevel** | `low \| medium \| high \| max` 预设，映射到迭代轮数/并行度/meta 自动化 |
| **Meta-loop** | 方法论的自我迭代：回溯案例 → 提出修订 → A/B 留出验证 → keep/rollback |

## 4. 架构与组件契约

```
loop_task(task, effort?, verifyCommand?, contextPaths?)
   │
   ▼
[Designer]  in: task + 检索(methods×k, cases×k) + effort
            out: ResearchPlan JSON（schema 校验失败即重试，2 次后降级为内置默认计划）
   │
   ▼
[Orchestrator]  in: plan
                out: 执行结果（经 pi-subagents RPC `spawn` workflowScript；逐结果收集）
   │
   ▼
[Evaluator]  in: 结果 + 验收（verifyCommand 机器断言优先；否则 critic agent rubric）
             out: {verdict: verified|partial|fail, score 0-100, reasons[], blame 轮次归因}
   │      ├─ fail/partial 且预算未耗尽 → 失败原因注入 Designer/提示词 → 重新调度
   ▼
[Archivist]  in: run 全量记录
             out: Case 入库 + 方法使用统计；触发条件满足时提议 Meta-loop
   │
   ▼
[Meta]  in: cases 集 + methods 当前版
        out: 方法修订提案 → 留出集 A/B 验证 → git commit（keep）或丢弃（rollback）
```

**组件间只通过上述接口耦合**；storage 层为唯一持久化出口。

## 5. 数据模型（schema 摘要，实现须校验）

- `ResearchPlan`: `{version, goal, steps: [{id, kind: research|build|verify|synthesis, agentRole, prompt, dependsOn[], budget}], verification: {kind: command|critic, spec}, effort}`
- `RunRecord`: `{id, taskId, effort, plan, iterations: [{round, dispatchLog, resultRefs, evaluation}], telemetry: {agents, turns, durationMs}, final, createdAt}`
- `MethodologyEntry`: `{id, name, appliesTo: {taskTypes, signals[]}, playbook（计划模板，可含提示词骨架）, fitness: {uses, avgScore}, lineage: {parent, diff}}`
- `Case`: `{id, task, methodIds[], plan, runId, finalScore, verified, lessons[]}`
- `~/.pi/loop/`：`settings.json`、`methods/`（git 仓库）、`cases/`、`runs/`

## 6. 交互面（对 pi 会话）

**工具 `loop_task`**：参数 `task: string`（必填）、`effort?: 'low'|'medium'|'high'|'max'`、`verifyCommand?: string`、`contextPaths?: string[]`。执行中通过 onUpdate 投递进度；返回 summary + 细节引用。

**命令 `/loop <task>`**：解析 `--effort`、`--verify`、`--context`；转 loop_task 流程并同步展示进度。`/loop-status`、`/loop-cases`、`/loop-methods` 只读视图。

**Effort 预设表**（默认值，settings.json 可覆盖）：

| preset | 结果迭代轮数上限 | 并行 subagents | meta 触发 |
|---|---|---|---|
| low | 1 | 2 | 关闭 |
| medium | 2 | 4 | 手动 |
| high | 3 | 6 | ≥5 新案例提议 |
| max | 5 | 8 | ≥3 新案例提议 |

## 7. 安全与防漂移（不可妥协）

1. **方法论仓库边界**：Meta-loop 只能写 `~/.pi/loop/methods/`（独立 git 仓库）；pi-loop 自身代码、用户其他文件、`~/.pi/agent/settings.json` 均为禁区。
2. **A/B 选择压力**：方法修订必须在留出的历史案例上验证不低于当前版才 keep；否则 rollback（`git revert` 语义）。
3. **预算硬上限**：每 run 的迭代轮数、并行数、（尽力获取的）token 上限都以 effort 表为界；超界立即收尾并如实报告 `budget_exhausted`。
4. **诚实遥测**：`verified` 判定必须来自 evaluator 的机器断言或 critic 结论原文，禁止 designer/orchestrator 自我宣称。
5. **幂等工作区**：Run 全部产物写 `~/.pi/loop/runs/<id>/`，不污染用户 cwd（除非任务本身要求在其 cwd 执行，此时以 contextPaths 显式声明）。

## 8. 非目标

- 不做 benchmark/评分排行榜集成（loop-engineer 已有）
- 不做可视化 UI（TUI 命令够用）
- 不替代 pi-subagents（复用其调度与安全模型）
- M1-M7 不引入大型 runtime 依赖

## 9. 里程碑与验收

| # | 里程碑 | 验收 |
|---|---|---|
| 0 | 仓库与规格 | main 上有 README/SPEC/plans；本文件评审通过 |
| 1 | 扩展壳 | `pi -e .` 加载成功；loop_task(stub)+/loop 命令+工作区+预设表+vitest 全绿 |
| 2 | 调度内核 | loop_task 硬编码 plan → 真实 spawn researcher → 结果落 RunRecord |
| 3 | 方法设计器 | 任意任务→ResearchPlan（schema 校验）→执行全流程 |
| 4 | 评估与迭代 | evaluate fail→注入归因→重跑→通过 端到端测试；verifyCommand 优先级正确 |
| 5 | 方法论库 | 案例入档+相似检索注入 designer；方法库 git 化 |
| 6 | Meta 自迭代 | 升/降两路径测试（keep 与 rollback）；边界（禁改区）测试 |
| 7 | 文档发版 | README/SPEC 同步；`pi install git:github.com/soraliu/pi-loop` 可装可用 |
