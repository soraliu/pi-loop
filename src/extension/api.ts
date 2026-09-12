// pi 扩展宿主接口的最小本地声明（M1-T4）
// 宿主类型包 @earendil-works/pi-coding-agent 不在 npm 发布，无法作为依赖安装；
// 因此这里只声明 pi-loop 实际用到的形状（结构化类型），运行时由 pi 宿主提供真实实现。
// 依据：pi 官方文档 docs/extensions.md 的 Quick Start 契约原文。

import type { TSchema } from "@sinclair/typebox";

import type { SubagentEventBus } from "../core/rpc.ts";

/** pi 工具向模型返回的标准结构（docs/extensions.md registerTool 契约） */
export interface ToolResponse {
 content: Array<{ type: "text"; text: string }>;
 details: unknown;
}

/** registerTool 的定义对象形状（只列 pi-loop 用到的字段） */
export interface ToolDefinition {
 /** 工具名（模型可见的调用名，snake_case） */
 name: string;
 /** 展示名（TUI 中显示） */
 label: string;
 /** 给模型看的说明（何时该调用本工具、参数语义） */
 description: string;
 /** 参数 schema（typebox；宿主用它做入参校验） */
 parameters: TSchema;
 /**
  * 工具执行体。
  * @param toolCallId 调用 id（宿主分配）
  * @param params 已通过 schema 校验的入参
  * @param signal 中止信号
  * @param onUpdate 进度回调（长任务可分段投递；回调签名不变。声明为可选系
  * M2-T4 的宽容契约：宿主未传时工具内部吞掉，不阻断执行）
  * @param ctx 扩展执行上下文（本扩展不使用；随 onUpdate 可选化后同步声明为可选）
  */
 execute: (
  toolCallId: string,
  params: unknown,
  signal: AbortSignal,
  onUpdate?: (update: {
   content: Array<{ type: "text"; text: string }>;
  }) => void,
  ctx?: unknown,
 ) => Promise<ToolResponse>;
}

/** registerCommand 的选项形状（只列 pi-loop 用到的字段） */
export interface CommandOptions {
 /** 命令说明（/help 与补全可见） */
 description: string;
 /**
  * 命令处理器。
  * @param args 命令参数原文（/loop 后的剩余文本，未解析）
  * @param ctx 命令上下文（含 ui 反馈通道）
  */
 handler: (args: string, ctx: CommandContext) => void | Promise<void>;
}

/** 命令上下文中 pi-loop 用到的最小形状（ui 反馈） */
export interface CommandContext {
 ui: {
  /** 向用户展示一条通知（TUI 弹出/状态行） */
  notify: (message: string, level?: "info" | "warning" | "error") => void;
 };
}

/** pi 扩展宿主对象的最小结构接口（pi-loop 用到的注册面） */
export interface PiExtensionApi {
 /** 注册一个供模型调用的工具 */
 registerTool: (definition: ToolDefinition) => unknown;
 /** 注册一个 /slash 命令 */
 registerCommand: (name: string, options: CommandOptions) => unknown;
 /**
  * 扩展事件总线（宿主提供；M2-T4 引入）。pi-loop 经它驱动 pi-subagents 的
  * in-process RPC（subagents:rpc:v1:* 事件）；形状与 src/core/rpc.ts 的
  * SubagentEventBus 同一（单一拼写，不引入宿主类型包）。缺省无总线时调度以
  * 超时失败收尾（LoopToolResult 附 pi-subagents 安装引导）。
  */
 events?: SubagentEventBus;
}
