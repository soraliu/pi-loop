# M5 计划 — 方法论库（Archivist + 案例档案 + 相似检索）

> 依据：docs/SPEC.md §4（Archivist 契约）、§5 数据模型（MethodologyEntry/Case/目录规范）、§9 M5 行："案例入档+相似检索注入 designer；方法库 git 化"。冲突以 SPEC 为准。

## Context

M4 后 pi-loop 会设计/执行/自我修正，但每次 run **都是孤独的**——没有案例记忆、没有方法沉淀、下一次任务从零开始。M5 落地 Archivist 组件与检索注入：**run 终态自动入档 Case + 方法使用统计 + 相似检索注入 designer**——这是自进化记忆的开端（M6 Meta-loop 的数据地基）。同时结算 M4 终审前置清单（M-1 终态判据补丁/README telemetry 句/Case 消费规范 + e2e 硬性验收）。

## 技术锚（M4 终审 M5 前置清单 + SPEC 数据模型）

- SPEC §5 形状：`MethodologyEntry {id, name, appliesTo: {taskTypes, signals[]}, playbook, fitness: {uses, avgScore}, lineage: {parent, diff}}`；`Case {id, task, methodIds[], plan, runId, finalScore, verified, lessons[]}`；`~/.pi/loop/{settings.json, methods/（git 仓库）, cases/, runs/}`
- **Case 消费规范（M4 终审定案）**：plan/evaluation/final 取 run.json 面；"无 final 的 completed"=异常终止
- 检索注入点：M3 时 designer 输入留了"检索(methods×k, cases×k)"接口桩——本里程碑接上
- **M-1 补丁**（M4 终审）：markRunFailedInRunJson 终态判据补 `final !== undefined` 才放过（mid-loop 基建异常陈旧终态窗）——T1 首件
- **e2e 硬性验收**：场景 A 物证 + 场景 C 首跑（依赖 1xtoken 恢复窗口；M5 收官仍不可用则升级用户决策——终审 RULING 原文）

## Global Constraints

- 零新增依赖（检索算法自实现：关键词重叠/加权评分——不引入 BM25 等库）
- **方法库 git 化语义**：`~/.pi/loop/methods/` 内 `git init`（首次入方法时惰性初始化）；每次方法条目新增/修订为一次 commit（lineage.diff 留痕）；**不自动 push**（无远端语义；M6 Meta-loop 的 keep/rollback 用 git revert 语义）
- 诚实遥测延续：fitness 统计只记真实 run 结果（verified 的 case 才计入 avgScore 正向；fail 计入但不增 avgScore 分母？——设计决策：uses++ 恒真、avgScore 累计真实 score 加权，报告口律试锁）
- 读写全部经 storage 层（组件间只通过 SPEC 接口耦合）；测试用临时目录注入（禁真实 ~/.pi/loop）
- 源码注释中文；commit 英文；目录边界：`src/storage/{methods,cases}.ts`（新）、`src/core/retrieval.ts`（新）、`src/core/designer.ts`（注入点最小改）、`src/core/iterate.ts 或 loop-task.ts`（Archivist 接线）、`src/extension/commands.ts`（/loop-cases /loop-methods）、tests/

## Tasks

### Task 1 — 前置补丁 + storage 层（M-1 补丁 + MethodologyEntry/Case 落档 + 方法库 git 化）
- **M-1 首件**: markRunFailed 终态判据 `status 终态 && record.final !== undefined` 才放过（+1 用例：final 缺席的 completed 被收口为 failed）
- README M4 物证段补 telemetry 一句（M-2 债）
- `src/storage/methods.ts`: `listMethods/saveMethodEntry/updateFitness`——方法条目 JSON 文件（`methods/<id>.json`）读写；首次写入时 `git init` + `.gitignore`（无）；每 save/fitness-revision 一次 git commit（message 英文：`methods: <id> <add|fitness update>`）
- `src/storage/cases.ts`: `saveCase/listCases`——Case 文件（`cases/<id>.json`）；`caseFromRunRecord(run.json 读取 → Case)` 转换器（**Case 消费规范落地**：plan/evaluation/final 取 run.json 面；无 final 的 completed → lessons 加"异常终止"标记、verified=false）
- types.ts：MethodologyEntry/Case 类型（SPEC §5 形状；playbook 为 JSON 结构——含 steps 骨架与提示词模板）
- 单测：临时目录全链（方法增改 fitness + git commit 在场断言 `git log` 输出；Case 转换的各终态形态——verified/budget_exhausted/异常终止）
### Task 2 — 相似检索 + designer 注入（检索桩接通）
- `src/core/retrieval.ts`: `retrieve(task, {methods, cases}, k): {methods: MethodologyEntry[], cases: Case[]}`——纯函数评分：任务文本与 appliesTo.signals/taskTypes 的关键词重叠（含中文分词的极简实现：2-gram 重叠计数——不做完整分词器）+ fitness 加权（uses/avgScore 平滑分）；top-k
- designer 注入：generatePlan 的任务文本模板追加"参考方法/案例"段（retrieved 为空时省略——M3 行为完全不变）；注入不改变 schema/重试/降级语义
- 单测：检索评分正确性（信号命中排序/空库零注入/disabled 情形）；注入后 designer prompt 含方法名与案例要点；零检索时 prompt 与 M3 逐字节一致（回归锚）
### Task 3 — Archivist 接线 + 命令
- iterate/loop-task 收尾接线：run 终态（三终点统一）后 `caseFromRunRecord → saveCase` + 方法 fitness 更新（首轮 origin=designer 时 plan.notes 提取 methodId 关联？——设计决策：M5 的 Case.methodIds 记空数组或从 plan 追溯 M6 再接；**v1 记 builtin/designer 二分 origin 即可**，报告定案）
- 环境开关：`PI_LOOP_NO_ARCHIVE=1`（测试/隐私）；入档失败不阻塞主流程（warn 日志——诚实但不破坏）
- `/loop-cases` 与 `/loop-methods` 命令（SPEC §6 用户故事 3）：列表呈现（id/task/verified/score | id/name/uses/avgScore）+ `--limit N`（默认 10）
- 单测：接线三终点入档断言；命令输出格式；开关行为
### Task 4 — e2e 真跑（硬性验收）+ 文档收口
- **e2e 硬性验收**（终审 RULING）：场景 A 物证（KEEP_ARTIFACTS=1——run.json completed 终帧 + designer-plan.json 双档）+ 场景 C 首跑（verifyCommand 全链 verdict=verified）；若模型层仍不可用 → **如实记录并升级用户决策**（不第三次滚动）
- e2e 档案断言扩展：跑完 loop_task 后 `cases/` 出现新 Case、`methods/` git log 有 commit（真实入档链）
- README M5 段 + gap 表 M5 行勾销（dispatchLog 留痕/resultRefs 多产物/plan 全文/字段联动——若 RunRecord 现形状已覆盖则勾销记录，缺的挂 M7）
- 单测零破坏（200+ 全绿）

## 验收（SPEC §9 M5 行展开）

1. 案例入档：run 终态自动 Case 化（三终点+异常终止四形态测试锁定）
2. 相似检索注入 designer：真实链路（e2e 档案断言）+ 检索评分单测
3. 方法库 git 化：commit 留痕断言 + lineage 字段
4. e2e 硬性项：场景 A 物证 + C 首跑（或升级用户决策的如实记录）
5. 既有 200 用例零破坏
