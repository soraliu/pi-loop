// pi-loop 静态计划与 workflowScript 编译器（M2-T2）
// 依据 docs/plans/m2-orchestrator.md T2、docs/SPEC.md §4（Orchestrator 契约）。
//
// 职责：把 PlanDraft（步骤 DAG 视图）编译为 pi-subagents 可执行的 workflowScript 字符串；
// 全量计划形状 ResearchPlan（M3-T1）是 PlanDraft 的结构超集，直接可喂。
// 安全不变式：所有动态值（agent/task）一律 JSON.stringify 后嵌入字符串字面量位置，
// 使引号/反引号/${}/换行均被转义，调用方注入的文本无法逃逸出字符串字面量。
// M3-T3：结构校验 + 拓扑分层收敛到共享 util ./dag.ts（唯一真源），本模块只保留
// 编译器特有的校验（变量名冲突）与产物拼接。

import { topoLayers } from "./dag.ts";
import type { PlanDraft, PlanStep, ResearchPlan } from "../types.ts";

/**
 * 内置"标准研究"静态计划（M2 最小闭环主线）。
 * M3 的 Designer 将以动态生成替代本函数；M3-T1 起出参升级为 ResearchPlan
 * （origin 固定 "builtin"），入参（任务全文）保持不变。compileWorkflowScript
 * 与 executePlan 按 PlanDraft 视图消费（只读 steps），结构兼容无需调整。
 */
export function BUILTIN_PLAN(task: string): ResearchPlan {
	return {
		version: 1,
		task,
		origin: "builtin",
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

/**
 * 编译前校验（本模块特有）：步骤 id 归一化成 JS 变量名后互不冲突。
 * varName 把非标识符字符替换为下划线（"a-b" 与 "a_b" 都得 s_a_b）——
 * 不拦截会产生 const 重声明，产物即非法脚本。
 *
 * 注：空计划 / id 重复 / 幽灵依赖 / 依赖环四类结构校验已收敛到 dag.topoLayers
 * （M3-T3 单一真源），编译器侧的既有负例用例因此保持绿（契约级断言）。
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
	// 空计划拦截也收敛在 dag.topoLayers 内（同一文案、同一触发）——此处不再重复检查；
	// id 重复 / 依赖不存在 / 依赖环（含 dependsOn 重复项的保守报环）同样如此，
	// 本模块只做编译器特有的变量名冲突校验。
	const layers = topoLayers(plan.steps);
	assertDistinctVarNames(plan.steps);
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
