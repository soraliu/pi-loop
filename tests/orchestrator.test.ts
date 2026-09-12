// orchestrator 调度内核测试（M2-T3）
// 全部使用脚本化 fake RPC + 临时 dataDir（不真 spawn；真实链路在 T5 冒烟）。
// fake 契约（T3 在 fake 层固化 T2 遗留的 runs.all 同序假设）：
//   1. waitForCompletion(runId) 只在投递事件的 runId 匹配（runId 为 undefined 时任意事件）时回包
//   2. 完成事件按 spawn 顺序投递（缺省等延迟时即「同序返回」）
//   3. spawn 受理可能省略 runId（协议 async-only 的受理形）；单步计划可退化为等任意完成事件

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { COMPLETION_TIMEOUT_MS } from "../src/core/consts.ts";
import { executePlan, type PlanUpdate } from "../src/core/orchestrator.ts";
import { BUILTIN_PLAN } from "../src/core/planner-static.ts";
import type { PlanDraft } from "../src/types.ts";
import { createRunRecord, ensureWorkspace } from "../src/storage/workspace.ts";

/** 本文件创建的临时目录清单——afterAll 只清理这些（沿用登记制） */
const createdDirs: string[] = [];

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** 3 步扇形 DAG：a ← (b, c)。拓扑层：[b, c]（并行）→ [a] */
function fanPlan(): PlanDraft {
	return {
		steps: [
			{
				id: "a",
				agent: "worker-a",
				task: "汇总 b 与 c 的结论",
				dependsOn: ["b", "c"],
			},
			{ id: "b", agent: "worker-b", task: "任务 b", dependsOn: [] },
			{ id: "c", agent: "worker-c", task: "任务 c", dependsOn: [] },
		],
	};
}

/** 临时 dataDir + 预建 run 记录（executePlan 的前置：run.json 必须已存在） */
function setupRun(task = "调度测试任务"): { dataDir: string; runId: string } {
	const dataDir = ensureWorkspace(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-orch-")),
	);
	createdDirs.push(dataDir);
	const record = createRunRecord(dataDir, task, "medium");
	return { dataDir, runId: record.id };
}

/** 读回 run.json（落盘终态断言用） */
function readRecord(
	dataDir: string,
	runId: string,
): {
	status: string;
	/** T4 abort 落痕：run 级 error 字段（中止时的可审计痕迹） */
	error?: string;
	iterations: Array<{
		stepId: string;
		agent: string;
		status: string;
		outputRef?: string;
		startedAt?: string;
		endedAt?: string;
		error?: string;
	}>;
} {
	return JSON.parse(
		fs.readFileSync(path.join(dataDir, "runs", runId, "run.json"), "utf-8"),
	);
}

/** 单步结局脚本（按步骤的 agent 名编排） */
interface FakeOutcome {
	/** 完成事件投递延迟（ms，缺省 1） */
	delayMs?: number;
	/** 悬挂该步：永不投递完成事件（abort 用例的注入） */
	hold?: boolean;
	/** 失败结局：事件携带 error */
	errorMessage?: string;
	/** 事件 output 字段（→ entry.outputRef） */
	output?: string;
	/** 事件 summary 字段（→ onUpdate.summary） */
	summary?: string;
	/** 原样并入完成 payload 的附加字段（构造非常规字段名的完成事件用，Fix round 2） */
	extras?: Record<string, unknown>;
}

/** 脚本化 fake RPC：pi-subagents 调度器 + T1 客户端事件流语义的最小合流体 */
class FakeRpc {
	readonly spawns: Array<{
		agent: string;
		task: string;
		context?: string;
		runId: string;
	}> = [];
	readonly stopCalls: string[] = [];
	readonly waits: Array<{ runId?: string; timeoutMs?: number }> = [];
	/** 完成事件的实际投递顺序（runId 列表） */
	readonly delivered: string[] = [];
	/** 受理省略 runId（协议 async-only 的降级形） */
	omitRunId = false;
	/** waitForCompletion 一律回 null（完成等待超时语义） */
	timeoutCompletions = false;
	/** spawn 一律抛该错误（模拟 pi-subagents 缺席的超时拒绝） */
	spawnError: Error | undefined;
	private readonly outcomes = new Map<string, FakeOutcome>();
	private readonly waiters: Array<{
		runId: string | undefined;
		resolve: (payload: unknown) => void;
	}> = [];
	private nextRunId = 0;

