// designer 生成器测试（M3-T2）
// 全部使用脚本化 fake RPC + 临时 dataDir（不真 spawn、无真网络；真实 designer 链路 T5 冒烟）。
// fake 契约：
//   1. spawn 按「尝试序」消费脚本（每次 spawn 取下一个 outcome；未脚本之处回落为
//      无产物成功事件——两通道皆失败的形态）
//   2. 完成事件按 outcome 的 delayMs 定时投递；preComplete 在投递前同步执行——模拟
//      designer agent 先写 designer-plan.json 再完成（文件先于完成事件可见，与真实时序同构；
//      preComplete 内 controller.abort() 时 abort 先于完成 settle——与真实信号竞速同构）
//   3. completionTimeout=true 的等待直接回 null（完成等待超时语义，不必真等 10 分钟）
//   4. spawnError 在记账之后抛（受理侧拒绝，尝试事实已发生——orchestrator fake 同款）
//
// 中止语义（本实现选定，T4 消费）：abort = 立即降级 BUILTIN_PLAN 收尾、不再 spawn、
// 不抛出；notes 如实记"中止"。后续 executePlan 对已中止 signal 自会 fail-fast。

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generatePlan } from "../src/core/designer.ts";
import { BUILTIN_PLAN } from "../src/core/planner-static.ts";
import { DEFAULT_EFFORT_PRESETS } from "../src/storage/settings.ts";
import { createRunRecord, ensureWorkspace } from "../src/storage/workspace.ts";

/** 本文件创建的临时目录清单——afterAll 只清理这些（登记制） */
const createdDirs: string[] = [];

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** 生效档位：medium（maxPlanSteps=5 / maxParallelSubagents=4）——prompt 契约断言用 */
const PRESET = DEFAULT_EFFORT_PRESETS.medium;

const TASK = "对比主流 JS runtime 的并发调度策略";

/** 合法两步计划（步骤 DAG：synth 依赖 survey；含全部可选字段） */
function goodPlan() {
	return {
		version: 1,
		task: TASK,
		origin: "designer",
		notes: "两步走",
		steps: [
			{
				id: "survey",
				agent: "researcher",
				task: "摸底各 runtime 的调度模型",
				dependsOn: [],
				guidance: "引用一手来源",
				acceptance: "至少三个可核验信源",
			},
			{
				id: "synth",
				agent: "researcher",
				task: "综合对比结论",
				dependsOn: ["survey"],
			},
		],
	};
}

/** 坏计划（version=2——sanitize 层必拒：version 必须为数字 1） */
function badVersionPlan(): string {
	return JSON.stringify({ ...goodPlan(), version: 2 });
}

/** 坏计划（幽灵依赖——语义层必拒：dependsOn 引用不存在的步骤 "ghost"） */
function ghostDepPlan(): string {
	const plan = goodPlan();
	return JSON.stringify({
		...plan,
		steps: [plan.steps[0], { ...plan.steps[1], dependsOn: ["ghost"] }],
	});
}

/** 单围栏回复（最终计划以 ```json 围栏附于回复末尾——输出契约 ② 的形态） */
function fenced(planJson: string): string {
	return `设计完成，分析如下：\n……（研究过程略）……\n\n最终计划：\n\`\`\`json\n${planJson}\n\`\`\``;
}

/** 双围栏回复：第一个是研究途中的示例（坏计划），第二个才是最终计划（末位启发用） */
function twoFenceReply(firstJson: string, secondJson: string): string {
	return [
		"研究中核对过一份示例结构（仅供参考，不是最终答案）：",
		"```json",
		firstJson,
		"```",
		"",
		"以下才是最终计划：",
		"```json",
		secondJson,
		"```",
	].join("\n");
}

/** 临时 dataDir + 预建 run 记录（与生产接线同构：runs/<id>/ 已存在） */
function setupRun(): {
	dataDir: string;
	runId: string;
	planFile: string;
} {
	const dataDir = ensureWorkspace(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-designer-")),
	);
	createdDirs.push(dataDir);
	const record = createRunRecord(dataDir, TASK, "medium");
	return {
		dataDir,
		runId: record.id,
		planFile: path.join(dataDir, "runs", record.id, "designer-plan.json"),
	};
}

