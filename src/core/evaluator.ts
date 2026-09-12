// pi-loop Evaluator 评估内核（M4-T1）
// 依据 docs/plans/m4-evaluator.md Task 1、docs/SPEC.md §7.4（诚实遥测铁律）。
//
// 双通道评估（互斥；verifyCommand 在场即机器断言唯一权威——critic 不跑，零 spawn 由测试锁定）：
//   ① verifyCommand 机器断言：execFile（shell:false 安全优先）在 dataDir 幂等工作区
//      执行用户给的命令行字符串。shlex 风格简易分词（单双引号包裹含空格段，未闭合
//      引号 = 语法错误拒收——M1 遗留"未闭合引号"分词债务在此收口）；超时（生产 60s）
//      即 fail；exit 0 → verified（输出含可解析 N/M 计数则按比例计分，否则满分 100）；
//      exit ≠ 0 → fail + stderr 尾部（≤500 字）入 reasons。blame 恒为空数组——
//      退出码断言没有轮次归因概念（错误细节在 reasons 的 stderr）。
//   ② critic rubric：无 verifyCommand 时 spawn researcher（兼任 critic；fresh 上下文、
//      不指定 model——继承会话默认）评审任务原文与各步执行记录 → 恰好一个 ```json 围栏
//      {verdict, score, reasons[], blame[]} → deepSanitize 净化（defend-json.ts 共享
//      真源的原型污染键剔除）→ 形状校验（verdict 枚举/score 范围/字符串数组/stepId 过滤）。
//      产物通道为围栏单一通道（对照 designer.ts 的"文件先/围栏后"双通道——Evaluation
//      是小结构化对象、无落盘产物契约；选型论证见任务报告 task-1-report.md）。
//
// 诚实遥测铁律（SPEC §7.4）：evaluator 自身的任何故障（命令语法错/超时/命令不存在/
// spawn 失败/等待超时/产物坏/中止）一律收敛为 verdict=fail + score 0 + blame [] +
// reasons 如实——绝不因"拿不到证据"而自判通过。partial 的判定权在 critic
// （verified/fail 的中间态），机器断言不产生中间态。

import { execFile } from "node:child_process";

import {
	ABORTED,
	COMPLETION_TIMEOUT_MS,
	STOP_TIMEOUT_MS,
	createAbortWatch,
} from "./consts.ts";
import { deepSanitize, type JsonValue } from "./defend-json.ts";
import type { SubagentsRpcClient } from "./rpc.ts";
import type { Evaluation, IterationEntry } from "../types.ts";

/** verify 命令的缺省执行超时（生产口径 60s；测试经 EvaluateContext.verifyTimeoutMs 注入缩短——evaluator 专属口径，不进 consts.ts） */
const VERIFY_COMMAND_TIMEOUT_MS = 60_000;

/** IterationEntry.status → rubric 提示词里的可读标签（口径仿 loop-task 的 labels 表） */
const STATUS_LABELS: Record<IterationEntry["status"], string> = {
	succeeded: "成功",
	failed: "失败",
	running: "仍在运行",
	pending: "未开始",
};

/** evaluateResult 的输入（评估对象数据——由调用方依据 run 现场组装） */
export interface EvaluateInput {
	/** 任务原文（loop_task 的 task 入参——critic 评审与 rubric 的目标） */
	task: string;
	/** 本轮执行的迭代记录快照（RunRecord.iterations 同形） */
	entries: IterationEntry[];
	/**
	 * 机器验收命令（在场即唯一权威——verifyCommand 通道，critic 不跑）。
	 * 注意空串/纯空白同样算"在场"：语法错误直接 fail，绝不静默改走 critic 通道。
	 */
	verifyCommand?: string;
	/** 各步验收标准（PlanStep.acceptance——M3 预留字段，本模块是第一消费者；key 为 stepId） */
	acceptanceByStep: Record<string, string | undefined>;
	/** 数据根目录（verify 命令的 cwd——幂等工作区，不污染用户 cwd，SPEC §7.5） */
	dataDir: string;
}

/** evaluateResult 的依赖注入上下文（结构类型——测试注入 fake rpc / 临时目录 / 缩短超时） */
export interface EvaluateContext {
	/** pi-subagents RPC 最小方法面：critic 通道的 spawn 受理 / 完成等待 / abort 收尾 stop（verifyCommand 通道零调用量） */
	rpc: Pick<SubagentsRpcClient, "spawn" | "waitForCompletion" | "stop">;
	/** 用户中止信号（中止 → 评估以 fail 收尾 + reasons 如实——不自判通过） */
	signal?: AbortSignal;
	/** verify 命令执行超时毫秒（缺省 60s 生产口径；测试注入缩短以快速走完超时分支——口径仿 RunLoopTaskOptions.rpcTimeoutMs 的测试缝） */
	verifyTimeoutMs?: number;
}