	/** 按步骤的 agent 名登记结局（缺省：成功、无 output/summary） */
	script(agent: string, outcome: FakeOutcome): this {
		this.outcomes.set(agent, outcome);
		return this;
	}

	async spawn(params: {
		workflowScript?: string;
		agent?: string;
		task?: string;
		context?: string;
	}): Promise<{ runId?: string }> {
		// 尝试先于结果记账：spawnError 建模的是「请求已发出后的受理侧拒绝」——
		// 真实缺席场景为请求发出后超时，尝试事实存在，必须入 spawns 台账
		const runId = `run-${++this.nextRunId}`;
		this.spawns.push({
			agent: params.agent ?? "",
			task: params.task ?? "",
			context: params.context,
			runId,
		});
		if (this.spawnError) throw this.spawnError;
		const outcome = this.outcomes.get(params.agent ?? "") ?? {};
		if (!outcome.hold) {
			// 完成事件经宏任务定时器投递时序同构真实总线：
			// waitForCompletion 的订阅先发生（受理微任务后立即注册），投递必然晚于订阅
			setTimeout(() => this.deliver(runId, outcome), outcome.delayMs ?? 1);
		}
		return this.omitRunId ? {} : { runId };
	}

	waitForCompletion(
		runId?: string,
		timeoutMs?: number,
	): Promise<unknown | null> {
		this.waits.push({ runId, timeoutMs });
		if (this.timeoutCompletions) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiters.push({ runId, resolve });
		});
	}

	async stop(id: string): Promise<Record<string, unknown>> {
		this.stopCalls.push(id);
		return { stopped: id };
	}

	async request<T = unknown>(
		_method: string,
		_params?: unknown,
		_timeoutMs?: number,
	): Promise<T> {
		throw new Error(
			"fake rpc: request 不应被调用（orchestrator 只用 spawn/stop/waitForCompletion）",
		);
	}

	/** 投递完成事件：唤醒 runId 匹配（或约定任意事件的）等待者——对齐 T1 匹配语义 */
	private deliver(runId: string, outcome: FakeOutcome): void {
		this.delivered.push(runId);
		const payload: Record<string, unknown> = { runId };
		if (outcome.errorMessage === undefined) {
			if (outcome.output !== undefined) payload.output = outcome.output;
			if (outcome.summary !== undefined) payload.summary = outcome.summary;
			Object.assign(payload, outcome.extras);
		} else {
			payload.ok = false;
			payload.error = { code: "agent_failed", message: outcome.errorMessage };
		}
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i];
			if (waiter.runId === runId || waiter.runId === undefined) {
				waiter.resolve(payload);
				this.waiters.splice(i, 1);
			}
		}
	}
}

describe("executePlan — 成功链", () => {
	it("3 步扇形 DAG：b、c 先于 a spawn，全 succeeded，run.json completed，遥测正确", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", {
				output: "/runs/x/b-transcript.md",
				summary: "b 的结论",
			})
			.script("worker-c", {
				output: "/runs/x/c-transcript.md",
				summary: "c 的结论",
			});
		// worker-a 不编排：验证「payload 无 output 字段 → 无 outputRef」分支
		const updates: PlanUpdate[] = [];
		const outcome = await executePlan(fanPlan(), {
			rpc: fake,
			runId,
			dataDir,
			onUpdate: (update) => updates.push(update),
		});

		// 分层 spawn 顺序：层 1 [b, c] 全部先于层 2 [a]；spawn 参数 context 一律 fresh
		expect(fake.spawns.map((s) => s.agent)).toEqual([
			"worker-b",
			"worker-c",
			"worker-a",
		]);
		for (const spawn of fake.spawns) {
			expect(spawn.context).toBe("fresh");
		}
		expect(fake.spawns[0].task).toBe("任务 b");

		// onUpdate 序列：受理序（b→c）与完成事件序（b→c→a）
		expect(updates.map((u) => `${u.stepId}:${u.status}`)).toEqual([
			"b:running",
			"c:running",
			"b:succeeded",
			"c:succeeded",
			"a:running",
			"a:succeeded",
		]);
		const bUpdate = updates.find(
			(u) => u.stepId === "b" && u.status === "succeeded",
		);
		expect(bUpdate?.summary).toBe("b 的结论");

		// run.json 终态
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("completed");
		expect(final.iterations.map((e) => e.stepId)).toEqual(["b", "c", "a"]);
		const byStep = new Map(final.iterations.map((e) => [e.stepId, e]));
		expect(byStep.get("b")).toMatchObject({
			agent: "worker-b",
			status: "succeeded",
			outputRef: "/runs/x/b-transcript.md",
		});
		expect(byStep.get("c")).toMatchObject({
			agent: "worker-c",
			status: "succeeded",
			outputRef: "/runs/x/c-transcript.md",
		});
		expect(byStep.get("a")?.outputRef).toBeUndefined(); // 无 output 字段 → 无引用
		for (const entry of final.iterations) {
			expect(entry.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(entry.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(entry.error).toBeUndefined();
		}

		// 遥测
		expect(outcome.steps).toBe(3);
		expect(outcome.succeeded).toBe(3);
		expect(outcome.failed).toBe(0);
		expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
		expect(outcome.iterations).toEqual(final.iterations);
	});
});

