// loop_task 的执行核心（M1-T4 stub → M2-T4 真实调度内核接入 → M3-T4 designer 接线）
// 工具（loop_task）与命令（/loop）共享同一入口——单一事实源，保证两边行为一致。
// 双行为分派：PI_LOOP_STUB=1 保留 M1 stub 语义（冒烟/降级/回归）；缺省走真实调度——
// 三步链（配置快照 → 建工作区 → 落 run.json）之后构造 SubagentsRpcClient，先经
// generatePlan 动态生成研究计划（researcher 兼任 designer；降级=内置计划照跑，
// M2 的 BUILTIN_PLAN 直执行路径是降级链的末端特例），DesignerOutcome 全量映射落入
// RunRecord.plan，再经 executePlan 按预设预算（maxPlanSteps/maxParallelSubagents）
// 逐步 spawn。runLoopTaskStub 仍是 stub 分支的实现体（M1 直呼它的既有用例原样有效）。

import * as fs from "node:fs";
import * as path from "node:path";

import {
  executePlan,
  type PlanUpdate,
  type RunOutcome,
} from "../core/orchestrator.ts";
import { generatePlan, type DesignerOutcome } from "../core/designer.ts";
import { SubagentsRpcClient, type SubagentEventBus } from "../core/rpc.ts";
import {
  DEFAULT_EFFORT_LEVEL,
  isEffortLevel,
  loadLoopSettings,
} from "../storage/settings.ts";
import {
  createRunRecord,
  defaultDataDir,
  ensureWorkspace,
  type RunRecord,
} from "../storage/workspace.ts";
import type {
  EffortPreset,
  LoopPlanBrief,
  LoopToolParams,
  LoopToolResult,
  RunPlanInfo,
} from "../types.ts";

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

/** PI_LOOP_STUB=1 → true（stub 双行为开关：冒烟/降级用，M1 用例的回归口径） */
function isStubMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_LOOP_STUB?.trim() === "1";
}

/** 三步链的公共产物：两条路径（stub / 真实调度）共享的配置快照与 run 骨架 */
interface PreparedRun {
  /** 数据根目录（run.json 与 settings.json 同根） */
  dataDir: string;
  /** 生效预设快照（settings.json 覆盖优先；审计"当时允许了几轮迭代"） */
  preset: EffortPreset;
  /** 已落盘的 run 骨架（status=created，真实路径由此续跑） */
  record: RunRecord;
}

/**
 * 三步链（brief 锚定，M1 原序保持）：校验入参 → 加载生效配置 → 建工作区 → 落 run.json。
 * 预设表以 loadLoopSettings 的结果为 先（settings.json 覆盖生效），缺省回落 DEFAULT 表。
 * @throws TypeError 当 task 缺失或 effort 非法时（调用方负责转为 error content / notify）
 */
function prepareRun(params: LoopToolParams): PreparedRun {
  validateLoopParams(params);
  const dataDir = resolveDataDir();
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
  return { dataDir, preset, record };
}

/**
 * loop_task 的 stub 执行链（M1 语义原样保留：不执行任何调度，只完成记录与配置解析）。
 * PI_LOOP_STUB=1 时 runLoopTask 委派到本函数；M1 既有用例继续直呼本函数。
 */
export function runLoopTaskStub(params: LoopToolParams): LoopToolResult {
  const { preset, record } = prepareRun(params);
  return {
    status: "stub",
    runId: record.id,
    effort: record.effort,
    preset,
    telemetry: {
      steps: 0,
      succeeded: 0,
      failed: 0,
      iterations: 0,
      durationMs: 0,
    },
    summary: `已创建运行记录 ${record.id}（stub：调度引擎在 M2 接入）`,
  };
}

/** runLoopTask 的注入面：宿主能力由工具/命令层传入，测试全部可注入 fake */
export interface RunLoopTaskOptions {
  /**
   * 宿主事件总线（pi.events 的结构形状）。调度经它走 pi-subagents 的 RPC 协议；
   * 缺省无总线时无从应答——真实路径以超时失败收尾并附安装引导
   * （与 pi-subagents 未安装同一语义）。
   */
  busEnv?: SubagentEventBus;
  /** 进度回调（原样透传给 executePlan 的 onUpdate） */
  onUpdate?: (update: PlanUpdate) => void;
  /** 中止信号（原样透传给 executePlan 的 signal） */
  signal?: AbortSignal;
  /** spawn 受理等待上限毫秒（缺省 10s；测试注入缩短以快速走完缺席分支） */
  rpcTimeoutMs?: number;
}