/* ------------------------------------------------------------------
 * 以下 helper 为 designer.ts 同口径的本地固化（该模块私有、无法 import）：
 * 口径漂移由测试的 timeoutMs/文案断言锁定。超时/stop/abortWatch 常量已随
 * M4-T0 收敛至 consts.ts 单一真源（本模块 import 消费）。
 * ------------------------------------------------------------------ */

/** ```json 围栏匹配（标签大小写不敏感；标签后紧跟内容也容忍），内容为捕获组 1 */
const JSON_FENCE_RE = /```json[ \t]*\r?\n?([\s\S]*?)```/gi;

/** 未知错误 → 可读句子（fail reasons 与净化错误共用） */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** error 字段的防御性文案化：字符串直用；对象取 message，退而 JSON 化 */
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
 * 完成事件的失败信号解读（口径对齐 designer/orchestrator 的 readCompletion）：
 * status ∈ {failed,error,aborted} / ok===false / success===false / error 字段非空
 * 视为失败；其余（含无可读标记的 payload）按成功处理——事件到达即完成，缺错误
 * 标记即视为无错。
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
 * 完成事件可读正文的防御性收集（拼接返回）。payload 结构未完全文档化——宽候选集：
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

/** 提取文本中最后一个 ```json 围栏的内容（末位启发：先期出现的示例 JSON 不是最终结论） */
function lastJsonFence(text: string): string | undefined {
	let last: string | undefined;
	for (const match of text.matchAll(JSON_FENCE_RE)) {
		const content = match[1]?.trim();
		if (content !== undefined && content.length > 0) last = content;
	}
	return last;
}

/** 诚实遥测捷径：evaluator 自身的一切故障都收敛为 fail（score 0 / blame [] / reasons 如实） */
function failEvaluation(reason: string): Evaluation {
	return { verdict: "fail", score: 0, reasons: [reason], blame: [] };
}

/**
 * shlex 风格简易分词（M1 遗留"未闭合引号"债务的修复点：未闭合引号视为语法错误
 * 直接拒收，不猜测补全）。语义：
 *   - 引号（单双等价）：包裹含空格的字段；引号内一切字符（含另一类引号）都是字面量
 *   - 空白（空格/制表/换行）为分隔符；空引号段是合法的空 token
 *   - 转义序列不支持（无 \" 语义——YAGNI，需要引号字符的脚本由调用侧用另一类引号规避）
 */
function tokenizeCommand(
	command: string,
): { ok: true; file: string; args: string[] } | { ok: false; error: string } {
	const tokens: string[] = [];
	let current = "";
	let hasCurrent = false;
	let quote: '"' | "'" | undefined;
	for (const ch of command) {
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasCurrent = true; // 空引号段也是真实 token
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (hasCurrent) {
				tokens.push(current);
				current = "";
				hasCurrent = false;
			}
			continue;
		}
		current += ch;
		hasCurrent = true;
	}
	if (quote !== undefined) {
		return {
			ok: false,
			error: `存在未闭合的${quote === '"' ? "双" : "单"}引号（拒绝猜测补全，命令未执行）`,
		};
	}
	if (hasCurrent) tokens.push(current);
	if (tokens.length === 0) {
		return {
			ok: false,
			error: "命令为空或只含空白（verifyCommand 需要至少一个可执行命令字）",
		};
	}
	return { ok: true, file: tokens[0], args: tokens.slice(1) };
}

/**
 * 可信计数的判定：两个都是整数、分母 ≥1、分子在 [0, 分母] 内——
 * "5/3" 之类的畸形计数不算证据（也顺带剔除日期形如 2024/09 的 N > M 误配）。
 */
function credibleCount(n: number, m: number): boolean {
	return (
		Number.isInteger(n) && Number.isInteger(m) && m >= 1 && n >= 0 && n <= m
	);
}

/** n/m 的比例分（round 到整数并 clamp 0-100；前置 credibleCount 已过） */
function ratioScore(n: number, m: number): number {
	return Math.max(0, Math.min(100, Math.round((n / m) * 100)));
}

