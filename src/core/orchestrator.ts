// pi-loop 调度内核（M2-T3）
// 依据 docs/SPEC.md §4（Orchestrator 契约）、docs/plans/m2-orchestrator.md Task 3。
//
// 与编译器路线（planner-static.ts）的关键差异：编译器把整个计划编成一段 workflowScript
// 交给宿主执行；本模块逐步 dispatch——每个步骤单独 spawn（结构化接口
// `{ agent, task, context: "fresh" }`），以受理 runId 等各自的 async-complete 事件，
// entry 生命周期与整体状态全程落盘 run.json。
//
// 执行语义（M2 极简；M3-T3 增预算硬上限与层内并发钳制）：
//   读取现有 run.json → status=running → 拓扑分层逐层执行（层内并行 spawn、层间串行；
//   ctx.budget 存在时：计划步数超顶 → 拒绝执行整个计划[不 spawn 任何步]；
//   层内并发按 maxParallelSubagents 分批钳制[批内并行、批间串行、某批失败不开下批]）
//   → 全部成功 status=completed；任一步失败 / 手工中止（signal）→ status=failed、
//   错误入对应 entry、整体失败即返回（不重试——重试与迭代是 M4 的领域）。
//   预算拒绝对应的 run 级 error 一律以 "budget_exhausted:" 前缀落痕（诚实遥测 §7.3）。
//
// 协议事实（T1 锚定）：spawn 的 reply 只是受理（可能含 runId）；完成经
// "subagent:async-complete" 事件通知，payload 结构未完全文档化——完成结果的解读
// 全走防御性读取（见 readCompletion），T5 冒烟再与真实结构校准。

import * as fs from "node:fs";
import * as path from "node:path";

import {
	ABORTED,
	COMPLETION_TIMEOUT_MS,
	STOP_TIMEOUT_MS,
	createAbortWatch,
} from "./consts.ts";
import { topoLayers } from "./dag.ts";
import type { SubagentsRpcClient } from "./rpc.ts";
import type { RunRecord } from "../storage/workspace.ts";
import type { IterationEntry, PlanDraft, PlanStep } from "../types.ts";

// 关于 ctx.rpc 的方法面：任务书基线 Pick 是 "spawn"|"stop"|"request"，但同一段
// 执行流明确要求 "waitForCompletion(runId) 拿完成"（T1 挂点方法集 request/spawn/
// stop/waitForCompletion 的成员）——不含它的 Pick 无法表达该执行流（类型都无法编译）。
// 故取超集：request 保留为能力面（T4 可用于 ping 探测等），本模块自身不直接调用。

/** 进度更新事件（onUpdate 的透传形状）；summary 从完成 payload 防御性抽取，结构不明时省略 */
export interface PlanUpdate {
	stepId: string;
	agent: string;
	status: IterationEntry["status"];
	summary?: string;
}

/** executePlan 的依赖注入上下文（结构类型——测试注入 fake rpc 与临时 dataDir） */
export interface ExecutePlanContext {
	rpc: Pick<
		SubagentsRpcClient,
		"spawn" | "stop" | "request" | "waitForCompletion"
	>;
	/** 目标 run 记录 id（<dataDir>/runs/<runId>/run.json 必须已存在） */
	runId: string;
	/** 数据根目录（生产 ~/.pi/loop/，测试临时目录） */
	dataDir: string;
	/**
	 * 预算硬上限（SPEC §7.3，M3-T3；由 T4 从生效档位 EffortPreset 派生注入）。
	 * 可选——缺省即 M2 行为零变化（不校验步数、层内全并行）。生效语义：
	 *   - plan.steps.length > maxPlanSteps → 拒绝执行整个计划
	 *     （status=failed + error="budget_exhausted: plan steps N > max M"，不 spawn 任何步；
	 *     Designer/plan-schema 侧已先行校验——此处是执行层的双保险闸）
	 *   - 层内并发 > maxParallelSubagents → 分批串行（批内并行；某批失败不开下批）
	 */
	budget?: {
		/** 计划步骤数硬顶（超过即拒绝执行整个计划；恰好在上限 → 照常执行） */
		maxPlanSteps: number;
		/** 层内并发上限（同层超出分批钳制，不静默丢弃） */
		maxParallelSubagents: number;
	};
	onUpdate?: (update: PlanUpdate) => void;
	signal?: AbortSignal;
}

