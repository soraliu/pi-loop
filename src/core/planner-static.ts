// pi-loop 静态计划与 workflowScript 编译器（M2-T2）
// 依据 docs/plans/m2-orchestrator.md T2、docs/SPEC.md §4（Orchestrator 契约）。
//
// 职责：把 PlanDraft（步骤 DAG）编译为 pi-subagents 可执行的 workflowScript 字符串。
// 安全不变式：所有动态值（agent/task）一律 JSON.stringify 后嵌入字符串字面量位置，
// 使引号/反引号/${}/换行均被转义，调用方注入的文本无法逃逸出字符串字面量。

import type { PlanDraft, PlanStep } from "../types.ts";

/**
 * 内置"标准研究"静态计划（M2 最小闭环主线）。
 * M3 的 Designer 将以动态生成替代本函数；接口（入参任务全文、出参 PlanDraft）保持不变。
 */
export function BUILTIN_PLAN(task: string): PlanDraft {
	return {
		steps: [
			{
				id: "research",
				agent: "researcher",
				task,
				dependsOn: [],
			},
		],
	};
}

/** 编译前校验一：步骤 id 唯一 */
function assertUniqueIds(steps: PlanStep[]): Map<string, PlanStep> {
	const byId = new Map<string, PlanStep>();
	for (const step of steps) {
		if (byId.has(step.id)) {
			throw new Error(`计划校验失败：步骤 id 重复 "${step.id}"`);
		}
		byId.set(step.id, step);
	}
	return byId;
}

/** 编译前校验二：dependsOn 引用必须存在 */
function assertKnownDeps(byId: Map<string, PlanStep>): void {
	for (const step of byId.values()) {
		for (const dep of step.dependsOn) {
			if (!byId.has(dep)) {
				throw new Error(
					`计划校验失败：步骤 "${step.id}" 依赖不存在的步骤 "${dep}"`,
				);
			}
		}
	}
}

/** 编译前校验三：Kahn 环检测（摘不完入度即有环） */
function assertAcyclic(steps: PlanStep[]): void {
	const indegree = new Map<string, number>();
	for (const step of steps) indegree.set(step.id, 0);
	for (const step of steps) {
		for (const dep of step.dependsOn) {
			indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
		}
	}
	const queue = steps
		.filter((s) => (indegree.get(s.id) ?? 0) === 0)
		.map((s) => s.id);
	let removed = 0;
	while (queue.length > 0) {
		const id = queue.shift() as string;
		removed++;
		for (const step of steps) {
			if (step.dependsOn.includes(id)) {
				const next = (indegree.get(step.id) ?? 0) - 1;
				indegree.set(step.id, next);
				if (next === 0) queue.push(step.id);
			}
		}
	}
	if (removed !== steps.length) {
		const cycleNodes = steps
			.filter((s) => (indegree.get(s.id) ?? 0) > 0)
			.map((s) => s.id);
		throw new Error(`计划校验失败：依赖环涉及 ${cycleNodes.join(", ")}`);
	}
}

/**
 * 编译前校验四：步骤 id 归一化成 JS 变量名后互不冲突。
 * varName 把非标识符字符替换为下划线（"a-b" 与 "a_b" 都得 s_a_b）——
 * 不拦截会产生 const 重声明，产物即非法脚本。
 */
function assertDistinctVarNames(steps: PlanStep[]): void {
	const seen = new Set<string>();
	for (const step of steps) {
		const v = varName(step.id);
		if (seen.has(v)) {
			throw new Error(
				`计划校验失败：步骤 id "${step.id}" 归一化后变量名 "${v}" 与其他步骤冲突`,
			);
		}
		seen.add(v);
	}
}

/**
 * 拓扑分层：同一层内的步骤互不依赖，可并行（runs.all）；
 * 层间串行（后层依赖前层的产物）。Kahn 分层实现。
 */
function topoLayers(plan: PlanDraft): PlanStep[][] {
	const byId = new Map<string, PlanStep>();
	for (const step of plan.steps) byId.set(step.id, step);
	const remaining = new Map(byId);
	const layers: PlanStep[][] = [];
	while (remaining.size > 0) {
		const layer = [...remaining.values()].filter((step) =>
			step.dependsOn.every((dep) => !remaining.has(dep)),
		);
		if (layer.length === 0) {
			// 理论上 assertAcyclic 已拦截环；此处兜底防御
			throw new Error("拓扑分层失败：剩余步骤存在未检出的依赖环");
		}
		for (const step of layer) remaining.delete(step.id);
		layers.push(layer);
	}
	return layers;
}

/** 动态值 → 字面量安全嵌入（JSON.stringify 转义引号/反引号/${}/换行） */
function lit(value: string): string {
	return JSON.stringify(value);
}

/** 单个 runs.run 调用的键名变量（合法 JS 标识符：step id 经前缀 s_ + 非字符替换） */
function varName(stepId: string): string {
	return "s_" + stepId.replace(/[^A-Za-z0-9_$]/g, "_");
}

/**
 * 把 PlanDraft 编译为 workflowScript（JS 语句体，非函数）：
 * - 无依赖单步：`const s_x = await runs.run("x", {agent, task}); return { x: s_x };`
 * - 多步 DAG：拓扑分层——层内 `await runs.all([{key, agent, task}, ...])`，
 *   层间串行 await；`return {...}` 汇总全部步骤结果。
 */
export function compileWorkflowScript(plan: PlanDraft): string {
	if (plan.steps.length === 0) {
		throw new Error("计划校验失败：计划不含任何步骤");
	}
	const byId = assertUniqueIds(plan.steps);
	assertKnownDeps(byId);
	assertAcyclic(plan.steps);
	assertDistinctVarNames(plan.steps);
	const layers = topoLayers(plan);
	const lines: string[] = [];
	const resultKeys: string[] = [];
	for (const layer of layers) {
		if (layer.length === 1) {
			const step = layer[0];
			const v = varName(step.id);
			lines.push(
				`const ${v} = await runs.run(${lit(step.id)}, { agent: ${lit(step.agent)}, task: ${lit(step.task)} });`,
			);
			resultKeys.push(`\t${lit(step.id)}: ${v}`);
		} else {
			const items = layer
				.map(
					(step) =>
						`\t\t{ key: ${lit(step.id)}, agent: ${lit(step.agent)}, task: ${lit(step.task)} },`,
				)
				.join("\n");
			lines.push(
				`const [${layer.map((s) => varName(s.id)).join(", ")}] = await runs.all([\n${items}\n\t]);`,
			);
			for (const step of layer) {
				resultKeys.push(`\t${lit(step.id)}: ${varName(step.id)}`);
			}
		}
	}
	lines.push("return {");
	lines.push(resultKeys.join(",\n"));
	lines.push("};");
	return lines.join("\n");
}
