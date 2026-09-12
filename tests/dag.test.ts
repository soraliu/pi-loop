// topoLayers（src/core/dag.ts）单元测试（M3-T3）
// 收敛背景：orchestrator 与 planner-static 的两份私有实现已删除，本套是
// 「环 / 重复 / 幽灵依赖」行为在全仓的唯一锁定点；两个消费侧
// （tests/planner.test.ts、tests/orchestrator.test.ts）只保留各自入口的
// 契约级断言。错误文案与 planner-static M2 既有抛错语义逐字对齐
// （消费侧既有负例因此保持绿）；dependsOn 重复项例外：按 Controller ruling
// 反转为去重计数放行（与 plan-schema 的 I-1 修复语义统一）。

import { describe, expect, it } from "vitest";

import { topoLayers } from "../src/core/dag.ts";
import type { PlanStep } from "../src/types.ts";

/** 构造步骤的小助手（dependsOn 缺省为空） */
function step(partial: Partial<PlanStep> & { id: string }): PlanStep {
	return {
		agent: "researcher",
		task: `任务 ${partial.id}`,
		dependsOn: [],
		...partial,
	};
}

/** 分层结果的 id 视图（断言可读性） */
function layerIds(steps: PlanStep[]): string[][] {
	return topoLayers(steps).map((layer) => layer.map((s) => s.id));
}

describe("topoLayers — 分层正确性", () => {
	it("扇形（a 依赖 b、c）→ [[b, c], [a]]，层内保持 steps 声明序", () => {
		const steps = [
			step({ id: "a", dependsOn: ["b", "c"] }),
			step({ id: "b" }),
			step({ id: "c" }),
		];
		expect(layerIds(steps)).toEqual([["b", "c"], ["a"]]);
	});

	it("菱形（a→b,c→d）→ [[a], [b, c], [d]]", () => {
		const steps = [
			step({ id: "a" }),
			step({ id: "b", dependsOn: ["a"] }),
			step({ id: "c", dependsOn: ["a"] }),
			step({ id: "d", dependsOn: ["b", "c"] }),
		];
		expect(layerIds(steps)).toEqual([["a"], ["b", "c"], ["d"]]);
	});

	it("全串行依赖链 → 每层单步，逐层剥出", () => {
		const steps = [
			step({ id: "c", dependsOn: ["b"] }),
			step({ id: "b", dependsOn: ["a"] }),
			step({ id: "a" }),
		];
		expect(layerIds(steps)).toEqual([["a"], ["b"], ["c"]]);
	});

	it("同层解锁项仍按 steps 声明序入层（不被解锁时序抢位）", () => {
		// x 先声明但依赖 c；同层序列表必须保持 x 先于 yy（steps 原序）
		const steps = [
			step({ id: "x", dependsOn: ["c"] }),
			step({ id: "c" }),
			step({ id: "yy", dependsOn: ["c"] }),
		];
		expect(layerIds(steps)).toEqual([["c"], ["x", "yy"]]);
	});

	it("多个前置分别解锁的第二层，仍按 steps 声明序拼接", () => {
		const steps = [
			step({ id: "c" }),
			step({ id: "a" }),
			step({ id: "x", dependsOn: ["c"] }),
			step({ id: "y", dependsOn: ["a"] }),
		];
		expect(layerIds(steps)).toEqual([
			["c", "a"],
			["x", "y"],
		]);
	});

	it("dependsOn 重复项（[a, a] 无环）→ 按去重计数放行，正常分层", () => {
		// Controller ruling（M3-T3）：重复依赖项 = "依赖 a"的无害冗余——与
		// plan-schema 的去重计数语义（I-1 修复）统一（schema 放行的形状，
		// 编译/执行层不得拒绝）；本用例反转 M2 时代的保守报环锁定
		const steps = [step({ id: "a" }), step({ id: "b", dependsOn: ["a", "a"] })];
		expect(layerIds(steps)).toEqual([["a"], ["b"]]);
	});

	it("返回步骤引用（编排器按引用消费，不做拷贝）", () => {
		const steps = [step({ id: "a" }), step({ id: "b", dependsOn: ["a"] })];
		const layers = topoLayers(steps);
		expect(layers[0]?.[0]).toBe(steps[0]);
		expect(layers[1]?.[0]).toBe(steps[1]);
	});
});

describe("topoLayers — 负例（错误语义与既有消费侧锁定对齐）", () => {
	it("空计划 → 抛错（文案与 orchestrator/planner-static 既有口径一致）", () => {
		expect(() => topoLayers([])).toThrow("计划校验失败：计划不含任何步骤");
	});

	it("步骤 id 重复 → 点名重复项", () => {
		const steps = [step({ id: "a" }), step({ id: "a", task: "重复" })];
		expect(() => topoLayers(steps)).toThrow('计划校验失败：步骤 id 重复 "a"');
	});

	it("依赖不存在的步骤 → 点名发端与幽灵", () => {
		const steps = [step({ id: "a", dependsOn: ["ghost"] })];
		expect(() => topoLayers(steps)).toThrow(
			'计划校验失败：步骤 "a" 依赖不存在的步骤 "ghost"',
		);
	});

	it("两步互依环 → 报环并点名全部环上节点", () => {
		const steps = [
			step({ id: "a", dependsOn: ["b"] }),
			step({ id: "b", dependsOn: ["a"] }),
		];
		expect(() => topoLayers(steps)).toThrow("计划校验失败：依赖环涉及 a, b");
	});

	it("自依赖（a dependsOn [a]）→ 报环", () => {
		const steps = [step({ id: "a", dependsOn: ["a"] })];
		expect(() => topoLayers(steps)).toThrow(/依赖环涉及 a/);
	});

	it("校验顺序：id 重复先于幽灵依赖报出（与 M2 断言序一致）", () => {
		const steps = [step({ id: "a", dependsOn: ["ghost"] }), step({ id: "a" })];
		expect(() => topoLayers(steps)).toThrow(/id 重复/);
	});
});