/**
 * verifyCommand 输出的计数解析（退出码 0 的前提下调用；解析不出返回 undefined，
 * 调用方回落满分 100）：
 *   ① 显式句式优先（"2/3 passed" / "passed: 2/3" / "2 of 3 passed" /
 *      "2 passed out of 3"）
 *   ② 兜底裸 N/M：取全文最后一个"可信"计数（credibleCount；1-4 位数字——
 *      更长的数字更像 ID/时间戳而非计数）
 */
function parseCountScore(stdout: string): { n: number; m: number } | undefined {
	// 锚定句式（T1 review M1 收口）：数字边界守卫（(?<!\d)/(?!\d)）与 1-4 位长度
	// 上限为裸兜底同款——更长的数字更像 ID/时间戳而非计数；g 标志 + matchAll 取
	// 每句式的最后一个可信计数（末位启发：前置日期形 12/03/2024 passed 类不
	// 遮蔽输出末尾的真计数）
	const anchored: RegExp[] = [
		/(?<!\d)(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)\s*(?:passed|pass|ok)\b/gi,
		/(?:passed|pass|ok)\s*[:：]?\s*(?<!\d)(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)/gi,
		/(?<!\d)(\d{1,4})\s+of\s+(\d{1,4})\s+(?:passed|pass|ok)\b/gi,
		/(?<!\d)(\d{1,4})\s+passed\s+out\s+of\s+(\d{1,4})(?!\d)/gi,
	];
	for (const re of anchored) {
		let last: { n: number; m: number } | undefined;
		for (const match of stdout.matchAll(re)) {
			const n = Number(match[1]);
			const m = Number(match[2]);
			if (credibleCount(n, m)) last = { n, m };
		}
		if (last !== undefined) return last;
	}
	let last: { n: number; m: number } | undefined;
	for (const match of stdout.matchAll(
		/(?<!\d)(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)/g,
	)) {
		const n = Number(match[1]);
		const m = Number(match[2]);
		if (credibleCount(n, m)) last = { n, m };
	}
	return last;
}

/** stderr 尾部截取（≤500 字，连续空白折叠为单空格——reasons 的单行可读性；口径仿 taskPreview 的空白折叠） */
function stderrTail(stderr: string): string {
	const collapsed = stderr.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 500) return collapsed;
	return collapsed.slice(-500);
}

/** 值的可读描述（形状错误的 reasons 里说明"实际得到什么"；长值截断——口径仿 plan-schema 的 describeValue） */
function describeValue(value: unknown): string {
	if (value === undefined) return "缺失";
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** score 的边界：有限数值 → clamp 0-100 的整数 */
function clampScore(score: number): number {
	return Math.max(0, Math.min(100, Math.round(score)));
}

/** verdict 枚举的解析判定（枚举外返回 undefined——由 checkEvaluationShape 统一报错） */
function parseVerdict(value: JsonValue): Evaluation["verdict"] | undefined {
	return value === "verified" || value === "partial" || value === "fail"
		? value
		: undefined;
}

/** score 的解析判定（非有限数值返回 undefined；越界不是形状错误——clamp 是后续步骤） */
function parseScore(value: JsonValue): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 字符串数组的解析判定（任一元素非字符串返回 undefined） */
function parseStringArray(value: JsonValue): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? (value as string[])
		: undefined;
}

/** 净化后评审产物（Evaluation 形状）的校验结果 */
type EvaluationShape =
	| { ok: true; evaluation: Evaluation }
	| { ok: false; errors: string[] };

/**
 * 净化后评审产物的形状校验（防御弱化的模型输出）：
 *   - verdict ∈ {verified, partial, fail}（枚举外一律拒收）
 *   - score 必须是有限数值（NaN/Infinity/字符串拒收；越界不是形状错误——clamp 0-100）
 *   - reasons 必须是字符串数组；blame 必须是字符串数组
 *   - blame 中的 stepId 不在本轮执行记录内 → 过滤该 id 且 reasons 附真实警告（不静默丢弃）
 * 全部字段收集齐再一次性返回（口径仿 plan-schema 的语义层收集——错误信息可读）。
 */
