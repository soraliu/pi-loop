# M4 计划 — 评估与迭代（Evaluator + 闭环）

> 依据：docs/SPEC.md §4（Evaluator 契约与迭代闭环）、§7.3/§7.4、§9 M4 行。本计划是 SPEC 的论证；冲突以 SPEC 为准。

## Context

M3 之后 pi-loop 会设计方法（ResearchPlan）也会执行，但**一次性成败听天由命**——没有评估、没有归因、没有重跑。M4 落地 SPEC §4 图中 Evaluator 组件与迭代闭环：**evaluate fail → 失败原因注入 → 重跑 → 通过（或预算耗尽如实收尾）**——这是 pi-loop 从「会执行」到「会自我修正」的最后一块核心拼图（SPEC §1 全生命周期闭环）。同时结算 M3 终审附随义务（白天 e2e 补跑物证）与 M4 前置清单。

## 技术锚（M3 交付事实回填）

- **acceptance 字段已预留**（PlanStep.acceptance?: string——M3-T1 落，零消费者）：M4 的 evaluator 验收标准来源之一（designer 每步自带的验收描述）
- **verifyCommand 入参已存在**（LoopToolParams.verifyCommand?: string——M1 落，注释即"机器验收命令（存在时优先于 critic 打分，SPEC §7.4）"；prepareRun 未消费）
- **RunOutcome/iterations 现状**：iterations 为 step 形（stepId/agent/status/outputRef/error）；round/evaluation 形未存在（spec5-runrecord-gap.md M4 行回填目标）
- e2e 基建：场景 A/B + SKIP 判型链 + runId 协议归一化（M3-T5）；6 组终审遗留待本里程碑消化

## Global Constraints

- 零新增依赖（typebox 已在）；devDeps 不增
- **诚实遥测铁律（§7.4）**：verified 判定必须来自 verifyCommand 的机器断言或 critic 结论原文；designer/orchestrator/evaluator 自我宣称一律禁止——evaluator 自身的 spawn 失败时 verdict 只能是 fail 或 partial（附原因），绝不能自判通过
- **verifyCommand 优先级**：存在即机器断言唯一权威（critic 不跑）；不存在才走 critic rubric。verifyCommand 的执行以 dataDir 沙箱 cwd（幂等工作区 §7.5——不污染用户 cwd）
- 迭代轮数以 effort.maxResultIterations 为界（§7.3）；重跑消耗完整 designer→execute 链 or 仅 execute（设计决策：fail 归因注入点是 designer 的重生成还是步骤级重试——见 T2 任务内裁定，倾向**最小注入面**：保留原 plan，失败原因注入受 blame 步骤的 task 前缀重跑；plan 级重设计仅当全部步骤 fail 且 designer 校验也报错时）
- 源码注释中文；commit 英文；目录边界：`src/core/evaluator.ts`（新）、`src/core/orchestrator.ts`（迭代接线）、`src/extension/`、`src/storage/`（RunRecord 扩展）、`tests/`
- 测试全 fake（critic fake / verifyCommand 用假 shell 脚本文件）；真实 critic spawn 仅 e2e
- **附随义务执行窗口**：e2e 场景 A 白天补跑（物证留档改造后）在本里程碑 T4 完成

## Tasks

### Task 1 — Evaluator 核心（src/core/evaluator.ts）
- `evaluateResult(input: {runOutcome, entries, task, verifyCommand?, acceptanceByStep, budget}, ctx): Promise<Evaluation>`
- `Evaluation = { verdict: "verified"|"partial"|"fail", score: 0-100, reasons: string[], blame: string[] }`（blame=归因 stepId 列表——基于 entry.error 与 critic 指认）
- **verifyCommand 通道**：`child_process.execFile`（shell:false 安全优先；命令拆分由 shlex 风格简易分词——注意 M1 已知"未闭合引号"分词器债务，本任务修复或绕过：verifyCommand 为单命令字符串，用现有分词逻辑若有则消费）在 dataDir 作 cwd 执行，timeout 60s；exit 0 → verified（score 由输出可解析的 PASS/FAIL 计数或满分 100）；非 0 → fail + stderr 摘要入 reasons
- **critic 通道**（无 verifyCommand）：spawn critic（agent 批量名 researcher 兼任，fresh）rubric prompt（任务+各步产出摘要+acceptance 标准追问）→ 输出结构化 JSON（fenced）→ 防御解析（复用 plan-schema 的净化模式——提取 `__proto__` 剔除逻辑为共享 util 或复制调用）；critic spawn 失败 → verdict fail + reasons 如实（不自判通过）
- 单测：verifyCommand 成功/失败/超时/命令输出解析；critic verified/partial/fail 三态；critic 失败降级 honesty；blame 归因正确性（哪步坏了）

