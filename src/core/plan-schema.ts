// pi-loop 研究计划的运行时 schema 与防御性解析（M3-T1）
// 依据 docs/plans/m3-designer.md T1、docs/SPEC.md §7.3（预算硬上限）。
//
// 职责：把外部输入（Designer 的模型输出 JSON 文本 / 已解析对象）防御性解析为
// ResearchPlan。三道防线依次为：
//   1. sanitizePlanJson：JSON.parse（仅字符串输入）→ 深度净化（剔除原型污染键）→
//      字段类型强校验（能最早定位的错误先报，错误信息直接可用于重试 prompt）
//      → steps 步数硬顶（SPEC §7.3 预算硬上限）
//   2. typebox Value.Check：形状校验（schema 与 types.ts 的 ResearchPlan 同构）
//   3. 结构语义校验：空 steps / 重复 id / 自引用 / 依赖不存在 / 依赖环
//
// 安全不变式：
//   - 绝不 mutate 输入：净化阶段把数据复制为全新的冻结普通对象再继续
//   - 除三类危险键外字段一律原样保留（合法数据零损耗，未知键不误删）
//   - 所有错误为中文人类可读句子，可直接拼接进 Designer 的重试 prompt

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ResearchPlan } from "../types.ts";

/** 原型污染攻击键：对象/数组任意层级一律剔除（含嵌套对象与数组内对象） */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/**
 * 深度净化产物的域类型：与 JSON 数据同构（原始值，或递归冻结的普通对象/数组）。
 * 非 JSON 原始值（symbol/function/bigint 等）净化时折算为 undefined——
 * 计划的真源是 JSON 文本或已解析 JSON，此类值本就不该出现。
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| { readonly [key: string]: JsonValue }
	| readonly JsonValue[];

/** 单个计划步骤的 schema（PlanStep 形状：model/guidance/acceptance 可选） */
const planStepSchema = Type.Object({
	id: Type.String(),
	agent: Type.String(),
	task: Type.String(),
	dependsOn: Type.Array(Type.String()),
	model: Type.Optional(Type.String()),
	guidance: Type.Optional(Type.String()),
	acceptance: Type.Optional(Type.String()),
});

/** 全量研究计划 schema（version 固定字面量 1；形状与 types.ts 的 ResearchPlan 同构） */
export const researchPlanSchema = Type.Object({
	version: Type.Literal(1),
	task: Type.String(),
	origin: Type.Union([Type.Literal("designer"), Type.Literal("builtin")]),
	steps: Type.Array(planStepSchema),
	notes: Type.Optional(Type.String()),
});

/**
 * 编译期锚点（运行时零开销）：schema 的静态形状必须与 types.ts 的 ResearchPlan
 * 双向兼容。任一侧漂移（字段改名/形状变化）都会使下方两个赋值直接编译失败——
 * 防止两处声明失同步。两个常量运行时恒为 null 且永不读取，仅承担类型检查。
 */
type ResearchPlanSchemaShape = Static<typeof researchPlanSchema>;
// SAFETY: 纯编译期锚——null 断言只用于检查 ResearchPlan 可赋值给 schema 静态形状
const _anchorFromType: ResearchPlanSchemaShape =
	null as unknown as ResearchPlan;
// SAFETY: 纯编译期锚——反向：schema 静态形状可赋值回 ResearchPlan
const _anchorFromSchema: ResearchPlan =
	null as unknown as ResearchPlanSchemaShape;

/** 值的可读描述（错误信息里说明"实际得到什么"；长值截断防 prompt 膨胀） */
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

/** 非空字符串判定（id/agent/task 的强校验下限） */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * 净化产物中的“冻结普通对象”判定。
 * 自写守卫的原因：TS 的 Array.isArray 无法从联合类型中可靠排除 readonly 数组，
 * 直接用它做窄化会让对象分支残留数组形状。
 */
