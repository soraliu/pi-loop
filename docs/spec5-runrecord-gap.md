# SPEC §5 RunRecord 对账注记（M3 现状 vs 目标形状）

> 状态：M3-T5 落盘（M2 终审 M-6 挂账正式化）。**本文件是对账注记，不修改
> `docs/SPEC.md` 本体**——SPEC 为 M0 基线权威；实施形状经 M1-M3 演进产生的差异
> 在此登记，回填计划指向 M4/M7。

## 目标形状（SPEC §5 原文）

`RunRecord`: `{id, taskId, effort, plan, iterations: [{round, dispatchLog, resultRefs, evaluation}], telemetry: {agents, turns, durationMs}, final, createdAt}`

## 现状（M3 收官时 run.json 的实际形状）

`{id, task, taskPreview, effort, status, createdAt, iterations[], plan?}`（另有运行级可选 `error?`——中止与 `budget_exhausted` 落痕，M2/M3 新增、SPEC 未列）：

- `iterations[]` 元素 = `IterationEntry {stepId, agent, status, outputRef?, startedAt?, endedAt?, error?}`
- `plan?` = `RunPlanInfo {origin, steps, degraded?, notes?, channel?, attempts?}`

## 逐字段 gap 表

| SPEC §5 字段 | M3 现状 | 状态 | 差距与回填 |
| --- | --- | --- | --- |
| `id` | `id`（`r-<epoch36>-<rand>`） | ✅ 对齐 | — |
| `taskId` | 无独立字段；`task`（任务全文）+ `taskPreview`（截断视图） | ⚠️ 部分 | `task` 承担了 taskId+任务文本双职责；M4 评估迭代引入轮次概念时拆分定形 |
| `effort` | `effort` | ✅ 对齐 | — |
| `plan` | `plan?: RunPlanInfo`（M3-T4 落盘：origin/steps/degraded/notes/channel/attempts） | ✅ 语义已有（形状为 M3 自有） | SPEC 未定义 plan 字段形状；现形状是诚实遥测的最小集。计划全文在 `runs/<id>/designer-plan.json`（designer 产物）或内核常量（builtin）；M5 案例入档时复核是否把全文并入 RunRecord |
| `iterations[].round` | 无 `round` 维度（entry 按计划步骤粒度，一次执行一轮） | ❌ 缺 | M4 评估与迭代：plan × N 轮重跑 → entry 需带轮次归属 |
| `iterations[].dispatchLog` | `startedAt`/`endedAt`/`error` 是调度事实的子集 | ⚠️ 部分 | 完整调度日志（spawn 受理 runId 等）未入档；M4 归因注入时定形 |
| `iterations[].resultRefs` | `outputRef?`（单个产物引用） | ⚠️ 部分 | 单引用近似；多产物（transcript/artifacts）随 M5 案例入档扩展 |
| `iterations[].evaluation` | 无 | ❌ 缺 | M4 evaluator（verdict/score/reasons/轮次归因） |
| `telemetry` | run.json **无** telemetry 块；`LoopToolResult.telemetry`（steps/succeeded/failed/iterations/durationMs）只在工具返回面 | ❌ 缺（面+形状双差） | M4 把遥测块随终态写回 run.json；`agents`/`turns` 与现有计数的映射在 M7 发版对账时定形 |
| `final` | 无 | ❌ 缺 | M4：最终结论 + verified 判定（来自 evaluator，诚实遥测） |
| `createdAt` | `createdAt` | ✅ 对齐 | — |

另有 SPEC 未列的现状字段（超集，非冲突）：`task`、`taskPreview`、`status`（`created → running → completed | failed` 状态机）、entry 级 `startedAt`/`endedAt`、运行级 `error?`。

## 回填计划（按里程碑）

- **M4（评估与迭代）**：`round` 轮次归属、`evaluation`、`final`、run.json 侧 `telemetry` 块、失败归因注入记录
- **M5（方法论库）**：`resultRefs` 多产物扩展、案例入档字段联动复核、`plan` 全文是否并入 RunRecord
- **M7（文档发版）**：本文件与 SPEC §5 的一致性终审——届时要么字段回填完成、要么以修订版 SPEC §5 收口（同步更新本文件状态）

## 原则

- 诚实遥测优先：现状形状均经 M1-M3 测试锁定，回填以增量可选字段实现，不做破坏性改名
- SPEC §5 是 schema 摘要（非 JSON Schema 全文）；对账以"语义可映射"为准，形状对齐是 M4/M7 的演进项