describe("executePlan — 失败路径", () => {
	it("中步失败（b 失败）→ a 不执行、status=failed、error 落 b 的 entry", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", { errorMessage: "b 调用的执行工具不存在" })
			.script("worker-c", { output: "OUT_C" });
		const updates: PlanUpdate[] = [];
		const outcome = await executePlan(fanPlan(), {
			rpc: fake,
			runId,
			dataDir,
			onUpdate: (update) => updates.push(update),
		});

		// 层 1 的 b、c 都被 spawn；层 2 的 a 不再执行
		expect(fake.spawns.map((s) => s.agent)).toEqual(["worker-b", "worker-c"]);
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.iterations).toHaveLength(2); // a 未进入计划
		const byStep = new Map(final.iterations.map((e) => [e.stepId, e]));
		expect(byStep.get("b")).toMatchObject({
			status: "failed",
			error: expect.stringContaining("b 调用的执行工具不存在"),
		});
		expect(byStep.get("c")).toMatchObject({
			status: "succeeded",
			outputRef: "OUT_C",
		});

		// 遥测：整体失败即返（3 步计划，1 成 1 败）
		expect(outcome).toMatchObject({ steps: 3, succeeded: 1, failed: 1 });
		expect(updates.map((u) => `${u.stepId}:${u.status}`)).toEqual([
			"b:running",
			"c:running",
			"b:failed",
			"c:succeeded",
		]);
	});

	it("pi-subagents 缺席（spawn 抛超时错误）→ status=failed，错误含安装引导", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		fake.spawnError = new Error(
			"RPC spawn 失败: RPC spawn 超时（30000ms 无 reply）",
		);
		const outcome = await executePlan(fanPlan(), { rpc: fake, runId, dataDir });

		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.iterations).toHaveLength(2); // b、c 均尝试且失败；a 未尝试
		for (const entry of final.iterations) {
			expect(entry.error).toContain("请安装 pi-subagents");
			expect(entry.error).toContain("超时");
			// spawn 失败的步从未 running（pending → failed，无 startedAt）
			expect(entry.startedAt).toBeUndefined();
		}
		// 同层 b、c 的 spawn 尝试都已发出（缺席在受理侧拒绝，不撤回同层并行尝试）
		expect(fake.spawns.map((s) => s.agent)).toEqual(["worker-b", "worker-c"]);
		expect(outcome).toMatchObject({ steps: 3, succeeded: 0, failed: 2 });
	});

	it("完成等待超时（waitForCompletion 回 null）→ 该步 failed、a 不执行", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		fake.timeoutCompletions = true;
		const outcome = await executePlan(fanPlan(), { rpc: fake, runId, dataDir });

		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.iterations).toHaveLength(2);
		for (const entry of final.iterations) {
			expect(entry.error).toContain("等待完成超时");
		}
		expect(outcome).toMatchObject({ steps: 3, succeeded: 0, failed: 2 });
	});

	it("运行中 abort → rpc.stop 停掉在途 run、status=failed、entry 记 aborted", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", { hold: true })
			.script("worker-c", { hold: true });
		const controller = new AbortController();
		const updates: PlanUpdate[] = [];
		const pending = executePlan(fanPlan(), {
			rpc: fake,
			runId,
			dataDir,
			onUpdate: (update) => updates.push(update),
			signal: controller.signal,
		});

		// 微任务沉降后在途快照：running 中间态已真实落盘（可观测）
		await sleep(5);
		const mid = readRecord(dataDir, runId);
		expect(mid.status).toBe("running");
		expect(mid.iterations.map((e) => e.status)).toEqual(["running", "running"]);

		controller.abort();
		const outcome = await pending;

		// 每个 spawn 受理的在途 run 都被 stop（按受理序）
		expect(fake.stopCalls).toEqual(fake.spawns.map((s) => s.runId));
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		// T4 收口（T3 review M1）：中止在 run 级也留痕——error="aborted"
		// （层间检查点中止时不产生任何 entry，run 级 error 是唯一痕迹）
		expect(final.error).toBe("aborted");
		expect(final.iterations).toHaveLength(2); // a 未执行
		for (const entry of final.iterations) {
			expect(entry.status).toBe("failed");
			expect(entry.error).toBe("aborted");
		}
		expect(updates.map((u) => `${u.stepId}:${u.status}`)).toEqual([
			"b:running",
			"c:running",
			"b:failed",
			"c:failed",
		]);
		expect(outcome).toMatchObject({ steps: 3, succeeded: 0, failed: 2 });
		// M3-T4 顺手（T3 review M2 收口）：outcome.error 镜像未随 budget 门控——
		// no-budget abort 的返回形是 additive 变化（error 在场、batches 缺席），入档锁定
		expect(outcome.error).toBe("aborted");
		expect("batches" in outcome).toBe(false);
	});
});

