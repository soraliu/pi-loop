// iterate 迭代引擎测试（M4-T2；M4-T3 补 telemetry 收尾用例）
// 全脚本化 fake RPC + 临时 dataDir + 真 node -e 微脚本（verifyCommand 通道）——
// 无真 spawn、无真网络（真实 critic/designer 链路归 e2e）。fake 按 spawn 任务文本
// 分诊三类角色（designer=设计提示词 / critic=评审提示词 / 其他=计划步骤），各自
// 维护脚本队列：designer 写实产文件（文件通道一次即成）、critic 按序回围栏结论、
// 步骤按 spawn 序消费结局（缺省成功）——轮次行为完全可预测（Round 计数口径：0 起计）。
// 另：执行层计划预算拒绝在自然流里不可达（designer 先行校验同一条预算上限，
// 执行层闸是双保险）——该分支经 vi.mock 注入 executePlan 返回形覆盖（见顶部
// rejectedOutcomes，与 extension.test.ts 的 outcomeOverrides 同手法）。

import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	runWithIterations,
	type IterateAdapter,
	type RoundEvent,
} from "../src/core/iterate.ts";
import type { RunOutcome } from "../src/core/orchestrator.ts";
import type { DesignerOutcome } from "../src/core/designer.ts";
import type {
	EffortPreset,
	IterationEntry,
	ResearchPlan,
} from "../src/types.ts";
import type { RunRecord } from "../src/storage/workspace.ts";
import { createRunRecord, ensureWorkspace } from "../src/storage/workspace.ts";

// ---------- executePlan 的返回形注入（M4-T3：空计划拒绝路径） ----------
// vi.mock 对整个文件生效：wrapper 透传实际实现（既有用例零影响），仅当注入队列
// 非空时按序消费其一绕过真实调度。vi.mock 工厂会被提升到文件顶部，引用的变量
// 必须经 vi.hoisted 同样提升。
const rejectedOutcomes = vi.hoisted(() => [] as RunOutcome[]);
vi.mock("../src/core/orchestrator.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/core/orchestrator.ts")>();
	return {
		...actual,
		executePlan: (
			plan: Parameters<typeof actual.executePlan>[0],
			ctx: Parameters<typeof actual.executePlan>[1],
		) => {
			const override = rejectedOutcomes.shift();
			if (override !== undefined) return Promise.resolve(override);
			return actual.executePlan(plan, ctx);
		},
	};
});

/** 本文件创建的临时目录清单——afterAll 只清理这些（登记制） */
const createdDirs: string[] = [];

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** 任务原文 */
const PLAN_TASK = "迭代引擎测试任务：对比并发调度策略";

/** 两步无依赖计划（步骤 spawn 序确定：survey → synth——同层 Promise.map 顺序） */
function twoStepPlan(): ResearchPlan {
	return {
		version: 1,
		task: PLAN_TASK,
		origin: "designer",
		notes: "两步：摸底后综合",
		steps: [
			{
				id: "survey",
				agent: "researcher",
				task: "摸底主流方案",
				dependsOn: [],
				acceptance: "覆盖三家",
			},
			{
				id: "synth",
				agent: "researcher",
				task: "综合对比结论",
				dependsOn: [],
			},
		],
	};
}

/** 重设计后的两步计划（换 id：验证 fresh 轮不注入、entry 分轮归组按新步骤） */
function redesignPlan(): ResearchPlan {
	return {
		version: 1,
		task: PLAN_TASK,
		origin: "designer",
		notes: "重设计：换切入角",
		steps: [
			{ id: "probe", agent: "researcher", task: "换角度摸底", dependsOn: [] },
			{ id: "report", agent: "researcher", task: "重构结论", dependsOn: [] },
		],
	};
}

/**
 * 两步两 agent 计划（M4-T3：agents 去重口径的断言素材——entry 数多但去重后仅
 * 2：survey=researcher / synth=writer）。无依赖：spawn 序确定 survey → synth。
 */
function twoAgentPlan(): ResearchPlan {
	return {
		version: 1,
		task: PLAN_TASK,
		origin: "designer",
		notes: "两 agent 分工：摸底与综合",
		steps: [
			{ id: "survey", agent: "researcher", task: "摸底主流方案", dependsOn: [] },
			{ id: "synth", agent: "writer", task: "综合对比结论", dependsOn: [] },
		],
	};
}

