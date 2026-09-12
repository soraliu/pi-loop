# pi-loop

> Loop Engineering 引擎 —— 让 pi harness 面对任意任务自主设计研究方法、调度 subagents、迭代优化结果的扩展，并且能对"研究方法设计"这个流程本身持续自我迭代。

## 这是什么

你指派一个任务（研究、分析、构建皆可），pi-loop：

1. **设计**：检索方法论库与相似历史案例，产出结构化研究计划（`ResearchPlan`：任务分解、subagent 角色与提示词、验证标准、预算）
2. **调度**：通过 pi-subagents 的官方 RPC 通道驱动 subagent 团队执行计划
3. **评估**：可选机器断言（`verifyCommand`，在场即唯一权威）+ critic agent 多维 rubric 打分，失败自动归因
4. **迭代**：不达标时注入失败原因、改良提示词后重跑（预算内）
5. **沉淀**：案例与方法论入档；方法论修订走 git keep/rollback（DGM 选择压力：有证据才保留）

## 安装

```bash
pi install git:github.com/soraliu/pi-loop
```

## 使用

```text
/loop 研究 rust tokio 和 async-std 的调度器差异，产出对比报告     # 交互式启动
/loop --effort max 写一个 redis 简化版并附基准测试                # 激进迭代
/loop --effort low 实现解析工具并补单测 --verify "npm test"      # 机器断言验收（M4，见下文）
/loop-status                                                     # 查看最近运行
/loop-cases                                                      # 查看案例档案
/loop-methods                                                    # 查看方法论库
```

或在会话中直接对 agent 说"用 loop_task 研究并实现 X"，agent 会调用 `loop_task` 工具。

## 激进度预设

`/loop --effort low|medium|high|max`，或 `loop_task` 的 `effort` 参数（全部档位可经
`~/.pi/loop/settings.json` 的 `effortPresets.<档>.*` 深合并覆盖）：

| preset | 结果迭代轮数上限 | 计划步数上限（maxPlanSteps） | 并行 subagents | meta 触发 |
| --- | --- | --- | --- | --- |
| low | 1 | 3 | 2 | 关闭 |
| medium | 2 | 5 | 4 | 手动 |
| high | 3 | 8 | 6 | ≥5 新案例提议 |
| max | 5 | 12 | 8 | ≥3 新案例提议 |

## M2 能力：真实调度已可用

`/loop` 与 `loop_task` 自 M2 起接入**真实调度**：内置静态研究计划 → 经
pi-subagents 的 in-process RPC spawn `researcher` subagent → 完成事件回写
`runs/<id>/run.json`（状态机 `created → running → completed | failed`，含每步
iteration 记录、outputRef 与耗时遥测）。

- **需要 pi-subagents 包**（`pi install npm:pi-subagents`）。宿主没有它时，
  `loop_task` / `/loop` 以 `status=failed` 收尾，error 携带安装引导文案，
  不会挂死或裸崩（RPC 受理超时兜底）。
- 其余失败（模型层熔断/额度/网络）同样收敛为 failed 结果，可从 run.json 审计。
- 尚未接入：案例与方法论实档（M5）——`/loop-cases` 与 `/loop-methods` 仍是
  统计 stub。（动态计划已由 M3 接入、评估与迭代闭环已由 M4 接入，见后续两节）

### 冒烟验证（本地，不入 CI）

| 脚本 | 覆盖 | 前置条件 | 量级 |
| --- | --- | --- | --- |
| `npm run smoke`（`scripts/smoke.sh`，M1） | 结构冒烟：扩展可加载、`loop_task` 可被调用、run id 落盘 | `pi` 命令 | 秒级 |
| `bash scripts/smoke-e2e.sh`（M2 → M4 三场景） | 全链冒烟：场景 A designer 动态计划 + 逐步 spawn；场景 B `maxPlanSteps=1` 预算强制；场景 C `verifyCommand` 机器断言端到端（详见后续小节） | `pi` + `pi-subagents` + 可用模型与额度 + 用户级 researcher agent | 分钟级（三场景） |

两脚本降级语义一致：环境不满足（pi 缺失 / pi-subagents 缺席 / 模型熔断或额度耗尽）
时 `SKIP` / `DEGRADED-PASS` 并 exit 0，只有断言真实失败才 exit 1。
`smoke-e2e.sh` 不隔离 HOME（真实 spawn 需要用户级 agent 定义），但把
`PI_LOOP_DATA_DIR` 指向临时目录——run 落盘隔离，不污染真实 `~/.pi/loop/`。
需要留档物证（终帧 run.json / designer-plan.json）时用
`KEEP_ARTIFACTS=1 bash scripts/smoke-e2e.sh` 运行——退出时保留各场景的
dataDir 与 pi 输出日志并打印路径，默认退出即清理。

### 调试降级：`PI_LOOP_STUB=1`

`PI_LOOP_STUB=1` 强制 `loop_task` / `/loop` 回归 M1 stub 语义：只完成参数校验、
配置解析与 run 骨架落盘，**不 spawn 任何 subagent**。用于无网络/无模型环境下
验证注册与落盘链路，或 CI 快速回归（真实路径由 e2e 冒烟覆盖）。

### M2 验收对照（SPEC §9 第 2 行：`loop_task 硬编码 plan → 真实 spawn researcher → 结果落 RunRecord`）

| 验收项（`docs/plans/m2-orchestrator.md` Task 5） | 覆盖方式 |
| --- | --- |
| 单测全绿（fake 总线全覆盖 RPC 协议路径） | `npm test`（CI） |
| smoke-e2e 真实跑通 spawn→完成→RunRecord 落盘（环境受限时明确 SKIP） | `bash scripts/smoke-e2e.sh`（本地，见上表） |
| `PI_LOOP_STUB=1` 降级回归 M1 行为 | `npm test` 内 M1 stub 用例 + `PI_LOOP_STUB=1 npm run smoke` |
| `npm run typecheck` && `npm test` 零错误 | CI 保持不变（e2e 不入 CI） |

