# M1 计划 — 扩展壳（Skeleton）

> 依据：docs/SPEC.md §6（交互面）、§5（存储）、§9 M1 行。本计划是 SPEC 的论证；冲突以 SPEC 为准。

## Context

pi-loop 需要一个可加载、可安装的扩展骨架：工具与命令先以**契约完整、实现 stub** 的形态注册（参数 schema 按最终形态设计，返回占位结构），工作区与配置/预设表落地，为 M2（调度内核）提供稳定挂点。本里程碑不含任何 subagents 交互。

## Global Constraints

- TypeScript ESM（`"type": "module"`），面向 pi 0.85+ 的 `ExtensionAPI`（`@earendil-works/pi-coding-agent` 类型，仅类型导入，不打包进产物）
- 零 runtime 依赖；devDependencies 允许 typescript / vitest / 同步用 `@sinonjs/typebox`（pi registry 同名 API 的本地类型源）
- 所有源码注释、文档一律中文；commit message 用英文
- 目录边界：`index.ts`、`src/extension/`、`src/storage/`、`src/types.ts`、`tests/`、`docs/`；不得新建 SPEC 之外的行为
- 每个导出符号有对应测试；`npm test` 必须全绿；`pi -e .` 冒烟通过（smoke 脚本固化在 `scripts/smoke.sh`）
- 所有对 `~/.pi/loop/` 的写入幂等、可重入；测试中用临时目录注入（不得写真实 `~/.pi/loop/`）

## Tasks

### Task 1 — 包骨架与工具链
- `package.json`（name: pi-loop, type: module, exports: "." => ./index.ts; devDeps + scripts: test/typecheck/smoke）
- `tsconfig.json`（strict, ES2022, moduleResolution bundler）
- `vitest.config.ts`、`.gitignore`（node_modules/dist/.pi-loop-test 等）
- `npm run typecheck` 通过空实现跑绿

### Task 2 — 类型与预设表（src/types.ts + src/storage/settings.ts）
- `EffortLevel`、`LoopToolParams`、`LoopToolResult`（含 telemetry/stub 预留字段）、`RunSummary` 类型
- `DEFAULT_EFFORT_PRESETS` 常量（SPEC §6 表格数据）+ `resolveEffort(input?): EffortPreset`（合法输入校验，非法值抛错并列举合法值）
- settings 加载/合并：`loadLoopSettings(dataDir)` 读 `~/.pi/loop/settings.json`（存在则深合并覆盖预设；损坏时回退默认并告警）
- 单元测试覆盖：默认值、自定义覆盖、非法 effort、损坏 settings 回退

### Task 3 — 工作区管理（src/storage/workspace.ts）
- `ensureWorkspace(dataDir?)`：创建 `~/.pi/loop/{runs,cases,methods}`；幂等；返回根路径；自定义 dataDir 用于测试
- `createRunRecord(dataDir, taskText, effort)`：生成 `runs/<id>/run.json` 骨架（id 格式 `r-<epoch36>`）；返回记录对象
- 单元测试：目录创建幂等、run.json 初值内容、隔离的临时目录两次创建

### Task 4 — loop_task 工具与 /loop 命令（src/extension/tools.ts + commands.ts + index.ts）
- `registerLoopTools(pi)`：注册 `loop_task` 工具——参数 schema 与 SPEC §6 完全一致（task 必填、effort/verifyCommand/contextPaths 可选）；execute 先 `loadLoopSettings`+`ensureWorkspace`+`createRunRecord`，再返回占位结果（`status: "stub"`、含 run id、读取到的 preset 快照），不执行任何调度
- `registerLoopCommands(pi)`：`/loop`（解析 `--effort/--verify/--context`，显示解析结果与"stub"提示）、`/loop-status`（显示最近 run 列表，读 runs 目录）、`/loop-cases`、`/loop-methods`（均 stub 视图，显示目录统计）
- `index.ts` 默认导出组装（注入各注册器；`PI_LOOP_DATA_DIR` 环境变量可覆盖 dataDir，冒烟/测试用）
- 单元测试：工具参数校验（缺 task 报错、effort 非法报错）、run.json 确已落盘、/loop 命令解析（--effort max --verify "npm test" 等）

### Task 5 — 冒烟脚本与 README 对齐
- `scripts/smoke.sh`：在一个隔离 `HOME` 下以 `pi -e <repo> -p "调用 loop_task 工具,任务:hello stub,effort:low"` 验证工具出现在输出/无加载错误（退出码 0 断言），可跳过条件：`command -v pi`
- README 首页与 SPEC 的安装/使用段一致（如有偏差以 SPEC 修正 README）
- `.github/workflows/ci.yml`：node 20 + `npm ci && npm run typecheck && npm test`

## 验收

1. `npm test` 全绿；`npm run typecheck` 无错误
2. `./scripts/smoke.sh` 退出码 0（无 pi 环境时显式 SKIP 而非失败）
3. `pi -e .` 手动加载：`/loop --effort high demo` 显示解析结果；`loop_task` 被调用后 `~/.pi/loop/runs/`（或测试目录）出现 run.json
4. 全部代码无 runtime 依赖：`node -e "require('./package.json')"` 的 dependencies 字段为空
