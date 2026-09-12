# pi-loop

> Loop Engineering 引擎 —— 让 pi harness 面对任意任务自主设计研究方法、调度 subagents、迭代优化结果的扩展，并且能对"研究方法设计"这个流程本身持续自我迭代。

## 这是什么

你指派一个任务（研究、分析、构建皆可），pi-loop：

1. **设计**：检索方法论库与相似历史案例，产出结构化研究计划（`ResearchPlan`：任务分解、subagent 角色与提示词、验证标准、预算）
2. **调度**：通过 pi-subagents 的官方 RPC 通道驱动 subagent 团队执行计划
3. **评估**：critic agent 多维 rubric 打分 + 可选机器断言（`verifyCommand`），失败自动归因
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
/loop-status                                                     # 查看最近运行
/loop-cases                                                      # 查看案例档案
/loop-methods                                                    # 查看方法论库
```

或在会话中直接对 agent 说"用 loop_task 研究并实现 X"，agent 会调用 `loop_task` 工具。

## 激进度预设

`/loop --effort low|medium|high|max`，或 `loop_task` 的 `effort` 参数：

| preset | 结果迭代轮数上限 | 并行 subagents | meta 触发 |
| --- | --- | --- | --- |
| low | 1 | 2 | 关闭 |
| medium | 2 | 4 | 手动 |
| high | 3 | 6 | ≥5 新案例提议 |
| max | 5 | 8 | ≥3 新案例提议 |

## M2 能力：真实调度已可用

`/loop` 与 `loop_task` 自 M2 起接入**真实调度**：内置静态研究计划 → 经
pi-subagents 的 in-process RPC spawn `researcher` subagent → 完成事件回写
`runs/<id>/run.json`（状态机 `created → running → completed | failed`，含每步
iteration 记录、outputRef 与耗时遥测）。

- **需要 pi-subagents 包**（`pi install npm:pi-subagents`）。宿主没有它时，
  `loop_task` / `/loop` 以 `status=failed` 收尾，error 携带安装引导文案，
  不会挂死或裸崩（RPC 受理超时兜底）。
- 其余失败（模型层熔断/额度/网络）同样收敛为 failed 结果，可从 run.json 审计。
- 尚未接入：动态计划（Designer，M3）、失败归因与迭代重跑（M4）、案例与方法论实档（M5）
  ——`/loop-cases` 与 `/loop-methods` 仍为统计 stub。

### 冒烟验证（本地，不入 CI）

| 脚本 | 覆盖 | 前置条件 | 量级 |
| --- | --- | --- | --- |
| `npm run smoke`（`scripts/smoke.sh`，M1） | 结构冒烟：扩展可加载、`loop_task` 可被调用、run id 落盘 | `pi` 命令 | 秒级 |
| `bash scripts/smoke-e2e.sh`（M2） | 全链冒烟：真实宿主 → `loop_task` → 真实 spawn researcher → `run.json` 终态 `completed` | `pi` + `pi-subagents` + 可用模型与额度 + 用户级 researcher agent | 分钟级 |

两脚本降级语义一致：环境不满足（pi 缺失 / pi-subagents 缺席 / 模型熔断或额度耗尽）
时 `SKIP` / `DEGRADED-PASS` 并 exit 0，只有断言真实失败才 exit 1。
`smoke-e2e.sh` 不隔离 HOME（真实 spawn 需要用户级 agent 定义），但把
`PI_LOOP_DATA_DIR` 指向临时目录——run 落盘隔离，不污染真实 `~/.pi/loop/`。

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
