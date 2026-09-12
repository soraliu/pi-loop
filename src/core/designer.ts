// pi-loop Designer 生成器（M3-T2）
// 依据 docs/plans/m3-designer.md T2、docs/SPEC.md §4（Designer 契约）、§7.3（预算硬上限）。
//
// 生成协议（动态研究计划的产出者）：
//   ① 组装任务文本：任务原文 + 预算约束（maxPlanSteps 步数硬顶 / maxParallelSubagents
//      并行上限）+ 计划结构须知 + 输出契约（两条都要：把 ResearchPlan JSON 写入
//      <runDir>/designer-plan.json 文件 + 最终回复附 ```json 围栏完整副本）
//   ② spawn researcher（M3 无专用 designer agent 定义，researcher 兼任设计）：
//      context:"fresh"（M2 熔断教训：fork+空输出不可靠）、不指定 model（继承会话默认）
//   ③ 完成事件后双通道取产物：文件优先 → 回复围栏副本（末位启发）；
//      validateResearchPlan（sanitize + schema + 结构语义）全过才算成功
//   ④ 校验失败 → 重试（≤2 次；fresh spawn 无记忆，每轮任务文本自带完整模板 + 上轮错误附录）
//   ⑤ rpc 层失败（spawn 受理拒绝 / 完成等待超时）→ 不重试直接降级（与"校验重试"区分）
//   ⑥ 降级 = BUILTIN_PLAN + notes 如实记原因（诚实遥测：降级禁止冒充正常生成）
//
// 口径复用声明（本地固化而非 import 的项）：orchestrator.ts 的
// STEP_COMPLETION_TIMEOUT_MS / STOP_TIMEOUT_MS / createAbortWatch 是模块私有，且该文件
// 由并行任务（M3-T3）维护——本模块按同口径本地实现（10 分钟 / 10 秒 / 同款 abort 竞速），
// 漂移由测试的 timeoutMs 断言锁定。

import * as fs from "node:fs";
import * as path from "node:path";

import { validateResearchPlan } from "./plan-schema.ts";
import { BUILTIN_PLAN } from "./planner-static.ts";
import type { SubagentsRpcClient } from "./rpc.ts";
import type { EffortPreset, ResearchPlan } from "../types.ts";

/** designer 单次 spawn 的完成等待上限：真实研究 agent 可跑数分钟，取保守宽裕值（口径对齐 orchestrator 的 STEP_COMPLETION_TIMEOUT_MS——10 分钟） */
const COMPLETION_TIMEOUT_MS = 10 * 60_000;

/** abort 收尾时 stop 在途 run 的等待上界：超时即放弃确认，不阻断降级收尾（口径对齐 orchestrator 的 STOP_TIMEOUT_MS） */
const STOP_TIMEOUT_MS = 10_000;

/** 校验失败的重试次数上限（SPEC §4：schema 校验失败即重试，2 次后降级内置计划） */
const MAX_RETRIES = 2;
/** 总尝试次数 = 首发 1 + 重试 2（注意：与 preset.maxResultIterations 无关——那是结果迭代轮数，M4 领域） */
const MAX_ATTEMPTS = 1 + MAX_RETRIES;

/** abort 竞速哨兵：完成 payload 是对象或 null，Symbol 保证不与之混淆 */
const ABORTED = Symbol("pi-loop:designer:aborted");

/** ```json 围栏匹配（标签大小写不敏感；标签后紧跟内容也容忍），内容为捕获组 1 */
const JSON_FENCE_RE = /```json[ \t]*\r?\n?([\s\S]*?)```/gi;

