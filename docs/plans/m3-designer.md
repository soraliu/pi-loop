# M3 计划 — 方法设计器（Designer）

> 依据：docs/SPEC.md §4（Designer 契约）、§7.3（预算硬上限）、§9 M3 行。本计划是 SPEC 的论证；冲突以 SPEC 为准。

## Context

M2 的调度内核执行的是**静态内置计划**（BUILTIN_PLAN 单步 researcher）。M3 落地 SPEC §4 图中的 Designer 组件：**任务 → 动态生成 ResearchPlan → 校验 → 执行全流程**——这是 pi-loop 从"会调度"到"会设计方法"的质变里程碑。同时结算 M2 终审的三项前置加固（M-1 spawn 误归因、M-2 DEGRADED_RE 宽匹配、M-3 预算硬上限）与两项收敛（M-5 topoLayers 双实现、T4-M2 多步终态可见性）。

**SPEC 契约原文**：Designer 入参 `task + 检索(methods×k, cases×k) + effort`，出参 ResearchPlan JSON；**schema 校验失败即重试，2 次后降级为内置默认计划**。检索注入是 M5（方法论库）——M3 的 designer 输入留检索接口桩（空数组），M5 接线。

## 技术锚（M2 事实回填）

- **产物通道**（T5 e2e 核证）：subagent 完成事件 async-complete 的引用字段实际形态为 `results[0].outputReference`（string|{path}）与 `results[0].artifactPaths.outputPath`——researcher 类 agent 产物是**文件**（subagent-artifacts 下 .md）。Designer 的 JSON 输出策略：**任务文本要求把 ResearchPlan JSON 写入约定文件 `<runDir>/designer-plan.json`**；同时容错提取 output 文本中的 ```json 围栏块（双通道，谁在用谁）。fake 层两种形态都测。
- **fresh 上下文**：designer spawn 一律 `context: "fresh"`（M2 熔断教训：fork+空输出不可靠）。
- **模型继承**：spawn 不指定 model（用户规则）。
- **typebox 迁移**：`@sinclair/typebox` devDep → dependencies（runtime 须校验 LLM 生成 JSON；库零依赖、体积小，符合 SPEC §8 约束；M0 规划已批准使用）。

## Global Constraints

- runtime 依赖仅新增 `@sinclair/typebox`（迁移性质）；其余 devDeps 不增
- **防御性解析强制**：designer 产物是 LLM 文本——JSON.parse 后必须深度净化（`__proto__`/`constructor`/`prototype` 键剔除，M2-T2 review 遗留威胁模型在本次兑现）；所有插值仍走 JSON.stringify 转义
- **预算硬上限**（SPEC §7.3）：plan 步数、层内并行、迭代轮数都以 effort 表为界；超界立即收尾并如实报告 `budget_exhausted`（不得静默截断）
- 降级链完整：designer 失败（校验 2 次重试后仍坏 / spawn 失败 / 超时）→ BUILTIN_PLAN + `RunRecord.plan.degraded = true`（如实标注，禁止冒充正常生成）
- **诚实遥测**（§7.4）：designer 生成/降级/预算事件如实入 RunRecord，禁止自我宣称质量
- 源码注释中文；commit 英文；目录边界：`src/core/`（新 designer + plan-schema）、`src/storage/`（预设扩展）、`src/extension/`（接线改造）、`tests/`
- 测试 fake 双形态（产物文件 / output 内嵌 JSON），真实 designer 仅 T5 冒烟
- contextPaths 相关的安全边界不在本里程碑（M4/M5 演进）

## Tasks

### Task 1 — ResearchPlan 类型 + schema + 防御解析（types.ts + src/core/plan-schema.ts）
- `PlanStep` 升级：`{ id, agent, task, dependsOn: string[], guidance?: string, acceptance?: string }`（guidance=每步附加引导；acceptance=验证标准，M4 evaluator 消费预留）；`ResearchPlan = { version: 1, task, origin: "designer"|"builtin", steps: PlanStep[], notes?: string }`
- typebox schema（Type.Object 形）+ `validateResearchPlan(unknown): {ok, plan?} | {ok:false, errors}`——错误信息可直接注入 designer 重试 prompt
- `sanitizePlanJson(raw: unknown)`：解析后深度净化（原型污染键剔除 + 数值/字符串类型强校验 + steps 长度硬顶），schema 前置
- `EffortPreset` 扩展 `maxPlanSteps`（每档默认 low 3 / medium 5 / high 8 / max 12；settings.json 部分覆盖容缺省——沿用 M1 合并语义）
- 单测：正例（完整 plan）／原型污染三键（`__proto__`、`constructor`、`prototype` 攻击样例——含嵌套）／缺字段／越界步数／dupe id／环依赖

### Task 2 — Designer 生成器（src/core/designer.ts）
- `generatePlan(task, effort, preset, ctx: {rpc, runId, dataDir, signal?}): Promise<ResearchPlan>`
- 生成协议：spawn designer agent（`context:"fresh"`，agent 名 `researcher` 兼任——M3 无专用 agent 定义），任务文本=模板（任务原文 + effort 预算 + maxPlanSteps + 步骤须知 + **输出契约：把 ResearchPlan JSON 写入 `<runDir>/designer-plan.json`，且在最终回复中附 ```json 围栏副本**）→ 完成后**双通道取产物**（文件优先，output 围栏次之）→ sanitizePlanJson → validateResearchPlan
- 重试：校验失败 ≤2 次，重试任务文本附加具体校验错误；2 次后降级 `BUILTIN_PLAN` 且 `origin:"builtin"` + `notes:"designer 降级：<原因>"`
- spawn 失败/超时：直接降级（不重试——与"校验重试"区分，如实入 notes）
- 单测：fake RPC 4 场景（文件通道成功 / 围栏通道成功 / 校验失败→重试→降级 / spawn 失败→降级）+ RunRecord 落真值断言（origin/degraded 语义务必如实）