describe("executePlan — spawn 失败归因（M-1：仅超时/无应答附安装引导）", () => {
	it("code=timeout 的受理失败 → 错误附安装引导（结构化判据，非仅文案匹配）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		// 消息不含“超时/无 reply”字样——引导后缀只能来自 code==="timeout" 判据
		const timeoutLike = new Error("RPC spawn 失败: 客户端放弃等待应答");
		(timeoutLike as Error & { code?: string }).code = "timeout";
		fake.spawnError = timeoutLike;
		const outcome = await executePlan(fanPlan(), { rpc: fake, runId, dataDir });

		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.iterations).toHaveLength(2); // b、c 均在受理层被拒；a 未尝试
		for (const entry of final.iterations) {
			expect(entry.error).toContain("放弃等待应答");
			expect(entry.error).toContain("请安装 pi-subagents");
			expect(entry.startedAt).toBeUndefined(); // 未受理即失败：无 running 态痕迹
		}
		expect(outcome).toMatchObject({ steps: 3, succeeded: 0, failed: 2 });
	});

	it("真实拒绝（agent 不存在）→ 原样报错，不附安装引导（不误归因为未安装）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		const rejected = new Error('RPC spawn 失败: Agent "worker-b" 不存在');
		(rejected as Error & { code?: string }).code = "agent_not_found";
		fake.spawnError = rejected;
		const outcome = await executePlan(fanPlan(), { rpc: fake, runId, dataDir });

		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		for (const entry of final.iterations) {
			expect(entry.error).toContain('Agent "worker-b" 不存在');
			expect(entry.error).not.toContain("请安装 pi-subagents");
			expect(entry.error).not.toContain("pi-subagents 不在或不可用");
		}
		expect(outcome).toMatchObject({ steps: 3, succeeded: 0, failed: 2 });
	});
});