/** 注入前缀模板的测试侧镜像（与 core/iterate.ts 的裁定文案一致——漂移由断言暴露） */
function injected(reason: string, task: string): string {
	return `前一轮失败：${reason}。请修正此步骤避免同类问题：${task}`;
}

/** 临时 dataDir + 预建 run 记录 + fresh fake（iterate 的调用现场全量注入） */
function setupRun(): {
	fake: IterateFakeRpc;
	dataDir: string;
	runId: string;
} {
	const dataDir = ensureWorkspace(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-iterate-")),
	);
	createdDirs.push(dataDir);
	const record = createRunRecord(dataDir, PLAN_TASK, "medium");
	return { fake: new IterateFakeRpc(), dataDir, runId: record.id };
}

/** 读回 run.json（落盘断言用——含 M4-T2 新键） */
function readRecord(ctx: { dataDir: string; runId: string }): RunRecord & {
	error?: string;
} {
	return JSON.parse(
		fs.readFileSync(
			path.join(ctx.dataDir, "runs", ctx.runId, "run.json"),
			"utf-8",
		),
	);
}

/** 测试用预设（迭代预算独立可调——其余字段取 medium 同款量级） */
function presetOf(maxResultIterations: number): EffortPreset {
	return {
		maxResultIterations,
		maxParallelSubagents: 4,
		maxPlanSteps: 5,
		metaTrigger: { kind: "off" },
	};
}

/** 计划步骤 spawn 的脚本化结局（缺省成功） */
interface StepScript {
	/** 完成事件携带 error（步骤失败——落 entry.error） */
	error?: string;
	/** 完成事件 summary */
	summary?: string;
	/** 投递延迟（ms，缺省 1） */
	delayMs?: number;
}

/**
 * 脚本化 fake RPC（三角色分诊合流体）：spawn 按任务文本分类记账并各自走脚本——
 * designer spawn 同步写实产文件后投递成功事件（文件通道一次即成，attempts=1）；
 * critic spawn 按序回围栏评估；其余（计划步骤）按 spawn 序消费 StepScript。
 * waitForCompletion(runId 匹配) / stop——与 evaluator.test / designer.test 的 fake 同语义。
 */
class IterateFakeRpc {
	readonly spawns: Array<{
		task: string;
		agent: string;
		kind: "designer" | "critic" | "step";
		runId: string;
	}> = [];
	readonly designerPrompts: string[] = [];
	readonly criticPrompts: string[] = [];
	/** 步骤 spawn 的任务文本（归因注入面的断言面——按 spawn 序） */
	readonly stepTasks: string[] = [];
	readonly waits: Array<{ runId?: string; timeoutMs?: number }> = [];
	readonly stopCalls: string[] = [];
	/** designer 计划产物（按调用序；首个失败轮之后的重设计用例排第二个） */
	designerPlans: ResearchPlan[] = [];
	/** critic 回复（按轮序；>1 个时 shift 消费，单个时每轮复用） */
	criticReplies: string[] = [];
	/** 步骤结局队列（按 step spawn 序；耗尽回落成功） */
	stepOutcomes: StepScript[] = [];
	private nextRunId = 0;
	private readonly waiters: Array<{
		runId: string | undefined;
		resolve: (payload: unknown) => void;
	}> = [];

	/** 下一个 designer 计划（>1 个排队的逐个 shift；单个复用；空则测试配置错误如实抛） */
	private nextDesignerPlan(): ResearchPlan {
		if (this.designerPlans.length > 1) {
			const plan = this.designerPlans.shift();
			if (plan !== undefined) return plan;
		}
		if (this.designerPlans.length === 1) return this.designerPlans[0];
		throw new Error("测试未脚本化 designer 计划（designerPlans 为空）");
	}

	/** 下一个 critic 回复（同 designer 消费规则） */
	private nextCriticReply(): string {
		if (this.criticReplies.length > 1) {
			const reply = this.criticReplies.shift();
			if (reply !== undefined) return reply;
		}
		if (this.criticReplies.length === 1) return this.criticReplies[0];
		throw new Error("测试未脚本化 critic 回复（criticReplies 为空）");
	}

