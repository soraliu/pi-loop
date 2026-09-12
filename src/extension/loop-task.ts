// loop_task 的执行核心（M1-T4 stub → M2-T4 真实调度内核接入 → M3-T4 designer 接线
// → M4-T0 债务收口 → M4-T2 迭代闭环接线）
// 工具（loop_task）与命令（/loop）共享同一入口——单一事实源，保证两边行为一致。
// 双行为分派：PI_LOOP_STUB=1 保留 M1 stub 语义（冒烟/降级/回归）；缺省走真实调度——
// 三步链（配置快照 → 建工作区 → 落 run.json）之后构造 SubagentsRpcClient，交
// runWithIterations 迭代闭环（designer 降级 builtin 照常进循环；execute → evaluate
// → fail/partial 注入归因重跑 → verified 或预算尽 budget_exhausted 如实收尾），
// DesignerOutcome 全量映射经 adapter 落 RunRecord.plan（首轮与重设计各一次）。
// LoopToolResult 三态收口：completed（verified）/ budget_exhausted / failed +
// evaluation 摘要字段。runLoopTaskStub 仍是 stub 分支的实现体（M1 直呼它的既有用例
// 原样有效）。

import * as fs from "node:fs";
import * as path from "node:path";

import {
  runWithIterations,
  type IterateUpdate,
  type IterationResult,
  type RoundEvent,
} from "../core/iterate.ts";
import type { PlanUpdate } from "../core/orchestrator.ts";
import type { DesignerOutcome } from "../core/designer.ts";
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
  /** 进度回调（轮次事件 + 步骤事件——原样透传给 runWithIterations 的 onUpdate） */
  onUpdate?: (update: IterateUpdate) => void;
  /** 中止信号（原样透传给 runWithIterations 的 signal） */
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

/**
 * run.json 悬留收口（M4-T0，M3 终审 M-4 债）：runLoopTask 的 catch 意味着异常发生在
 * executePlan 无法保证落盘的位置（designer 基建异常 / recordPlanInRunJson 读写失败 /
 * executePlan 受理前的上抛）——run 记录可能悬留非终态（status=created）。对照
 * executePlan 前置失败「先标 failed 再上抛」的既有治法，以同样的落盘格式（读改写、
 * 磁盘为事实源）补齐：只收口非终态（created/running——executePlan 已自标 failed 的
 * 路径不覆盖），error 字段落异常摘要供审计。兜底自身的失败（run.json 损坏/不可写）
 * 静默吞掉——绝不掩盖原异常。
 */
function markRunFailedInRunJson(
  dataDir: string,
  runId: string,
  message: string,
): void {
  try {
    const file = path.join(dataDir, "runs", runId, "run.json");
    if (!fs.existsSync(file)) return;
    const record = JSON.parse(fs.readFileSync(file, "utf-8")) as RunRecord & {
      error?: string;
    };
    if (record.status !== "created" && record.status !== "running") return;
    record.status = "failed";
    record.error = message;
    fs.writeFileSync(file, JSON.stringify(record, null, "\t") + "\n");
  } catch {
    // 收口失败（run.json 缺席/损坏/不可写）不掩盖原异常——原异常才是调用方要呈现的
  }
}

/**
 * 迭代闭环结果的 LoopToolResult 构造（M4-T2 三态收口）：verified→completed；
 * budget_exhausted/failed 如实；evaluation 摘要（verdict+score+轮数）。遥测口径：
 * succeeded/failed 按末轮分轮切片（entries 的 round 标注）报真值，iterations 报
 * 累计（RunTelemetry 的「run.json iterations 数组长度」口径），durationMs 报闭环
 * 总墙钟（含 designer/评估等待）。错误优先级沿用 M2 语义：pi-subagents 缺席标记
 * → 安装引导与运行级文案并列；否则运行级镜像（迭代预算文案 / aborted / 预算拒绝原文）
 */
function buildIteratedResult(
  prep: PreparedRun,
  iteration: IterationResult,
  wallMs: number,
): LoopToolResult {
  const { outcome, finalRound, evaluation, runOutcome } = iteration;
  const ordinal = finalRound + 1;
  // 末轮分轮切片——多轮重跑不把历史轮的成功/失败混入末轮计数
  const lastEntries = runOutcome.iterations.filter(
    (entry) => entry.round === finalRound,
  );
  const succeeded = lastEntries.filter((e) => e.status === "succeeded").length;
  const failed = lastEntries.filter((e) => e.status === "failed").length;
  // 执行层预算拒绝（计划级——零步骤执行）：M4-T0 的旧文案语义保持（枚举值经
  // outcome="budget_exhausted" 延续，语义扩展为迭代预算尽）
  const planRejected =
    runOutcome.error !== undefined &&
    runOutcome.error.startsWith("budget_exhausted:") &&
    runOutcome.iterations.length === 0;
  const completed = outcome === "verified";
  const budget = outcome === "budget_exhausted";
  // 诚实措辞：结论（verdict/score/轮数）+ 末轮执行事实，不用模糊话术遮盖
  const summary = completed
    ? `任务完成：第 ${ordinal} 轮验收通过（verdict=verified，score=${evaluation.score}；末轮 ${succeeded}/${runOutcome.steps} 步成功，累计调度 ${runOutcome.iterations.length} 次）`
    : planRejected
      ? `任务因预算耗尽终止：计划 ${runOutcome.steps} 步超出允许上限（详情见 run.json）`
      : budget
        ? `任务因迭代预算耗尽终止：${ordinal} 轮执行后仍未通过验收（最后一轮 verdict=${evaluation.verdict}，score=${evaluation.score}）`
        : `任务中止：第 ${ordinal} 轮后运行信号中止（最后评估 verdict=${evaluation.verdict}）`;
  const stepFailures = lastEntries
    .filter((e) => e.status === "failed" && e.error !== undefined)
    .map((e) => e.error as string);
  let error = iteration.error;
  if (!completed && stepFailures.some((m) => m.includes(RPC_ABSENT_MARK))) {
    error =
      error === undefined
        ? RPC_INSTALL_GUIDANCE
        : `${error}\n${RPC_INSTALL_GUIDANCE}`;
  }
  const result: LoopToolResult = {
    status: completed ? "completed" : budget ? "budget_exhausted" : "failed",
    runId: prep.record.id,
    effort: prep.record.effort,
    preset: prep.preset,
    telemetry: {
      steps: runOutcome.steps,
      succeeded,
      failed,
      iterations: runOutcome.iterations.length,
      durationMs: wallMs,
    },
    plan: iteration.plan,
    evaluation: {
      verdict: evaluation.verdict,
      score: evaluation.score,
      round: finalRound,
    },
    summary,
  };
  if (error !== undefined) result.error = error;
  return result;
}