function checkEvaluationShape(
	clean: JsonValue,
	knownStepIds: ReadonlySet<string>,
): EvaluationShape {
	if (typeof clean !== "object" || clean === null || Array.isArray(clean)) {
		return {
			ok: false,
			errors: [`评审结论必须是 JSON 对象，实际得到：${describeValue(clean)}`],
		};
	}
	const raw = clean as Record<string, JsonValue>;
	const verdict = parseVerdict(raw.verdict);
	const score = parseScore(raw.score);
	const reasons = parseStringArray(raw.reasons);
	const blame = parseStringArray(raw.blame);
	if (
		verdict === undefined ||
		score === undefined ||
		reasons === undefined ||
		blame === undefined
	) {
		const errors: string[] = [];
		if (verdict === undefined) {
			errors.push(
				`verdict 必须是 "verified"、"partial" 或 "fail"，实际得到：${describeValue(raw.verdict)}`,
			);
		}
		if (score === undefined) {
			errors.push(`score 必须是有限数值，实际得到：${describeValue(raw.score)}`);
		}
		if (reasons === undefined) {
			errors.push(
				`reasons 必须是字符串数组，实际得到：${describeValue(raw.reasons)}`,
			);
		}
		if (blame === undefined) {
			errors.push(
				`blame 必须是字符串（stepId）数组，实际得到：${describeValue(raw.blame)}`,
			);
		}
		return { ok: false, errors };
	}
	// 形状全部达标——组装（ghost blame 过滤 + 去重保序，警告如实入 reasons）
	const finalReasons = [...reasons];
	const validBlame: string[] = [];
	for (const id of blame) {
		if (knownStepIds.has(id)) {
			if (!validBlame.includes(id)) validBlame.push(id);
		} else {
			finalReasons.push(
				`【警告】critic 指认的 blame 步骤 "${id}" 不在本轮执行记录内，已过滤该 id`,
			);
		}
	}
	return {
		ok: true,
		evaluation: {
			verdict,
			score: clampScore(score),
			reasons: finalReasons,
			blame: validBlame,
		},
	};
}

/**
 * critic 的 rubric 提示词（fresh 上下文无记忆——每次评审都自带完整契约）。
 * 素材：任务原文 + 每步 {agent, 状态, 失败原因, 验收标准, 产出引用}——产出引用只给
 * 路径（产物核验由 critic 自行读取，evaluator 不代读）+ 输出契约（有且仅有一个
 * ```json 围栏：{verdict, score, reasons[], blame[]}）。
 */
function buildCriticPrompt(input: EvaluateInput): string {
	const lines: string[] = [
		"你是研究任务评审员（critic）：下述任务已由一组 subagent 步骤执行完毕。请依据任务目标、各步执行记录与验收标准，独立评审最终结果。",
		"",
		"【任务原文】",
		input.task,
		"",
		"【各步执行记录】",
	];
	if (input.entries.length === 0) {
		lines.push("（本轮没有任何迭代记录——没有任何步骤实际执行）");
	}
	for (const entry of input.entries) {
		lines.push(
			`- 步骤 "${entry.stepId}"（执行角色：${entry.agent}；状态：${STATUS_LABELS[entry.status]}）`,
		);
		if (entry.error !== undefined) {
			lines.push(`  - 失败原因：${entry.error}`);
		}
		const acceptance = input.acceptanceByStep[entry.stepId];
		if (acceptance !== undefined && acceptance.length > 0) {
			lines.push(`  - 验收标准：${acceptance}`);
		}
		if (entry.outputRef !== undefined) {
			lines.push(
				`  - 产出引用：${entry.outputRef}（产物在该路径——请自行读取核验后再下结论）`,
			);
		}
	}
	lines.push(
		"",
		"【评审要求】",
		"- 对照每步的验收标准与任务目标核验实际结果；有产出引用时优先读取产物本身再作判断。",
		"- 结论必须基于证据；不确定之处如实陈述——宁可降级，不可虚报通过。",
		"",
		"【输出契约（最终回复中有且仅有一个 ```json 围栏块，其余文字只作说明）】",
		"```json",
		"{",
		'  "verdict": "verified | partial | fail",',
		'  "score": 0,',
		'  "reasons": ["结论依据，逐条中文句子"],',
		'  "blame": ["需归因的失败步骤 stepId；无则空数组"]',
		"}",
		"```",
		"",
		"verdict 语义：verified=验收全面达成；partial=部分达成（多数验收通过但存在明显缺口）；fail=未达成。",
	);
	return lines.join("\n");
}

/** execFile 回调的 error 参数结构面（结构类型——兼容 ExecFileException 的窄化） */
interface ExecFailureShape {
	message: string;
	code?: unknown;
	killed?: unknown;
	signal?: unknown;
}