function isPlainObject(
	value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 深度净化：把任意输入复制为全新的冻结普通对象/数组（绝不触碰原输入）。
 * - 三类危险键直接剔除（含嵌套对象与数组内对象）
 * - 只复制自有可枚举键——原型链上的属性天然被丢弃
 * - 其余字段原样递归保留（合法数据零损耗）
 */
function deepSanitize(value: unknown): JsonValue {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(deepSanitize));
	}
	if (value === null || typeof value !== "object") {
		// SAFETY: typeof 已把 value 排除到 object 之外，只剩 JSON 原始值与 symbol/function/bigint
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === undefined
		) {
			return value;
		}
		return undefined; // symbol/function/bigint：非 JSON 值，折算丢弃
	}
	const clean: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (DANGEROUS_KEYS.has(key)) continue;
		clean[key] = deepSanitize(entry);
	}
	return Object.freeze(clean);
}

/** sanitizePlanJson 的结果：ok 时 value 为净化后的冻结副本；失败时 error 为可读原因 */
export type SanitizeResult =
	| { ok: true; value: JsonValue }
	| { ok: false; error: string };

/**
 * 防御性解析（schema 前置防线）。
 * @param raw 计划原文：JSON 字符串（Designer 的模型输出）或已解析的任意值
 * @param maxSteps 步数预算硬顶（来自生效档位 EffortPreset.maxPlanSteps，SPEC §7.3）
 * @returns ok 时 value 为净化后的冻结副本（可直接进 schema 校验）；失败时 error 为
 *          带位置/字段上下文的中文句子，可直接拼接进 Designer 重试 prompt
 */
export function sanitizePlanJson(
	raw: unknown,
	maxSteps: number,
): SanitizeResult {
	// ① 字符串输入先解析（失败信息含 V8 的 position/column 细节，供重试定位）
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `JSON 解析失败：${detail}` };
		}
	}
	// ② 深度净化：在冻结副本上继续（原输入零改动）
	const clean = deepSanitize(raw);
	if (!isPlainObject(clean)) {
		return {
			ok: false,
			error: `计划必须是 JSON 对象，实际得到：${describeValue(clean)}`,
		};
	}
	const plan = clean;
	// ③ 计划级强校验：version 必须是数字 1（"1"/2/缺失均拒绝）
	if (typeof plan.version !== "number" || plan.version !== 1) {
		return {
			ok: false,
			error: `version 必须为数字 1，实际得到：${describeValue(plan.version)}`,
		};
	}
	if (!isNonEmptyString(plan.task)) {
		return {
			ok: false,
			error: `计划的 task 必须是非空字符串，实际得到：${describeValue(plan.task)}`,
		};
	}
	// ④ steps：数组 + 步数硬顶 + 每步字段强校验
	const steps = plan.steps;
	if (!Array.isArray(steps)) {
		return {
			ok: false,
			error: `steps 必须是数组，实际得到：${describeValue(steps)}`,
		};
	}
	if (steps.length > maxSteps) {
		return {
			ok: false,
			error: `计划步骤数 ${steps.length} 超出预算硬顶 ${maxSteps}（SPEC §7.3）`,
		};
	}
	for (const [index, step] of steps.entries()) {
		if (!isPlainObject(step)) {
			return {
				ok: false,
				error: `步骤 #${index} 必须是对象，实际得到：${describeValue(step)}`,
			};
		}
		const where = isNonEmptyString(step.id)
			? `步骤 #${index}（id "${step.id}"）`
			: `步骤 #${index}`;
		for (const field of ["id", "agent", "task"] as const) {
			if (!isNonEmptyString(step[field])) {
				return {
					ok: false,
					error: `${where} 的 ${field} 必须是非空字符串，实际得到：${describeValue(step[field])}`,
				};
			}
		}
		const dependsOn = step.dependsOn;
		if (
			!Array.isArray(dependsOn) ||
			dependsOn.some((dep) => typeof dep !== "string")
		) {
			return {
				ok: false,
				error: `${where} 的 dependsOn 必须是字符串数组，实际得到：${describeValue(dependsOn)}`,
			};
		}
	}
	return { ok: true, value: clean };
}

/** validateResearchPlan 的结果：ok 时 plan 为净化后的冻结 ResearchPlan；失败时 errors 为可读句子数组 */
export type PlanValidationResult =
	| { ok: true; plan: ResearchPlan }
	| { ok: false; errors: string[] };