/** 单次 designer spawn 尝试的脚本化结局 */
interface FakeOutcome {
	/** 完成事件投递延迟（ms，缺省 1） */
	delayMs?: number;
	/** 悬挂：永不投递完成事件（abort 用例的注入） */
	hold?: boolean;
	/** spawn 受理即抛该错误（模拟 pi-subagents 缺席的受理超时；记账在拒绝前） */
	spawnError?: Error;
	/** 这次等待直接回 null（完成等待超时语义） */
	completionTimeout?: boolean;
	/** 完成事件的回复正文（payload.output 携带） */
	reply?: string;
	/** 回复改用现代形（payload.results[0].output 携带，其余字段同构真实事件） */
	modern?: boolean;
	/** 完成事件报告 subagent 失败（ok:false + error.message） */
	errorMessage?: string;
	/** 投递完成事件前同步执行（模拟 agent 先写产物文件再完成） */
	preComplete?: (runId: string) => void;
}

/**
 * 脚本化 fake RPC（最小合流体）：designer 每次 spawn 都由 ctx.rpc 消费——
 * spawn / waitForCompletion(runId 匹配) / stop，与 orchestrator.test.ts 的 fake 同语义。
 */
class FakeRpc {
	readonly spawns: Array<{
		agent?: string;
		task?: string;
		context?: string;
		runId: string;
	}> = [];
	readonly stopCalls: string[] = [];
	readonly waits: Array<{ runId?: string; timeoutMs?: number }> = [];
	private readonly outcomes: FakeOutcome[] = [];
	private readonly timeoutRunIds = new Set<string>();
	private readonly waiters: Array<{
		runId: string | undefined;
		resolve: (payload: unknown) => void;
	}> = [];
	private nextRunId = 0;

	/** 按尝试序登记结局（designer 固定 spawn researcher，按 spawn 次序脚本即可） */
	script(...outcomes: FakeOutcome[]): this {
		this.outcomes.push(...outcomes);
		return this;
	}

	async spawn(params: {
		workflowScript?: string;
		agent?: string;
		task?: string;
		context?: string;
	}): Promise<{ runId: string }> {
		const runId = `d-${++this.nextRunId}`;
		// 先记账再可能抛出：受理被拒也计入 spawn 尝试台账
		this.spawns.push({
			agent: params.agent,
			task: params.task,
			context: params.context,
			runId,
		});
		const outcome = this.outcomes[this.nextRunId - 1] ?? {};
		if (outcome.completionTimeout) this.timeoutRunIds.add(runId);
		if (outcome.spawnError) throw outcome.spawnError;
		if (!outcome.hold && !outcome.completionTimeout) {
			setTimeout(() => {
				outcome.preComplete?.(runId);
				this.deliver(runId, outcome);
			}, outcome.delayMs ?? 1);
		}
		return { runId };
	}