describe("executePlan — fake 契约与 waitForCompletion 匹配语义", () => {
	it("完成按 spawn 顺序投递（同序契约固化），每个 waitForCompletion 按受理 runId 精确等待", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", { output: "OUT_B" })
			.script("worker-c", { output: "OUT_C" })
			.script("worker-a", { output: "OUT_A" });
		await executePlan(fanPlan(), { rpc: fake, runId, dataDir });

		// 同序契约：事件投递顺序 === spawn 顺序（T2 的 runs.all 同序假设在 T3 的 fake 层固化）
		expect(fake.delivered).toEqual(fake.spawns.map((s) => s.runId));
		// 每次 waitForCompletion 都带着对应受理的 runId（无 undefined 混入——T1 匹配语义的消费）
		expect(fake.waits.map((w) => w.runId)).toEqual(
			fake.spawns.map((s) => s.runId),
		);
		// 匹配正确性：各 entry 的 outputRef 各归其主，无串包
		const final = readRecord(dataDir, runId);
		const byStep = new Map(final.iterations.map((e) => [e.stepId, e]));
		expect(byStep.get("b")?.outputRef).toBe("OUT_B");
		expect(byStep.get("c")?.outputRef).toBe("OUT_C");
		expect(byStep.get("a")?.outputRef).toBe("OUT_A");
		expect(final.status).toBe("completed");
	});

	it("乱序投递（压力配置：后 spawn 的先完成）不影响 runId 匹配——结论不串包", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", { output: "OUT_B", delayMs: 20 }) // b 晚完成
			.script("worker-c", { output: "OUT_C", delayMs: 1 }); // c 先完成
		const updates: PlanUpdate[] = [];
		const outcome = await executePlan(fanPlan(), {
			rpc: fake,
			runId,
			dataDir,
			onUpdate: (update) => updates.push(update),
		});

		// 投递顺序与 spawn 顺序相反（b 先 spawn 但 c 先完成）
		expect(fake.delivered).toEqual([
			fake.spawns[1].runId,
			fake.spawns[0].runId,
			fake.spawns[2].runId,
		]);
		// 尽管先收到 c 的完成事件，b 的结论依然是 b 的
		const byStep = new Map(outcome.iterations.map((e) => [e.stepId, e]));
		expect(byStep.get("b")?.outputRef).toBe("OUT_B");
		expect(byStep.get("c")?.outputRef).toBe("OUT_C");
		expect(outcome.succeeded).toBe(3);
		// onUpdate 的完成序按事件（c 在 b 前），而非按 spawn 序
		const succeededOrder = updates
			.filter((u) => u.status === "succeeded")
			.map((u) => u.stepId);
		expect(succeededOrder).toEqual(["c", "b", "a"]);
	});
});