/** typebox JSON pointer 路径 → 人类可读字段名（"/steps/0/guidance" → "steps[0].guidance"） */
function fieldPath(path: string): string {
	if (path === "" || path === "/") return "(根)";
	return path
		.replace(/^\//, "")
		.split("/")
		.map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
		.join("")
		.replace(/^\./, "");
}

/** Kahn 拓扑剥离：返回依赖环涉及的全部节点 id（空数组 = 无环） */
function findCycleNodeIds(plan: ResearchPlan): string[] {
	const indegree = new Map<string, number>();
	for (const step of plan.steps) indegree.set(step.id, 0);
	for (const step of plan.steps) {
		for (const _dep of step.dependsOn) {
			indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
		}
	}
	const queue = plan.steps
		.filter((step) => (indegree.get(step.id) ?? 0) === 0)
		.map((step) => step.id);
	let removed = 0;
	while (queue.length > 0) {
		const id = queue.shift() as string; // SAFETY: 队列只收步骤 id（string），shift 空才走不到
		removed++;
		for (const step of plan.steps) {
			if (step.dependsOn.includes(id)) {
				const next = (indegree.get(step.id) ?? 0) - 1;
				indegree.set(step.id, next);
				if (next === 0) queue.push(step.id);
			}
		}
	}
	if (removed === plan.steps.length) return [];
	return plan.steps
		.filter((step) => (indegree.get(step.id) ?? 0) > 0)
		.map((step) => step.id);
}

/**
 * 校验外部输入为 ResearchPlan（sanitize → typebox schema → 结构语义三段）。
 * 语义层尽量收集全部问题再一次性返回（利于 Designer 一轮重试修正全部错误）；
 * 成功时的 plan 是净化后的冻结副本；errors 均为中文陈述句，可整体拼接进重试 prompt。
 */
export function validateResearchPlan(
	raw: unknown,
	maxSteps: number,
): PlanValidationResult {
	const sanitized = sanitizePlanJson(raw, maxSteps);
	if (!sanitized.ok) {
		return { ok: false, errors: [sanitized.error] };
	}
	if (!Value.Check(researchPlanSchema, sanitized.value)) {
		const errors = [...Value.Errors(researchPlanSchema, sanitized.value)].map(
			(error) =>
				`结构校验失败：字段 "${fieldPath(error.path)}" 不符合 schema（${error.message}；实际值：${describeValue(error.value)}）`,
		);
		return { ok: false, errors };
	}
	// SAFETY: Value.Check(researchPlanSchema) 已通过，值的形状与 schema 一致；
	// schema 的静态形状由编译期锚点保证与 ResearchPlan 双向同构。
	const plan = sanitized.value as ResearchPlan;
	const errors: string[] = [];
	if (plan.steps.length === 0) {
		errors.push("计划不含任何步骤（steps 为空数组）：至少需要 1 个步骤");
	}
	// 重复 id：同一 id 的第二次及以后出现都点名
	const seenIds = new Set<string>();
	for (const step of plan.steps) {
		if (seenIds.has(step.id)) {
			errors.push(`步骤 id 重复："${step.id}"（每个步骤的 id 必须唯一）`);
		} else {
			seenIds.add(step.id);
		}
	}
	// 自引用（a 依赖 a）：单独点名，比笼统报环更利于一轮修正
	for (const step of plan.steps) {
		if (step.dependsOn.includes(step.id)) {
			errors.push(`步骤 "${step.id}" 的 dependsOn 引用了自身（不允许自依赖）`);
		}
	}
	// 幽灵依赖：dependsOn 引用了计划中不存在的步骤 id
	const knownIds = new Set(plan.steps.map((step) => step.id));
	for (const step of plan.steps) {
		for (const dep of step.dependsOn) {
			if (!knownIds.has(dep)) {
				errors.push(
					`步骤 "${step.id}" 依赖不存在的步骤 "${dep}"（dependsOn 只能引用计划内的步骤 id）`,
				);
			}
		}
	}
	// 依赖环（Kahn 剥不完即有环，环上节点全部点名；id 加引号与其他错误点名格式统一）
	const cycleNodes = findCycleNodeIds(plan);
	if (cycleNodes.length > 0) {
		errors.push(
			`存在依赖环，涉及步骤：${cycleNodes.map((id) => `"${id}"`).join("、")}`,
		);
	}
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return { ok: true, plan };
}