### Task 2 — 迭代闭环（orchestrator 或新 src/core/iterate.ts + loop-task 接线）
- `runWithIterations(task, preset, ctx)`：executePlan → evaluate → fail/partial 且 rounds < maxResultIterations → **归因注入重跑**（注入面最小化裁定在此实现）→ 循环到 verified 或预算尽
- RunRecord 迭代结构升级（gap M4 行回填）：顶层 `round: number`（当前轮）、`evaluation: Evaluation`（最终轮结论）、iterations 每条挂 round 段（多轮的 entry 分轮归组）；`final?: {round, verdict, score}` 收尾摘要
- 预算语义：budget_exhausted 收尾（status=failed + error 前缀 + 已得 evaluation 留档——最后一轮的 partial/fail 结论不丢）
- LoopToolResult.status 枚举映射收口（终审 M-3 债）：completed/failed/budget_exhausted 三态如实 + evaluation 摘要字段
- 单测：一轮通过（无迭代）；fail→注入→二轮通过；连续 fail 到预算尽（budget_exhausted + 最后 evaluation 留档）；verifyCommand 优先（有它时不 spawn critic——fake 断言零 critic spawn）；轮间 plan 保留/重设计的分支行为

### Task 3 — RunRecord 回填 + 债务收口（types/workspace/loop-task）
- gap 表 M4 行全回填：telemetry 块（agents/turns 尽力收集——从 entry 时长与 spawn 数派生的**事实数值**，不可得字段如 omit）+ taskId（runId 兼用或显式）+ round/evaluation/final（T2 落的部分此任务对账清零）
- 终审 M-4 债：loop-task catch 分支（designer/recordPlanInRunJson 基建异常）补 run.json status=failed 落盘
- 终审 M-5 债：designer↔orchestrator 超时常量/abortWatch 三件收敛为 src/core/consts.ts（或 rpc.ts 导出）单一真源
- 终审 M-2 债：ASYNC_HEADER_RUN_ID_RE 补 `^` 锚
- 单测：gap 字段存在性/诚实性（telemetry 缺省时 omit 而非 0 假值）；catch 路径 run.json 终态；常量收敛后行为零回归

### Task 4 — e2e 迭代验证 + 附随义务（scripts/smoke-e2e.sh + 白天物证）
- **附随义务（M3 终审）**：白天窗口补跑场景 A——designer 全链 completed 终帧物证（含两轮 designer-plan.json/run.json 留档：--keep-artifacts 开关改造 trap）
- e2e 场景 C（新增）：verifyCommand 端到端——`/loop --effort low 任务 X，验收: <真实可执行的微型命令>`（命令选环境无关的，如 `test -f <dataDir>/runs/*/run.json`？不行——需任务产物语义。用"输出包含关键词"类简单断言命令：`grep -q ... $(ls ...) || echo FAIL` 类）；断言 verified + evaluation.score>0 + 无 critic spawn（效率证据：真实链路中 critic 不 MIX）
- 一轮 fail→二轮 pass 的 e2e（可选——若任务设计可控失败一次，用微型假命令首坏后修复的模式；不可控则降为单测覆盖+说明）
- README M4 段（评估/迭代/verifyCommand 优先级/budget_exhausted 语义）+ gap 表勾销 M4 行
- 单测零破坏（156+ 全绿）

## 验收（SPEC §9 M4 行展开）

1. evaluate fail→注入→重跑→通过：单测全链锁定（T2）+ e2e 场景 verifyCommand 优先级正确（T4）
2. verifyCommand 优先级：存在即机器断言唯一（零 critic spawn 断言，单测+e2e 双证）
3. 诚实遥测：critic/verify 失败绝不自判通过（单测锁定）
4. 预算耗尽如实收尾 budget_exhausted + 最后 evaluation 留档
5. gap 表 M4 行回填 + 终审附随义务完成（白天物证）
6. 既有 156 用例零破坏
