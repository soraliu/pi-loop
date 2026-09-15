// pi-loop 迭代引擎（M4-T2）：SPEC §4 的核心闭环
// evaluate fail → 注入归因 → 重跑 → 通过（或预算尽如实收尾）。
//
// 循环结构（Round 计数口径：0 起计，round 0 = 首轮无注入）：
//   generatePlan（首轮；重设计时再调一次——designer 自带降级链，不抛出）
//   → 每轮：executePlan →（entries 分轮归组落盘）→ evaluateResult
//   → verified → 收尾 completed（final/evaluation 留档）
//   → 中止（signal）→ 收尾 failed（error="aborted"）
//   → round === preset.maxResultIterations → 收尾 budget_exhausted
//     （error="budget_exhausted: 迭代轮数上限 N 轮用尽（共执行 N+1 轮，最后一轮
//       verdict=X）"+ 最后一轮 evaluation 留档——partial/fail 结论不丢）
//   → 否则 → 重跑（跳过 designer 重生成）
//
// 归因注入面（计划内裁定——「最小注入面」）：保留原 plan，仅 blame 步骤的 task
// 前缀注入上轮失败上下文（"前一轮失败：{reasons 摘要}。请修正此步骤避免同类问题：
// {原 task}"）；非 blame 步骤原样。verifyCommand 通道 blame 恒空（退出码断言无轮次
// 归因概念）→ 原样重跑（重跑的改良来源只剩子代理 fresh 重跑的非确定性——如实，
// 不虚报归因）。每轮从「当前保留计划」重新派生前缀（不叠加旧前缀——素材取最近
// 一轮的失败上下文）。
//
// designer 重设计启发式（计划内裁定）：「全部步骤 fail 且连续 2 轮同因」才重设计——
// 实现为「blame 覆盖计划全部步骤 且 前后两轮 reasons 相似（字符 bigram Jaccard ≥
// 0.6，完全相等短路通过；任一侧为空视为不同因）」。重设计轮以 fresh 计划执行（不
// 注入——fresh 计划自带完整上下文），run.json.plan 由扩展层经 adapter.onPlanDesigned
// 更新（core 不反向依赖 extension 的映射函数）。省预算且防设计漂移：单一失败轮
// 不重设计。
//
// 诚实遥测（SPEC §7.4）：verified 只能来自 evaluator（机器断言/critic 结论原文）；
// 本引擎对一切非 verified 收尾如实留档（evaluation/final），不虚报通过。终态
// telemetry 随收尾一并落盘（agents=/全轮 entry 去重计数 + 末轮口径计数——零执行
// 事实时整个块 omit，不写假 0）。
//
// M5-T3 检索透传：IterateContext.retrieved 检索注入素材的透传管道——扩展层在 run
// 头部（prepareRun 后、generatePlan 前）经 listMethods+listCases+retrieve 算好传入；
// core 不做 IO 检索，首轮与重设计的 generatePlan 均透传同一份（run 内任务与库不变）。

import * as fs from "node:fs";
import * as path from "node:path";

import { generatePlan, type DesignerOutcome } from "./designer.ts";
import { evaluateResult } from "./evaluator.ts";
import {
	executePlan,
	type PlanUpdate,
	type RunOutcome,
} from "./orchestrator.ts";
import type { SubagentsRpcClient } from "./rpc.ts";
import type { RetrievalResult } from "./retrieval.ts";
import type { RunRecord } from "../storage/workspace.ts";
import type {
	Evaluation,
	EffortPreset,
	IterationEntry,
	LoopPlanBrief,
	ResearchPlan,
} from "../types.ts";

/** 迭代进度事件：轮次事件（本引擎发出）与步骤事件（executePlan 的 PlanUpdate 原样透传） */
export interface RoundEvent {
	/** 判别键（PlanUpdate 无 kind 字段——"kind" in update 判别联合） */
	kind: "round";
	/** 轮次（0 起计——0=首轮） */
	round: number;
	phase: "start" | "end";
	/** phase="end" 时在场：本轮评估结论 */
	verdict?: Evaluation["verdict"];
	/** phase="end" 时在场 */
	score?: number;
	/** phase="end" 时在场：后续去向 */
	next?: "retry" | "redesign" | "done" | "budget_exhausted" | "abort";
}