/** generatePlan 的依赖注入上下文（结构类型——测试注入 fake rpc 与临时 dataDir） */
export interface GeneratePlanContext {
	/** pi-subagents RPC 的最小方法面：spawn 受理 / 完成等待 / abort 时 stop 在途 run */
	rpc: Pick<SubagentsRpcClient, "spawn" | "waitForCompletion" | "stop">;
	/** 目标 run id（<dataDir>/runs/<runId>/ 即产物目录） */
	runId: string;
	/** 数据根目录（生产 ~/.pi/loop/，测试临时目录——绝不写死用户路径） */
	dataDir: string;
	/** 用户中止信号（M2 语义：中止不再发起新 subagent） */
	signal?: AbortSignal;
}

/**
 * generatePlan 的诚实遥测返回（T4 接线时落 RunRecord.plan 的数据源——本任务不改
 * RunRecord 类型本体，只定义返回形状）。
 */
export interface DesignerOutcome {
	/** 最终生效的研究计划（designer 产出或降级 builtin） */
	plan: ResearchPlan;
	/** 实际向 rpc 发出的 spawn 尝试次数（1=一次即成；3=重试耗尽；0=中止于首发之前） */
	attempts: number;
	/** 是否降级为内置静态计划（恒等于 channel==="builtin"——降级禁止冒充正常生成） */
	degraded: boolean;
	/** 产物提取通道：file=designer-plan.json；fence=完成回复围栏副本；builtin=降级 */
	channel: "file" | "fence" | "builtin";
}

/** 双通道单次提取的结果：成功携带计划与通道；失败携带可直接注入重试 prompt 的错误数组 */
type ExtractionResult =
	| { ok: true; plan: ResearchPlan; channel: "file" | "fence" }
	| { ok: false; errors: string[] };

/** 未知错误 → 可读句子（重试 prompt 与降级 notes 共用） */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 错误字段的防御性文案化：字符串直用；对象取 message，退而 JSON 化（口径同 orchestrator 的 describeError） */
function describeErrorText(error: unknown): string | undefined {
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
 * 完成事件的失败信号解读（口径对齐 orchestrator readCompletion 的失败判定——该函数
 * 为模块私有且 orchestrator 由并行任务维护，此处只取 designer 所需子集）：
 * status ∈ {failed,error,aborted} / ok===false / success===false / error 字段非空视为失败；
 * 其余（含无可读标记的 payload）按成功处理——事件到达即完成，缺错误标记即视为无错。
 * @returns 失败原因文案；无失败信号时 undefined
 */
function readCompletionFailure(payload: unknown): string | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	const status = typeof p.status === "string" ? p.status : "";
	const failed =
		["failed", "error", "aborted"].includes(status) ||
		p.ok === false ||
		p.success === false ||
		(p.error !== undefined && p.error !== null);
	if (!failed) return undefined;
	const described = describeErrorText(p.error);
	if (described !== undefined) return described;
	if (status.length > 0) return `状态 "${status}"（未携带错误详情）`;
	return "完成事件未携带错误详情";
}

/**
 * 完成事件可读正文的防御性收集（拼接返回）。payload 结构未完全文档化——M2-T5 核证的
 * 真实形态只带 results[0].outputReference / artifactPaths.outputPath 的路径引用，往往
 * 没有正文文本，故围栏通道本质是容错备份（文件通道才是主设计）。宽候选集：
 * output / text / message / result（string 或其内层）/ results[*] 的同名字段；
 * outputReference 是路径不是正文，刻意不收（防把路径误当正文）。
 */
function collectReplyTexts(payload: unknown): string {
	if (payload === null || typeof payload !== "object") return "";
	const texts: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0) texts.push(value);
	};
	const p = payload as Record<string, unknown>;
	push(p.output);
	push(p.text);
	push(p.message);
	if (typeof p.result === "string") {
		push(p.result);
	} else if (p.result !== null && typeof p.result === "object") {
		const result = p.result as Record<string, unknown>;
		push(result.output);
		push(result.text);
		push(result.message);
		push(result.result);
	}
	if (Array.isArray(p.results)) {
		for (const item of p.results) {
			if (item === null || typeof item !== "object") continue;
			const one = item as Record<string, unknown>;
			push(one.output);
			push(one.text);
			push(one.message);
			push(one.result);
		}
	}
	return texts.join("\n\n");
}