describe("executePlan — BUILTIN_PLAN 单步最小路径（T4 直连口径）", () => {
	it("单步 researcher 全链：completed、entry succeeded、payload output 记 outputRef", async () => {
		const { dataDir, runId } = setupRun("研究 tokio 调度器内幕");
		const fake = new FakeRpc().script("researcher", {
			output: "/runs/r/research-transcript.md",
			summary: "tokio 调度器研究结论",
		});
		const updates: PlanUpdate[] = [];
		const outcome = await executePlan(BUILTIN_PLAN("研究 tokio 调度器内幕"), {
			rpc: fake,
			runId,
			dataDir,
			onUpdate: (update) => updates.push(update),
		});

		expect(fake.spawns).toHaveLength(1);
		expect(fake.spawns[0]).toMatchObject({
			agent: "researcher",
			task: "研究 tokio 调度器内幕",
			context: "fresh",
		});
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("completed");
		expect(final.iterations).toEqual([
			expect.objectContaining({
				stepId: "research",
				agent: "researcher",
				status: "succeeded",
				outputRef: "/runs/r/research-transcript.md",
			}),
		]);
		expect(updates.map((u) => u.status)).toEqual(["running", "succeeded"]);
		expect(updates[1]?.summary).toBe("tokio 调度器研究结论");
		expect(outcome).toMatchObject({
			steps: 1,
			succeeded: 1,
			failed: 0,
			durationMs: expect.any(Number),
		});
	});

	it("完成等待口径锁定：以 consts.COMPLETION_TIMEOUT_MS（10 分钟）等待——与 designer 共享单一真源（M4-T0，M-5 债收敛）", async () => {
		const { dataDir, runId } = setupRun("完成等待口径对账");
		const fake = new FakeRpc().script("researcher", {});
		await executePlan(BUILTIN_PLAN("完成等待口径对账"), {
			rpc: fake,
			runId,
			dataDir,
		});
		// 常量搬家（本地固化 → consts 导出）后的零回归锚点：等待值与 designer 同源同值
		expect(fake.waits).toEqual([
			{ runId: fake.spawns[0].runId, timeoutMs: COMPLETION_TIMEOUT_MS },
		]);
		expect(COMPLETION_TIMEOUT_MS).toBe(10 * 60_000);
	});

	it("完成 payload 经 results[0] 携带产物引用（真实形 outputReference/artifactPaths）→ outputRef 有效", async () => {
		// Fix round 2 实测校准：真实完成事件（pi-subagents CompletionNotification）不含顶层
		// output/outputPath——产物路径在 results[0].outputReference（string | {path}）与
		// results[0].artifactPaths.outputPath；顶层三字段保留 fake 兼容（已由上一用例锁定）
		const first = setupRun("产物引用之 outputReference");
		const fake = new FakeRpc().script("researcher", {
			summary: "结论一",
			extras: {
				results: [
					{
						agent: "researcher",
						status: "succeeded",
						outputReference: {
							path: "/runs/x/subagent-artifacts/outputs/research.md",
						},
					},
				],
			},
		});
		const outcome1 = await executePlan(
			BUILTIN_PLAN("产物引用之 outputReference"),
			{
				rpc: fake,
				runId: first.runId,
				dataDir: first.dataDir,
			},
		);
		expect(outcome1.succeeded).toBe(1);
		expect(outcome1.iterations[0]?.outputRef).toBe(
			"/runs/x/subagent-artifacts/outputs/research.md",
		);

		const second = setupRun("产物引用之 artifactPaths");
		const fake2 = new FakeRpc().script("researcher", {
			summary: "结论二",
			extras: {
				results: [
					{
						agent: "researcher",
						status: "succeeded",
						outputReference: "/runs/y/string-form.md",
						artifactPaths: {
							outputPath: "/runs/y/subagent-artifacts/outputs/research.md",
						},
					},
				],
			},
		});
		// string 形 outputReference 优先于 artifactPaths.outputPath（集合顺序）
		const outcome2 = await executePlan(BUILTIN_PLAN("产物引用之 artifactPaths"), {
			rpc: fake2,
			runId: second.runId,
			dataDir: second.dataDir,
		});
		expect(outcome2.succeeded).toBe(1);
		expect(outcome2.iterations[0]?.outputRef).toBe("/runs/y/string-form.md");

		const third = setupRun("产物引用之仅 artifactPaths");
		const fake3 = new FakeRpc().script("researcher", {
			summary: "结论三",
			extras: {
				results: [
					{
						agent: "researcher",
						status: "succeeded",
						artifactPaths: {
							outputPath: "/runs/z/subagent-artifacts/outputs/research.md",
						},
					},
				],
			},
		});
		const outcome3 = await executePlan(
			BUILTIN_PLAN("产物引用之仅 artifactPaths"),
			{
				rpc: fake3,
				runId: third.runId,
				dataDir: third.dataDir,
			},
		);
		expect(outcome3.succeeded).toBe(1);
		expect(outcome3.iterations[0]?.outputRef).toBe(
			"/runs/z/subagent-artifacts/outputs/research.md",
		);
	});

	it("受理缺省 runId 的单步计划：按任意完成事件等待（降级路径可用）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		fake.omitRunId = true;
		const outcome = await executePlan(BUILTIN_PLAN("最小路径"), {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(fake.waits.map((w) => w.runId)).toEqual([undefined]);
		expect(outcome.succeeded).toBe(1);
		expect(readRecord(dataDir, runId).status).toBe("completed");
	});

	it("多步计划下受理缺省 runId → 该步 failed（完成事件归属无法区分）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		fake.omitRunId = true;
		const outcome = await executePlan(fanPlan(), { rpc: fake, runId, dataDir });

		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.iterations).toHaveLength(2);
		for (const entry of final.iterations) {
			expect(entry.error).toContain("未返回 runId");
		}
		expect(fake.waits).toHaveLength(0); // 失败发生在等待前
		expect(outcome.failed).toBe(2);
	});
});

describe("executePlan — 前置错误", () => {
	it("run 记录不存在 → 抛错且不 spawn", async () => {
		const dataDir = ensureWorkspace(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-orch-")),
		);
		createdDirs.push(dataDir);
		const fake = new FakeRpc();
		await expect(
			executePlan(fanPlan(), { rpc: fake, runId: "r-ghost", dataDir }),
		).rejects.toThrow(/run 记录不存在/);
		expect(fake.spawns).toHaveLength(0);
	});

	it("空计划 → run 标记 failed 后抛错（run.json 不停留在 running）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		await expect(
			executePlan({ steps: [] }, { rpc: fake, runId, dataDir }),
		).rejects.toThrow(/不含任何步骤/);
		expect(readRecord(dataDir, runId).status).toBe("failed");
		expect(fake.spawns).toHaveLength(0);
	});
});