/** onUpdate 的联合事件形（loop-task 透传给工具 onUpdate 与命令 notify） */
export type IterateUpdate = RoundEvent | PlanUpdate;

/** 迭代引擎与扩展层（run.json 集成面）的钩子集合 */
export interface IterateAdapter {
	/**
	 * 首轮与重设计后各调用一次：designer 结局交由扩展层（负责 DesignerOutcome →
	 * RunRecord.plan 的映射与落盘——core 不反向依赖 extension 的映射函数）。
	 */
	onPlanDesigned?(designed: DesignerOutcome): void;
}

/** runWithIterations 的依赖注入上下文（结构类型——测试注入 fake rpc 与临时目录） */
export interface IterateContext {
	/** pi-subagents RPC 方法面（超集：executePlan 的 Pick 含 request，本模块自身不直接调用 request） */
	rpc: Pick<
		SubagentsRpcClient,
		"spawn" | "stop" | "request" | "waitForCompletion"
	>;
	/** 目标 run id（<dataDir>/runs/<runId>/run.json 必须已存在——迭代引擎在其上追加轮次结构） */
	runId: string;
	/** 数据根目录（生产 ~/.pi/loop/，测试临时目录；verifyCommand 的执行 cwd） */
	dataDir: string;
	/** 用户中止信号（中止 → 不再开下一轮，以 failed 收尾如实留档） */
	signal?: AbortSignal;
	/** 进度回调（步骤事件透传 executePlan 的 onUpdate；轮次事件由本引擎发出） */
	onUpdate?: (update: IterateUpdate) => void;
	/** 机器验收命令（在场即唯一权威——零 critic spawn；blame 恒空导致重跑为原样重跑） */
	verifyCommand?: string;
	/**
	 * 迟到完成对账读取器（B-1 修复，透传给 executePlan 的注入面——见该接口注释；
	 * 缺省 undefined = 既有语义零变化，仅超时判死 + stop 切断注入后的新行为）
	 */
	readLateCompletion?: (runId: string) => unknown | undefined;
	/**
	 * 相似检索结果（M5-T3 检索连线）：扩展层在 prepareRun 后经 listMethods+listCases+
	 * retrieve 算好传入（"下一次 run 时"的贯通线——上一 run 的入档发生在它的收尾，本轮的
	 * 检索发生在头部，自引用不可能）。首轮与重设计的 generatePlan 均透传同一份（run
	 * 内任务与库不变，不重复检索）；缺省 = 无注入（M4 行为不变），空检索（双列空）由
	 * generatePlan 自然省略参考段（零成本路径）
	 */
	retrieved?: RetrievalResult;
	/** 扩展层集成钩子（plan 元信息落盘等） */
	adapter?: IterateAdapter;
}

/** 迭代闭环的收尾结论（loop-task 据此构造 LoopToolResult） */
export interface IterationResult {
	/** verified=评估通过；budget_exhausted=迭代预算尽（或执行层计划预算拒绝）；failed=中止等其他终止 */
	outcome: "verified" | "budget_exhausted" | "failed";
	/** 终止（通过或预算尽）时所在的轮次（0 起计——finalRound+1 = 总执行轮数） */
	finalRound: number;
	/** 最终轮评估结论（预算尽时为最后一轮的 partial/fail——留档不丢） */
	evaluation: Evaluation;
	/** 末轮执行遥测（iterations 为累计快照——含此前各轮 entry；steps 为末轮计划步数） */
	runOutcome: RunOutcome;
	/** 首轮计划元信息（LoopToolResult.plan 同形摘要；重设计后的新计划不覆盖此项——口径见任务报告） */
	plan: LoopPlanBrief;
	/** 运行级终止原因镜像（budget_exhausted=迭代预算文案或计划拒绝原文；failed=aborted；verified 缺省） */
	error?: string;
}

/* ------------------------------------------------------------------
 * run.json 读改写（本轮次结构落盘的唯一出口）——路径构造与 core/orchestrator.ts、
 * storage/workspace.ts 同口径（私有无法 import 的第三处固化，口径由测试的
 * run.json 断言锁定；缩进 tab + 尾换行与全局一致）。
 * ------------------------------------------------------------------ */

