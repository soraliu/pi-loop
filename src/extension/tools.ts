// pi-loop 工具注册（M1-T4）：loop_task（M2-T4 接入真实调度与进度回调）
// 契约：docs/SPEC.md §6（参数与语义）、docs/plans/m1-skeleton.md Task 4、m2-orchestrator.md Task 4。

import { Type } from "@sinclair/typebox";

import type { PiExtensionApi, ToolResponse } from "./api.ts";
import { describeStepUpdate, runLoopTask } from "./loop-task.ts";
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
      description:
        "可选机器验收命令；提供时其退出码优先于 critic 打分作为迭代依据",
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

/** LoopToolResult 的 JSON 序列化（含遥测真值与失败原因，转文本 content 给模型） */
function resultToText(result: LoopToolResult): string {
  const payload: Record<string, unknown> = {
    status: result.status,
    runId: result.runId,
    effort: result.effort,
    preset: result.preset,
    telemetry: result.telemetry,
    summary: result.summary,
  };
  if (result.error !== undefined) payload.error = result.error;
  return JSON.stringify(payload, null, 2);
}

/**
 * loop_task 执行体的工厂：闭包捕获宿主对象以取 pi.events（RPC 总线来源）。
 * 进度：宿主 onUpdate（execute 第 4 参，M1 api.ts 契约）有则把 LoopToolResult
 * 的步骤进度映射为 { content } 分段投递给模型；无则让 runLoopTask 内部吞掉。
 * 业务错误（task 缺失/effort 非法/执行链异常）转为 error content，不向宿主抛裸异常。
 */
function makeExecuteLoopTask(pi: PiExtensionApi) {
  return async function executeLoopTask(
    _toolCallId: string,
    rawParams: unknown,
    signal: AbortSignal,
    onUpdate?: (update: {
      content: Array<{ type: "text"; text: string }>;
    }) => void,
  ): Promise<ToolResponse> {
    // typebox 校验后的 params 形状与 SchemaParams 一致；此处收窄为业务类型
    const params = rawParams as SchemaParams;
    const loopParams: LoopToolParams = {
      task: params.task,
      // effort 窄化为合法档位：undefined 直接省略（缺省回落由 runLoopTask 处理）；
      // 非 undefined 的非法值由 prepareRun 内 isEffortLevel 守卫拦截并抛 TypeError
      ...(params.effort === undefined
        ? {}
        : { effort: params.effort as LoopToolParams["effort"] }),
      ...(params.verifyCommand === undefined
        ? {}
        : { verifyCommand: params.verifyCommand }),
      ...(params.contextPaths === undefined
        ? {}
        : { contextPaths: params.contextPaths }),
    };
    try {
      const result = await runLoopTask(loopParams, {
        busEnv: pi.events,
        signal,
        onUpdate:
          onUpdate === undefined
            ? undefined
            : (update) =>
                onUpdate({
                  content: [{ type: "text", text: describeStepUpdate(update) }],
                }),
      });
      return {
        content: [{ type: "text", text: resultToText(result) }],
        details: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `loop_task 执行出错: ${message}` }],
        details: { error: message },
      };
    }
  };
}

/** 注册 loop_task 工具（execute 已接真实调度内核；注册面保持稳定） */
export function registerLoopTools(pi: PiExtensionApi): void {
  pi.registerTool({
    name: "loop_task",
    label: "Loop Task",
    description:
      "pi-loop 自主研究引擎入口：指派一个任务（研究/分析/构建），由它自主设计研究方法、调度 subagents 并迭代优化结果。" +
      "task 必填；effort 控制迭代激进度（low=最多1轮迭代 low成本 / medium=2轮 / high=3轮 / max=5轮，缺省 medium）；" +
      "verifyCommand 可选，提供机器验收命令时优先于 critic 打分作为迭代判定依据。",
    parameters: LoopTaskParamsSchema,
    execute: makeExecuteLoopTask(pi),
  });
}
