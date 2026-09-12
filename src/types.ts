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
	/** 计划步骤数上限（预算硬上限之一，SPEC §7.3——研究计划步数超界即拒收预算耗尽） */
	maxPlanSteps: number;
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

/**
 * Run 遥测（M2-T4 起由调度内核 RunOutcome 填充；stub 路径为全零占位；M4-T3
 * 起随终态落盘 RunRecord.telemetry）。SPEC §5 的 turns 字段无从获得真实轮次
 * 数据——诚实遥测：不可得字段 omit、不造假数值（对账见 docs/spec5-runrecord-gap.md）。
 */
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
	/**
	 * 真实 spawn 过的不同 agent 计数（M4-T3）：全部轮次 entry 的 agent 去重——同一
	 * agent 多步多轮只计 1。诚实遥测：无执行事实（零 entry）时 omit 不写假 0——
	 * 故为可选字段（stub 与拒绝路径不落键）。
	 */
	agents?: number;
}

/**
 * 计划元信息摘要（LoopToolResult.plan，M3-T4 接线）：工具结果侧可见的最小集合。
 * 全量元信息（notes/channel/attempts）不存在这一层——那是 run.json 审计域。
 */
export interface LoopPlanBrief {
	/** 计划来源：designer=动态生成；builtin=内置静态计划（含 designer 降级产物） */
	origin: "designer" | "builtin";
	/** 计划步骤数 */
	steps: number;
	/** 是否为降级产物（诚实遥测：降级禁止冒充正常生成） */
	degraded?: boolean;
}

/**
 * 计划元信息全量（RunRecord.plan，M3-T4 接线）：DesignerOutcome 的落盘形。
 * channel 三值与 src/core/designer.ts 的产物通道定义同源（此处声明结构，避免
 * types ← designer 的反向依赖）。
 */
export interface RunPlanInfo extends LoopPlanBrief {
	/** 设计备注（designer 计划的假设/取舍；降级时如实记降级原因） */
	notes?: string;
	/** 产物提取通道：file=designer-plan.json；fence=完成回复围栏；builtin=降级 */
	channel?: "file" | "fence" | "builtin";
	/** designer 实际发起的 spawn 尝试次数（0=中止于首发之前） */
	attempts?: number;
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
	/** 计划元信息摘要（真实调度路径必带：designer 生成或降级 builtin；stub 缺省） */
	plan?: LoopPlanBrief;
	/** 人类可读结果摘要 */
	summary?: string;
	/** 失败原因（status=failed 时给可操作信息，如 pi-subagents 安装引导；中止记 "aborted"） */
	error?: string;
	/** 评估结论摘要（M4-T2：迭代闭环最终轮 evaluation 的结果侧投影） */
	evaluation?: {
		/** 最终轮结论（verified 首见即终；budget_exhausted/failed 为终止轮的末次评估） */
		verdict: Evaluation["verdict"];
		/** 最终轮评分（clamp 0-100 整数） */
		score: number;
		/** 终止（通过或预算尽/中止）时所在的迭代轮（0 起计，0=首轮） */
		round: number;
	};
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
 * 研究计划与迭代（M2-T2：静态计划 + 编译器的类型基础；M3-T1：ResearchPlan）
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
	/** 附加提示词引导（可选：Designer 对本步的补充指引，随任务提示词下发） */
	guidance?: string;
	/** 验证标准（可选：本步产出的验收标准——M4 evaluator 消费预留） */
	acceptance?: string;
}

/**
 * 研究计划的「步骤 DAG 视图」：编译器（compileWorkflowScript）与调度内核（executePlan）
 * 的输入契约——两者只消费 steps，不强求计划级元数据。
 * M3-T1 起全量计划形状为 ResearchPlan（本接口的超集，结构兼容可直接喂给两者）。
 */
export interface PlanDraft {
	steps: PlanStep[];
}

/**
 * 全量研究计划（M3-T1）：Designer 动态产物与 BUILTIN_PLAN 静态计划的统一形状。
 * 外部输入（模型输出 / JSON 文本）须经 plan-schema 的防御解析
 * （净化 + schema 校验 + 结构语义校验）后才成为本类型。
 */
export interface ResearchPlan extends PlanDraft {
	/** 计划结构版本（当前固定字面量 1——保留给未来不兼容演进） */
	version: 1;
	/** 计划针对的任务全文（loop_task 的 task 入参） */
	task: string;
	/** 计划来源：designer=方法设计器动态生成；builtin=内置静态计划 */
	origin: "designer" | "builtin";
	/** 设计备注（可选：Designer 的说明/假设/取舍，不参与调度） */
	notes?: string;
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
	/** 所属迭代轮（M4-T2：0 起计——0=首轮；多轮执行的 entry 分轮归组，读取侧按 round 分组展示。orchestrator 落盘时不感知轮次，由迭代引擎补标） */
	round?: number;
}

/* ================================================================
 * 评估结论（M4-T1：Evaluator 的输出形状——verifyCommand 机器断言或 critic rubric 二择其一的产物）
 * ================================================================ */

/**
 * Evaluator 的评估结论（src/core/evaluator.ts 的返回；M4-T2 起落入 RunRecord.evaluation
 * 与 LoopToolResult 摘要）。
 * 诚实遥测（SPEC §7.4）：verified 只能来自 verifyCommand 的机器断言或 critic 结论
 * 原文——evaluator 自身的任何故障一律收敛为 fail（不自判通过）。
 */
export interface Evaluation {
	/** 结论三态：verified=验收通过；partial=部分达成（判定权在 critic——机器断言不产生中间态）；fail=未通过 */
	verdict: "verified" | "partial" | "fail";
	/** 0 到 100 的整数分（evaluator 对一切来源的输入 clamp 到该区间） */
	score: number;
	/**
	 * 结论依据（中文可读句子数组）。verifyCommand 通道携带退出码/stderr 尾部等执行事实；
	 * critic 通道为 critic 围栏 JSON 的 reasons 原文（外加幽灵 blame 过滤的警告）。
	 */
	reasons: string[];
	/** 归因 stepId 列表：critic 通道来自 critic 指认（已过滤不存在的 id）；verifyCommand 机器断言通道恒为空数组——退出码没有轮次归因概念（细节在 reasons） */
	blame: string[];
}