/** spawn 受理超时上限：真实受理是 in-process RPC（毫秒级），上限只兜 pi-subagents 缺席/卡死 */
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/** 无总线时的兜底：emit 无人应答（必然超时），on 注册即弃（返回空卸载函数） */
const DEAD_BUS: SubagentEventBus = {
  emit: () => undefined,
  on: () => () => undefined,
};

/**
 * orchestrator 受理失败后缀的稳定标记：把「pi-subagents 缺席」从普通步骤失败中
 * 区分出来，改造为含安装命令的完整引导（与 core/orchestrator.ts 的文案须同步演进）。
 */
const RPC_ABSENT_MARK = "pi-subagents 不在或不可用";

/** pi-subagents 缺席时的失败引导文案（brief 指定，含安装命令） */
const RPC_INSTALL_GUIDANCE =
  "pi-subagents 不在或不可用——请安装 pi-subagents（pi install npm:pi-subagents）后重试";

/** DesignerOutcome → RunRecord.plan 的全量映射（诚实遥测：designer 元信息全量入档；
 * notes 仅在计划携带时在场，保持字段语义最小） */
function planInfoFromOutcome(designed: DesignerOutcome): RunPlanInfo {
  const info: RunPlanInfo = {
    origin: designed.plan.origin,
    steps: designed.plan.steps.length,
    degraded: designed.degraded,
    channel: designed.channel,
    attempts: designed.attempts,
  };
  if (designed.plan.notes !== undefined) info.notes = designed.plan.notes;
  return info;
}

/**
 * 把计划元信息并入 run.json（落盘时机：generatePlan 返回即写——执行中 orchestrator
 * 的读写不触碰 plan 字段，终态 run.json 与此一致）。读改写而非内存重写：磁盘是
 * 事实源（口径同 orchestrator 的 loadRunRecord；createRunRecord 与此处之间无其他写入方）。
 * 由调用方保证 run.json 已存在（prepareRun 的第三步已建骨架）。
 */
function recordPlanInRunJson(
  dataDir: string,
  runId: string,
  plan: RunPlanInfo,
): void {
  const file = path.join(dataDir, "runs", runId, "run.json");
  const record = JSON.parse(fs.readFileSync(file, "utf-8")) as RunRecord;
  record.plan = plan;
  fs.writeFileSync(file, JSON.stringify(record, null, "\t") + "\n");
}

/** 真实路径的 LoopToolResult 构造：遥测/迭代数按 RunOutcome 落真值，失败附可读原因 */
function buildRealResult(
  prep: PreparedRun,
  outcome: RunOutcome,
  planSummary?: LoopPlanBrief,
): LoopToolResult {
  const completed = outcome.failed === 0 && outcome.succeeded === outcome.steps;
  const failures = outcome.iterations
    .filter((entry) => entry.status === "failed")
    .map((entry) => entry.error)
    .filter((message): message is string => message !== undefined);
  // 错误优先级：pi-subagents 缺席标记（spawn 超时类 step 错误）→ 首个 step 级失败原因 →
  // run 级镜像（预算拒绝的 "budget_exhausted: …" 文案透传 / 中止的 "aborted"——M3-T4）
  const error = failures.some((message) => message.includes(RPC_ABSENT_MARK))
    ? RPC_INSTALL_GUIDANCE
    : (failures[0] ?? outcome.error);
  const result: LoopToolResult = {
    status: completed ? "completed" : "failed",
    runId: prep.record.id,
    effort: prep.record.effort,
    preset: prep.preset,
    telemetry: {
      steps: outcome.steps,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      iterations: outcome.iterations.length,
      durationMs: outcome.durationMs,
    },
    summary: completed
      ? `任务完成：${outcome.succeeded}/${outcome.steps} 步成功，耗时 ${outcome.durationMs}ms`
      : `任务失败：${outcome.failed} 步未通过，耗时 ${outcome.durationMs}ms（详情见 run.json）`,
    ...(planSummary === undefined ? {} : { plan: planSummary }),
  };
  if (error !== undefined) result.error = error;
  return result;
}

