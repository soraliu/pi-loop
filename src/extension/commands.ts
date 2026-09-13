// pi-loop 命令注册（M1-T4）：/loop、/loop-status、/loop-cases、/loop-methods
// 契约：docs/SPEC.md §6（命令交互面）、docs/plans/m1-skeleton.md Task 4、m2-orchestrator.md Task 4。
// /loop 与 loop_task 工具共享 runLoopTask 核心（单一事实源）；M2-T4 起经 fake/真实
// 总线走真实调度，进度以 ctx.ui.notify 投递（每步一条：按 stepId 节流去重）。

import * as fs from "node:fs";
import * as path from "node:path";

import { stringArray } from "../core/retrieval.ts";
import type { IterateUpdate } from "../core/iterate.ts";
import type { CommandContext, PiExtensionApi } from "./api.ts";
import {
  describeIterateUpdate,
  describeRoundUpdate,
  resolveDataDir,
  runLoopTask,
} from "./loop-task.ts";
import { listCases } from "../storage/cases.ts";
import { listMethods } from "../storage/methods.ts";
import { isEffortLevel } from "../storage/settings.ts";
import { taskPreview } from "../storage/workspace.ts";
import type {
  Case,
  EffortLevel,
  LoopToolParams,
  MethodologyEntry,
  RunSummary,
} from "../types.ts";

/** /loop 参数的解析结果 */
export interface ParsedLoopArgs {
  /** 无旗标的剩余文本 = 任务描述 */
  task: string;
  effort?: EffortLevel;
  verifyCommand?: string;
  contextPaths?: string[];
  /** 解析期发现的错误（effort 非法等）；非空时命令直接提示并不执行 */
  error?: string;
}

/**
 * 解析 /loop 参数文本。
 * 语法：`任务描述 --effort <档位> --verify "<命令>" --context <路径>`（旗标可重复/任意顺序）
 */
export function parseLoopArgs(raw: string): ParsedLoopArgs {
  const taskParts: string[] = [];
  const contextPaths: string[] = [];
  let effort: string | undefined;
  let verifyCommand: string | undefined;
  let error: string | undefined;

  // 分词：双引号内为一段（允许 verify 命令含空格）；其余按空白切
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    switch (token) {
      case "--effort": {
        if (next === undefined) {
          error = "--effort 缺少值（合法值: low | medium | high | max）";
          break;
        }
        effort = next.replace(/^"|"$/g, "");
        i++; // 消费值
        break;
      }
      case "--verify": {
        if (next === undefined) {
          error = '--verify 缺少值（如 --verify "npm test"）';
          break;
        }
        verifyCommand = next.replace(/^"|"$/g, "");
        i++;
        break;
      }
      case "--context": {
        if (next === undefined) {
          error = "--context 缺少值（如 --context ./notes.md）";
          break;
        }
        contextPaths.push(next.replace(/^"|"$/g, ""));
        i++;
        break;
      }
      default:
        taskParts.push(token);
    }
    if (error) break;
  }

  const task = taskParts.join(" ").trim();
  if (!error && task.length === 0) {
    error =
      '缺少任务描述。用法: /loop <任务描述> [--effort low|medium|high|max] [--verify "命令"] [--context 路径]';
  }
  if (!error && effort !== undefined && !isEffortLevel(effort)) {
    error = `非法 effort 档位: ${effort}。合法值: low | medium | high | max`;
  }

  const result: ParsedLoopArgs = { task };
  if (effort !== undefined) result.effort = effort as EffortLevel;
  if (verifyCommand !== undefined) result.verifyCommand = verifyCommand;
  if (contextPaths.length > 0) result.contextPaths = contextPaths;
  if (error !== undefined) result.error = error;
  return result;
}

/**
 * /loop-status：读取全部 run.json 摘要（最近在前，调用方截取展示条数）。
 * 宽容读取：JSON 损坏或关键字段（status/effort）非法的记录跳过不展示，
 * 次要字段（taskPreview/createdAt）缺失时占位，不中断列表。
 */