/** run.json 路径（<dataDir>/runs/<runId>/run.json） */
function runJsonPath(dataDir: string, runId: string): string {
	return path.join(dataDir, "runs", runId, "run.json");
}

/** 读回 run 记录（必须已存在——调用链上游已建骨架；缺席/损坏按基建异常上抛给调用方收口） */
function readRunRecord(
	dataDir: string,
	runId: string,
): RunRecord & { error?: string } {
	return JSON.parse(
		fs.readFileSync(runJsonPath(dataDir, runId), "utf-8"),
	) as RunRecord & { error?: string };
}

/** 落盘 run 记录（读改写——磁盘为事实源） */
function writeRunRecord(
	dataDir: string,
	runId: string,
	record: RunRecord & { error?: string },
): void {
	fs.writeFileSync(
		runJsonPath(dataDir, runId),
		JSON.stringify(record, null, "\t") + "\n",
	);
}

/** 顶层 round 落盘（执行中当前轮——每轮开始时更新；同值短路省一次写盘） */
function writeRoundMarker(ctx: IterateContext, round: number): void {
	const record = readRunRecord(ctx.dataDir, ctx.runId);
	if (record.round === round) return;
	record.round = round;
	writeRunRecord(ctx.dataDir, ctx.runId, record);
}

/**
 * entries 分轮归组：本轮新 entry 由 orchestrator 追加（不感知轮次——无 round 字段），
 * 此处统一补标当前轮并落盘。返回已补标的全量 entries（含此前各轮）——调用
 * 方自行切出当轮切片（评估只喂当轮：历史轮的失败记录不进入 critic 素材，防归因被
 * 陈旧条目污染）；全量同时用于重建本轮 RunOutcome 的 entry 快照（executePlan
 * 结算时的快照早于补标——entry 无 round 值，不重建则下游按 round 切片全落空：
 * Fix round 1 的 Bug A succeeded 归零 / Bug B 引导被吞同根处）。
 */
function stampEntriesRound(
	ctx: IterateContext,
	round: number,
): IterationEntry[] {
	const record = readRunRecord(ctx.dataDir, ctx.runId);
	let stamped = false;
	for (const entry of record.iterations) {
		if (entry.round === undefined) {
			entry.round = round;
			stamped = true;
		}
	}
	if (stamped) writeRunRecord(ctx.dataDir, ctx.runId, record);
	return record.iterations;
}

/**
 * 收尾落盘：round/evaluation/final 三键 + 终态 status/error + telemetry 遥测块
 * （读改写——磁盘为事实源）。遥测口径（M4-T3，SPEC §5 对账）：steps=末轮计划
 * 步数、succeeded/failed=末轮分轮切片计数（历史轮失败不混入，与
 * buildIteratedResult 的 LoopToolResult.telemetry 同源）、iterations=累计调度
 * 次数、agents=全部轮次 entry 的 agent 去重数、durationMs=闭环墙钟。诚实遥测：
 * 零 entry 即无执行事实（空计划拒绝/预中止短路路径）——整个 telemetry 块
 * omit，不写假 0；SPEC §5 的 turns 无从获得真实轮次数据，恒不落。
 */
function finalizeRunRecord(
	ctx: IterateContext,
	final: {
		status: "completed" | "failed";
		error?: string;
		round: number;
		evaluation: Evaluation;
		/** 末轮执行事实（遥测素材：末轮 steps 与全轮 entries 快照） */
		runOutcome: RunOutcome;
		/** 闭环墙钟毫秒（runWithIterations 入口起计——含 designer/执行/评估等待） */
		wallMs: number;
	},
): void {
	const record = readRunRecord(ctx.dataDir, ctx.runId);
	record.round = final.round;
	record.evaluation = final.evaluation;
	record.final = {
		round: final.round,
		verdict: final.evaluation.verdict,
		score: final.evaluation.score,
	};
	record.status = final.status;
	if (final.error !== undefined) record.error = final.error;
	// agents：全部轮次 entry 的 agent 去重（同一 agent 多步多轮只计 1）——零 entry
	// 即无 spawn 受理事实，telemetry 整体 omit（run.json 无该键，而非全零对象）
	const agents = new Set(final.runOutcome.iterations.map((entry) => entry.agent))
		.size;
	if (agents >= 1) {
		const lastRoundEntries = final.runOutcome.iterations.filter(
			(entry) => entry.round === final.round,
		);
		record.telemetry = {
			steps: final.runOutcome.steps,
			succeeded: lastRoundEntries.filter((entry) => entry.status === "succeeded")
				.length,
			failed: lastRoundEntries.filter((entry) => entry.status === "failed").length,
			iterations: final.runOutcome.iterations.length,
			durationMs: final.wallMs,
			agents,
		};
	}
	writeRunRecord(ctx.dataDir, ctx.runId, record);
}

