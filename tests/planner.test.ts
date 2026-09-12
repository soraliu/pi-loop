// planner-static 编译器测试（M2-T2）
// 重点：转义安全（注入攻击样例不可逃逸）、DAG 分层正确、三负例拦截、BUILTIN_PLAN 形状。

import { describe, expect, it } from "vitest";

import {
	BUILTIN_PLAN,
	compileWorkflowScript,
} from "../src/core/planner-static.ts";
import type { PlanDraft, PlanStep } from "../src/types.ts";

/** 构造步骤的小助手（dependsOn 缺省为空） */
function step(partial: Partial<PlanStep> & { id: string }): PlanStep {
	return {
		agent: "researcher",
		task: `任务 ${partial.id}`,
		dependsOn: [],
		...partial,
	};
}

describe("BUILTIN_PLAN", () => {
	it("返回单步 researcher 计划，task 原样透传", () => {
		const plan = BUILTIN_PLAN("研究 pi-loop 的调度内核");
		expect(plan.steps).toHaveLength(1);
		const s = plan.steps[0];
		expect(s.id).toBe("research");
		expect(s.agent).toBe("researcher");
		expect(s.task).toBe("研究 pi-loop 的调度内核");
		expect(s.dependsOn).toEqual([]);
	});
});

describe("compileWorkflowScript — 单步", () => {
	it("产物含 runs.run 调用、agent/task 的 JSON 字面量、return 汇总", () => {
		const script = compileWorkflowScript(BUILTIN_PLAN("hello world"));
		expect(script).toContain('await runs.run("research"');
		expect(script).toContain('{ agent: "researcher", task: "hello world" }');
		expect(script).toContain("return {");
		expect(script).toContain('"research": s_research');
	});

	it("task 含引号/反引号/模板插值时全部被转义（注入不可逃逸）", async () => {
		const evil = 'x"}); require("node:fs").readFileSync("/etc/passwd"); ("';
		const script = compileWorkflowScript(BUILTIN_PLAN(evil));
		// 原始双引号必须被转义（产物含转义序列，而非裸引号闭合）
		expect(script).toContain(JSON.stringify(evil).slice(1, -1));

		// 执行级验证：用 stub runs 实跑产物——注入文本原样到达参数，
		// require 不会执行（无逃逸出字符串字面量的语句），全程不抛异常
		const captured: Array<{ key: string; agent: string; task: string }> = [];
		const runs = {
			run: async (key: string, opts: { agent: string; task: string }) => {
				captured.push({ key, ...opts });
				return { ok: true };
			},
			all: async (items: Array<{ key: string; agent: string; task: string }>) =>
				items.map((it) => captured.push(it)),
		};
		const executor = new Function(
			"runs",
			`return (async () => {\n${script}\n})()`,
		);
		await executor(runs);
		expect(captured).toHaveLength(1);
		expect(captured[0].task).toBe(evil); // 原样到达，无逃逸/无提前闭合
		expect(captured[0].agent).toBe("researcher");
	});

	it("task 含反引号/模板插值时全部被转义", () => {
		const evil2 = "`${process.env.PATH}` + `";
		const script2 = compileWorkflowScript(BUILTIN_PLAN(evil2));
		// 双引号字面量内 ${} 与反引号均无特殊含义；只要求转义后的原文完整在场
		expect(script2).toContain(JSON.stringify(evil2).slice(1, -1));
	});

	it("含换行的 task 产出 \\n 转义（保持单行语句）", () => {
		const script = compileWorkflowScript(BUILTIN_PLAN("第一行\n第二行"));
		expect(script).toContain("第一行\\n第二行");
		expect(script.split("\n").length).toBeLessThanOrEqual(6); // 单步语句不碎行
	});
});

describe("compileWorkflowScript — DAG 分层", () => {
	it("扇形三步（b,c 依赖 a）编译为先 a 后 runs.all([b,c]) 的拓扑序", () => {
		const plan: PlanDraft = {
			steps: [
				step({ id: "a", task: "基础研究" }),
				step({ id: "b", task: "深入 b", dependsOn: ["a"] }),
				step({ id: "c", task: "深入 c", dependsOn: ["a"] }),
			],
		};
		const script = compileWorkflowScript(plan);
		const posA = script.indexOf('await runs.run("a"');
		const posAll = script.indexOf("await runs.all([");
		expect(posA).toBeGreaterThanOrEqual(0);
		expect(posAll).toBeGreaterThan(posA); // a 先于并行层
		expect(script).toContain('{ key: "b", agent: "researcher"');
		expect(script).toContain('{ key: "c", agent: "researcher"');
		expect(script).toContain("return {");
	});

	it("菱形四步（a→b,c→d）分层为 a / [b,c] / d", () => {
		const plan: PlanDraft = {
			steps: [
				step({ id: "a" }),
				step({ id: "b", dependsOn: ["a"] }),
				step({ id: "c", dependsOn: ["a"] }),
				step({ id: "d", dependsOn: ["b", "c"] }),
			],
		};
		const script = compileWorkflowScript(plan);
		const posA = script.indexOf('await runs.run("a"');
		const posAll = script.indexOf("await runs.all([");
		const posD = script.indexOf('await runs.run("d"');
		expect(posA).toBeLessThan(posAll);
		expect(posAll).toBeLessThan(posD);
	});
});

describe("compileWorkflowScript — 负例", () => {
	it("依赖环 → 抛错并点名环上节点", () => {
		const plan: PlanDraft = {
			steps: [
				step({ id: "a", dependsOn: ["b"] }),
				step({ id: "b", dependsOn: ["a"] }),
			],
		};
		expect(() => compileWorkflowScript(plan)).toThrow(/依赖环/);
	});

	it("重复 id → 抛错", () => {
		const plan: PlanDraft = {
			steps: [step({ id: "a" }), step({ id: "a", task: "重复" })],
		};
		expect(() => compileWorkflowScript(plan)).toThrow(/id 重复/);
	});

	it("id 归一化后变量名冲突（a-b 与 a_b → 都是 s_a_b）→ 抛错", () => {
		const plan: PlanDraft = {
			steps: [step({ id: "a-b" }), step({ id: "a_b" })],
		};
		expect(() => compileWorkflowScript(plan)).toThrow(/变量名.*冲突/);
	});

	it("dependsOn 引用不存在的 id → 抛错", () => {
		const plan: PlanDraft = {
			steps: [step({ id: "a", dependsOn: ["ghost"] })],
		};
		expect(() => compileWorkflowScript(plan)).toThrow(/不存在的步骤 "ghost"/);
	});

	it("空计划 → 抛错", () => {
		expect(() => compileWorkflowScript({ steps: [] })).toThrow(/不含任何步骤/);
	});
});