export function listRecentRuns(dataDir: string): RunSummary[] {
  const runsDir = path.join(dataDir, "runs");
  if (!fs.existsSync(runsDir)) return [];
  const out: RunSummary[] = [];
  for (const entry of fs.readdirSync(runsDir)) {
    const file = path.join(runsDir, entry, "run.json");
    if (!fs.existsSync(file)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        id?: string;
        status?: string;
        effort?: string;
        taskPreview?: string;
        createdAt?: string;
      };
      // 字段级损坏与 JSON 级损坏同语义：跳过该记录，不用 "unknown" 占位伪装
      if (record.status === undefined || !isEffortLevel(record.effort))
        continue;
      out.push({
        id: record.id ?? entry,
        status: record.status as RunSummary["status"],
        effort: record.effort,
        taskPreview: record.taskPreview ?? "(无预览)",
        createdAt: record.createdAt ?? "",
      });
    } catch {
      // 损坏的 run.json 跳过（不中断列表）
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 列表命令(/loop-cases、/loop-methods)的 --limit 解析结果 */
export interface ParsedLimitArgs {
  /** 展示条数上限（缺省 10;正整数） */
  limit: number;
  /** 解析期发现的错误;非空时命令直接提示并不执行 */
  error?: string;
}

/** 列表命令缺省展示条数 */
const DEFAULT_LIST_LIMIT = 10;

/**
 * 解析列表命令参数文本(`--limit N`;其余文本忽略——列表命令无任务位，与 /loop 的解析
 * 语义各自独立)。缺省 10;非正整数或缺值 → error 且 limit 置 0(哨兵值——error 路径的
 * limit 不应被消费;若调用方误消费,0 只会得到空列表,不会以缺省值伪装成有效解析)。
 */
export function parseLimitArgs(raw: string): ParsedLimitArgs {
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "--limit") continue;
    const value = tokens[i + 1]?.replace(/^"|"$/g, "");
    if (value === undefined) {
      return {
        limit: 0,
        error: "--limit 缺少值（如 --limit 5）",
      };
    }
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0) {
      return {
        limit: 0,
        error: `非法 --limit 值：${value}（正整数）`,
      };
    }
    return { limit };
  }
  return { limit: DEFAULT_LIST_LIMIT };
}

/**
 * id 的展示截断:列表行宽裁剪(超 12 字符截断加省略号;展示口径，档案文件名内仍是
 * 完整 id——与 /loop-status 的运行 id 全显同源区分:案例/方法库量会增长，行宽提前留裕度)。
 */
function shortenId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 12)}…`;
}

/** 数字字段的展示(缺形/非有限数 → ?——渲染 0 留给真实零实证，与 designer 参考段同口径) */
function displayNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "?";
}

/** /loop-cases 单行:缩短 id + 验收徽标 + 评分 + 日期 + 任务截断 40 字(taskPreview 同款折叠/截断) */
function describeCaseEntry(c: Case): string {
  const score = displayNumber(c.finalScore);
  const date =
    (typeof c.createdAt === "string" ? c.createdAt : "").slice(0, 10) || "?";
  const task = taskPreview(typeof c.task === "string" ? c.task : "", 40);
  return [
    shortenId(typeof c.id === "string" ? c.id : "?"),
    `[${c.verified === true ? "已验收" : "未验收"}]`,
    `score=${score}`,
    date,
    task,
  ].join("  ");
}

/** /loop-methods 单行:id + 名称 + fitness 概要 + 适用面要点;防御读(与 designer 同口径) */
function describeMethodEntry(m: MethodologyEntry): string {
  const name =
    typeof m.name === "string" && m.name.length > 0 ? m.name : "（未命名方法）";
  const taskTypes = stringArray(m.appliesTo?.taskTypes);
  const signals = stringArray(m.appliesTo?.signals);
  const applies =
    taskTypes.length === 0 && signals.length === 0
      ? "适用面未声明"
      : [
          taskTypes.length > 0 ? `适用 ${taskTypes.join("、")}` : "",
          signals.length > 0 ? `信号 ${signals.join("、")}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("；");
  return [
    shortenId(typeof m.id === "string" ? m.id : "?"),
    name,
    `uses=${displayNumber(m.fitness?.uses)}`,
    `avgScore=${displayNumber(m.fitness?.avgScore)}`,
    applies,
  ].join("  ");
}

/**
 * /loop 的进度节流器（T4-M2 复评兑现：终态可见性升级；M4-T2 轮次事件并入）。
 * 旧语义「按 stepId 仅首条胜出」会吞掉每步的终态——失败步在收尾摘要之外无感知。
 * 新语义（目标口径：3 步计划含 1 失败 → notify 数 = 开始条数(1) + 终态条数(3)）：
 * - 开始信号：首个非终态更新（running）投递一条，代表计划开跑；其后各步的
 *   running 并入该条（合并投递，不再逐步重复）；
 * - 终态：每步成功/失败各投一条（成功/失败都发；按 stepId+终态去重，迟到的
 *   重复投递静默吞掉），失败走 error 级——终态不丢是本次升级的核心；
 * - 轮次事件（M4-T2）：每轮开始/结束各投一条（迭代引擎保证每轮恰两条，无
 *   节流必要），同时在轮边界重置节流状态——新一轮里同 stepId 的开始/终态
 *   重新可见（多轮重跑不吞进度；重设计/重试轮均适用）。
 */