	async spawn(params: {
		agent?: string;
		task?: string;
		context?: string;
	}): Promise<{ runId: string }> {
		const task = params.task ?? "";
		const runId = `s-${++this.nextRunId}`;
		const kind: "designer" | "critic" | "step" = task.includes("研究计划设计师")
			? "designer"
			: task.includes("研究任务评审员")
				? "critic"
				: "step";
		this.spawns.push({ task, agent: params.agent ?? "", kind, runId });

		if (kind === "designer") {
			this.designerPrompts.push(task);
			// 与真实时序同构：产物文件先于完成事件可见（designer 文件通道因此在场）
			const match = /把最终 ResearchPlan 的完整 JSON 写入文件：(\S+)/.exec(task);
			if (match !== null) {
				const planFile = match[1];
				fs.mkdirSync(path.dirname(planFile), { recursive: true });
				fs.writeFileSync(planFile, JSON.stringify(this.nextDesignerPlan()));
			}
			setTimeout(() => this.deliver(runId, { status: "succeeded" }), 1);
			return { runId };
		}
		if (kind === "critic") {
			this.criticPrompts.push(task);
			setTimeout(
				() =>
					this.deliver(runId, {
						status: "succeeded",
						output: this.nextCriticReply(),
					}),
				1,
			);
			return { runId };
		}
		// 计划步骤：按 spawn 序消费脚本（缺省成功——空 payload 无失败标记即成功）
		this.stepTasks.push(task);
		const script = this.stepOutcomes.shift() ?? {};
		const payload: Record<string, unknown> = { status: "succeeded" };
		if (script.error !== undefined) {
			payload.status = "failed";
			payload.error = script.error;
		} else if (script.summary !== undefined) {
			payload.summary = script.summary;
		}
		setTimeout(() => this.deliver(runId, payload), script.delayMs ?? 1);
		return { runId };
	}

	waitForCompletion(
		runId?: string,
		timeoutMs?: number,
	): Promise<unknown | null> {
		this.waits.push({ runId, timeoutMs });
		return new Promise((resolve) => {
			this.waiters.push({ runId, resolve });
		});
	}

	async stop(id: string): Promise<Record<string, unknown>> {
		this.stopCalls.push(id);
		return { stopped: id };
	}

	/**
	 * request 能力面（executePlan 的 rpc Pick 含它——本引擎不直接调用，测试侧
	 * 同样不消费；可被调用即抛错作为意外调用哨兵）
	 */
	async request(): Promise<never> {
		throw new Error("IterateFakeRpc.request 不应被消费（能力面占位）");
	}

	/** 投递完成事件：唤醒 runId 匹配（或约定任意事件的）等待者 */
	private deliver(runId: string, payload: Record<string, unknown>): void {
		const completion = { runId, ...payload };
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i];
			if (waiter.runId === runId || waiter.runId === undefined) {
				waiter.resolve(completion);
				this.waiters.splice(i, 1);
			}
		}
	}
}

/** 评估结论 → 围栏回复（输出契约形态） */
function fenceEvaluation(evaluation: Record<string, unknown>): string {
	return `评审小结：过程略。\n\`\`\`json\n${JSON.stringify(evaluation)}\n\`\`\``;
}