/* ------------------------------------------------------------------
 * 归因注入与重设计启发式
 * ------------------------------------------------------------------ */

/** 归因注入前缀的 reasons 摘要长度上限（防超长 reasons 撑爆重跑 prompt；超长截尾附省略号） */
const INJECT_REASONS_MAX = 400;

/** reasons 摘要（join("；")，超 400 字截尾）——注入前缀的唯一素材 */
function summarizeReasons(reasons: string[]): string {
	const text = reasons.join("；");
	return text.length <= INJECT_REASONS_MAX
		? text
		: text.slice(0, INJECT_REASONS_MAX) + "…";
}

/**
 * 归因注入（「最小注入面」）：保留原 plan，仅 blame 步骤的 task 前缀注入上轮失败
 * 上下文（任务书裁定文案）；非 blame 步骤原样。blame 为空（verifyCommand 通道/
 * critic 未指认）→ 计划原样返回。
 */
function planWithBlameInjection(
	plan: ResearchPlan,
	evaluation: Evaluation,
): ResearchPlan {
	if (evaluation.blame.length === 0) return plan;
	const blame = new Set(evaluation.blame);
	const prefix = `前一轮失败：${summarizeReasons(evaluation.reasons)}。请修正此步骤避免同类问题：`;
	return {
		...plan,
		steps: plan.steps.map((step) =>
			blame.has(step.id) ? { ...step, task: prefix + step.task } : step,
		),
	};
}

/** 各步验收标准的映射（evaluateResult 的 acceptanceByStep 输入形——key 为 stepId） */
function acceptanceByStepOf(
	plan: ResearchPlan,
): Record<string, string | undefined> {
	const map: Record<string, string | undefined> = {};
	for (const step of plan.steps) map[step.id] = step.acceptance;
	return map;
}

/** reasons 相似度阈值（字符 bigram Jaccard）——「连续 2 轮同因」的启发式判据 */
const REASONS_SIMILARITY_THRESHOLD = 0.6;

/** 字符 bigram 集合（连续 2 字符滑窗——中文友好；单字符文本退化为该字符本身） */
function bigrams(text: string): Set<string> {
	const grams = new Set<string>();
	if (text.length === 0) return grams;
	if (text.length === 1) {
		grams.add(text);
		return grams;
	}
	for (let i = 0; i + 1 < text.length; i++) grams.add(text.slice(i, i + 2));
	return grams;
}

/**
 * 两条 reasons 是否「同因」相似（启发式）：归一化（空白折叠）拼接后做字符 bigram
 * Jaccard ≥ 0.6；完全相等短路通过；任一侧为空视为不同因（无信息不触发重设计）。
 */
function reasonsSimilar(a: string[], b: string[]): boolean {
	const textA = a.join("\n").replace(/\s+/g, " ").trim();
	const textB = b.join("\n").replace(/\s+/g, " ").trim();
	if (textA.length === 0 || textB.length === 0) return false;
	if (textA === textB) return true;
	const gramsA = bigrams(textA);
	const gramsB = bigrams(textB);
	let hits = 0;
	for (const gram of gramsA) {
		if (gramsB.has(gram)) hits++;
	}
	const union = gramsA.size + gramsB.size - hits;
	if (union === 0) return false;
	return hits / union >= REASONS_SIMILARITY_THRESHOLD;
}

/** blame 是否覆盖计划全部步骤（「全部步骤 fail」的实现形；空计划不触发） */
function blameCoversAllSteps(
	evaluation: Evaluation,
	plan: ResearchPlan,
): boolean {
	if (plan.steps.length === 0) return false;
	const blame = new Set(evaluation.blame);
	return plan.steps.every((step) => blame.has(step.id));
}

