// pi-loop 命令注册（M1-T4）：/loop、/loop-status、/loop-cases、/loop-methods
// 契约：docs/SPEC.md §6（命令交互面）、docs/plans/m1-skeleton.md Task 4。
// /loop 与 loop_task 工具共享 runLoopTaskStub 核心（单一事实源）。

import * as fs from "node:fs";
import * as path from "node:path";

import type { CommandContext, PiExtensionApi } from "./api.ts";
import { resolveDataDir, runLoopTaskStub } from "./loop-task.ts";
import { isEffortLevel } from "../storage/settings.ts";
import type { EffortLevel, LoopToolParams, RunSummary } from "../types.ts";

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
      if (record.status === undefined || !isEffortLevel(record.effort)) continue;
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

/** 目录文件计数（/loop-cases、/loop-methods 的 stub 统计） */
function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile()).length;
}

/** 注册全部 /loop* 命令 */
export function registerLoopCommands(pi: PiExtensionApi): void {
  pi.registerCommand("loop", {
    description:
      '启动一次 loop 任务（用法: /loop <任务> [--effort low|medium|high|max] [--verify "命令"] [--context 路径]）',
    handler: (args: string, ctx: CommandContext) => {
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
      try {
        const result = runLoopTaskStub(params);
        ctx.ui.notify(
          `已创建运行 ${result.runId}（effort=${result.effort}，迭代上限=${result.preset.maxResultIterations}，并行上限=${result.preset.maxParallelSubagents}）。stub：调度引擎在 M2 接入。`,
          "info",
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
    description: "查看案例档案统计（M5 接入后展示完整案例）",
    handler: (_args: string, ctx: CommandContext) => {
      const dataDir = resolveDataDir();
      const count = countFiles(path.join(dataDir, "cases"));
      ctx.ui.notify(
        `案例档案: ${count} 个文件（stub：案例存档在 M5 接入）`,
        "info",
      );
    },
  });

  pi.registerCommand("loop-methods", {
    description: "查看方法论库统计（M5 接入后展示方法条目）",
    handler: (_args: string, ctx: CommandContext) => {
      const dataDir = resolveDataDir();
      const count = countFiles(path.join(dataDir, "methods"));
      ctx.ui.notify(
        `方法论库: ${count} 个文件（stub：方法条目在 M5 接入）`,
        "info",
      );
    },
  });
}
