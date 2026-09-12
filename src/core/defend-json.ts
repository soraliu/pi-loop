// pi-loop 共享防御性 JSON 净化工具（M4-T1）
// 依据 docs/plans/m4-evaluator.md Task 1：原型污染键剔除逻辑的单一真源——
// M3 落在 plan-schema.ts 私有的 deepSanitize 从此提取为共享工具，两类外部输入解析
// 双消费：计划（plan-schema 的 sanitizePlanJson）与 critic 评审产物（evaluator）。
// 提取语义与 plan-schema 原实现逐字一致（既有 plan-schema 用例零回归即契约）；
// 唯一例外是 M4-T1 Fix round 1 的 null 直通修正（旧行为把 null 吞成 undefined——
// null 是合法 JSON 值，直通才是正确语义，见函数内注释）。
//
// 安全不变式（沿用 M3 立下的口径）：
//   - 绝不 mutate 输入：净化阶段把数据复制为全新的冻结普通对象再继续
//   - 除三类危险键外字段一律原样保留（合法数据零损耗，未知键不误删）
//   - 只复制自有可枚举键——原型链上的属性天然被丢弃
//   - 非 JSON 原始值（symbol/function/bigint 等）折算为 undefined

/** 原型污染攻击键：对象/数组任意层级一律剔除（含嵌套对象与数组内对象） */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/**
 * 净化产物的域类型：与 JSON 数据同构（原始值，或递归冻结的普通对象/数组）。
 * 非 JSON 原始值（symbol/function/bigint 等）净化时折算为 undefined——
 * 真源是 JSON 文本或已解析 JSON，此类值本就不该出现。
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| { readonly [key: string]: JsonValue }
	| readonly JsonValue[];

/**
 * 深度净化：把任意输入复制为全新的冻结普通对象/数组（绝不触碰原输入）。
 * - 三类危险键直接剔除（含嵌套对象与数组内对象）——剔除发生在复制阶段，
 *   危险键的赋值（如 `clean["__proto__"] = …` 的原型链 setter）从未执行
 * - 其余字段原样递归保留（合法数据零损耗）
 */
export function deepSanitize(value: unknown): JsonValue {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(deepSanitize));
	}
	if (value === null || typeof value !== "object") {
		// SAFETY: 此分支只剩 JSON 原始值（null/undefined/string/number/boolean）与
		// 非 JSON 值（symbol/function/bigint）——前者原样直通，后者折算为 undefined。
		// 注意 null 必须直通（M4-T1 Fix round 1）：它是合法 JSON 值，旧代码漏判会被
		// undefined 吞哨，下游 describeValue 误报“缺失”而非如实报 null
		if (
			value === null ||
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