/* ------------------------------------------------------------------
 * 迭代闭环主入口
 * ------------------------------------------------------------------ */

/**
 * 迭代闭环主入口（M4-T2；loop-task 真实路径的消费点）。
 *
 * 预算语义：preset.maxResultIterations = 改良重跑次数上限（与类型注释「评估不达标
 * 时允许的改良重跑次数」同义；负值防御为 0=只执行首轮）——总执行轮数上界为
 * 1 + maxResultIterations，预算尽文案如实写明两数。
 *
 * @returns IterationResult——业务链不抛出（designer 自降级、evaluator 不抛）；
 *   基建类异常（run.json 缺席/损坏、磁盘）沿 executePlan 等既有语义原样上抛，由
 *   调用方收口。
 */
export async function runWithIterations(
	task: string,
	preset: EffortPreset,
	ctx: IterateContext,
): Promise<IterationResult> {
	const maxReruns = Math.max(0, preset.maxResultIterations);
	// 闭环计时起点（终态 telemetry.durationMs 的口径：本函数入口——含 designer
	// 设计/执行/评估等待的全程，各收尾分支取 Date.now() 差值落盘）
	const loopStartedAt = Date.now();

	// ① 首轮设计（designer 自带降级链，不抛出）；plan 元信息交扩展层落盘
	let designed = await generatePlan(
		task,
		preset,
		{
			rpc: ctx.rpc,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			signal: ctx.signal,
		},
		ctx.retrieved,
	);
	const firstPlanBrief: LoopPlanBrief = {
		origin: designed.plan.origin,
		steps: designed.plan.steps.length,
		degraded: designed.degraded,
	};
	ctx.adapter?.onPlanDesigned?.(designed);
	/** 当前保留的生效计划（重设计时换装；注入每轮由它重新派生——不叠加） */
	let plan: ResearchPlan = designed.plan;

	let round = 0;
	/** 上一轮评估（重设计同因判定的对照；首轮前为空——首个失败轮永不触发重设计） */
	let prevEvaluation: Evaluation | undefined;
	/** 最近一轮评估（重跑轮的归因注入素材） */
	let evaluation: Evaluation | undefined;
	let runOutcome: RunOutcome | undefined;
	/** 本轮计划是否 fresh（首轮/重设计轮：不做 blame 注入——fresh 计划自带完整上下文） */
	let freshPlanRound = true;
	/** 上一轮是否 blame 全覆盖（与 prevEvaluation 同轮事实，独立成布尔避免跨计划错配） */
	let prevBlameAll = false;

	// 循环不变式：每轮要么 return，要么 round++ 进入下一轮（maxReruns 封顶）
	for (;;) {
		const roundPlan =
			freshPlanRound || evaluation === undefined
				? plan
				: planWithBlameInjection(plan, evaluation);
		// 顶层 round 落盘（执行中当前轮）
		writeRoundMarker(ctx, round);
		ctx.onUpdate?.({ kind: "round", round, phase: "start" });
		runOutcome = await executePlan(roundPlan, {
			rpc: ctx.rpc,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			onUpdate: ctx.onUpdate,
			readLateCompletion: ctx.readLateCompletion,
			signal: ctx.signal,
			budget: {
				maxPlanSteps: preset.maxPlanSteps,
				maxParallelSubagents: preset.maxParallelSubagents,
			},
		});

		// 执行层计划预算拒绝（零步骤执行 + budget_exhausted: 前缀）：设计/注入链不
		// 改变步数、重设计经 designer 校验，正常不达此处——防御兜底。对被拒计划做
		// 评估无意义（没有执行事实），以如实的合成 fail 结论直接预算收尾
		if (
			runOutcome.error !== undefined &&
			runOutcome.error.startsWith("budget_exhausted:")
		) {
			const rejected: Evaluation = {
				verdict: "fail",
				score: 0,
				reasons: [`执行层预算拒绝（计划未执行）：${runOutcome.error}`],
				blame: [],
			};
			ctx.onUpdate?.({
				kind: "round",
				round,
				phase: "end",
				verdict: rejected.verdict,
				score: rejected.score,
				next: "budget_exhausted",
			});
			finalizeRunRecord(ctx, {
				status: "failed",
				error: runOutcome.error,
				round,
				evaluation: rejected,
				runOutcome,
				wallMs: Date.now() - loopStartedAt,
			});
			return {
				outcome: "budget_exhausted",
				finalRound: round,
				evaluation: rejected,
				runOutcome,
				plan: firstPlanBrief,
				error: runOutcome.error,
			};
		}

		// ② entries 分轮归组：补标后重建本轮 RunOutcome 的 entry 快照（executePlan
		// 结算时的快照早于补标——entry 无 round 值，不重建则消费侧（末轮分轮切片/
		// 遥测/缺席标记扫描）按 round 过滤全落空——Fix round 1 Bug A/B 同根处）
		const stampedIterations = stampEntriesRound(ctx, round);
		const roundEntries = stampedIterations.filter(
			(entry) => entry.round === round,
		);
		runOutcome = { ...runOutcome, iterations: stampedIterations };

		// ③ 评估（verifyCommand 在场即机器断言唯一权威——零 critic spawn；否则 critic rubric）
		evaluation = await evaluateResult(
			{
				task,
				entries: roundEntries,
				verifyCommand: ctx.verifyCommand,
				acceptanceByStep: acceptanceByStepOf(plan),
				dataDir: ctx.dataDir,
			},
			{ rpc: ctx.rpc, signal: ctx.signal },
		);

		// ④ 后续去向裁定（决定 end 事件语义与下一轮动作）
		const blameAll = blameCoversAllSteps(evaluation, plan);
		const redesign =
			evaluation.verdict !== "verified" &&
			prevEvaluation !== undefined &&
			blameAll &&
			prevBlameAll &&
			reasonsSimilar(prevEvaluation.reasons, evaluation.reasons);
		let next: RoundEvent["next"];
		if (evaluation.verdict === "verified") next = "done";
		else if (ctx.signal?.aborted) next = "abort";
		else if (round >= maxReruns) next = "budget_exhausted";
		else next = redesign ? "redesign" : "retry";
		ctx.onUpdate?.({
			kind: "round",
			round,
			phase: "end",
			verdict: evaluation.verdict,
			score: evaluation.score,
			next,
		});

		if (next === "done") {
			finalizeRunRecord(ctx, {
				status: "completed",
				round,
				evaluation,
				runOutcome,
				wallMs: Date.now() - loopStartedAt,
			});
			return {
				outcome: "verified",
				finalRound: round,
				evaluation,
				runOutcome,
				plan: firstPlanBrief,
			};
		}
		if (next === "abort") {
			// 中止：run 级 error 与 orchestrator 的 abort 落痕同值；evaluation（fail+中止
			// reasons）与 final 仍留档——最后评估事实不丢
			finalizeRunRecord(ctx, {
				status: "failed",
				error: "aborted",
				round,
				evaluation,
				runOutcome,
				wallMs: Date.now() - loopStartedAt,
			});
			return {
				outcome: "failed",
				finalRound: round,
				evaluation,
				runOutcome,
				plan: firstPlanBrief,
				error: "aborted",
			};
		}
		if (next === "budget_exhausted") {
			const message = `budget_exhausted: 迭代轮数上限 ${maxReruns} 轮用尽（共执行 ${round + 1} 轮，最后一轮 verdict=${evaluation.verdict}）`;
			finalizeRunRecord(ctx, {
				status: "failed",
				error: message,
				round,
				evaluation,
				runOutcome,
				wallMs: Date.now() - loopStartedAt,
			});
			return {
				outcome: "budget_exhausted",
				finalRound: round,
				evaluation,
				runOutcome,
				plan: firstPlanBrief,
				error: message,
			};
		}

		// ⑤ 下轮计划演化：重设计（fresh，不注入）或保留原 plan 注入归因（跳过
		// designer 重生成——省预算且防设计漂移）
		if (next === "redesign") {
			designed = await generatePlan(
				task,
				preset,
				{
					rpc: ctx.rpc,
					runId: ctx.runId,
					dataDir: ctx.dataDir,
					signal: ctx.signal,
				},
				ctx.retrieved,
			);
			plan = designed.plan;
			ctx.adapter?.onPlanDesigned?.(designed);
			freshPlanRound = true;
		} else {
			freshPlanRound = false;
		}
		prevEvaluation = evaluation;
		prevBlameAll = blameAll;
		round++;
	}
}
