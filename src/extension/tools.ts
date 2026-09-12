// pi-loop 工具注册（M1-T4）：loop_task
// 契约：docs/SPEC.md §6（参数与语义）、docs/plans/m1-skeleton.md Task 4。

import { Type } from "@sinclair/typebox";

import type { PiExtensionApi, ToolResponse } from "./api.ts";
import { runLoopTaskStub } from "./loop-task.ts";
import type { LoopToolParams, LoopToolResult } from "../types.ts";

/** loop_task 的 typebox 参数 schema——与 SPEC §6 一字不差（task 必填，其余可选） */
const LoopTaskParamsSchema = Type.Object({
  task: Type.String({
    description: "用户指派的任务描述（研究/分析/构建目标，必填）",
  }),
  effort: Type.Optional(
    Type.String({
      description: "激进度档位：low | medium | high | max（缺省 medium）",
    }),
  ),
  verifyCommand: Type.Optional(
    Type.String({
      description: "可选机器验收命令；提供时其退出码优先于 critic 打分作为迭代依据",
    }),
  ),
  contextPaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "任务相关上下文路径（允许 agent 读写的范围声明）",
    }),
  ),
});

/** schema 的 TS 静态类型（编译期与 SPEC §6 对齐） */
type SchemaParams = {
  task: string;
  effort?: string;
  verifyCommand?: string;
  contextPaths?: string[];
};

/** LoopToolResult 的最小 JSON 序列化（stub 结果转文本 content） */
function resultToText(result: LoopToolResult): string {
  return JSON.stringify(
    {
      status: result.status,
      runId: result.runId,
      effort: result.effort,
      preset: result.preset,
      summary: result.summary,
    },
    null,
    2,
  );
}

/**
 * loop_task 执行体（stub）：校验 → 落 run 记录 → 返回占位结果。
 * 业务错误（task 缺失/effort 非法）转为 error content，不向宿主抛裸异常。
 */
async function executeLoopTask(_toolCallId: string, rawParams: unknown): Promise<ToolResponse> {
  // typebox 校验后的 params 形状与 SchemaParams 一致；此处收窄为业务类型
  const params = rawParams as SchemaParams;
  const loopParams: LoopToolParams = {
    task: params.task,
    // effort 由字符串窄化为合法档位：非法值由 runLoopTaskStub 内 resolveEffort 抛错
    ...(params.effort === undefined ? {} : { effort: params.effort as LoopToolParams["effort"] }),
    ...(params.verifyCommand === undefined ? {} : { verifyCommand: params.verifyCommand }),
    ...(params.contextPaths === undefined ? {} : { contextPaths: params.contextPaths }),
  };
  try {
    const result = runLoopTaskStub(loopParams);
    return { content: [{ type: "text", text: resultToText(result) }], details: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `loop_task 参数错误: ${message}` }],
      details: { error: message },
    };
  }
}

/** 注册 loop_task 工具（M2 调度内核将替换 execute 内部实现，注册面保持稳定） */
export function registerLoopTools(pi: PiExtensionApi): void {
  pi.registerTool({
    name: "loop_task",
    label: "Loop Task",
    description:
      "pi-loop 自主研究引擎入口：指派一个任务（研究/分析/构建），由它自主设计研究方法、调度 subagents 并迭代优化结果。" +
      "task 必填；effort 控制迭代激进度（low=最多1轮迭代 low成本 / medium=2轮 / high=3轮 / max=5轮，缺省 medium）；" +
      "verifyCommand 可选，提供机器验收命令时优先于 critic 打分作为迭代判定依据。",
    parameters: LoopTaskParamsSchema,
    execute: executeLoopTask,
  });
}