/**
 * loop_task 的统一执行入口（工具与命令共用；M2-T4 起缺省为真实调度）。
 * - PI_LOOP_STUB=1 → M1 stub 行为（runLoopTaskStub，断言语义不变）
 * - 缺省 → 三步链 → 构造 SubagentsRpcClient → generatePlan（designer
 *   三态：成功 / 校验重试耗尽降级 / rpc 层失败降级——均不抛出，内置计划照跑）→
 *   plan 元信息入档 → executePlan(plan, budget)
 * 调度失败收敛为 status=failed 的结果（error 携带可读原因；step 级细节落 run.json），
 * 不向宿主抛裸异常。
 * @throws TypeError 当 task 缺失或 effort 非法时（调用方负责转为 error content / notify）
 */
export async function runLoopTask(
  params: LoopToolParams,
  opts: RunLoopTaskOptions = {},
): Promise<LoopToolResult> {
  if (isStubMode()) return runLoopTaskStub(params);
  const prep = prepareRun(params);
  const rpc = new SubagentsRpcClient(opts.busEnv ?? DEAD_BUS, {
    defaultTimeoutMs: opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
  });
  let outcome: RunOutcome;
  /** 已确定的计划摘要（catch 分支的诚实补档：执行链异常时也带上已知的计划元信息） */
  let planSummary: LoopPlanBrief | undefined;
  try {
    // ① Designer 先行：动态生成研究计划（降级由其内部完成且不抛出——再做二保险
    // 只会掩盖真实行为；rpc 层 spawn 失败/等待超时/校验耗尽均收敛为 builtin 产物）
    const designed = await generatePlan(params.task, prep.preset, {
      rpc,
      runId: prep.record.id,
      dataDir: prep.dataDir,
      signal: opts.signal,
    });
    planSummary = {
      origin: designed.plan.origin,
      steps: designed.plan.steps.length,
      degraded: designed.degraded,
    };
    // ② 元信息落盘（generatePlan 返回即写；执行中记录的其余字段归 orchestrator 管）
    recordPlanInRunJson(
      prep.dataDir,
      prep.record.id,
      planInfoFromOutcome(designed),
    );
    // ③ 执行：预算从生效档位原样派生（步数硬顶 + 层内并发钳制，T3 双闸）
    outcome = await executePlan(designed.plan, {
      rpc,
      runId: prep.record.id,
      dataDir: prep.dataDir,
      onUpdate: opts.onUpdate,
      signal: opts.signal,
      budget: {
        maxPlanSteps: prep.preset.maxPlanSteps,
        maxParallelSubagents: prep.preset.maxParallelSubagents,
      },
    });
  } catch (error) {
    // 基建类异常（executePlan/designer 已各自完成降级路径后仍上抛的磁盘/run.json
    // 类异常——executePlan 已把 run 标 failed 后上抛）：统一收敛为 failed 结果，
    // 错误详情仍可经 error 字段与 run.json 审计，不向宿主抛裸异常
    const message = error instanceof Error ? error.message : String(error);
    const failed: LoopToolResult = {
      status: "failed",
      runId: prep.record.id,
      effort: prep.record.effort,
      preset: prep.preset,
      telemetry: {
        steps: 0,
        succeeded: 0,
        failed: 0,
        iterations: 0,
        durationMs: 0,
      },
      summary: `任务失败（执行链异常）：${message}`,
      error: message,
      ...(planSummary === undefined ? {} : { plan: planSummary }),
    };
    return failed;
  }
  const result = buildRealResult(prep, outcome, planSummary);
  // 无 entry 落痕的中止（层间检查点）在 run 级已记 error="aborted"，
  // 结果侧同步补上（有 entry 时 failures 已带出，不覆盖；outcome.error 镜像
  // 在场时同值——此处为防御性双保险，不产生分歧）
  if (
    result.status === "failed" &&
    opts.signal?.aborted &&
    result.error === undefined
  ) {
    result.error = "aborted";
  }
  return result;
}

/** PlanUpdate → 人类可读单行（工具 onUpdate 的 content 与命令 notify 共用同款文案） */
export function describeStepUpdate(update: PlanUpdate): string {
  const labels: Record<PlanUpdate["status"], string> = {
    pending: "已受理",
    running: "开始执行",
    succeeded: "执行完成",
    failed: "执行失败",
  };
  const base = `[loop] 步骤 ${update.stepId}（${update.agent}）${labels[update.status]}`;
  return update.summary === undefined ? base : `${base}：${update.summary}`;
}