/**
 * 提取文本中最后一个 ```json 围栏的内容（末位启发：模型输出中先期出现的研究示例 JSON
 * 不是最终计划，围栏按最后一个取）。
 * @returns 围栏内 JSON 文本（已 trim；空围栏跳过）；没有任何围栏时 undefined
 */
function lastJsonFence(text: string): string | undefined {
	let last: string | undefined;
	for (const match of text.matchAll(JSON_FENCE_RE)) {
		const content = match[1]?.trim();
		if (content !== undefined && content.length > 0) last = content;
	}
	return last;
}

/**
 * 设计师 spawn 的任务文本模板（每次尝试都完整自带——fresh 上下文无对话记忆）。
 * 内容：任务原文 + 预算约束（步数硬顶 / 并行上限）+ 计划结构须知（字段级 + 结构规则 +
 * 产出物建议）+ 输出契约（①写文件 ②回复围栏副本——两条都要）。
 */
function buildDesignerPrompt(
	task: string,
	preset: EffortPreset,
	planFilePath: string,
): string {
	return [
		"你是研究计划设计师：为下述任务设计一份研究计划（ResearchPlan），后续编排器将按计划调度 subagent 并行执行。",
		"",
		"【用户任务】",
		task,
		"",
		"【预算约束（硬性，超出即被校验拒绝）】",
		`- 计划步骤数上限：${preset.maxPlanSteps} 步`,
		`- 并行度上限：最多 ${preset.maxParallelSubagents} 个 subagent 同时执行（无依赖关系的步骤会被并行调度）`,
		"",
		"【计划结构（JSON 对象，字段说明）】",
		"{",
		"  version: 1,                     // 固定字面量 1",
		'  task: "用户任务原文（照抄上方任务）",',
		'  origin: "designer",',
		"  steps: [",
		"    {",
		'      id: "步骤短 id（计划内唯一，如 survey）",',
		'      agent: "执行角色（当前仅 researcher 可用——researcher 兼任设计与研究）",',
		'      task: "本步完整任务提示词（必须自包含：执行 subagent 以全新上下文运行，看不到本说明）",',
		'      dependsOn: ["前置步骤 id 数组；无依赖为空数组"],',
		'      guidance: "可选：对本步的补充指引",',
		'      acceptance: "可选：本步产出的验收标准",',
		"    },",
		"  ],",
		'  notes: "可选：设计备注（关键假设与取舍）",',
		"}",
		"结构规则：至少 1 步；id 全计划唯一；dependsOn 只能引用计划内已有 id；不允许自依赖或成环。",
		"产出物建议：各步骤的 task 宜写明期望产出物（如「把结论写入指定路径的 markdown」或「以结构化摘要收尾」），便于后续步骤引用其结论。",
		"",
		"【输出契约（两条都必须满足）】",
		`1. 把最终 ResearchPlan 的完整 JSON 写入文件：${planFilePath}`,
		"   （用你的写文件工具直接写入；目录已存在。不要写入其他路径。）",
		"2. 在你的最终回复中，附上同一份 JSON 的完整 ```json 围栏副本（与文件内容一致，可直接解析）。",
	].join("\n");
}

/** 重试附录：上轮具体校验错误（T1 保证错误为中文陈述句，可整体注入重试 prompt） */
function buildRetryAnnex(errors: string[]): string {
	return [
		"",
		"【上次的计划未通过校验】",
		"上次的计划未通过校验，具体错误：",
		...errors.map((error) => `- ${error}`),
		"请修正这些问题，重新输出完整计划 JSON；两条输出契约保持不变（写入上述文件 + 最终回复附围栏副本）。",
	].join("\n");
}

