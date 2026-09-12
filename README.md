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
|---|---|---|---|
| low | 1 | 2 | 关闭 |
| medium | 2 | 4 | 手动 |
| high | 3 | 6 | ≥5 新案例提议 |
| max | 5 | 8 | ≥3 新案例提议 |

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
