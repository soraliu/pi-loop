# M2 计划 — 调度内核（Orchestrator）

> 依据：docs/SPEC.md §4（Orchestrator 契约）、§9 M2 行。本计划是 SPEC 的论证；冲突以 SPEC 为准。

## Context

M1 交付的 `runLoopTaskStub` 是占位：加载设置→建工作区→写 run.json→返回 stub 结果。M2 把内核换成真实的：通过 pi-subagents 的官方 in-process RPC（事件总线协议）调度 subagent 执行**内置静态研究计划**，结果与遥测回写 RunRecord。这是 SPEC §4 图中 Orchestrator 组件的首次落地；PlanCompiler 接口为 M3 的动态 Designer 预留。

## 技术锚（pi-subagents 官方 extension API，唯一权威）

- 就绪信号：`subagents:rpc:v1:ready` 事件（探测 pi-subagents 在场）
- 请求：`pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params })`
- 回复：监听 `subagents:rpc:v1:reply:<requestId>` → `{ version: 1, requestId, success: true, data } | { success: false, error: {code, message} }`
- `spawn` 方法：`params: { workflowScript | (agent + task), context: "fresh" }`，**async-only**（reply 返回的是启动受理，完成由异步事件通告 `asyncComplete` capability）
- 方法集：`ping`（capability 探测）/`spawn`/`status`/`stop` 等（M2 只用 ping + spawn + stop）

## Global Constraints

- 零 runtime 依赖；devDeps 不增
- RPC 客户端必须容错：pi-subagents 不在场（超时无 reply / 无 ready 事件）→ 明确失败态 + 引导文案（"请安装 pi-subagents"），不得挂死或裸崩
- workflowScript 只做受控拼接：agent 名/任务文本等插值必须 JSON 转义（JSON.stringify 后注入），防脚本注入
- RunRecord.iterations 从 `unknown[]` 升级为结构化 `IterationEntry[]`（T2 review 预期兑现）
- spawn 不指定 model（继承会话默认——用户规则）；plan 数据结构里预留 model 字段但 M2 全部省略
- 源码注释中文；commit message 英文；目录边界：`src/core/`、`src/extension/`（改造）、`tests/`
- 测试全部用 fake 事件总线 / fake RPC（不真 spawn）；真实 spawn 只在 T5 冒烟，且带额度降级 SKIP 语义

## Tasks

### Task 1 — RPC 客户端（src/core/rpc.ts）
- `SubagentsRpcClient`：构造注入 `{emit, on}`（宿主 pi.events 的形状；沿用 M1 本地结构接口模式）
- `request(method, params, timeoutMs)`：UUIDv4 requestId、emit 请求、on 对应 reply、超时 reject、success 解包 data / 失败抛 error
- `ping(capabilities 声明)` 与 `spawn(params)` 便捷方法；`stop(id)`
- 完成事件：订阅 async 完成通知（capability `asyncComplete` 时的事件流向按实际协议实现；文档未明确处按 reply 语义做防御性双通道）
- 单测：fake 总线——正常 reply / 超时 / success:false / 多请求并发不串线

### Task 2 — 静态计划与编译器（src/core/planner-static.ts + types 扩展）
- `PlanDraft` 类型：`{ steps: [{ id, agent, task, dependsOn: string[], model? }] }`（model M2 不用）
- `BUILTIN_PLAN(task): PlanDraft`：内置"标准研究"静态计划——单步 researcher（M2 最小闭环主线）+ 结构上明确支持多步（编译器必须处理 DAG）
- `compileWorkflowScript(plan): string`：DAG → 合法 workflowScript（无用例路径的降级：单步直接 `runs.run`；M2 只需单步执行正确，DAG 编译的图逻辑按拓扑序 runs.all 展开，多步正确性以单元断言为准不要求真跑）
- RunRecord.iterations 类型升级为 `IterationEntry[]`（entry：stepId、agent、状态、输出引用、开始/结束时间）；迁移现有写入点（含 run.json 骨架与测试）
- 单测：编译产物字符串关键断言（runs.run 存在、agent/task 已转义、JSON 注入不可逃逸——用含引号/反引号的任务文本做攻击样例）

### Task 3 — Orchestrator（src/core/orchestrator.ts）
- `executePlan(plan, ctx)`：ctx = { rpc, runId, dataDir, onUpdate?, signal? }
- 每步 spawn → 迭代 entry 追加（先 pending 置 running，完成置 succeeded/failed）；onUpdate 透传 { stepId, agent, status, 摘要 }；RunRecord 整体状态流转 created→running→(completed|failed)；遥测汇总 { steps, agents, durationMs }
- 失败策略（M2 极简）：任一步失败 → 整个 run failed，错误信息入 entry；不做重试（M4 的迭代域）
- 手工 stop（signal abort）→ rpc.stop + run 标 failed("aborted")
- 单测：fake RPC 各路径——成功全链（3 步 DAG）、中步失败、pi-subagents 缺席（超时）、abort

### Task 4 — runLoopTask 内核替换（src/extension/loop-task.ts + tools/commands）
- stub → `executePlan(BUILTIN_PLAN(task))`；工具 execute 与 /loop 命令经 onUpdate 投递进度（工具用 onUpdate 回调，命令用 ctx.ui.notify——命令侧节流：每步一条）
- LoopToolResult 落真值：status completed/failed + 遥测 + iterations 数；`PI_LOOP_STUB=1` env 保留 stub 路径（冒烟/降级）
- pi-subagents 缺席时的失败态文案引导安装
- 单测：与 M1 相同 double（fake pi 捕获注册 + fake RPC），断言真实路径与 PI_LOOP_STUB 双行为

### Task 5 — 端到端冒烟 + 文档
- `scripts/smoke-e2e.sh`：真实 pi 宿主加载扩展 + loop_task 触发（真实 spawn researcher 跑 "回复一句话总结 pi-loop 是什么" 类微型任务）→ 断言 run.json status=completed 且 iterations 有输出引用；降级链（模型熔断/额度耗尽/pi-subagents 缺席）→ SKIP 语义 exit 0 并注明原因
- README：M2 能力段（真实调度的 /loop 已可用——注明需 pi-subagents 包）
- CI 保持 typecheck+test（e2e 不入 CI，本地脚本）

## 验收（SPEC §9 M2 行展开）
1. 单测全绿（fake 总线全覆盖 RPC 协议路径）
2. smoke-e2e 在有 pi-subagents 的宿主上真实跑通一次 spawn→完成→RunRecord 落盘（或环境受限时明确 SKIP 计数）
3. `PI_LOOP_STUB=1` 降级路径回归 M1 行为
4. `npm run typecheck` && `npm test` 零错误