## M3 能力：方法设计器（Designer）动态计划

`/loop` 与 `loop_task` 自 M3 起不再依赖静态计划：每次运行先由 **Designer** 动态生成
`ResearchPlan`（M3 阶段由 `researcher` 兼任设计角色——无独立 designer agent 定义），
再交调度内核逐层执行。

- **任意任务 → 动态计划**：任务原文 + 预算约束（`maxPlanSteps` 步数硬顶 /
  `maxParallelSubagents` 并行上限）注入设计提示词，产出结构化计划（步骤 id /
  角色 / 自包含提示词 / 依赖 DAG），无论任务多复杂都无需人工预设流程。
- **schema 校验与重试**：产物经防御解析（原型污染键剔除）+ schema 形状 + 结构语义
  （id 唯一 / 依赖不悬空 / 无环 / 步数越界）三重校验；失败自动重试（≤2 次，重试文本
  附具体校验错误）。运行时唯一新增依赖 `@sinclair/typebox`。
- **双通道产物**：设计 agent 把计划 JSON 写入 `runs/<id>/designer-plan.json`
  （主通道）；完成回复正文中的 JSON 围栏副本作兜底（次通道）。采纳的通道如实记入
  `plan.channel`（`file` / `fence`）。
- **降级语义（诚实遥测）**：校验重试耗尽 / spawn 受理失败 / 完成等待超时 → 回落
  内置单步计划照常执行，`run.json` 的 `plan` 字段如实标注：`origin: "builtin"` +
  `degraded: true` + 降级原因（`notes`）+ 通道与尝试次数（`channel` / `attempts`）
  ——降级禁止冒充正常生成（SPEC §7.4）。

### 预算硬上限（SPEC §7.3）

计划步数超顶即**拒绝执行整个计划**（`budget_exhausted` 如实报告，不静默截断）；
层内并发超上限自动分批（批内并行、批间串行、某批失败不开下批）。两道闸都由
`executePlan` 在执行层强制（designer/schema 侧已先行校验）：

| preset | maxPlanSteps（步数硬顶） | maxParallelSubagents（层内并发上限） |
| --- | --- | --- |
| low | 3 | 2 |
| medium | 5 | 4 |
| high | 8 | 6 |
| max | 12 | 8 |

档位可用 `~/.pi/loop/settings.json` 的 `effortPresets.<档>.*` 深合并覆盖，例如
`{"effortPresets": {"low": {"maxPlanSteps": 1}}}`（e2e 冒烟场景 B 即用此法
注入强制路径；实现语义见上表）。

## M4 能力：评估与迭代闭环（Evaluator）

`/loop` 与 `loop_task` 自 M4 起不再一次成败听天由命：每轮执行完成后先评估，未达
标自动注入失败归因重跑（预算内），通过或预算耗尽才收尾——SPEC §4 的
evaluate → 注入 → 重跑 闭环落地。

- **双通道评估（互斥，verifyCommand 优先）**：`verifyCommand` 在场即机器断言唯一
  权威——命令经安全分词（无 shell 语法，未闭合引号拒收）后在 dataDir 工作区执行
  （cwd 隔离，SPEC §7.5），exit 0 → verified（stdout 含 `2/3 passed` 类计数时按
  比例计分，否则满分 100），非 0 → fail（退出码与 stderr 尾部如实入 reasons；
  超时 60s 同样 fail）；未提供时才 spawn critic（`researcher` 兼任）依据任务原文
  与各步执行记录做 rubric 打分。verifyCommand 在场零 critic spawn——效率语义由
  单测锁定，e2e 冒烟场景 C 端到端复核。
- **诚实遥测（SPEC §7.4）**：evaluator 自身的任何故障（命令超时/不存在/语法错、
  critic spawn 失败/围栏解析失败）一律收敛为 fail + 原因如实——绝不因"拿不到
  证据"而自判通过。
- **归因注入重跑（最小注入面）**：critic 指认的失败步骤（blame）在下一轮的提示词
  前缀注入上轮失败原因，原计划保留；verifyCommand 通道 blame 恒空（退出码断言无
  轮次归因概念），重跑为原样重跑。连续两轮全部步骤同因失败才触发重新设计计划
  （fresh 计划不注入——单一失败轮不重设计，防设计漂移）。
- **预算耗尽如实收尾**：迭代轮数达 `maxResultIterations`（low=1 … max=5，见
  预设表）仍未通过 → 结果 `status="budget_exhausted"`，error 如实说明轮数与末轮
  结论，最后一轮 `evaluation` 与 `final` 留档——partial/fail 不丢、不虚报通过。
- **物证留档**：run.json 新增 `round`（当前轮）、`evaluation`（最终轮结论：
  verdict / score / reasons / blame）与 `final`（收尾摘要：round / verdict /
  score）；工具结果与 `/loop` 收尾通知同步携带 evaluation 摘要。

`/loop --verify`（等价于 `loop_task` 的 `verifyCommand` 入参）用法：

```text
/loop --effort low 实现工具函数并补单测 --verify "npm test"   # 退出码即验收结论
```

## 开发

```bash
git clone https://github.com/soraliu/pi-loop
cd pi-loop && npm install && npm test
pi -e .          # 本地开发模式加载
```

- 规格书（权威）：`docs/SPEC.md`
- 里程碑计划：`docs/plans/`
- 开发流程：SDD（subagent-driven development），每个 milestone 一个独立 PR

## License

MIT