/**
 * verifyCommand 机器断言通道的退出分类（execFile 回调侧）：
 *   - error === null（exit 0）→ verified：score 按输出可解析计数（无计数 → 满分 100）
 *   - abort（signal 触发的 kill）→ fail + 中止原因（abort 先于超时判别——归因不混淆）
 *   - error.code 为数字（非 0 退出）→ fail + 退出码 + stderr 尾部（blame 恒空）
 *   - killed/带信号且耗时已达超时口径 → fail + 超时原因（elapsed 双保险判别）
 *   - 其余（ENOENT 等启动失败）→ fail + 原样错误（如命令不存在，如实报）
 */
function classifyVerifyOutcome(
	error: ExecFailureShape | null,
	stdout: string,
	stderr: string,
	info: { aborted: boolean; timeoutMs: number; startedMs: number },
): Evaluation {
	if (error === null) {
		const count = parseCountScore(stdout);
		if (count === undefined) {
			return {
				verdict: "verified",
				score: 100,
				reasons: ["机器断言通过（退出码 0；输出无可解析计数——按满分计）"],
				blame: [],
			};
		}
		return {
			verdict: "verified",
			score: ratioScore(count.n, count.m),
			reasons: [
				`机器断言通过（退出码 0；输出计数 ${count.n}/${count.m}，按比例计分）`,
			],
			blame: [],
		};
	}
	if (info.aborted) {
		return failEvaluation(
			"verify 断言中止：运行信号已中止，命令被终止，评估未完成",
		);
	}
	if (typeof error.code === "number") {
		const tail = stderrTail(stderr);
		return {
			verdict: "fail",
			score: 0,
			reasons: [
				`verify 断言失败：退出码 ${error.code}`,
				tail.length > 0
					? `stderr 尾部（≤500 字）：${tail}`
					: "（命令未输出 stderr）",
			],
			blame: [],
		};
	}
	const killed = error.killed === true || typeof error.signal === "string";
	if (killed && Date.now() - info.startedMs >= info.timeoutMs - 20) {
		return failEvaluation(
			`verify 断言超时：命令在 ${info.timeoutMs}ms 内未完成，进程已被终止`,
		);
	}
	const codeSuffix =
		typeof error.code === "string" ? `（错误码 ${error.code}）` : "";
	return failEvaluation(`verify 断言执行失败：${error.message}${codeSuffix}`);
}

/**
 * verifyCommand 机器断言通道（存在即唯一权威）：execFile（shell:false）在 dataDir
 * 执行分词后的 [file, ...args]。blame 恒为空——退出码断言没有轮次归因概念。
 * 中止语义：signal 触发时 kill 在途命令并以 fail 收尾（reasons 如实）。
 */