/**
 * 双通道提取并校验 designer 产物。
 * 通道①文件优先（designer 被要求写 designer-plan.json）；失败（缺失/不可读/校验不过）
 * 落通道②——完成回复正文的最后一个 ```json 围栏（末位启发）。两通道都失败 → errors
 * （可整体注入下一轮重试 prompt）。完成事件自身的失败信号（错误/失败状态）一并记入
 * errors——模型的崩溃原因就是重试最有用的信息；但若文件已合法（模型崩溃前已写出），
 * 产物即有效：文件通道照常采纳。
 */
function extractPlan(
	completion: unknown,
	planFilePath: string,
	maxSteps: number,
): ExtractionResult {
	const errors: string[] = [];
	const failure = readCompletionFailure(completion);
	if (failure !== undefined) {
		errors.push(`完成事件报告 subagent 执行失败：${failure}`);
	}

	// 通道①：约定产物文件
	if (fs.existsSync(planFilePath)) {
		let planText: string | undefined;
		try {
			// BOM 兜底：个别写文件工具会带 \uFEFF 前缀，JSON.parse 不容忍
			planText = fs.readFileSync(planFilePath, "utf-8").replace(/^\uFEFF/, "");
		} catch (error) {
			errors.push(`产物文件读取失败：${planFilePath}（${errorMessage(error)}）`);
		}
		if (planText !== undefined) {
			const validated = validateResearchPlan(planText, maxSteps);
			if (validated.ok) {
				return { ok: true, plan: validated.plan, channel: "file" };
			}
			errors.push(...validated.errors);
		}
	} else {
		errors.push(`产物文件不存在：${planFilePath}（Designer 未按输出契约写出）`);
	}

	// 通道②：完成回复正文的围栏副本（末位启发）
	const replyText = collectReplyTexts(completion);
	const fenced = lastJsonFence(replyText);
	if (fenced !== undefined) {
		const validated = validateResearchPlan(fenced, maxSteps);
		if (validated.ok) {
			return { ok: true, plan: validated.plan, channel: "fence" };
		}
		errors.push(...validated.errors);
	} else if (replyText.length > 0) {
		errors.push("完成回复中未找到 ```json 围栏（无法提取计划副本）");
	} else {
		errors.push("完成事件未携带可读的回复正文（围栏副本无从提取）");
	}

	// 同一份坏计划在两通道重复报错时去重（模型只修一处）
	return { ok: false, errors: [...new Set(errors)] };
}

/**
 * signal → 一次性 settle 的"已中止"哨兵 promise（与完成等待 Promise.race 竞速；
 * 形状对齐 orchestrator 的 createAbortWatch——模块私有无法 import，本地同口径固化）。
 */
function createAbortWatch(signal?: AbortSignal): {
	promise: Promise<typeof ABORTED>;
	dispose: () => void;
} {
	let resolveAbort!: (value: typeof ABORTED) => void;
	const promise = new Promise<typeof ABORTED>((resolve) => {
		resolveAbort = resolve;
	});
	const onAbort = (): void => resolveAbort(ABORTED);
	if (signal?.aborted) onAbort(); // 已中止：立即 settle（尝试间检查点兜底）
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		promise,
		dispose: () => signal?.removeEventListener("abort", onAbort),
	};
}

/**
 * 动态生成研究计划（Designer 主入口，供 T4 在 prepareRun 后接线）。
 *
 * 失败语义三档（诚实遥测，notes/attempts/channel 如实区分）：
 *   - 校验失败：重试 ≤2 次（共 3 次尝试），耗尽后降级 builtin；
 *   - rpc 层失败（spawn 受理拒绝 / 完成等待超时）：不重试立即降级；
 *   - 中止（signal）：立即降级且不再 spawn、不抛出（后续 executePlan 对已中止
 *     signal 自会 fail-fast——T4 收口 run 状态为 failed/aborted）。
 *
 * @returns DesignerOutcome（plan + attempts + degraded + channel——T4 落 RunRecord.plan）
 */