export function makeStepNotifier(
  notify: (message: string, level?: "info" | "warning" | "error") => void,
): (update: IterateUpdate) => void {
  let startNotified = false;
  const terminalSeen = new Set<string>();
  return (update) => {
    // 轮次事件：文案同源（describeRoundUpdate）；未通过的轮终态降 warning 级
    // （终局结论另由收尾摘要投递，不重复用 error 级宣判）
    if ("kind" in update) {
      startNotified = false;
      terminalSeen.clear();
      notify(
        describeRoundUpdate(update),
        update.phase === "end" &&
          update.verdict !== undefined &&
          update.verdict !== "verified"
          ? "warning"
          : "info",
      );
      return;
    }
    if (update.status === "succeeded" || update.status === "failed") {
      const key = `${update.stepId}\u0000${update.status}`;
      // 终态去重：同 stepId 同终态的迟到重复投递静默吞掉
      if (terminalSeen.has(key)) return;
      terminalSeen.add(key);
    } else if (startNotified) {
      // 非终态（running/pending）：开始信号只发首条，后续并入
      return;
    } else {
      startNotified = true;
    }
    notify(
      describeIterateUpdate(update),
      update.status === "failed" ? "error" : "info",
    );
  };
}

/** 注册全部 /loop* 命令 */
export function registerLoopCommands(pi: PiExtensionApi): void {
  pi.registerCommand("loop", {
    description:
      '启动一次 loop 任务（用法: /loop <任务> [--effort low|medium|high|max] [--verify "命令"] [--context 路径]）',
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseLoopArgs(args);
      if (parsed.error !== undefined) {
        ctx.ui.notify(`参数错误: ${parsed.error}`, "error");
        return;
      }
      const params: LoopToolParams = {
        task: parsed.task,
        ...(parsed.effort === undefined ? {} : { effort: parsed.effort }),
        ...(parsed.verifyCommand === undefined
          ? {}
          : { verifyCommand: parsed.verifyCommand }),
        ...(parsed.contextPaths === undefined
          ? {}
          : { contextPaths: parsed.contextPaths }),
      };
      // 进度：开始 1 条 + 每步终态 1 条 + 每轮首尾各 1 条（makeStepNotifier 节流）；完成后另发一条摘要
      const notifyStep = makeStepNotifier(ctx.ui.notify);
      try {
        const result = await runLoopTask(params, {
          busEnv: pi.events,
          onUpdate: notifyStep,
        });
        if (result.status === "stub") {
          // M1 stub 语义（PI_LOOP_STUB=1）：原有单条通知文案保持不变
          ctx.ui.notify(
            `已创建运行 ${result.runId}（effort=${result.effort}，迭代上限=${result.preset.maxResultIterations}，并行上限=${result.preset.maxParallelSubagents}）。stub：调度引擎在 M2 接入。`,
            "info",
          );
          return;
        }
        const tail = result.error === undefined ? "" : `\n${result.error}`;
        ctx.ui.notify(
          `${result.summary}（run ${result.runId}）${tail}`,
          result.status === "completed" ? "info" : "error",
        );
      } catch (error) {
        ctx.ui.notify(
          `执行失败: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("loop-status", {
    description: "查看最近的 loop 运行列表",
    handler: (_args: string, ctx: CommandContext) => {
      const dataDir = resolveDataDir();
      const runs = listRecentRuns(dataDir).slice(0, 10);
      if (runs.length === 0) {
        ctx.ui.notify(`尚无运行记录（${path.join(dataDir, "runs")}）`, "info");
        return;
      }
      const lines = runs.map(
        (r) => `${r.id}  [${r.status}]  (effort=${r.effort})  ${r.taskPreview}`,
      );
      ctx.ui.notify(
        `最近 ${lines.length} 条运行:\n${lines.join("\n")}`,
        "info",
      );
    },
  });

  pi.registerCommand("loop-cases", {
    description: "查看案例档案列表（用法：/loop-cases [--limit N]；默认 10）",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseLimitArgs(args);
      if (parsed.error !== undefined) {
        ctx.ui.notify(`参数错误: ${parsed.error}`, "error");
        return;
      }
      const dataDir = resolveDataDir();
      const cases = await listCases(dataDir, parsed.limit);
      if (cases.length === 0) {
        ctx.ui.notify(`尚无案例档案（${path.join(dataDir, "cases")}）`, "info");
        return;
      }
      const lines = cases.map(describeCaseEntry);
      ctx.ui.notify(
        `最近 ${lines.length} 条案例:\n${lines.join("\n")}`,
        "info",
      );
    },
  });

  pi.registerCommand("loop-methods", {
    description: "查看方法论库条目（用法：/loop-methods [--limit N]；默认 10）",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseLimitArgs(args);
      if (parsed.error !== undefined) {
        ctx.ui.notify(`参数错误: ${parsed.error}`, "error");
        return;
      }
      const dataDir = resolveDataDir();
      const methods = (await listMethods(dataDir)).slice(0, parsed.limit);
      if (methods.length === 0) {
        ctx.ui.notify(
          `尚无方法条目（${path.join(dataDir, "methods")}）`,
          "info",
        );
        return;
      }
      const lines = methods.map(describeMethodEntry);
      ctx.ui.notify(`方法库 ${lines.length} 条:\n${lines.join("\n")}`, "info");
    },
  });
}