async function runVerifyCommand(
	input: EvaluateInput,
	ctx: EvaluateContext,
): Promise<Evaluation> {
	const timeoutMs = ctx.verifyTimeoutMs ?? VERIFY_COMMAND_TIMEOUT_MS;
	const tokenized = tokenizeCommand(input.verifyCommand ?? "");
	if (!tokenized.ok) {
		return failEvaluation(
			`verify 命令语法错误（拒收，未执行）：${tokenized.error}`,
		);
	}
	return new Promise<Evaluation>((resolve) => {
		// 中止竞速窗的兜底：pre-check 与 listener 挂载之间已中止的直接落收尾
		if (ctx.signal?.aborted) {
			resolve(failEvaluation("评估中止：运行信号在命令启动前已中止"));
			return;
		}
		const startedMs = Date.now();
		let aborted = false;
		const onAbort = (): void => {
			aborted = true;
			child.kill();
		};
		const child = execFile(
			tokenized.file,
			tokenized.args,
			{ cwd: input.dataDir, timeout: timeoutMs, shell: false },
			(error, stdout, stderr) => {
				ctx.signal?.removeEventListener("abort", onAbort);
				resolve(
					classifyVerifyOutcome(error, stdout ?? "", stderr ?? "", {
						aborted,
						timeoutMs,
						startedMs,
					}),
				);
			},
		);
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * critic rubric 通道（无 verifyCommand 时）：spawn researcher（兼任 critic，fresh、
 * 不指定 model）→ 完成等待（10 分钟口径，consts.ts 单一真源）+ abort 竞速 → 围栏
 * 单一通道提取 → deepSanitize 净化 + 形状校验。任何环节故障 → fail + reasons
 * 如实（诚实遥测铁律）。
 */
async function runCritic(
	input: EvaluateInput,
	ctx: EvaluateContext,
): Promise<Evaluation> {
	// 已知 stepId 集：critic 指认的 blame 与此对照（幽灵 id 过滤）。
	// 取 acceptanceByStep 键与 entries 实际 stepId 的并集——前者来自计划，后者来自执行现场
	const knownStepIds = new Set<string>([
		...Object.keys(input.acceptanceByStep),
		...input.entries.map((entry) => entry.stepId),
	]);

	const abortWatch = createAbortWatch(ctx.signal);
	try {
		// ① spawn 受理（fresh 上下文、不指定 model——继承会话默认；零重试：评审失败即 fail，
		//    重试是 T2 迭代闭环的领域，evaluator 不自作主张）
		let runId: string | undefined;
		try {
			const acceptance = await ctx.rpc.spawn({
				agent: "researcher",
				task: buildCriticPrompt(input),
				context: "fresh",
			});
			runId = acceptance.runId;
		} catch (error) {
			return failEvaluation(`critic spawn 失败：${errorMessage(error)}`);
		}
		// ② 完成等待 + abort 竞速（受理缺省 runId 时等任意完成事件——evaluator 在途 run
		//    至多一个，事件可归属；口径同 designer 的单步降级）
		let completion: unknown;
		try {
			completion = await Promise.race([
				ctx.rpc.waitForCompletion(runId, COMPLETION_TIMEOUT_MS),
				abortWatch.promise,
			]);
		} catch (error) {
			// waitForCompletion 的异常按等待失败处理（理论不发生：超时走 null 分支）
			return failEvaluation(`critic 完成等待异常：${errorMessage(error)}`);
		}
		if (completion === ABORTED) {
			// 中止：尽力 stop 在途 critic run（失败/超时不阻断 fail 收尾）
			if (runId !== undefined) {
				await ctx.rpc.stop(runId, STOP_TIMEOUT_MS).catch(() => undefined);
			}
			return failEvaluation(
				"critic 评审中止：运行信号已中止（评审未完成——不自判通过）",
			);
		}
		if (completion === null || completion === undefined) {
			return failEvaluation(
				`critic 完成等待超时（${COMPLETION_TIMEOUT_MS}ms 内无匹配完成事件）`,
			);
		}
		const failure = readCompletionFailure(completion);
		if (failure !== undefined) {
			return failEvaluation(
				`critic 执行失败（完成事件报告 subagent 失败）：${failure}`,
			);
		}
		// ③ 围栏单一通道提取（Evaluation 是小结构化对象——无文件通道；选型见任务报告）
		const replyText = collectReplyTexts(completion);
		if (replyText.length === 0) {
			return failEvaluation(
				"critic 完成事件未携带可读回复正文（评审围栏无从提取）",
			);
		}
		const fenced = lastJsonFence(replyText);
		if (fenced === undefined) {
			return failEvaluation(
				"critic 回复中未找到 ```json 围栏（无法提取评审结论）",
			);
		}
		// ④ JSON.parse → deepSanitize（原型污染键剔除——defend-json 共享真源）→ 形状校验
		let parsed: unknown;
		try {
			parsed = JSON.parse(fenced);
		} catch (error) {
			return failEvaluation(`critic 评审 JSON 解析失败：${errorMessage(error)}`);
		}
		const shaped = checkEvaluationShape(deepSanitize(parsed), knownStepIds);
		if (!shaped.ok) {
			return failEvaluation(
				`critic 评审结论形状非法：${shaped.errors.join("；")}`,
			);
		}
		return shaped.evaluation;
	} finally {
		abortWatch.dispose();
	}
}

/**
 * 评估一次执行结果（Evaluator 主入口，M4-T2 的迭代闭环消费）。
 * 通道互斥：verifyCommand 在场（含空串——语法错误即 fail，不静默改走 critic）即
 * 机器断言唯一权威；否则走 critic rubric。
 * 诚实遥测铁律（SPEC §7.4）：evaluator 自身的任何故障都收敛为 fail + reasons
 * 如实——绝不自判通过。本函数不抛出（调用方拿到的一定是结构完整的 Evaluation）。
 */
export async function evaluateResult(
	input: EvaluateInput,
	ctx: EvaluateContext,
): Promise<Evaluation> {
	// 中止快捷拒绝：signal 已中止时不 spawn critic / 不启动 verify 命令
	if (ctx.signal?.aborted) {
		return failEvaluation("评估中止：运行信号在评估开始前已中止");
	}
	if (input.verifyCommand !== undefined) {
		return runVerifyCommand(input, ctx);
	}
	return runCritic(input, ctx);
}
