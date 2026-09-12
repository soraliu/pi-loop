// plan-schema 防御性解析与校验测试（M3-T1）
// 重点：正例全字段保留（净化不伤合法数据）；原型污染三键（嵌套/数组内）剔除且
// Object.prototype 不被污染；各类负例错误信息具体可读（可直接拼进 Designer 重试 prompt）；
// sanitize 不 mutate 原输入（deep-freeze 强证明）；BUILTIN_PLAN（origin="builtin"）兼容。

import { describe, expect, it } from "vitest";

import {
	sanitizePlanJson,
	validateResearchPlan,
} from "../src/core/plan-schema.ts";
import { BUILTIN_PLAN } from "../src/core/planner-static.ts";

/** 测试用 JSON 对象形状 */
type JsonRecord = Record<string, unknown>;

/** 合法 3 步计划（DAG：deep/synth 依赖 survey；用到全部可选字段） */
function validPlan3(): JsonRecord {
	return {
		version: 1,
		task: "研究 pi-loop 的调度内核",
		origin: "designer",
		notes: "示例计划",
		steps: [
			{
				id: "survey",
				agent: "researcher",
				task: "摸底调查",
				dependsOn: [],
				guidance: "优先引用一手来源",
				acceptance: "至少给出三个可核验信源",
			},
			{
				id: "deep",
				agent: "researcher",
				task: "深入分析",
				dependsOn: ["survey"],
				guidance: "对比不同实现的取舍",
			},
			{
				id: "synth",
				agent: "writer",
				task: "汇总成文",
				dependsOn: ["survey", "deep"],
				acceptance: "结论与证据一一对应",
			},
		],
	};
}

/** 2 步计划（依赖类负例构造用） */
function twoStepPlan(dependsOnA: string[], dependsOnB: string[]): JsonRecord {
	return {
		version: 1,
		task: "依赖测试",
		origin: "designer",
		steps: [
			{ id: "a", agent: "researcher", task: "任务 a", dependsOn: dependsOnA },
			{ id: "b", agent: "researcher", task: "任务 b", dependsOn: dependsOnB },
		],
	};
}

/** 读取任意输入的自有键（危险键断言用；非对象返回空数组） */
function ownKeys(value: unknown): string[] {
	return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/** 未知值探针：读步骤对象上 schema 外的额外字段（净化不伤合法数据的断言用） */
function probe(value: unknown): Record<string, unknown> {
	// SAFETY: 测试内只读探针——调用点传入的都是计划步骤对象/嵌套对象
	return value as Record<string, unknown>;
}

/** deep-freeze：任何针对输入的 mutate 都会以 TypeError 暴露（sanitize 无副作用的强证明） */
function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null) return;
	Object.freeze(value);
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
}

describe("validateResearchPlan — 正例", () => {
	it("3 步完整计划（guidance/acceptance/notes 及未知无害键）字段零损过检", () => {
		const input = validPlan3();
		// 未知无害键必须原样保留（净化只剔除三类危险键）
		(input.steps as JsonRecord[])[0].freeForm = "无害的自由字段";
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.version).toBe(1);
		expect(result.plan.origin).toBe("designer");
		expect(result.plan.steps).toHaveLength(3);
		expect(result.plan.steps[0].id).toBe("survey");
		expect(result.plan.steps[0].guidance).toBe("优先引用一手来源");
		expect(result.plan.steps[0].acceptance).toBe("至少给出三个可核验信源");
		expect(result.plan.steps[1].dependsOn).toEqual(["survey"]);
		expect(result.plan.steps[2].agent).toBe("writer");
		expect(result.plan.notes).toBe("示例计划");
		expect(probe(result.plan.steps[0]).freeForm).toBe("无害的自由字段");
	});

	it("JSON 字符串输入走同一管线（Designer 的原始输出形态）", () => {
		const result = validateResearchPlan(JSON.stringify(validPlan3()), 5);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.steps).toHaveLength(3);
	});

	it('BUILTIN_PLAN 输出直接过检（origin="builtin" 兼容口径）', () => {
		const result = validateResearchPlan(BUILTIN_PLAN("研究 tokio 内幕"), 5);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.version).toBe(1);
		expect(result.plan.origin).toBe("builtin");
		expect(result.plan.steps[0].id).toBe("research");
	});
});