/**
 * loop_task 的统一执行入口（工具与命令共用；M2-T4 起缺省为真实调度）。
 * - PI_LOOP_STUB=1 → M1 stub 行为（runLoopTaskStub，断言语义不变）
 * - 缺省 → 三步链 → 构造 SubagentsRpcClient → runWithIterations 迭代闭环
 *   （M4-T2：designer 降级 builtin 照常进循环；execute → evaluate → 注入归因
 *   重跑 → verified / budget_exhausted；plan 元信息经 adapter 落盘，LoopToolParams
 *   签名不变）
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
  const startedMs = Date.now();
  /** 已确定的计划摘要（catch 分支的诚实补档：执行链异常时也带上已知的计划元信息） */
  let planSummary: LoopPlanBrief | undefined;
  try {
    // 迭代闭环（M4-T2）：首轮 design → 每轮 execute → evaluate → fail/partial 注入
    // 归因重跑；run.json 的 plan 元信息经 adapter 在首轮与重设计后各落盘一次
    // （读改写——磁盘为事实源）；重启后或连续失败到预算尽按 budget_exhausted 如实收尾
    const iteration = await runWithIterations(params.task, prep.preset, {
      rpc,
      runId: prep.record.id,
      dataDir: prep.dataDir,
      signal: opts.signal,
      onUpdate: opts.onUpdate,
      verifyCommand: params.verifyCommand,
      adapter: {
        onPlanDesigned: (designed) => {
          planSummary = {
            origin: designed.plan.origin,
            steps: designed.plan.steps.length,
            degraded: designed.degraded,
          };
          recordPlanInRunJson(
            prep.dataDir,
            prep.record.id,
            planInfoFromOutcome(designed),
          );
        },
      },
    });
    const result = buildIteratedResult(prep, iteration, Date.now() - startedMs);
    // 无 entry 落痕的中止（层间检查点）在 run 级已记 error="aborted"，结果侧同步
    // 补上（iterate 的 abort 收尾已带 error="aborted"——此处为防御性双保险，不产生分歧）
    if (
      result.status === "failed" &&
      opts.signal?.aborted &&
      result.error === undefined
    ) {
      result.error = "aborted";
    }
    return result;
  } catch (error) {
    // 基建类异常（executePlan/designer 已各自完成降级路径后仍上抛的磁盘/run.json
    // 类异常——executePlan 已把 run 标 failed 后上抛）：统一收敛为 failed 结果，
    // 错误详情仍可经 error 字段与 run.json 审计，不向宿主抛裸异常
    const message = error instanceof Error ? error.message : String(error);
    // M-4 债兜底（M3 终审）：异常发生在 executePlan 接管前（designer 抛出 /
    // recordPlanInRunJson 读写失败）时 run.json 会悬留非终态（created）——对照
    // executePlan 前置失败「先标 failed 再上抛」的既有治法补齐落盘（终态不覆盖）
    markRunFailedInRunJson(prep.dataDir, prep.record.id, message);
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

/** 轮次事件 → 人类可读单行（工具 onUpdate 的 content 与命令 notify 共用——与 describeStepUpdate 同源的文案真源；轮次序数按 round+1 人类可读显示） */
export function describeRoundUpdate(event: RoundEvent): string {
  const base = `[loop] 第 ${event.round + 1} 轮迭代`;
  if (event.phase === "start") return `${base}开始`;
  if (event.verdict === undefined) return `${base}结束`;
  const verdictText =
    event.verdict === "verified"
      ? `验收通过（verdict=verified，score=${event.score ?? "?"}）`
      : `未通过（verdict=${event.verdict}，score=${event.score ?? "?"}）`;
  const nextText =
    event.next === "retry"
      ? "——注入归因重跑"
      : event.next === "redesign"
        ? "——重新设计计划"
        : event.next === "budget_exhausted"
          ? "——迭代预算已用尽"
          : event.next === "abort"
            ? "——运行已中止"
            : "";
  return `${base}结束：${verdictText}${nextText}`;
}

/** 迭代进度事件的总分发（轮次事件 + 步骤事件）——工具与命令共用的单一文案真源 */
export function describeIterateUpdate(update: IterateUpdate): string {
  if ("kind" in update) return describeRoundUpdate(update);
  return describeStepUpdate(update);
}