/** 遥测汇总（T4 填 LoopToolResult 的数据源；计数按 iterations 终态统计） */
export interface RunOutcome {
	/** 计划步骤总数 */
	steps: number;
	/** 成功步骤数 */
	succeeded: number;
	/** 失败步骤数 */
	failed: number;
	/** executePlan 自身耗时（毫秒） */
	durationMs: number;
	/** 最终迭代记录快照（与 run.json 落盘内容一致） */
	iterations: IterationEntry[];
	/**
	 * 层内并发钳制的分批执行数（budget 传入时才出现的字段：「全部已开出的批次」
	 * 的累计——层内不需分批时等于层数，拒绝执行时为 0；budget 缺省时字段缺省，
	 * 保持 M2 返回形状零回归）。
	 */
	batches?: number;
	/**
	 * 运行级终止原因（run.json run 级 error 落痕的同源镜像：预算拒绝 →
	 * "budget_exhausted: …" 前缀，中止 → "aborted"；step 级失败不设——错误细节
	 * 在各 entry。T4 据此区分 LoopToolResult 的 budget_exhausted 收尾）。
	 */
	error?: string;
}

// 完成等待 / 收尾超时与 abortWatch 自 M4-T0 起收敛于 ./consts.ts（M3 终审 M-5 债：
// 常量值不变只是搬家——waitForCompletion 的 timeoutMs 断言锁定的仍是同值 10 分钟，
// 与 designer 共享单一真源，命名统一为 COMPLETION_TIMEOUT_MS——spawn 等待本无步语义）。

/**
 * spawn 失败的「超时/无应答」特征判定（M-1，M2 终审收口）：pi-subagents 缺席的
 * 真实形态是请求无人应答直至客户端超时——SubagentsRpcClient 对此以 code:"timeout"
 * 抛 RpcError。按结构化判据检测（不引用具体类——本模块按结构类型消费注入的 rpc，
 * fake 抛的裸 Error 同样适用）：①错误对象携带 code==="timeout"；②错误消息含
 * 无应答特征（"无 reply"/"超时"）。agent 不存在等真实拒绝两判据皆不沾——返回
 * false，调用方不附安装引导、原样呈现失败原因（不把「已安装但被拒绝」误归因为
 * 「未安装」）。
 *
 * M3-T5 起导出供 designer.ts 的 spawn 失败分支复用（M3-T4 review M-2 收口：
 * designer 降级 notes 的安装引导与 orchestrator 的 M-1 采用同款门控，单一真源）。
 */
export function isNoReplyTimeout(error: unknown): boolean {
	const code =
		error !== null && typeof error === "object"
			? (error as { code?: unknown }).code
			: undefined;
	if (code === "timeout") return true;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("无 reply") || message.includes("超时");
}

/** run.json 路径（与 storage/workspace.createRunRecord 同构：<dataDir>/runs/<id>/run.json） */
function runJsonPath(dataDir: string, runId: string): string {
	return path.join(dataDir, "runs", runId, "run.json");
}

/**
 * 读取现有 run 记录；不存在 / 损坏 / 缺 iterations 数组都是错误（调用方负责呈现）。
 * 返回类型附加 run 级 error 可选字段——abort 落痕（T4 收口，T3 review M1）：
 * 层间检查点中止时不产生任何 entry，run 级 error 是该次中止除 status=failed 外的唯一痕迹。
 */