describe("原型污染防御", () => {
	it("JSON 文本直传 __proto__ 攻击（顶层 + step 级）→ 净化剔除且各层原型干净", () => {
		// 攻击串必须手写 JSON 文本：对象字面量的 __proto__ 设的是原型而非自有键，
		// JSON.stringify 只序列化自有键——经字面量构造会得到不含危险键的恒真样例。
		// JSON.parse 产物中 "__proto__" 为自有键（不触发 setter），是真实攻击载荷。
		const attack =
			'{"__proto__":{"polluted":"evil"},' +
			'"version":1,"task":"污染测试","origin":"designer",' +
			'"steps":[{"id":"x","agent":"researcher","task":"t","dependsOn":[],' +
			'"__proto__":{"polluted":"evil"}}]}';
		const sanitized = sanitizePlanJson(attack, 5);
		expect(sanitized.ok).toBe(true);
		if (!sanitized.ok) return;
		// 顶层：危险自有键已剔除，原型仍是 Object.prototype（未被改写）
		expect(ownKeys(sanitized.value)).not.toContain("__proto__");
		expect(Object.getPrototypeOf(sanitized.value)).toBe(Object.prototype);
		// step 级：__proto__ 不能经净化路径变为自有键/改原型
		const steps = probe(sanitized.value).steps as JsonRecord[];
		expect(steps).toHaveLength(1);
		expect(ownKeys(steps[0])).not.toContain("__proto__");
		expect(Object.getPrototypeOf(steps[0])).toBe(Object.prototype);
		// Object.prototype 全局未被污染；整份计划（净化后）照常过校验
		const fresh: Record<string, unknown> = {};
		expect(fresh.polluted).toBeUndefined();
		expect(validateResearchPlan(attack, 5).ok).toBe(true);
	});

	it("合法计划携带三个危险键（顶层/步骤/嵌套数组内）→ 过检且输出无危险键、全局原型干净", () => {
		const raw = `{
			"version": 1,
			"task": "污染测试",
			"origin": "designer",
			"steps": [
				{ "id": "a", "agent": "researcher", "task": "ta", "dependsOn": [], "__proto__": { "polluted": "evil" } },
				{ "id": "b", "agent": "researcher", "task": "tb", "dependsOn": ["a"], "constructor": { "prototype": { "polluted": "evil" } } },
				{ "id": "c", "agent": "researcher", "task": "tc", "dependsOn": [], "meta": { "prototype": "danger", "keep": 1, "deep": [ { "__proto__": { "evil": 1 }, "ok": 2 } ] } }
			]
		}`;
		// sanitize 直查：净化副本冻结、危险键剔除
		const sanitized = sanitizePlanJson(raw, 5);
		expect(sanitized.ok).toBe(true);
		if (!sanitized.ok) return;
		expect(Object.isFrozen(sanitized.value)).toBe(true);
		expect(ownKeys(sanitized.value)).not.toContain("__proto__");

		const result = validateResearchPlan(raw, 5);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const step of result.plan.steps) {
			const keys = ownKeys(step);
			expect(keys).not.toContain("__proto__");
			expect(keys).not.toContain("constructor");
			expect(keys).not.toContain("prototype");
		}
		const meta = probe(result.plan.steps[2]).meta as JsonRecord;
		expect(meta.keep).toBe(1);
		expect(ownKeys(meta)).not.toContain("prototype");
		const deep = meta.deep as JsonRecord[];
		expect(deep[0].ok).toBe(2);
		expect(ownKeys(deep[0])).not.toContain("__proto__");
		// 全局原型未被污染（三个攻击点逐一核实）
		const fresh: Record<string, unknown> = {};
		expect(fresh.polluted).toBeUndefined();
		expect(fresh.evil).toBeUndefined();
		expect(fresh.prototype).toBeUndefined(); // constructor.prototype 注入未生效
	});
});

describe("sanitize 不 mutate 原输入", () => {
	it("deep-frozen 输入全程无损（任何 mutate 尝试都会以 TypeError 暴露）", () => {
		const input = validPlan3();
		deepFreeze(input);
		const before = JSON.stringify(input);
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(true);
		expect(JSON.stringify(input)).toBe(before); // 输入未被改动
		if (!result.ok) return;
		expect(result.plan).not.toBe(input); // 输出是净化副本而非原对象
		expect(Object.isFrozen(result.plan)).toBe(true);
		expect(Object.isFrozen(result.plan.steps[0])).toBe(true);
	});
});

