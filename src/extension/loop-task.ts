// loop_task 的 stub 执行核心（M1-T4）
// 工具（loop_task）与命令（/loop）共享同一入口——单一事实源，保证两边行为一致。
// M2 调度内核接入后，本文件的 stub 实现将被真实执行链替换，函数签名保持稳定。

import {
  DEFAULT_EFFORT_LEVEL,
  isEffortLevel,
  loadLoopSettings,
} from "../storage/settings.ts";
import {
  createRunRecord,
  defaultDataDir,
  ensureWorkspace,
} from "../storage/workspace.ts";
import type { LoopToolParams, LoopToolResult } from "../types.ts";

/** 解析数据根目录：环境变量 PI_LOOP_DATA_DIR 优先（冒烟/测试注入用），缺省 ~/.pi/loop/ */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_LOOP_DATA_DIR?.trim() || defaultDataDir();
}

/** LoopToolParams 的运行时校验（工具入参经 typebox 校验后仍需业务校验的部分） */
export function validateLoopParams(params: LoopToolParams): void {
  if (typeof params.task !== "string" || params.task.trim().length === 0) {
    throw new TypeError("task 参数必填且不能为空白字符串");
  }
}

/**
 * loop_task 的 stub 执行链（M1 阶段：不执行任何调度，只完成记录与配置解析）。
 * 流程：校验入参 → 加载生效配置 → 解析 effort 预设 → 建工作区 → 落 run.json → 返回占位结果。
 * 预设表以 loadLoopSettings 的结果为 先（settings.json 覆盖生效），缺省回落 DEFAULT 表。
 * @throws TypeError 当 task 缺失或 effort 非法时（调用方负责转为 error content / notify）
 */
export function runLoopTaskStub(params: LoopToolParams): LoopToolResult {
  validateLoopParams(params);
  const dataDir = resolveDataDir();
  // 三步链路（brief 明文）：加载生效配置 → 建工作区 → 落 run.json
  const settings = loadLoopSettings(dataDir);
  ensureWorkspace(dataDir);
  // 档位名解析：缺省回落默认档；非法值报错（含四合法值提示）
  const level = params.effort ?? DEFAULT_EFFORT_LEVEL;
  if (!isEffortLevel(level)) {
    throw new TypeError(
      `effort 非法：${String(level)}（合法值：${["low", "medium", "high", "max"].join(" / ")}）`,
    );
  }
  // 预设取生效表（settings.json 覆盖优先），而非 DEFAULT 直取
  const preset = settings.effortPresets[level];
  const record = createRunRecord(dataDir, params.task, level);
  return {
    status: "stub",
    runId: record.id,
    effort: record.effort,
    preset,
    telemetry: { agents: 0, turns: 0, durationMs: 0 },
    summary: `已创建运行记录 ${record.id}（stub：调度引擎在 M2 接入）`,
  };
}