describe("executePlan — 预算硬上限与层内并发钳制（M3-T3）", () => {
	/** n 步同层（互不依赖）计划——层内并发钳制用例的最小形状 */
	function widePlan(n = 4): PlanDraft {
		return {
			steps: Array.from({ length: n }, (_, i) => ({
				id: `w${i + 1}`,
				agent: `worker-w${i + 1}`,
				task: `任务 w${i + 1}`,
				dependsOn: [],
			})),
		};
	}

	it("4 步同层 / maxParallelSubagents=2 → 两批：前 2 步完成前第 3 步未被 spawn（批序时序证明）", async () => {
		const { dataDir, runId } = setupRun();
		// 前两步延迟投递（40ms）、后两步最快（1ms）——若实现未分批（M2 无上限行为），
		// w3/w4 会在 w1/w2 完成前 spawn 并先完成，下述快照断言即告失败（时序可证伪）
		const fake = new FakeRpc()
			.script("worker-w1", { delayMs: 40, output: "OUT_W1" })
			.script("worker-w2", { delayMs: 40, output: "OUT_W2" })
			.script("worker-w3", { delayMs: 1, output: "OUT_W3" })
			.script("worker-w4", { delayMs: 1, output: "OUT_W4" });
		/** fake 的时序钩子：首个 running 上报瞬间的 spawn 台账与 w3 受理瞬间的完成事件台账 */
		let spawnsAtFirstRunning: number | undefined;
		let deliveredAtW3Start: string[] | undefined;
		const updates: PlanUpdate[] = [];
		const outcome = await executePlan(widePlan(), {
			rpc: fake,
			runId,
			dataDir,
			budget: { maxPlanSteps: 8, maxParallelSubagents: 2 },
			onUpdate: (update) => {
				updates.push(update);
				if (update.status === "running" && spawnsAtFirstRunning === undefined) {
					spawnsAtFirstRunning = fake.spawns.length;
				}
				if (update.stepId === "w3" && update.status === "running") {
					deliveredAtW3Start = [...fake.delivered];
				}
			},
		});
		expect(outcome.batches).toBe(2); // 4 步 / 上限 2 → 两个批次
		// 批 1 窗口：首个 running 上报时只有 w1、w2 被 spawn（未钳制时会是 4）
		expect(spawnsAtFirstRunning).toBe(2);
		// 强门时序证明：w3 受理瞬间，批 1 的两个完成事件都已投递（且仅此两个）
		expect(deliveredAtW3Start).toEqual([
			fake.spawns[0].runId,
			fake.spawns[1].runId,
		]);
		// 终态：批序整体 = w1,w2 → w3,w4；完成序同序（批 1 的 40ms 事件先于批 2 的 1ms）
		expect(fake.spawns.map((s) => s.agent)).toEqual([
			"worker-w1",
			"worker-w2",
			"worker-w3",
			"worker-w4",
		]);
		expect(fake.delivered).toEqual(fake.spawns.map((s) => s.runId));
		expect(updates.map((u) => `${u.stepId}:${u.status}`)).toEqual([
			"w1:running",
			"w2:running",
			"w1:succeeded",
			"w2:succeeded",
			"w3:running",
			"w4:running",
			"w3:succeeded",
			"w4:succeeded",
		]);
		expect(readRecord(dataDir, runId).status).toBe("completed");
		expect(outcome).toMatchObject({ steps: 4, succeeded: 4, failed: 0 });
	});

	it("计划步数恰好在上限（n == maxPlanSteps）→ 照常执行；层不需分批时批数=层数", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", { output: "OUT_B" })
			.script("worker-c", { output: "OUT_C" })
			.script("worker-a", { output: "OUT_A" });
		const outcome = await executePlan(fanPlan(), {
			rpc: fake,
			runId,
			dataDir,
			budget: { maxPlanSteps: 3, maxParallelSubagents: 2 },
		});
		expect(fake.spawns.map((s) => s.agent)).toEqual([
			"worker-b",
			"worker-c",
			"worker-a",
		]);
		expect(readRecord(dataDir, runId).status).toBe("completed");
		// 层 [b,c]（≤2 一批）与层 [a]（1 步一批）→ 共 2 批
		expect(outcome.batches).toBe(2);
		expect(outcome.steps).toBe(3);
		expect(outcome.error).toBeUndefined(); // 正常完成不带运行级 error
	});

	it("计划步数超顶 → 拒绝执行整个计划：failed + budget_exhausted 落痕，零 spawn", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		const outcome = await executePlan(fanPlan(), {
			rpc: fake,
			runId,
			dataDir,
			budget: { maxPlanSteps: 2, maxParallelSubagents: 2 },
		});
		expect(fake.spawns).toEqual([]); // 未 spawn 任何步
		expect(fake.waits).toEqual([]); // 亦未等待任何完成
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.error).toBe("budget_exhausted: plan steps 3 > max 2");
		expect(final.iterations).toEqual([]); // 没有任何步进入计划
		expect(outcome).toMatchObject({
			steps: 3,
			succeeded: 0,
			failed: 0,
			batches: 0,
			error: "budget_exhausted: plan steps 3 > max 2",
		});
		expect(outcome.iterations).toEqual([]);
	});

	it("分批中途失败（批 1 的 w1 失败）→ 不开下批：w3/w4 未 spawn 无 entry，fail-fast 语义保持", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-w1", { errorMessage: "w1 的结论站不住" })
			.script("worker-w2", { output: "OUT_W2" });
		const outcome = await executePlan(widePlan(), {
			rpc: fake,
			runId,
			dataDir,
			budget: { maxPlanSteps: 8, maxParallelSubagents: 2 },
		});
		// 只 spawn 了批 1（w1、w2）；批 2（w3、w4）因批内失败不再开
		expect(fake.spawns.map((s) => s.agent)).toEqual(["worker-w1", "worker-w2"]);
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.iterations.map((e) => e.stepId)).toEqual(["w1", "w2"]); // w3/w4 未进计划
		const byStep = new Map(final.iterations.map((e) => [e.stepId, e]));
		expect(byStep.get("w1")).toMatchObject({
			status: "failed",
			error: expect.stringContaining("w1 的结论站不住"),
		});
		expect(byStep.get("w2")).toMatchObject({
			status: "succeeded",
			outputRef: "OUT_W2",
		});
		expect(outcome).toMatchObject({
			steps: 4,
			succeeded: 1,
			failed: 1,
			batches: 1,
		});
	});

	it("批间中止 → 同批在途步记 aborted、下批不再开（abort 检查点扩展到批间）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-w1", { hold: true })
			.script("worker-w2", { hold: true });
		const controller = new AbortController();
		const pending = executePlan(widePlan(), {
			rpc: fake,
			runId,
			dataDir,
			budget: { maxPlanSteps: 8, maxParallelSubagents: 2 },
			signal: controller.signal,
		});
		await sleep(5);
		controller.abort();
		const outcome = await pending;
		// 批 1 在途步被 stop + 记 aborted；批 2（w3/w4）未开——无 entry、无 spawn
		expect(fake.spawns.map((s) => s.agent)).toEqual(["worker-w1", "worker-w2"]);
		expect(fake.stopCalls).toEqual(fake.spawns.map((s) => s.runId));
		const final = readRecord(dataDir, runId);
		expect(final.status).toBe("failed");
		expect(final.error).toBe("aborted");
		expect(final.iterations.map((e) => e.stepId)).toEqual(["w1", "w2"]); // w3/w4 未进计划
		expect(final.iterations.every((e) => e.error === "aborted")).toBe(true);
		expect(outcome).toMatchObject({
			steps: 4,
			succeeded: 0,
			failed: 2,
			batches: 1,
			error: "aborted",
		});
	});

	it("budget 形状非法（maxParallelSubagents=0）→ 受理前原样上抛，run 记录保持原状", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		// 注入面契约违规（分批宽度 0 会使分批循环退化）→ 前置拒绝，不静默钳位修正
		await expect(
			executePlan(widePlan(1), {
				rpc: fake,
				runId,
				dataDir,
				budget: { maxPlanSteps: 8, maxParallelSubagents: 0 },
			}),
		).rejects.toThrow(/maxParallelSubagents/);
		expect(fake.spawns).toEqual([]);
		// run.json 保持磁盘原状（status 仍 created——未受理即无收尾义务）
		expect(readRecord(dataDir, runId).status).toBe("created");
	});

	it("budget 未传 → 遥测不带 batches/error 字段（M2 返回形状逐字保持）", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc()
			.script("worker-b", { output: "OUT_B" })
			.script("worker-c", { output: "OUT_C" })
			.script("worker-a", { output: "OUT_A" });
		const outcome = await executePlan(fanPlan(), { rpc: fake, runId, dataDir });
		expect(readRecord(dataDir, runId).status).toBe("completed");
		expect(outcome.succeeded).toBe(3);
		expect("batches" in outcome).toBe(false);
		expect("error" in outcome).toBe(false);
	});
});
