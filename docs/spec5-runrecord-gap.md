# SPEC §5 RunRecord 对账注记（实施现状 vs 目标形状）

> 状态：M5-T4 更新（M5 行逐项复核：案例字段联动与 plan 全文决策勾销；
> dispatchLog/resultRefs 仍缺挂 M7；turns 倾向 omit 在案）；M4-T3 更新（gap 表 M4
> 行全勾销：round/evaluation/final/telemetry/taskId）；初版 M3-T5 落盘（M2 终审
> M-6 挂账正式化）。**本文件是对账注记，不修改 `docs/SPEC.md` 本体**——SPEC 为
> M0 基线权威；实施形状经 M1-M5 演进产生的差异在此登记，回填计划指向 M7。

## 目标形状（SPEC §5 原文）

`RunRecord`: `{id, taskId, effort, plan, iterations: [{round, dispatchLog, resultRefs, evaluation}], telemetry: {agents, turns, durationMs}, final, createdAt}`

## 现状（M5 收官时 run.json 的实际形状）

`{id, task, taskPreview, effort, status, createdAt, iterations[], plan?, round?, evaluation?, final?, telemetry?}`（另有运行级可选 `error?`——中止与 `budget_exhausted` 落痕，M2/M3 新增、SPEC 未列）。M5 未新增 RunRecord 字段——记忆扩展落在 `cases/`（案例投影档案）与 `methods/`（git 化方法库）侧，run.json 形状与 M4 收官一致：

- `iterations[]` 元素 = `IterationEntry {stepId, agent, status, outputRef?, startedAt?, endedAt?, error?, round?}`（`round` M4-T2 落：分轮归组，0 起计）
- `plan?` = `RunPlanInfo {origin, steps, degraded?, notes?, channel?, attempts?}`
- `round?`/`evaluation?`/`final?` = 迭代闭环终态留档（M4-T2；`final={round, verdict, score}`）
- `telemetry?` = `RunTelemetry`（M4-T3：收尾落盘——零执行事实时整个块 omit，见 gap 表 `telemetry` 行）

## 逐字段 gap 表

| SPEC §5 字段 | 实施现状（M5 收官时） | 状态 | 差距与回填 |
| --- | --- | --- | --- |
| `id` | `id`（`r-<epoch36>-<rand>`） | ✅ 对齐 | — |
| `taskId` | 无独立字段；`task`（任务全文）+ `taskPreview`（截断视图） | ✅ 对齐（runId 兼用） | **M4-T3 定案：taskId=runId 兼用**（`id` 即任务标识，`task` 保持任务全文语义，不引入独立字段）；M5/M7 如需独立再分离（届时回访本行） |
| `effort` | `effort` | ✅ 对齐 | — |
| `plan` | `plan?: RunPlanInfo`（M3-T4 落盘：origin/steps/degraded/notes/channel/attempts） | ✅ 语义已有（形状为 M3 自有） | SPEC 未定义 plan 字段形状；现形状是诚实遥测的最小集。计划全文在 `runs/<id>/designer-plan.json`（designer 产物）或内核常量（builtin）。**M5-T4 定案：不并入全文**——案例入档已按摘要形状消费（`caseFromRunRecord` 投影 `record.plan` 的 steps/notes），全文继续留产物文件，RunRecord.plan 维持六元摘要 |
| `iterations[].round` | `round?`（entry 分轮归组，0 起计） | ✅ 对齐 | M4-T2 落地：orchestrator 落盘不感知轮次，由迭代引擎补标（多层重跑正确归组） |
| `iterations[].dispatchLog` | `startedAt`/`endedAt`/`error` 是调度事实的子集 | ⚠️ 部分（挂 M7） | 完整调度日志（spawn 受理 runId 等）未入档；轮次归因已经 `evaluation.blame` 闭环（M4-T2）。M5-T4 复核：**不覆盖，仍缺**——M5 的入档为终态投影（`caseFromRunRecord`），不触碰 entry 结构；受理留痕顺延 M7 发版对账 |
| `iterations[].resultRefs` | `outputRef?`（单个产物引用） | ⚠️ 部分（挂 M7） | 单引用近似。M5-T4 复核：**不覆盖，仍缺**——案例入档取终态投影（案例档案不消费多产物引用），多产物（transcript/artifacts）顺延 M7 发版对账 |
| `iterations[].evaluation` | run 级 `evaluation?: Evaluation` + `final?`（M4-T2 落盘） | ✅ 语义对齐（形状为 run 级） | SPEC 的 per-iteration evaluation 以「run 级终评 + entry.round」对账（按「语义可映射」原则收口）；不留逐轮 evaluation 存档（评估只喂当轮——素材隔离，防陈旧失败污染归因） |
| `telemetry` | `telemetry?: RunTelemetry`（M4-T3 起随终态落盘 run.json；工具结果面 `LoopToolResult.telemetry` 同口径） | ✅ 语义对齐（形状为 M4 自有超集） | `agents`=全部轮次 entry 的 agent 去重计数、`steps/succeeded/failed` 末轮口径、`iterations` 累计、`durationMs` 闭环墙钟；零执行事实（空计划拒绝/预中止）时整个块 omit（不写假 0）。**`turns` 恒 omit——无从获得真实轮次数据（诚实遥测：不可得字段 omit，不造假数值）**。M5-T4 定形记录：逐 run 联动复核后确认 pi-subagents 的 RPC/完成事件面未暴露对话轮次数据，run 侧无从真实采得——omit 倾向在案；M7 发版对账时终审定形（维持 omit 或修订 SPEC §5 形状） |
| `final` | `final?: {round, verdict, score}`（M4-T2 落盘） | ✅ 对齐 | — |
| `createdAt` | `createdAt` | ✅ 对齐 | — |

另有 SPEC 未列的现状字段（超集，非冲突）：`task`、`taskPreview`、`status`（`created → running → completed | failed` 状态机）、entry 级 `startedAt`/`endedAt`、运行级 `error?`。

## 回填计划（按里程碑）

- **M4（评估与迭代）——✅ T2/T3 收口**：`round` 轮次归属、`evaluation`、`final`（T2）；run.json 侧 `telemetry` 块（T3——agents 去重计数 + 末轮口径计数，turns 恒 omit）；失败归因注入记录（T2 经 `evaluation.blame` + blame 步骤前缀重跑闭环）；taskId=runId 兼用定案（T3）
- **M5（记忆档案）——T4 收口**：案例入档字段联动复核 ✅（定案：Case = run.json 投影——plan/evaluation/final 取记录面，`caseFromRunRecord` 落地且单测锁定四形态）；`plan` 全文 ✅ 定案不并入（维持六元摘要，全文留 designer-plan.json/内核常量）；**仍缺挂 M7**——`resultRefs` 多产物扩展、`dispatchLog` 受理留痕、`telemetry.turns`（pi-subagents 无轮次数据面，omit 倾向在案——见上表 telemetry 行）
- **M7（文档发版）**：本文件与 SPEC §5 的一致性终审——届时要么字段回填完成、要么以修订版 SPEC §5 收口（同步更新本文件状态）；终审范围含 `telemetry.turns` 的 omit 定形、taskId=runId 兼用的最终去留，以及 M5-T4 顺延挂账的 `resultRefs` 多产物与 `dispatchLog` 受理留痕

## 原则

- 诚实遥测优先：现状形状均经 M1-M5 测试锁定，回填以增量可选字段实现，不做破坏性改名
- SPEC §5 是 schema 摘要（非 JSON Schema 全文）；对账以“语义可映射”为准，形状对齐顺延为 M7 的演进项