export async function generatePlan(
	task: string,
	preset: EffortPreset,
	ctx: GeneratePlanContext,
): Promise<DesignerOutcome> {
	// 产物目录防御：T4 流程中 createRunRecord 已建 runs/<id>；幂等兜底防接线顺序差异
	const runDir = path.join(ctx.dataDir, "runs", ctx.runId);
	fs.mkdirSync(runDir, { recursive: true });
	const planFilePath = path.join(runDir, "designer-plan.json");
	const basePrompt = buildDesignerPrompt(task, preset, planFilePath);

	/** 局部：降级收尾（origin/channel 必为 builtin、notes 如实记原因——禁止冒充 designer 产物） */
	const degrade = (attempts: number, reason: string): DesignerOutcome => ({
		plan: {
			...BUILTIN_PLAN(task),
			origin: "builtin",
			notes: `designer 降级：${reason}`,
		},
		attempts,
		degraded: true,
		channel: "builtin",
	});

	const abortWatch = createAbortWatch(ctx.signal);
	try {
		// 最近一次尝试的校验失败原因（下一轮重试 prompt 的附录）
		let errors: string[] = [];
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			// abort 检查点（尝试之间）：中止不再发起新 subagent，attempts 记已发起数
			if (ctx.signal?.aborted) {
				return degrade(
					attempt - 1,
					"运行信号已中止（aborted），未再发起 Designer 尝试",
				);
			}
			// fresh spawn 无记忆：每次尝试都发完整模板（重试附上轮错误附录）
			const prompt =
				attempt === 1 ? basePrompt : basePrompt + buildRetryAnnex(errors);
			let runId: string | undefined;
			try {
				const acceptance = await ctx.rpc.spawn({
					agent: "researcher",
					task: prompt,
					context: "fresh",
					// 不指定 model：一律继承会话默认模型（用户规则）
				});
				runId = acceptance.runId;
			} catch (error) {
				// rpc 层失败（受理拒绝/超时）：不重试直接降级（与"校验重试"区分）
				return degrade(
					attempt,
					`Designer spawn 失败：${errorMessage(error)}（pi-subagents 不在或不可用——请安装 pi-subagents 扩展后重试）`,
				);
			}
			// 受理缺省 runId 时等任意完成事件：designer 在途 run 至多一个，事件可归属
			// （orchestrator 单步计划的同款降级口径）
			let completion: unknown;
			try {
				completion = await Promise.race([
					ctx.rpc.waitForCompletion(runId, COMPLETION_TIMEOUT_MS),
					abortWatch.promise,
				]);
			} catch (error) {
				// waitForCompletion 的异常按 rpc 层失败处理（理论不发生：超时走 null 分支）
				return degrade(attempt, `完成等待异常：${errorMessage(error)}`);
			}
			if (completion === ABORTED) {
				// 中止：尽力 stop 在途 run（失败/超时不阻断降级收尾）
				if (runId !== undefined) {
					await ctx.rpc.stop(runId, STOP_TIMEOUT_MS).catch(() => undefined);
				}
				return degrade(attempt, "运行信号中止（aborted），等待完成被中断");
			}
			if (completion === null || completion === undefined) {
				// 完成等待超时（rpc 层）：不重试直接降级
				return degrade(
					attempt,
					`等待完成超时（${COMPLETION_TIMEOUT_MS}ms 内无匹配的完成事件）`,
				);
			}
			const extraction = extractPlan(
				completion,
				planFilePath,
				preset.maxPlanSteps,
			);
			if (extraction.ok) {
				return {
					plan: extraction.plan,
					attempts: attempt,
					degraded: false,
					channel: extraction.channel,
				};
			}
			errors = extraction.errors;
		}
		// 校验重试耗尽：最后一次的错误如实入 notes（含尝试次数）
		return degrade(
			MAX_ATTEMPTS,
			`连续 ${MAX_ATTEMPTS} 次尝试均未通过校验（最近一次问题：${errors.join("；")}）`,
		);
	} finally {
		abortWatch.dispose();
	}
}