	waitForCompletion(
		runId?: string,
		timeoutMs?: number,
	): Promise<unknown | null> {
		this.waits.push({ runId, timeoutMs });
		if (runId !== undefined && this.timeoutRunIds.has(runId)) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			this.waiters.push({ runId, resolve });
		});
	}

	async stop(id: string): Promise<Record<string, unknown>> {
		this.stopCalls.push(id);
		return { stopped: id };
	}

	/** 投递完成事件：唤醒 runId 匹配（或约定任意事件的）等待者 */
	private deliver(runId: string, outcome: FakeOutcome): void {
		const payload: Record<string, unknown> = { runId };
		if (outcome.errorMessage !== undefined) {
			payload.ok = false;
			payload.error = { code: "agent_failed", message: outcome.errorMessage };
		} else if (outcome.modern) {
			payload.status = "succeeded";
			payload.results = [
				{
					agent: "researcher",
					status: "succeeded",
					output: outcome.reply ?? "",
				},
			];
		} else if (outcome.reply !== undefined) {
			payload.output = outcome.reply;
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

describe("generatePlan — 产物双通道（文件优先，围栏次之）", () => {
	it("文件通道成功：agent 先写 designer-plan.json 再完成 → attempts=1 / channel=file / origin=designer", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const plan = goodPlan();
		const fake = new FakeRpc().script({
			preComplete: () => fs.writeFileSync(planFile, JSON.stringify(plan)),
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: false,
			channel: "file",
		});
		expect(outcome.plan).toEqual(plan);
		expect(outcome.plan.origin).toBe("designer");

		// spawn 契约：agent=researcher（兼任设计）、context=fresh、不指定 model（继承）
		const spawn = fake.spawns[0];
		expect(spawn.agent).toBe("researcher");
		expect(spawn.context).toBe("fresh");
		expect("model" in spawn).toBe(false);

		// 任务文本契约：任务原文 + 预算（5 步 / 4 个）+ 产物绝对路径 + 双输出契约
		const text = spawn.task ?? "";
		expect(text).toContain(TASK);
		expect(text).toContain("5 步");
		expect(text).toContain("4 个");
		expect(text).toContain(planFile);
		expect(text).toContain("```json");
		expect(text).toContain("designer-plan.json");

		// 完成等待口径：按受理 runId 等待，10 分钟超时（对齐 orchestrator 步完成常量）
		expect(fake.waits).toEqual([{ runId: spawn.runId, timeoutMs: 10 * 60_000 }]);
		expect(fake.stopCalls).toEqual([]);
	});

	it("围栏通道成功：无产物文件，完成 output 正文带围栏 → channel=fence", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const fake = new FakeRpc().script({
			reply: fenced(JSON.stringify(goodPlan())),
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: false,
			channel: "fence",
		});
		expect(outcome.plan).toEqual(goodPlan());
		// 围栏通道的前提：产物文件就没写出来
		expect(fs.existsSync(planFile)).toBe(false);
	});

	it("围栏通道的防御性读取：完成事件为现代形（results[0].output 正文）也能提取围栏", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc().script({
			reply: fenced(JSON.stringify(goodPlan())),
			modern: true,
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: false,
			channel: "fence",
		});
		expect(outcome.plan).toEqual(goodPlan());
	});

	it("末位启发：回复含两个围栏（第一个是研究示例坏计划），最终计划取最后一个围栏", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc().script({
			reply: twoFenceReply(badVersionPlan(), JSON.stringify(goodPlan())),
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		// 取首围栏（坏示例）会失败重试；取末围栏则一次成功——断言锁定末位启发
		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: false,
			channel: "fence",
		});
		expect(outcome.plan).toEqual(goodPlan());
	});

	it("文件存在但校验失败 + 围栏合法 → 落围栏通道（文件通道失败不阻断）", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const fake = new FakeRpc().script({
			preComplete: () => fs.writeFileSync(planFile, badVersionPlan()),
			reply: fenced(JSON.stringify(goodPlan())),
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: false,
			channel: "fence",
		});
		expect(outcome.plan).toEqual(goodPlan());
	});

	it("产物文件合法但完成事件报告失败 → 以文件产物为准（产物即契约）", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const fake = new FakeRpc().script({
			errorMessage: "模型在收尾阶段崩溃（计划已先写出）",
			preComplete: () => fs.writeFileSync(planFile, JSON.stringify(goodPlan())),
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: false,
			channel: "file",
		});
		expect(outcome.plan).toEqual(goodPlan());
	});
});

describe("generatePlan — 校验失败与重试", () => {
	it("上轮围栏坏计划（version=2）→ 重试一次成功：attempts=2，重试文本携带上轮具体错误", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const fake = new FakeRpc().script(
			{ reply: fenced(badVersionPlan()) },
			{
				preComplete: () => fs.writeFileSync(planFile, JSON.stringify(goodPlan())),
			},
		);
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 2,
			degraded: false,
			channel: "file",
		});
		// fresh 无记忆：重试文本仍自带完整模板（任务原文 + 产物路径）+ 上轮错误附录
		const retryText = fake.spawns[1].task ?? "";
		expect(retryText).toContain(TASK);
		expect(retryText).toContain(planFile);
		expect(retryText).toContain("上次的计划未通过校验");
		expect(retryText).toContain("请修正这些问题");
		expect(retryText).toContain("version 必须为数字 1");
	});

	it("完成事件报告 subagent 失败且无产物 → 计入校验失败进入重试（失败原因附入重试文本）", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const fake = new FakeRpc().script(
			{ errorMessage: "模型中途异常退出" },
			{
				preComplete: () => fs.writeFileSync(planFile, JSON.stringify(goodPlan())),
			},
		);
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 2,
			degraded: false,
			channel: "file",
		});
		const retryText = fake.spawns[1].task ?? "";
		expect(retryText).toContain("完成事件报告 subagent 执行失败");
		expect(retryText).toContain("模型中途异常退出");
		// 失败尝试的文件缺席与围栏缺席也如实进附录
		expect(retryText).toContain("产物文件不存在");
	});

	it("三次尝试都产出坏计划 → 降级 builtin：attempts=3 / degraded=true / notes 如实记最近错误", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc().script(
			{ reply: fenced(badVersionPlan()) },
			{ reply: fenced(badVersionPlan()) },
			{ reply: fenced(ghostDepPlan()) },
		);
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 3,
			degraded: true,
			channel: "builtin",
		});
		// 降级计划 = BUILTIN_PLAN（步骤一致）+ notes 如实记原因
		expect(outcome.plan.origin).toBe("builtin");
		expect(outcome.plan.task).toBe(TASK);
		expect(outcome.plan.steps).toEqual(BUILTIN_PLAN(TASK).steps);
		expect(outcome.plan.notes).toContain(
			"designer 降级：连续 3 次尝试均未通过校验",
		);
		expect(outcome.plan.notes).toContain("ghost"); // 最近一次的具体错误片段
		// 第 3 次尝试的重试文本携带第 2 次的错误（version）
		expect(fake.spawns[2].task ?? "").toContain("version 必须为数字 1");
	});
});

