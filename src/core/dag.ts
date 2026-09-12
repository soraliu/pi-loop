// pi-loop 计划 DAG 拓扑分层（M3-T3 收敛）
// 终审 M-5 债务结算：orchestrator 与 planner-static 各有一份私有 topoLayers，
// 收敛后本模块是唯一真源——两处一律经 import 消费，私有副本已删除。
//
// 语义对齐（环/重复/幽灵依赖的行为锁定统一在 dag 侧（tests/dag.test.ts），
// 消费侧只保留契约级断言）：
//   - 校验顺序与错误文案保持两个消费侧 M2 已锁定的形态：
//       空计划 → "计划校验失败：计划不含任何步骤"
//       id 重复 → "计划校验失败：步骤 id 重复 \"x\""
//       幽灵依赖 → "计划校验失败：步骤 \"x\" 依赖不存在的步骤 \"y\""
//       依赖环   → "计划校验失败：依赖环涉及 a, b"（点名全部环上节点）
//   - 计数式 Kahn（去重计数）：dependsOn 重复项（如 ["a","a"]）是"依赖 a"的
//     无害冗余——入度按 new Set(dependsOn) 计数、剥离时每个 (前置, 步骤) 组合
//     只销账一次，重复项不残留入度、不误报环。此为 Controller ruling（M3-T3）：
//     与 plan-schema 的 I-1 修复语义统一（schema 放行的形状，编译/执行层不得
//     拒绝）；planner.test.ts 的 M2 保守报环锁定随之反转。
//   - 分层结果（M3-T3 review M-1 弱化为如实描述）：层集合与 M2 过滤式实现一致；
//     层内序为「next 拼接序」——首层按 steps 声明序（filter 保序），后续层按
//     （前置层序 × 依赖表构建序，两者均源自声明序）逐组合拼接，交叉解锁时可能在
//     全局声明序之外。不实现稳定排序：层内是并行集合，消费侧不依赖层内次序。

import type { PlanStep } from "../types.ts";

/**
 * 拓扑分层：steps → 层序数组。同一层内的步骤互不依赖（可并行），层间必须串行。
 * 输入结构非法（空计划 / 步骤 id 重复 / 依赖不存在 / 依赖环）一律抛错——
 * 消费方（compileWorkflowScript / executePlan）把它视为计划校验失败处理，
 * 不产出半途产物。
 */
export function topoLayers(steps: PlanStep[]): PlanStep[][] {
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
	// 计数式 Kahn 分层（去重计数）：入度按去重后的依赖集合大小计数，前置剥离时
	// 每个 (前置, 步骤) 组合只销账一次——重复依赖项不残留入度（不误报环）
	const indegree = new Map<string, number>();
	// 前置 id → 依赖它的步骤列表（键内已去重；列表按 steps 声明序构造——层内序
	// 由「前置层序 × 声明序」的拼接决定，不保证全局声明序，见文件头说明）
	const dependents = new Map<string, PlanStep[]>();
	for (const step of steps) {
		const deps = new Set(step.dependsOn); // 重复依赖项去重（"依赖 a"的无害冗余，Controller ruling）
		indegree.set(step.id, deps.size);
		for (const dep of deps) {
			const list = dependents.get(dep);
			if (list === undefined) dependents.set(dep, [step]);
			else list.push(step);
		}
	}
	const layers: PlanStep[][] = [];
	/** 已纳入分层的步骤数（收尾与 steps.length 比对即环检测的"摘不完"判定） */
	let layered = 0;
	let frontier = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0);
	while (frontier.length > 0) {
		layers.push(frontier);
		layered += frontier.length;
		const next: PlanStep[] = [];
		for (const step of frontier) {
			for (const dependent of dependents.get(step.id) ?? []) {
				const rest = (indegree.get(dependent.id) ?? 0) - 1;
				indegree.set(dependent.id, rest);
				if (rest === 0) next.push(dependent);
			}
		}
		frontier = next;
	}
	if (layered !== steps.length) {
		const cycleNodes = steps
			.filter((step) => (indegree.get(step.id) ?? 0) > 0)
			.map((step) => step.id);
		throw new Error(`计划校验失败：依赖环涉及 ${cycleNodes.join(", ")}`);
	}
	return layers;
}