describe("runWithIterations — 迭代闭环（SPEC §4）", () => {
	it("一轮通过（verifyCommand exit 0）：零 critic spawn、final/evaluation 留档、entries round=0、轮次事件 start/end(done)", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan()];
		// critic 无脚本——任何 critic spawn 都会让 nextCriticReply 抛出（零 spawn 的恶意证明）
		const roundEvents: RoundEvent[] = [];
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			verifyCommand: `node -e "console.log('all done, looks good')"`,
			onUpdate: (update) => {
				if ("kind" in update) roundEvents.push(update);
			},
		});

		expect(result.outcome).toBe("verified");
		expect(result.finalRound).toBe(0);
		expect(result.error).toBeUndefined();
		expect(result.evaluation.verdict).toBe("verified");
		expect(result.evaluation.score).toBe(100);
		expect(result.evaluation.reasons.join()).toContain("退出码 0");
		// 互斥通道机器锁定（迭代循环内再核一次）：verifyCommand 在场零 critic spawn
		expect(ctx.fake.spawns.filter((s) => s.kind === "critic")).toHaveLength(0);
		// designer 只设计一次；两步各 spawn 一次（无迭代轮）
		expect(ctx.fake.spawns.filter((s) => s.kind === "designer")).toHaveLength(1);
		expect(ctx.fake.stepTasks).toEqual(["摸底主流方案", "综合对比结论"]);
		// 轮次事件：start → end(done)
		expect(roundEvents.map((e) => `${e.phase}:${String(e.next)}`)).toEqual([
			"start:undefined",
			"end:done",
		]);
		// run.json：completed + round=0 + final/evaluation 留档 + entries 分轮归组
		const record = readRecord(ctx);
		expect(record.status).toBe("completed");
		expect(record.round).toBe(0);
		expect(record.final).toEqual({ round: 0, verdict: "verified", score: 100 });
		expect(record.evaluation?.verdict).toBe("verified");
		expect(record.iterations.map((e) => e.round)).toEqual([0, 0]);
		expect(record.iterations.map((e) => `${e.stepId}:${e.status}`)).toEqual([
			"survey:succeeded",
			"synth:succeeded",
		]);
	});

	it("critic fail（blame: survey）→ 注入重跑 → 二轮 verified：blame 步骤 task 带前缀、非 blame 原样、跳过 designer 重生成、评估只喂当轮 entries", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan()];
		ctx.fake.criticReplies = [
			fenceEvaluation({
				verdict: "fail",
				score: 20,
				reasons: ["引用不足"],
				blame: ["survey"],
			}),
			fenceEvaluation({
				verdict: "verified",
				score: 95,
				reasons: ["达标"],
				blame: [],
			}),
		];
		// 首轮 synth 步骤失败（带标记——轮次素材隔离断言的锚点）；二轮两步都成功
		ctx.fake.stepOutcomes = [{}, { error: "round-zero-marker" }, {}, {}];
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
		});

		expect(result.outcome).toBe("verified");
		expect(result.finalRound).toBe(1);
		expect(result.evaluation.score).toBe(95);
		// 注入面（最小）：保留 plan 只改 blame 步骤的 task——survey 前缀注入（reason
		// 摘要 + 原文），synth 原样
		expect(ctx.fake.stepTasks).toEqual([
			"摸底主流方案",
			"综合对比结论",
			injected("引用不足", "摸底主流方案"),
			"综合对比结论",
		]);
		// 重跑跳过 designer 重生成（省预算防设计漂移——单一 blame 非「全步骤 fail」）
		expect(ctx.fake.spawns.filter((s) => s.kind === "designer")).toHaveLength(1);
		// 评估只喂当轮 entries：首轮 critic 素材含失败标记，次轮不含（陈旧条目不污染归因）
		expect(ctx.fake.criticPrompts[0]).toContain("round-zero-marker");
		expect(ctx.fake.criticPrompts[1]).not.toContain("round-zero-marker");
		// run.json：分轮归组（[0,0,1,1]）+ final 落在通过轮
		const record = readRecord(ctx);
		expect(record.status).toBe("completed");
		expect(record.round).toBe(1);
		expect(record.final).toEqual({ round: 1, verdict: "verified", score: 95 });
		expect(record.iterations.map((e: IterationEntry) => e.round)).toEqual([
			0, 0, 1, 1,
		]);
	});

	it("连续 fail 至预算尽（maxResultIterations=2 → 共执行 3 轮）：budget_exhausted 文案 + 最后 evaluation 留档 + blame 步骤逐轮注入", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan()];
		ctx.fake.criticReplies = [
			fenceEvaluation({
				verdict: "fail",
				score: 10,
				reasons: ["产出不达标"],
				blame: ["synth"],
			}),
		];
		const adapterCalls: DesignerOutcome[] = [];
		const adapter: IterateAdapter = {
			onPlanDesigned: (designed) => adapterCalls.push(designed),
		};
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			adapter,
		});

		expect(result.outcome).toBe("budget_exhausted");
		expect(result.finalRound).toBe(2);
		// 预算语义：文案如实（上限轮数 + 总执行轮数 + 末轮 verdict）
		expect(result.error).toBe(
			"budget_exhausted: 迭代轮数上限 2 轮用尽（共执行 3 轮，最后一轮 verdict=fail）",
		);
		// 最后 evaluation 留档（轮轮都是失败——取末轮）
		expect(result.evaluation).toEqual({
			verdict: "fail",
			score: 10,
			reasons: ["产出不达标"],
			blame: ["synth"],
		});
		// 单步骤 blame 不触发重设计：designer 保持 1 次、adapter 单次
		expect(ctx.fake.spawns.filter((s) => s.kind === "designer")).toHaveLength(1);
		expect(adapterCalls).toHaveLength(1);
		// 注入面按轮更新（素材取最近一轮的失败 reason）：二、三轮 synth 均带前缀
		expect(ctx.fake.stepTasks).toEqual([
			"摸底主流方案",
			"综合对比结论",
			"摸底主流方案",
			injected("产出不达标", "综合对比结论"),
			"摸底主流方案",
			injected("产出不达标", "综合对比结论"),
		]);
		// run.json：failed + run 级 error + evaluation/final 与返回值同源 + 分轮归组
		const record = readRecord(ctx);
		expect(record.status).toBe("failed");
		expect(record.error).toBe(result.error);
		expect(record.round).toBe(2);
		expect(record.final).toEqual({ round: 2, verdict: "fail", score: 10 });
		expect(record.evaluation).toEqual(result.evaluation);
		expect(record.iterations.map((e) => e.round)).toEqual([0, 0, 1, 1, 2, 2]);
	});

	it("verifyCommand 通道连续失败至预算尽：blame 恒空 → 原样重跑（最小注入面的退化形态）", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan()];
		const result = await runWithIterations(PLAN_TASK, presetOf(1), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			// 恒定失败的真实机器断言（exit 1）
			verifyCommand: `node -e "console.error('nope'); process.exit(1)"`,
		});

		expect(result.outcome).toBe("budget_exhausted");
		expect(result.finalRound).toBe(1); // maxResultIterations=1 → 共执行 2 轮
		expect(result.error).toBe(
			"budget_exhausted: 迭代轮数上限 1 轮用尽（共执行 2 轮，最后一轮 verdict=fail）",
		);
		expect(result.evaluation.reasons.join()).toContain("退出码 1");
		// 机器断言通道零 critic spawn；两轮步骤 task 完全原样（blame 恒空——不自造归因）
		expect(ctx.fake.spawns.filter((s) => s.kind === "critic")).toHaveLength(0);
		expect(ctx.fake.stepTasks).toEqual([
			"摸底主流方案",
			"综合对比结论",
			"摸底主流方案",
			"综合对比结论",
		]);
		const record = readRecord(ctx);
		expect(record.status).toBe("failed");
		expect(record.evaluation?.verdict).toBe("fail");
		expect(record.iterations.map((e) => e.round)).toEqual([0, 0, 1, 1]);
	});

	it("designer re-design 启发式：全步骤 blame 且连续两轮 reasons 相似 → 第三轮重新 generatePlan（fresh 不注入），designer 两次、adapter 两次", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan(), redesignPlan()];
		const REASON = "全盘方向错误，需要重新设计";
		ctx.fake.criticReplies = [
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [REASON],
				blame: ["survey", "synth"],
			}),
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [REASON],
				blame: ["survey", "synth"],
			}),
			fenceEvaluation({
				verdict: "verified",
				score: 90,
				reasons: ["重构后达标"],
				blame: [],
			}),
		];
		const adapterCalls: DesignerOutcome[] = [];
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			adapter: {
				onPlanDesigned: (designed) => adapterCalls.push(designed),
			},
		});

		expect(result.outcome).toBe("verified");
		expect(result.finalRound).toBe(2);
		// 首轮设计 1 次 + 第三轮前的重设计 1 次（第二轮按启发式保留注入——未重生成）
		expect(ctx.fake.spawns.filter((s) => s.kind === "designer")).toHaveLength(2);
		expect(adapterCalls).toHaveLength(2);
		expect(adapterCalls[1].plan.steps.map((s) => s.id)).toEqual([
			"probe",
			"report",
		]);
		// 第三轮（fresh）步骤任务来自新计划、不带注入前缀；第二轮曾全步骤注入
		expect(ctx.fake.stepTasks).toEqual([
			"摸底主流方案",
			"综合对比结论",
			injected(REASON, "摸底主流方案"),
			injected(REASON, "综合对比结论"),
			"换角度摸底",
			"重构结论",
		]);
		// entry 分轮归组按轮内实际计划：第三轮 stepIds 为新计划
		const record = readRecord(ctx);
		expect(record.status).toBe("completed");
		expect(
			record.iterations.filter((e) => e.round === 2).map((e) => e.stepId),
		).toEqual(["probe", "report"]);
		// 首轮元信息不因重设计改变（IterationResult.plan 恒首轮——口径见报告）
		expect(result.plan).toEqual({
			origin: "designer",
			steps: 2,
			degraded: false,
		});
	});

	it("全步骤 blame 但两轮 reasons 不同因 → 不触发重设计（启发式负例：保留原 plan 注入至预算尽）", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan()];
		const R1 = "情报来源全错";
		const R2 = "运算逻辑完全崩溃且无法恢复";
		ctx.fake.criticReplies = [
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [R1],
				blame: ["survey", "synth"],
			}),
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [R2],
				blame: ["survey", "synth"],
			}),
			// 第三轮（预算尽轮）复用 R2——同因对照在轮 0→1 已裁定完
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [R2],
				blame: ["survey", "synth"],
			}),
		];
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
		});

		// 未重设计 → 无新计划可用 → 注入到底至预算尽
		expect(result.outcome).toBe("budget_exhausted");
		expect(result.finalRound).toBe(2);
		expect(ctx.fake.spawns.filter((s) => s.kind === "designer")).toHaveLength(1);
		// 二轮注入 R1（首轮 reasons），三轮注入 R2（次轮 reasons）——素材逐轮更新
		expect(ctx.fake.stepTasks.slice(2)).toEqual([
			injected(R1, "摸底主流方案"),
			injected(R1, "综合对比结论"),
			injected(R2, "摸底主流方案"),
			injected(R2, "综合对比结论"),
		]);
	});

	it("中止（signal 预先 abort）：failed 收尾 + error=aborted + evaluation/final 如实留档（fail+中止 reasons）", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan()];
		const controller = new AbortController();
		controller.abort();
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			signal: controller.signal,
		});

		expect(result.outcome).toBe("failed");
		expect(result.error).toBe("aborted");
		expect(result.finalRound).toBe(0);
		expect(result.evaluation.verdict).toBe("fail");
		expect(result.evaluation.reasons.join()).toContain("中止");
		// 零业务 spawn：designer 预中止降级 builtin（不 spawn）；executePlan 层间检查点
		// 短路（不 spawn）；evaluator 预中止（不 spawn critic、不起 verify）
		expect(ctx.fake.spawns).toHaveLength(0);
		const record = readRecord(ctx);
		expect(record.status).toBe("failed");
		expect(record.error).toBe("aborted");
		expect(record.final).toEqual({ round: 0, verdict: "fail", score: 0 });
		expect(record.evaluation?.reasons.join()).toContain("中止");
		// M4-T3：预中止零 entry（层间检查点短路）→ 无执行事实，telemetry 整体
		// omit（run.json 无该键，而非全零对象）
		expect(record).not.toHaveProperty("telemetry");
	});

	it("telemetry 收尾落盘（M4-T3）：agents=全部轮次 entry 的 agent 去重、steps/succeeded/failed 按末轮、iterations 累计", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoAgentPlan()];
		// 首轮 synth 失败（末轮口径对照素材：末轮两步全成，历史轮的失败不混入计数）
		ctx.fake.stepOutcomes = [{}, { error: "综合崩溃" }];
		ctx.fake.criticReplies = [
			fenceEvaluation({
				verdict: "fail",
				score: 40,
				reasons: ["综合不到位"],
				blame: ["synth"],
			}),
			fenceEvaluation({
				verdict: "verified",
				score: 91,
				reasons: ["补齐后达标"],
				blame: [],
			}),
		];
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
		});

		expect(result.outcome).toBe("verified");
		expect(result.finalRound).toBe(1);
		const record = readRecord(ctx);
		// 两轮 × 两步 = 4 个 entry，agent 只有 researcher/writer 两个——去重计数为
		// 2 而非 4；steps/succeeded 按末轮（首轮 synth 的失败不混入 failed）；iterations
		// 为累计调度次数（M4-T3 落盘的对账点，与 LoopToolResult.telemetry 同口径）
		expect(record.telemetry).toEqual({
			steps: 2,
			succeeded: 2,
			failed: 0,
			iterations: 4,
			durationMs: expect.any(Number),
			agents: 2,
		});
		// durationMs 为真实墙钟（fake 链路含毫秒级定时器，非零）
		expect(record.telemetry?.durationMs).toBeGreaterThan(0);
	});

	it("全败至预算尽仍落 agents（spawn 过即有事实）；空计划拒绝零执行 → telemetry 整体 omit（不写假 0）", async () => {
		// 场景一：两轮全部步骤失败 + verifyCommand 恒 exit 1 → 预算尽收尾——步
		// 骤全败不抹去 spawn 事实：agents 照落（failed 为末轮真值）
		const failedRun = setupRun();
		failedRun.fake.designerPlans = [twoAgentPlan()];
		failedRun.fake.stepOutcomes = [
			{ error: "失败·摸底" },
			{ error: "失败·综合" },
			{ error: "失败·摸底" },
			{ error: "失败·综合" },
		];
		const failed = await runWithIterations(PLAN_TASK, presetOf(1), {
			rpc: failedRun.fake,
			runId: failedRun.runId,
			dataDir: failedRun.dataDir,
			verifyCommand: `node -e "console.error('nope'); process.exit(1)"`,
		});
		expect(failed.outcome).toBe("budget_exhausted");
		expect(failed.finalRound).toBe(1);
		const failedRecord = readRecord(failedRun);
		// 4 个 entry 全 failed、但 agent 去重后为 2——步骤失败与 agent 事实是两回事
		expect(failedRecord.telemetry).toEqual({
			steps: 2,
			succeeded: 0,
			failed: 2,
			iterations: 4,
			durationMs: expect.any(Number),
			agents: 2,
		});

		// 场景二：执行层计划预算拒绝（零步骤执行零 entry）——自然流不可达，注入
		// executePlan 返回形触发；无任何执行事实 → run.json 无 telemetry 键（诚实
		// 遥测：缺省而非假 0）
		const rejectedRun = setupRun();
		rejectedRun.fake.designerPlans = [twoAgentPlan()];
		rejectedOutcomes.push({
			steps: 6,
			succeeded: 0,
			failed: 0,
			durationMs: 0,
			iterations: [],
			batches: 0,
			error: "budget_exhausted: plan steps 6 > max 5",
		});
		const rejected = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: rejectedRun.fake,
			runId: rejectedRun.runId,
			dataDir: rejectedRun.dataDir,
		});
		expect(rejected.outcome).toBe("budget_exhausted");
		expect(rejected.error).toBe("budget_exhausted: plan steps 6 > max 5");
		const rejectedRecord = readRecord(rejectedRun);
		expect(rejectedRecord.status).toBe("failed");
		expect(rejectedRecord.iterations).toEqual([]);
		// omit 的真义：键不在场，而非全零对象
		expect(rejectedRecord).not.toHaveProperty("telemetry");
	});

	it("ctx.retrieved 检索透传（M5-T3）：首轮与重设计的 designer 任务文本均含参考段（generatePlan 第 4 参贯通）", async () => {
		const ctx = setupRun();
		ctx.fake.designerPlans = [twoStepPlan(), redesignPlan()];
		const REASON = "全盘方向需要重新设计";
		ctx.fake.criticReplies = [
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [REASON],
				blame: ["survey", "synth"],
			}),
			fenceEvaluation({
				verdict: "fail",
				score: 5,
				reasons: [REASON],
				blame: ["survey", "synth"],
			}),
			fenceEvaluation({
				verdict: "verified",
				score: 90,
				reasons: ["重构后达标"],
				blame: [],
			}),
		];
		const result = await runWithIterations(PLAN_TASK, presetOf(2), {
			rpc: ctx.fake,
			runId: ctx.runId,
			dataDir: ctx.dataDir,
			retrieved: {
				methods: [
					{
						id: "m-iter",
						name: "方法 m-iter",
						appliesTo: { taskTypes: ["研究"], signals: ["调度"] },
						playbook: {
							steps: [{ agent: "researcher", taskHint: "围绕 {task}" }],
						},
						fitness: { uses: 2, avgScore: 80 },
						lineage: {},
						updatedAt: "2026-09-13T00:00:00.000Z",
					},
				],
				cases: [
					{
						id: "c-iter",
						task: "研究并发调度策略的历史案例",
						methodIds: [],
						origin: "designer",
						plan: { steps: 2 },
						runId: "r-iter",
						finalScore: 85,
						verified: true,
						lessons: ["教训一", "教训二"],
						createdAt: "2026-09-13T00:00:00.000Z",
					},
				],
			},
		});

		expect(result.outcome).toBe("verified");
		// 首轮 + 重设计各一次 generatePlan：两份 designer 任务文本都应含参考段
		expect(ctx.fake.designerPrompts).toHaveLength(2);
		for (const prompt of ctx.fake.designerPrompts) {
			expect(prompt).toContain("【参考方法/案例");
			expect(prompt).toContain("方法 m-iter");
			expect(prompt).toContain("过往案例");
			expect(prompt).toContain("研究并发调度策略的历史案例");
		}
	});
});
