// pi-loop 核心类型定义（M1-T2）
// 依据 docs/SPEC.md §3（术语）、§5（数据模型）、§6（交互面）。
// 本文件只放类型与纯数据形状，不含行为逻辑。

/** 激进度预设档位（SPEC §6：low | medium | high | max） */
export type EffortLevel = "low" | "medium" | "high" | "max";

/**
 * Meta 自迭代（方法论自我改进）的触发条件。
 * - off：完全关闭
 * - manual：仅用户手动触发
 * - caseThreshold：累积新案例达到阈值后自动提议
 */
export type MetaTrigger =
	| { kind: "off" }
	| { kind: "manual" }
	| { kind: "caseThreshold"; count: number };

/** 单档激进度预设（SPEC §6 表格的一行） */
export interface EffortPreset {
	/** 结果迭代轮数上限（评估不达标时允许的改良重跑次数） */
	maxResultIterations: number;
	/** 并行 subagents 数量上限 */
	maxParallelSubagents: number;
	/** meta 自迭代触发条件 */
	metaTrigger: MetaTrigger;
}

/** 全部档位的预设表（settings.json 的 effortPresets 即此形状的部分覆盖） */
export type EffortPresetsMap = Record<EffortLevel, EffortPreset>;

/** loop_task 工具入参（SPEC §6：与最终形态一致，stub 阶段即按此校验） */
export interface LoopToolParams {
	/** 用户指派的任务描述（必填） */
	task: string;
	/** 激进度档位；缺省时由 prepareRun 回落 DEFAULT_EFFORT_LEVEL，非法值抛 TypeError */
	effort?: EffortLevel;
	/** 可选的机器验收命令（存在时优先于 critic 打分，SPEC §7.4 诚实遥测） */
	verifyCommand?: string;
	/** 任务相关上下文路径（允许 agent 读写的范围声明） */
	contextPaths?: string[];
}

/** Run 遥测（M2-T4 起由调度内核 RunOutcome 填充；stub 路径为全零占位） */
export interface RunTelemetry {
	/** 计划步骤总数 */
	steps: number;
	/** 成功步骤数 */
	succeeded: number;
	/** 失败步骤数 */
	failed: number;
	/** iteration 条目数（子代理实际调度次数，即 run.json iterations 数组长度） */
	iterations: number;
	/** 调度核心耗时（毫秒） */
	durationMs: number;
}

/** loop_task 工具返回结构（stub 阶段即含完整形状，M2+ 填充实质内容） */
export interface LoopToolResult {
	/** stub=占位实现；completed=已达成 verified；failed=失败收尾；budget_exhausted=预算耗尽 */
	status: "stub" | "completed" | "failed" | "budget_exhausted";
	/** 本次运行的 run id（runs/<id>/ 目录名） */
	runId: string;
	/** 实际生效的档位（解析后的，非原始输入） */
	effort: EffortLevel;
	/** 生效预设快照（便于审计"当时允许了几轮迭代"） */
	preset: EffortPreset;
	/** 遥测（真实调度路径按 RunOutcome 填充；stub 为全零） */
	telemetry: RunTelemetry;
	/** 人类可读结果摘要 */
	summary?: string;
	/** 失败原因（status=failed 时给可操作信息，如 pi-subagents 安装引导；中止记 "aborted"） */
	error?: string;
}

/** Run 的只读摘要（/loop-status 列表与调度内核使用） */
export interface RunSummary {
	/** run id（如 r-abcdef123） */
	id: string;
	/** 任务描述单行预览（截断） */
	taskPreview: string;
	effort: EffortLevel;
	/** 含 "running"（M2-T3 引入：run.json 运行中态——计划状态机 created→running→completed|failed） */
	status: LoopToolResult["status"] | "created" | "running";
	/** ISO 8601 创建时间 */
	createdAt: string;
}

/** settings.json 的形状（loadLoopSettings 的返回即完全解析后的生效配置） */
export interface LoopSettings {
	/** 激进度预设表（与默认表深合并后的结果） */
	effortPresets: EffortPresetsMap;
}

/* ================================================================
 * 研究计划与迭代（M2-T2：静态计划 + 编译器的类型基础）
 * ================================================================ */

/** 研究计划的单个步骤（M3 的 Designer 将动态生成；M2 由 BUILTIN_PLAN 静态提供） */
export interface PlanStep {
	/** 步骤唯一 id（计划内；也用作 workflowScript 的 runs.run key） */
	id: string;
	/** 执行本步的 subagent 角色名（如 researcher） */
	agent: string;
	/** 本步的任务提示词全文 */
	task: string;
	/** 前置步骤 id 列表（空数组 = 无依赖，可并行起点） */
	dependsOn: string[];
	/** 模型覆盖（M2 全部省略——spawn 一律继承会话默认模型） */
	model?: string;
}

/** 研究计划：步骤的 DAG（M2 由 BUILTIN_PLAN 静态构造，M3 由 Designer 动态生成） */
export interface PlanDraft {
	steps: PlanStep[];
}

/**
 * 单个计划步骤的执行记录（RunRecord.iterations 的元素）。
 * 生命周期：pending → running → succeeded | failed
 */
export interface IterationEntry {
	/** 对应的 PlanStep.id */
	stepId: string;
	/** 执行角色（冗余自 PlanStep.agent，便于 run.json 单文件审计） */
	agent: string;
	status: "pending" | "running" | "succeeded" | "failed";
	/** 输出物引用（M2+ 由调度层填：transcript/run 产物路径） */
	outputRef?: string;
	/** ISO 8601 */
	startedAt?: string;
	/** ISO 8601 */
	endedAt?: string;
	/** 失败原因（status=failed 时） */
	error?: string;
}