function loadRunRecord(
	dataDir: string,
	runId: string,
): RunRecord & { error?: string } {
	const file = runJsonPath(dataDir, runId);
	if (!fs.existsSync(file)) {
		throw new Error(
			`run 记录不存在：${file}（先经 createRunRecord 建立再执行计划）`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		throw new Error(`run 记录损坏（JSON 解析失败）：${file}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as { iterations?: unknown }).iterations)
	) {
		throw new Error(`run 记录结构非法（缺 iterations 数组）：${file}`);
	}
	return parsed as RunRecord & { error?: string };
}

/**
 * 层内并发钳制（budget 生效时）：把一层切成 ≤ maxParallelSubagents 的批序列——
 * 批内并行（Promise.all）、批间串行（上批全部结算后才发下批；某批失败不开
 * 下批，沿用 M2 层间 fail-fast 语义，不静默丢弃步骤）。budget 缺省
 * （maxParallel 为 undefined）时返回 [layer] 单一整批——与 M2 的层内全并行
 * 逐字等价（既有用例零回归的连接点）。前置：maxParallel ≥ 1（budget 形状校验）
 * 且 layer 非空（topoLayers 不产生空层）。
 */
function chunkLayer(
	layer: PlanStep[],
	maxParallel: number | undefined,
): PlanStep[][] {
	if (maxParallel === undefined) return [layer];
	const batches: PlanStep[][] = [];
	for (let start = 0; start < layer.length; start += maxParallel) {
		batches.push(layer.slice(start, start + maxParallel));
	}
	return batches;
}

/** 完成事件的防御性解读结果 */
interface CompletionReading {
	/** 是否失败 */
	failed: boolean;
	/** 失败原因（failed 时必有） */
	error?: string;
	/** 摘要（onUpdate 透传用；payload 无可读摘要时缺省） */
	summary?: string;
	/** 输出引用（完成 payload 的 output/outputPath/result.output/results[0] 产物引用，宽集合） */
	outputRef?: string;
}

/** 依次返回第一个非空字符串（防御性抽取） */
function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** outputReference 形态兼容（Fix round 2）：string 直取，{path} 对象取 path，其余落空 */
function stringOrPath(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (value !== null && typeof value === "object") {
		const inner = (value as { path?: unknown }).path;
		if (typeof inner === "string" && inner.length > 0) return inner;
	}
	return undefined;
}

/** 摘要截断（onUpdate 面向用户单行提示，超长截 200） */
function truncate(text: string, max = 200): string {
	return text.length <= max ? text : text.slice(0, max) + "…";
}

/** error 字段的防御性文案化（字符串直用；对象取 message，退而 JSON 化） */
function describeError(error: unknown): string | undefined {
	if (typeof error === "string" && error.length > 0) return error;
	if (error !== null && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}
	return undefined;
}

/**
 * async-complete payload 的防御性解读（结构未完全文档化，T5 冒烟再校准）：
 * 失败信号——status 为 failed/error/aborted、ok/success 显式 false、error 字段非 null；
 * 其余（含无可读标记的 payload）按成功处理——事件到达即完成，缺错误标记即视为无错。
 */
function readCompletion(payload: unknown): CompletionReading {
	const reading: CompletionReading = { failed: false };
	if (payload === null || typeof payload !== "object") {
		return reading;
	}
	const p = payload as Record<string, unknown>;
	const result =
		p.result !== null && typeof p.result === "object"
			? (p.result as Record<string, unknown>)
			: {};
	const status = typeof p.status === "string" ? p.status : "";
	reading.failed =
		["failed", "error", "aborted"].includes(status) ||
		p.ok === false ||
		p.success === false ||
		(p.error !== undefined && p.error !== null);
	if (reading.failed) {
		reading.error =
			describeError(p.error) ??
			(status.length > 0
				? `subagent 报告失败状态 "${status}"（未携带错误详情）`
				: "subagent 执行失败（完成事件未携带错误详情）");
	}
	const summary = firstString(
		p.summary,
		result.summary,
		typeof p.result === "string" ? p.result : undefined,
	);
	if (summary !== undefined) reading.summary = truncate(summary);
	// outputRef 宽集合（Fix round 2 实测校准）：真实完成事件（pi-subagents
	// CompletionNotification）不含顶层 output/outputPath——产物路径在
	// results[0].outputReference（string | {path}）与 results[0].artifactPaths.outputPath
	// （实验证的另一个候选源为 savedOutputPath，仅在 foreground 层存在，不属本事件形）；
	// 顶层三字段保留（fake/旧形态兼容），firstString 类型守卫取 string 即用
	const first = Array.isArray(p.results)
		? ((p.results as Array<Record<string, unknown>>)[0] ?? {})
		: {};
	const artifacts =
		typeof first.artifactPaths === "object" && first.artifactPaths !== null
			? (first.artifactPaths as Record<string, unknown>)
			: {};
	const outputRef = firstString(
		p.output,
		p.outputPath,
		result.output,
		stringOrPath(first.outputReference),
		artifacts.outputPath,
	);
	if (outputRef !== undefined) reading.outputRef = outputRef;
	return reading;
}

/**
 * 执行研究计划：读取 run 记录 → status=running → 拓扑分层逐层调度 → completed | failed。
 *
 * 失败语义（M2 极简）：任一步失败 / 手工中止（signal）→ 整体 failed 即返回，错误落
 * 对应 entry；不重试。基建类异常（计划校验、run.json、磁盘）标记 failed 后原样上抛
 * （调用方负责用户可感的错误呈现）。onUpdate 不投递 pending（受理即转 running，pending
 * 只是磁盘上的中转瞬态）。
 *
 * @returns 遥测汇总（iterations 为返回时刻的快照，与 run.json 落盘内容一致）
 */
export async function executePlan(
	plan: PlanDraft,
	ctx: ExecutePlanContext,
): Promise<RunOutcome> {
	const startMs = Date.now();
	const record = loadRunRecord(ctx.dataDir, ctx.runId);

	// budget 注入面契约（受理前校验，与 run 记录缺席同类）：形状非法即原样上抛，
	// run 记录保持磁盘原状（status 尚未迁移 running，无收尾义务）。
	// 不静默钳位修正（如 maxParallelSubagents=0 当 1）——隐藏调用方 bug 不如报错
	if (ctx.budget !== undefined) {
		const shapeOk = (v: number): boolean => Number.isInteger(v) && v >= 1;
		if (
			!shapeOk(ctx.budget.maxPlanSteps) ||
			!shapeOk(ctx.budget.maxParallelSubagents)
		) {
			throw new TypeError(
				"budget 形状非法：maxPlanSteps 与 maxParallelSubagents 都必须是 ≥1 的整数",
			);
		}
	}

	// 预算硬上限第一道闸（SPEC §7.3，执行层双保险—— Designer/plan-schema 侧已先行
	// 校验，此处是最后闸门）：计划步数超顶 → 拒绝执行整个计划。
	// 不置 running、不 spawn 任何步：run 直接落 status=failed + 运行级 error
	// （budget_exhausted: 前缀，诚实遥测）后即返；已完成 entry 语义不适用（一个未开）
	if (ctx.budget !== undefined && plan.steps.length > ctx.budget.maxPlanSteps) {
		const reason = `budget_exhausted: plan steps ${plan.steps.length} > max ${ctx.budget.maxPlanSteps}`;
		record.status = "failed";
		record.error = reason;
		saveRecord();
		return {
			steps: plan.steps.length,
			succeeded: 0,
			failed: 0,
			durationMs: Date.now() - startMs,
			iterations: [...record.iterations],
			batches: 0, // 拒绝执行：一批准也未开出（budget 已生效——字段在场）
			error: reason,
		};
	}

	// 状态机（计划锚定）：created → running → completed | failed
	record.status = "running";
	saveRecord();

	const abortWatch = createAbortWatch(ctx.signal);
	/** 局部：进度回调透传（onUpdate 缺省时直接空） */
	const emitUpdate = (
		step: PlanStep,
		status: IterationEntry["status"],
		summary?: string,
	): void => {
		if (!ctx.onUpdate) return;
		const update: PlanUpdate = { stepId: step.id, agent: step.agent, status };
		if (summary !== undefined) update.summary = summary;
		ctx.onUpdate(update);
	};
	/** 局部：entry 判失败——错误落 entry、落盘、透传 onUpdate，返回 false */
	const failEntry = (
		entry: IterationEntry,
		step: PlanStep,
		message: string,
		summary?: string,
	): false => {
		entry.status = "failed";
		entry.error = message;
		entry.endedAt = new Date().toISOString();
		saveRecord();
		emitUpdate(step, "failed", summary);
		return false;
	};

	/** 单步执行：pending → spawn 受理 → running → waitForCompletion → succeeded | failed */
	async function runStep(step: PlanStep): Promise<boolean> {
		// ① spawn 前先落 pending entry（即使 spawn 失败，run.json 也留有该步进入计划的事实）
		const entry: IterationEntry = {
			stepId: step.id,
			agent: step.agent,
			status: "pending",
		};
		record.iterations.push(entry);
		saveRecord();

		// ② abort 快速短路：已中止则不再发起新 subagent
		if (ctx.signal?.aborted) {
			return failEntry(entry, step, "aborted");
		}

		// ③ spawn 受理（pi-subagents 不在场时以超时拒绝——附安装引导文案）
		let runId: string | undefined;
		try {
			const acceptance = await ctx.rpc.spawn({
				agent: step.agent,
				task: step.task,
				context: "fresh",
				// step.model M2 不消费：spawn 不指定 model 即继承会话默认（用户规则）
			});
			runId = acceptance.runId;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// M-1（M2 终审收口）：安装引导仅在超时/无应答特征时附加——pi-subagents 缺席
			// 的真实形态；agent 不存在等真实拒绝原样报错，不误归因为「请安装」
			return failEntry(
				entry,
				step,
				isNoReplyTimeout(error)
					? `${message}（pi-subagents 不在或不可用——请安装 pi-subagents 扩展后重试）`
					: message,
			);
		}

		// ④ 受理即视为该步 running（startedAt 落盘 + onUpdate）
		entry.status = "running";
		entry.startedAt = new Date().toISOString();
		saveRecord();
		emitUpdate(step, "running");

		// ⑤ 受理缺省 runId：仅单步计划可降级（等待任意完成事件）——多步下事件归属无法区分
		if (runId === undefined && plan.steps.length > 1) {
			return failEntry(
				entry,
				step,
				"spawn 受理未返回 runId：多步计划下无法区分各步的完成事件",
			);
		}

		// ⑥ 等待完成：按 runId 匹配的事件 + abort 竞速（Promise.race）
		let completion: unknown;
		try {
			completion = await Promise.race([
				ctx.rpc.waitForCompletion(runId, COMPLETION_TIMEOUT_MS),
				abortWatch.promise,
			]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return failEntry(entry, step, `waitForCompletion 异常: ${message}`);
		}
		if (completion === ABORTED) {
			// 手工中止：尽力 stop 在途 run（失败/超时不阻断收尾），该步记 aborted
			if (runId !== undefined) {
				await ctx.rpc.stop(runId, STOP_TIMEOUT_MS).catch(() => undefined);
			}
			return failEntry(entry, step, "aborted");
		}
		if (completion === null || completion === undefined) {
			return failEntry(
				entry,
				step,
				`等待完成超时（${COMPLETION_TIMEOUT_MS}ms 内无匹配 async-complete 事件）`,
			);
		}
		const reading = readCompletion(completion);
		if (reading.failed) {
			return failEntry(
				entry,
				step,
				reading.error ?? "subagent 执行失败",
				reading.summary,
			);
		}
		entry.status = "succeeded";
		entry.endedAt = new Date().toISOString();
		if (reading.outputRef !== undefined) entry.outputRef = reading.outputRef;
		saveRecord();
		emitUpdate(step, "succeeded", reading.summary);
		return true;
	}

	function saveRecord(): void {
		fs.writeFileSync(
			runJsonPath(ctx.dataDir, ctx.runId),
			JSON.stringify(record, null, "\t") + "\n",
		);
	}

	let planFailed = false;
	/** 层内并发上限（budget 缺省 = 不钳制：整层一批，与 M2 层内全并行逐字等价） */
	const maxParallel = ctx.budget?.maxParallelSubagents;
	/** 已开出的执行批次数（budget 生效时随 outcome 遥测上报） */
	let batchesIssued = 0;
	try {
		const layers = topoLayers(plan.steps);
		for (const layer of layers) {
			// abort 检查点：每层开始（层与层之间）
			if (ctx.signal?.aborted) {
				planFailed = true;
				break;
			}
			// 层内并行（budget 钳制时按 maxParallelSubagents 分批：批内并行、批间串行）：
			// 每步独立 spawn（受理顺序无关紧要），整批 settle 后才发下批；
			// 层内失败者已各自落 failed entry，其余在途步自然结算完成（不产生悬挂 subagent）
			for (const batch of chunkLayer(layer, maxParallel)) {
				// abort 检查点：批与批之间（与层间同语义——中止后不再开新批；
				// 兜住「整批已恰好完成但下一批尚未发出」的竞速窗口）
				if (ctx.signal?.aborted) {
					planFailed = true;
					break;
				}
				if (ctx.budget !== undefined) batchesIssued++;
				const outcomes = await Promise.all(batch.map((step) => runStep(step)));
				if (outcomes.includes(false)) {
					planFailed = true; // 批内失败：不开下批/后续层（不重试——M4 领域）
					break;
				}
			}
			if (planFailed) break;
		}
	} catch (error) {
		// 计划校验 / 基建类异常（JSON.parse、磁盘等）：run 标记 failed 后原样上抛
		planFailed = true;
		throw error;
	} finally {
		abortWatch.dispose();
		record.status = planFailed ? "failed" : "completed";
		// abort 落痕（T4 收口）：因中止而失败的 run 在 run 级也记 error="aborted"
		if (planFailed && ctx.signal?.aborted) record.error = "aborted";
		saveRecord();
	}

	// 遥测（快照：防迟到的在途结算改动已返回的对象）
	const iterations = [...record.iterations];
	const outcome: RunOutcome = {
		steps: plan.steps.length,
		succeeded: iterations.filter((entry) => entry.status === "succeeded").length,
		failed: iterations.filter((entry) => entry.status === "failed").length,
		durationMs: Date.now() - startMs,
		iterations,
	};
	// budget 生效的运行才上报分批遥测（budget 缺省路径的字段形保持 M2 逐字零回归）
	if (ctx.budget !== undefined) outcome.batches = batchesIssued;
	// 运行级 error 落痕的镜像（中止时 finally 已记 "aborted"；预算拒绝在早退路径
	// 已直接返回）——step 级失败不在此列（细节在各 entry）
	if (record.error !== undefined) outcome.error = record.error;
	return outcome;
}