describe("validateResearchPlan — 负例", () => {
	it("JSON 解析失败 → 错误信息含解析位置/原因", () => {
		const result = validateResearchPlan('{"version": 1, "task": "x"', 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/JSON 解析失败/);
		expect(result.errors[0]).toMatch(/position|位置|Unexpected|Expected/);
	});

	it("顶层非对象（数字 / 数组 / null 文本）", () => {
		for (const bad of [42, "[1,2,3]", "null"]) {
			const result = validateResearchPlan(bad, 5);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.errors[0]).toContain("计划必须是 JSON 对象");
		}
	});

	it("缺字段：顶层缺 origin（typebox 层报告）", () => {
		const input = validPlan3();
		delete input.origin;
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("结构校验失败");
	});

	it("缺字段：步骤缺 agent（sanitize 层报告，含步骤定位上下文）", () => {
		const input = validPlan3();
		delete (input.steps as JsonRecord[])[0].agent;
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors[0]).toContain("步骤 #0");
		expect(result.errors[0]).toContain("agent");
		expect(result.errors[0]).toContain("缺失");
	});

	it('version 非 1（2 / 字符串 "1" / 1.5 / 缺失）→ 统一拒绝', () => {
		for (const bad of [2, "1", 1.5, undefined]) {
			const input = validPlan3();
			if (bad === undefined) delete input.version;
			else input.version = bad;
			const result = validateResearchPlan(input, 5);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.errors[0]).toContain("version 必须为数字 1");
		}
	});

	it("空 steps → 语义层拒绝", () => {
		const input = validPlan3();
		input.steps = [];
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors[0]).toContain("不含任何步骤");
	});

	it("越界步数：maxSteps=2 给 3 步 → 预算硬顶拒绝；恰好 3 步在上限时放行", () => {
		const over = validateResearchPlan(validPlan3(), 2);
		expect(over.ok).toBe(false);
		if (over.ok) return;
		expect(over.errors[0]).toContain("超出预算硬顶 2");

		const atLimit = validateResearchPlan(validPlan3(), 3);
		expect(atLimit.ok).toBe(true);
	});

	it("重复 id → 点名重复的 id", () => {
		const input = twoStepPlan([], ["a"]);
		(input.steps as JsonRecord[])[1].id = "a";
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain('步骤 id 重复："a"');
	});

	it("自引用（a 依赖 a）→ 单独点名自依赖", () => {
		const result = validateResearchPlan(twoStepPlan(["a"], ["a"]), 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain("引用了自身");
	});

	it("环依赖（a→b→a）→ 报环并点名环上节点", () => {
		const result = validateResearchPlan(twoStepPlan(["b"], ["a"]), 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const joined = result.errors.join("\n");
		expect(joined).toContain("存在依赖环");
		expect(joined).toContain('"a"');
		expect(joined).toContain('"b"');
	});

	it("重复依赖项（b dependsOn [a,a]）但无环 → 放行（入度按去重集合计数）", () => {
		// 防回归（I-1）：按出现次数计数的实现会把该合法 DAG 误报为环
		const result = validateResearchPlan(twoStepPlan([], ["a", "a"]), 5);
		expect(result.ok).toBe(true);
	});

	it("dependsOn 引用不存在的步骤 id", () => {
		const result = validateResearchPlan(twoStepPlan(["ghost"], []), 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join("\n")).toContain('依赖不存在的步骤 "ghost"');
	});

	it("dependsOn 非字符串数组（混合数字项）", () => {
		const input = twoStepPlan([], []);
		(input.steps as JsonRecord[])[0].dependsOn = ["ok", 42];
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors[0]).toContain("dependsOn 必须是字符串数组");
	});

	it("guidance 非 string（typebox 层报告）", () => {
		const input = validPlan3();
		(input.steps as JsonRecord[])[0].guidance = 3;
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const joined = result.errors.join("\n");
		expect(joined).toContain("结构校验失败");
		expect(joined).toContain("guidance");
	});

	it("origin 非法 → 错误均为非空字符串句（可注入重试 prompt）", () => {
		const input = validPlan3();
		input.origin = "hallucinated";
		const result = validateResearchPlan(input, 5);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.length).toBeGreaterThan(0);
		for (const error of result.errors) {
			expect(typeof error).toBe("string");
			expect(error.length).toBeGreaterThan(0);
		}
	});
});