### Task 3 — 预算硬上限 + 层内并发钳制 + topoLayers 收敛（orchestrator + planner-static，M2 债务结算）
- `executePlan` ctx 增 `budget: { maxPlanSteps, maxParallelSubagents }`（由 preset 派生）：步数超顶 → **拒绝执行整个 plan**（fail-fast：designer 侧已校验，这是执行层双保险，error="budget_exhausted: plan steps N > max M"）；层内并发 go 池钳制（同层多于上限时分批，不静默丢弃）
- 层间结算如派生新步数超界（未来动态域）→ 收尾 `status:"failed"`, `error:"budget_exhausted: <原因>"`；已完成 entry 保留
- `topoLayers` 双实现收敛（planner-static 与 orchestrator 提取到共享 util `src/core/dag.ts`；两处改 import；既有负例测试全部保持GREEN）
- 单测：层内并发钳制（4 步同层 / 上限 2 → 两批完成断言批序）；步数超顶拒绝；正常路径回归（M2 90 用例零破坏）

### Task 4 — 内核接线 + 前置加固（loop-task/tools/commands + M-1/M-2 收口）
- `prepareRun` 后插 designer：`generatePlan(...) → executePlan(plan, {budget...})`（降级 plan 照跑——验证 /loop 在无 designer 可用环境回落 M2 行为）；RunRecord 记 `plan: {origin, steps: n, notes}`
- M-1：spawn 失败的"请安装 pi-subagents"后缀仅在超时/无应答特征（`code==="timeout"` 或无 reply）时附加；agent 不存在等真实拒绝不再误归因
- M-2：`smoke-e2e.sh` 的 DEGRADED_RE 词边界收紧 + 仅匹配 run.json error/notes 字段（不再全量 grep $OUT）
- T4-M2 复评兑现：命令 notify 节流升级——每步**终态**一条（成功/失败都发，按 stepId+终态去重），替代"仅首条胜出"
- 单测：接线全链（fake designer 成功/降级双路径）；M-1 两分支断言；节流终态可见性（3 步含 1 失败 → running 条 + 3 终态条）

### Task 5 — e2e 多步全链 + 文档
- e2e 升级：中等任务（如"研究 X 并产出对比表"）→ designer 真实生成 2+ 步 plan → 逐层 spawn → completed；断言 run.json `plan.origin==="designer"` + steps≥2 + 全 entry 非 pending；降级链回归（PI_LOOP_STUB / 模型层 / pi-subagents 缺席三 SKIP 文案仍在）
- 预算路径小task验证：`maxPlanSteps=1` 强制注入（PI_LOOP_FORCE_MAX_STEPS=1 测试钩子或 dataDir 级 settings 覆盖）→ designer 压缩或降级 → 不 crash
- README M3 段：designer 能力 + 双通道产物 + 降级语义 + 预算硬上限表
- SPEC §5 对账注记（M-6 挂账正式化：RunRecord 现形状 vs SPEC 目标形状的 gap 表入 docs/——供 M4/M7 回填）

## 验收（SPEC §9 M3 行展开）

1. `任意任务 → ResearchPlan`：微型任务 e2e 真实跑通（designer 生成多步 → 执行 completed）
2. schema 校验全链：正例/污染/超界全绿（T1）；重试→降级双路径有测试锁定（T2）
3. 预算硬上限：步数/并发钳制测试 + budget_exhausted 收尾语义（T3）
4. M2 前置加固三项全部落地（M-1/M-2/M-3）
5. 既有 90 用例零破坏；新增全绿；e2e 降级链回归