describe("generatePlan — rpc 层失败（不重试立即降级）", () => {
	it("spawn 受理被拒（pi-subagents 缺席形超时）→ 立即降级：attempts=1、错误入 notes、无重试", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc().script({
			spawnError: new Error("RPC spawn 失败: RPC spawn 超时（30000ms 无 reply）"),
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: true,
			channel: "builtin",
		});
		expect(outcome.plan.notes).toContain("designer 降级：Designer spawn 失败");
		expect(outcome.plan.notes).toContain("请安装 pi-subagents");
		expect(outcome.plan.steps).toEqual(BUILTIN_PLAN(TASK).steps);
		// 尝试已发出（记账在拒绝前，与 orchestrator spawnError 口径一致）、无重试
		expect(fake.spawns).toHaveLength(1);
	});

	it("完成等待超时（waitForCompletion 回 null）→ 立即降级：attempts=1、超时原因入 notes", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc().script({ completionTimeout: true });
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: true,
			channel: "builtin",
		});
		expect(outcome.plan.notes).toContain("designer 降级：等待完成超时");
		// 与"校验失败重试"区分：不重试
		expect(fake.spawns).toHaveLength(1);
	});
});

describe("generatePlan — 中止语义（abort 即降级，不再 spawn，不抛出）", () => {
	it("调用时已中止 → 零 spawn 直接降级：attempts=0", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc();
		const controller = new AbortController();
		controller.abort();
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
			signal: controller.signal,
		});

		expect(outcome).toMatchObject({
			attempts: 0,
			degraded: true,
			channel: "builtin",
		});
		expect(outcome.plan.notes).toContain("中止");
		expect(fake.spawns).toHaveLength(0);
	});

	it("在途等待中止 → 尽力 stop 在途 run、降级收尾：attempts=1、notes 记中止", async () => {
		const { dataDir, runId } = setupRun();
		const fake = new FakeRpc().script({ hold: true });
		const controller = new AbortController();
		const pending = generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
			signal: controller.signal,
		});

		// 微任务沉降后进入完成等待（waitForCompletion 已按 runId 订阅）
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const outcome = await pending;

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: true,
			channel: "builtin",
		});
		expect(outcome.plan.notes).toContain("中止");
		// abort 收尾尽力 stop 在途 run（受理的 runId 一个不少）
		expect(fake.stopCalls).toEqual([fake.spawns[0].runId]);
	});

	it("完成投递前的中止胜出：即便来得及写出合法产物也降级（abort 优先于迟到的完成）", async () => {
		const { dataDir, runId, planFile } = setupRun();
		const controller = new AbortController();
		const fake = new FakeRpc().script({
			// 完成事件送达前用户中止——preComplete 内 abort 先 settle，竞速中完成结果落败
			preComplete: () => {
				fs.writeFileSync(planFile, JSON.stringify(goodPlan()));
				controller.abort();
			},
		});
		const outcome = await generatePlan(TASK, PRESET, {
			rpc: fake,
			runId,
			dataDir,
			signal: controller.signal,
		});

		expect(outcome).toMatchObject({
			attempts: 1,
			degraded: true,
			channel: "builtin",
		});
		expect(outcome.plan.notes).toContain("中止");
		// 中止后不再发起任何 designer 尝试
		expect(fake.spawns).toHaveLength(1);
	});
});
