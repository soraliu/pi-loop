// pi-loop 调度内核（M2-T3）
// 依据 docs/SPEC.md §4（Orchestrator 契约）、docs/plans/m2-orchestrator.md Task 3。
//
// 与编译器路线（planner-static.ts）的关键差异：编译器把整个计划编成一段 workflowScript
// 交给宿主执行；本模块逐步 dispatch——每个步骤单独 spawn（结构化接口
// `{ agent, task, context: "fresh" }`），以受理 runId 等各自的 async-complete 事件，
// entry 生命周期与整体状态全程落盘 run.json。
//
// 执行语义（M2 极简）：
//   读取现有 run.json → status=running → 拓扑分层逐层执行（层内并行 spawn、层间串行）
//   → 全部成功 status=completed；任一步失败 / 手工中止（signal）→ status=failed、
//   错误入对应 entry、整体失败即返回（不重试——重试与迭代是 M4 的领域）。
//
// 协议事实（T1 锚定）：spawn 的 reply 只是受理（可能含 runId）；完成经
// "subagent:async-complete" 事件通知，payload 结构未完全文档化——完成结果的解读
// 全走防御性读取（见 readCompletion），T5 冒烟再与真实结构校准。

import * as fs from "node:fs";
import * as path from "node:path";

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
}

/** 单步完成等待超时上限：真实研究 agent 可跑数分钟，取保守宽裕值（M2 固定；M4 再与 effort 档位挂钩） */
const STEP_COMPLETION_TIMEOUT_MS = 10 * 60_000;

/** abort 收尾时 stop 的等待上界：超时即放弃 stop 确认（不阻断整体失败收尾） */
const STOP_TIMEOUT_MS = 10_000;

/** abort 竞速哨兵：完成 payload 是对象或 null，Symbol 保证不与之混淆 */
const ABORTED = Symbol("pi-loop:aborted");

/** signal → 一次性 settle 的"已中止"哨兵 promise（竞速的从方） */
interface AbortWatch {
	promise: Promise<typeof ABORTED>;
	dispose: () => void;
}

function createAbortWatch(signal?: AbortSignal): AbortWatch {
	let resolveAbort!: (value: typeof ABORTED) => void;
	const promise = new Promise<typeof ABORTED>((resolve) => {
		resolveAbort = resolve;
	});
	const onAbort = (): void => resolveAbort(ABORTED);
	if (signal?.aborted) onAbort(); // 已中止：立即 settle（层开始与 spawn 前的检查点兜底）
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		promise,
		dispose: () => signal?.removeEventListener("abort", onAbort),
	};
}

/** run.json 路径（与 storage/workspace.createRunRecord 同构：<dataDir>/runs/<id>/run.json） */
function runJsonPath(dataDir: string, runId: string): string {
	return path.join(dataDir, "runs", runId, "run.json");
}

/** 读取现有 run 记录；不存在 / 损坏 / 缺 iterations 数组都是错误（调用方负责呈现） */
function loadRunRecord(dataDir: string, runId: string): RunRecord {
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
	return parsed as RunRecord;
}

/**
 * 拓扑分层（编译器同算法的独立实现——它的版本不导出，且 orchestrator 走逐步
 * spawn 路线不消费其产物）：层内步骤互不依赖（并行 spawn），层间串行。
 * 校验：空计划 / 重复 id / 未知依赖 / 不可分层（依赖环）都抛错。
 * 注：dependsOn 重复项（如 ["a","a"]）在本 filter 实现下不构成伪环
 * （编译器侧按计数 Kahn 会保守报环——该差异由 planner 负例锁定）。
 */
function topoLayers(steps: PlanStep[]): PlanStep[][] {
	if (steps.length === 0) {
		throw new Error("计划校验失败：计划不含任何步骤");
	}
	const byId = new Map<string, PlanStep>();
	for (const step of steps) {
		if (byId.has(step.id)) {
			throw new Error(`计划校验失败：步骤 id 重复 "${step.id}"`);
		}
		byId.set(step.id, step);
	}
	for (const step of steps) {
		for (const dep of step.dependsOn) {
			if (!byId.has(dep)) {
				throw new Error(
					`计划校验失败：步骤 "${step.id}" 依赖不存在的步骤 "${dep}"`,
				);
			}
		}
	}
	const layers: PlanStep[][] = [];
	const remaining = new Map(byId);
	while (remaining.size > 0) {
		const layer = [...remaining.values()].filter((step) =>
			step.dependsOn.every((dep) => !remaining.has(dep)),
		);
		if (layer.length === 0) {
			throw new Error("计划分层失败：剩余步骤存在依赖环");
		}
		for (const step of layer) remaining.delete(step.id);
		layers.push(layer);
	}
	return layers;
}

/** 完成事件的防御性解读结果 */
interface CompletionReading {
	/** 是否失败 */
	failed: boolean;
	/** 失败原因（failed 时必有） */
	error?: string;
	/** 摘要（onUpdate 透传用；payload 无可读摘要时缺省） */
	summary?: string;
	/** 输出引用（payload 带 output/outputPath/result.output 时） */
	outputRef?: string;
}

/** 依次返回第一个非空字符串（防御性抽取） */
function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
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
	const outputRef = firstString(p.output, p.outputPath, result.output);
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
			return failEntry(
				entry,
				step,
				`${message}（pi-subagents 不在或不可用——请安装 pi-subagents 扩展后重试）`,
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
				ctx.rpc.waitForCompletion(runId, STEP_COMPLETION_TIMEOUT_MS),
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
				`等待完成超时（${STEP_COMPLETION_TIMEOUT_MS}ms 内无匹配 async-complete 事件）`,
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
	try {
		const layers = topoLayers(plan.steps);
		for (const layer of layers) {
			// abort 检查点：每层开始（层与层之间）
			if (ctx.signal?.aborted) {
				planFailed = true;
				break;
			}
			// 层内并行：每步独立 spawn（受理顺序无关紧要），全部 settle 后才进下一层；
			// 层内失败者已各自落 failed entry，其余在途步会自然结算完成（不产生悬挂 subagent）
			const outcomes = await Promise.all(layer.map((step) => runStep(step)));
			if (outcomes.includes(false)) {
				planFailed = true; // 失败即返：不执行后续层（不重试——M4 领域）
				break;
			}
		}
	} catch (error) {
		// 计划校验 / 基建类异常（JSON.parse、磁盘等）：run 标记 failed 后原样上抛
		planFailed = true;
		throw error;
	} finally {
		abortWatch.dispose();
		record.status = planFailed ? "failed" : "completed";
		saveRecord();
	}

	// 遥测（快照：防迟到的在途结算改动已返回的对象）
	const iterations = [...record.iterations];
	return {
		steps: plan.steps.length,
		succeeded: iterations.filter((entry) => entry.status === "succeeded").length,
		failed: iterations.filter((entry) => entry.status === "failed").length,
		durationMs: Date.now() - startMs,
		iterations,
	};
}
