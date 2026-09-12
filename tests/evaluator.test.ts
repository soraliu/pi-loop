// evaluator 评估内核测试（M4-T1）
// 全 fake / 临时 dataDir + 真实 node -e 微脚本（verifyCommand 通道是真 execFile——
// shell:false 直 argv，微脚本规避平台差异；无真 spawn、无真网络，真实 critic 链路归 e2e）。
//
// 双通道互斥契约（SPEC §7.4）：
//   verifyCommand 通道：退出码唯一权威；语法错（未闭合引号/空命令）拒收不执行；
//   超时（注入缩短的 verifyTimeoutMs + 真 node -e 慢脚本）→ fail；score 按输出可解析
//   N/M 计数比例；在场零 critic spawn（互斥的机器锁定断言）。
//   critic 通道（脚本化 FakeRpc——契约同 designer.test.ts）：三态直通；污染键净化；
//   幽灵 blame 过滤；一切 spawn/等待/产物故障收敛 fail——诚实遥测铁律的锁定断言 =
//   verdict !== "verified"（拿不到证据绝不自判通过）。
// 临时 dataDir 登记制清理，绝不触碰真实 ~/.pi/loop。

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deepSanitize } from "../src/core/defend-json.ts";
import { evaluateResult } from "../src/core/evaluator.ts";
import type { IterationEntry } from "../src/types.ts";

/** 本文件创建的临时目录清单——afterAll 只清理这些（登记制） */
const createdDirs: string[] = [];

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** 临时 dataDir（verify 命令的 cwd——绝不使用真实 ~/.pi/loop） */
function tempDataDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-evaluator-"));
	createdDirs.push(dir);
	return dir;
}

/** 任务原文（critic rubric 素材断言的锚点） */
const TASK = "对比主流 JS engine 的 GC 策略并产出结论报告";

/** 产出引用路径（entries 携带——prompt 契约断言的锚点） */
const OUTPUT_REF = "/tmp/pi-loop-eval-fixture/survey-output.md";

/** 两步执行记录：survey 成功（带产出引用）、synth 失败（带错误）——three 态素材齐备 */
const ENTRIES: IterationEntry[] = [
	{
		stepId: "survey",
		agent: "researcher",
		status: "succeeded",
		outputRef: OUTPUT_REF,
	},
	{
		stepId: "synth",
		agent: "researcher",
		status: "failed",
		error: "综合报告写出超时",
	},
];

/** 各步验收标准（PlanStep.acceptance 的映射形态） */
const ACCEPTANCE_BY_STEP: Record<string, string | undefined> = {
	survey: "至少引用三个一手来源",
	synth: "报告须含明确对比表",
};

/** 评估输入的公共底座（verifyCommand/critic 测试各自扩展） */
function baseInput(dataDir: string = tempDataDir()): {
	task: string;
	entries: IterationEntry[];
	acceptanceByStep: Record<string, string | undefined>;
	dataDir: string;
} {
	return {
		task: TASK,
		entries: ENTRIES,
		acceptanceByStep: ACCEPTANCE_BY_STEP,
		dataDir,
	};
}

/** 单次 critic spawn 的脚本化结局（语义对齐 designer.test.ts 的 FakeOutcome） */
interface FakeOutcome {
	/** spawn 受理即抛该错误（记账在前——受理被拒也计入 spawn 台账） */
	spawnError?: Error;
	/** 这次等待直接回 null（完成等待超时语义，不必真等 10 分钟） */
	completionTimeout?: boolean;
	/** 悬挂：永不投递完成事件（abort 用例的注入） */
	hold?: boolean;
	/** 完成事件的回复正文（payload.output 携带） */
	reply?: string;
	/** 完成事件报告 subagent 失败（ok:false + error.message） */
	errorMessage?: string;
	/** 完成投递延迟（ms，缺省 1） */
	delayMs?: number;
}

/**
 * 脚本化 fake RPC（最小合流体）：spawn 按尝试序消费脚本结局；
 * waitForCompletion(runId 匹配) / stop——与 designer.test.ts 的 fake 同语义。
 */
class FakeRpc {
	readonly spawns: Array<{
		workflowScript?: string;
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

	/** 按尝试序登记结局（evaluator 每 run 只 spawn 一个 critic，按 spawn 次序脚本即可） */
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
		const runId = `c-${++this.nextRunId}`;
		// 先记账再可能抛出（与 designer.test/orchestrator.test 同款）；全量展开 params——
		// 「"model" in spawn」断言由此恒真变有效（evaluator 契约是不指定 model）
		this.spawns.push({ ...params, runId });
		const outcome = this.outcomes[this.nextRunId - 1] ?? {};
		if (outcome.completionTimeout) this.timeoutRunIds.add(runId);
		if (outcome.spawnError) throw outcome.spawnError;
		if (!outcome.hold && !outcome.completionTimeout) {
			setTimeout(() => this.deliver(runId, outcome), outcome.delayMs ?? 1);
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

/** critic 回复：把评审 JSON 包进 ```json 围栏（输出契约形态——最终回复附围栏） */
function fenceEvaluation(json: string): string {
	return `评审小结：过程略。\n\`\`\`json\n${json}\n\`\`\``;
}

/** 对象形评审结论 → 围栏回复 */
function fencedEvaluation(evaluation: Record<string, unknown>): string {
	return fenceEvaluation(JSON.stringify(evaluation));
}

/** 两个 evaluation 的长断言用：reasons 拼接（单行可读） */
function joinedReasons(evaluation: { reasons: string[] }): string {
	return evaluation.reasons.join("\n");
}

describe("evaluateResult — verifyCommand 机器断言通道（存在即唯一权威）", () => {
	it("exit 0 且输出无可解析计数 → verified 满分 100；全程零 critic spawn（互斥通道锁定）", async () => {
		const fake = new FakeRpc();
		const evaluation = await evaluateResult(
			{
				...baseInput(),
				verifyCommand: `node -e "console.log('all done, looks good')"`,
			},
			{ rpc: fake },
		);

		expect(evaluation.verdict).toBe("verified");
		expect(evaluation.score).toBe(100);
		expect(evaluation.blame).toEqual([]);
		expect(joinedReasons(evaluation)).toContain("退出码 0");
		// 互斥通道的机器锁定：verifyCommand 在场不 spawn critic
		expect(fake.spawns).toHaveLength(0);
	});

	it("退出码 0 + 输出计数 → 按比例计分（2/3 passed=67；0/5 passed=0；裸 1/4=25）", async () => {
		const cases: Array<[string, number]> = [
			["2/3 passed", 67],
			["0/5 passed", 0],
			["done: 1/4", 25],
		];
		for (const [fixture, expected] of cases) {
			const evaluation = await evaluateResult(
				{ ...baseInput(), verifyCommand: `node -e "console.log('${fixture}')"` },
				{ rpc: new FakeRpc() },
			);
			expect(evaluation.verdict).toBe("verified");
			expect(evaluation.score).toBe(expected);
		}
	});

	it("锚定计数的数字边界守卫与末位启发（T1 review M1 收口）：前置日期形不遮蔽末位真计数；超长编号不构成计数", async () => {
		// 前置日期 + 末位真计数：锚定句式取最后一个可信计数（旧实现取首个会被
		// 日期抢占给出 0 分——score 失真而 verdict 不受影响）
		const dateShadowing = await evaluateResult(
			{
				...baseInput(),
				verifyCommand: `node -e "console.log('12/03/2024 passed, 8/10 passed')"`,
			},
			{ rpc: new FakeRpc() },
		);
		expect(dateShadowing.verdict).toBe("verified");
		expect(dateShadowing.score).toBe(80);

		// 超长编号形（时间戳/ID——分母 8 位）：锚定与裸兜底的 1-4 位长度守卫均拒收
		// → 无可信计数 → 满分 100（退出码唯一权威）
		const longDenominator = await evaluateResult(
			{
				...baseInput(),
				verifyCommand: `node -e "console.log('run ref 2/20245678 passed')"`,
			},
			{ rpc: new FakeRpc() },
		);
		expect(longDenominator.verdict).toBe("verified");
		expect(longDenominator.score).toBe(100);
	});

	it("非 0 退出码 → fail + 退出码与 stderr 尾部入 reasons（blame 恒空——无轮次归因）", async () => {
		const evaluation = await evaluateResult(
			{
				...baseInput(),
				verifyCommand: `node -e "console.error('boom-marker-xyz'); process.exit(3)"`,
			},
			{ rpc: new FakeRpc() },
		);

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(evaluation.blame).toEqual([]);
		const joined = joinedReasons(evaluation);
		expect(joined).toContain("退出码 3");
		expect(joined).toContain("boom-marker-xyz");
		expect(joined).toContain("stderr 尾部");
	});

	it("超时（注入缩短超时 + 真 node -e 慢脚本）→ fail + 超时 reasons（不自判通过）", async () => {
		const evaluation = await evaluateResult(
			{
				...baseInput(),
				// node -e 微脚本挂起 30s（规避平台差异的"慢命令"），注入 100ms 超时快速走完
				verifyCommand: `node -e "setTimeout(() => {}, 30000)"`,
			},
			{ rpc: new FakeRpc(), verifyTimeoutMs: 100 },
		);

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(evaluation.blame).toEqual([]);
		expect(joinedReasons(evaluation)).toContain("超时");
	});

	it("未闭合引号 → 语法错误拒收（fail + 明确 reasons，命令未执行）", async () => {
		const evaluation = await evaluateResult(
			// 少一个收尾双引号——分词器不得猜测补全（M1 债务修复口径）
			{ ...baseInput(), verifyCommand: `node -e "console.log('x')` },
			{ rpc: new FakeRpc() },
		);

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		const joined = joinedReasons(evaluation);
		expect(joined).toContain("语法错误");
		expect(joined).toContain("未闭合");
	});

	it("命令不存在 → fail 如实（原样错误 + 错误码，不白名单豁免也不静默通过）", async () => {
		const evaluation = await evaluateResult(
			{ ...baseInput(), verifyCommand: "pi-loop-nonexistent-cmd-9812 --once" },
			{ rpc: new FakeRpc() },
		);

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(joinedReasons(evaluation)).toContain("pi-loop-nonexistent-cmd-9812");
	});

	it("空串/纯空白命令 → 同样在场：语法错误 fail，绝不静默改走 critic 通道", async () => {
		const fake = new FakeRpc();
		const evaluation = await evaluateResult(
			{ ...baseInput(), verifyCommand: "   " },
			{ rpc: fake },
		);

		expect(evaluation.verdict).toBe("fail");
		expect(joinedReasons(evaluation)).toContain("命令为空");
		// 不改道 critic：错误可见优于通道切换的惊讶行为
		expect(fake.spawns).toHaveLength(0);
	});

	it("stderr 尾部截断（≤500 字）：700+ 字 stderr 只保留尾部", async () => {
		const evaluation = await evaluateResult(
			{
				...baseInput(),
				verifyCommand: `node -e "console.error('HEAD' + 'x'.repeat(700)); process.exit(1)"`,
			},
			{ rpc: new FakeRpc() },
		);

		expect(evaluation.verdict).toBe("fail");
		const stderrReason = evaluation.reasons.find((reason) =>
			reason.includes("stderr 尾部"),
		);
		expect(stderrReason).toBeDefined();
		// 头部标记被截掉、只留尾部 500 字以内（前缀 18 字符 + ≤500）
		expect(stderrReason?.includes("HEAD")).toBe(false);
		expect(stderrReason?.length).toBeLessThanOrEqual(520);
		expect(stderrReason?.length).toBeGreaterThan(400);
	});

	it("cwd=dataDir（幂等工作区）：命令产物落在 dataDir 而非用户 cwd", async () => {
		const dataDir = tempDataDir();
		const evaluation = await evaluateResult(
			{
				...baseInput(dataDir),
				verifyCommand: `node -e "require('node:fs').writeFileSync('verify-cwd-marker.txt', 'x'); console.log('1/1 passed')"`,
			},
			{ rpc: new FakeRpc() },
		);

		expect(evaluation.verdict).toBe("verified");
		expect(evaluation.score).toBe(100);
		// 标记文件出现在 dataDir——cwd 沙箱的直接证据
		expect(fs.existsSync(path.join(dataDir, "verify-cwd-marker.txt"))).toBe(true);
	});

	it("调用前已中止 → fail + 中止 reasons（不起 verify 进程）", async () => {
		const controller = new AbortController();
		controller.abort();
		const evaluation = await evaluateResult(
			{ ...baseInput(), verifyCommand: `node -e "console.log('ok')"` },
			{ rpc: new FakeRpc(), signal: controller.signal },
		);

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(joinedReasons(evaluation)).toContain("中止");
	});
});

describe("evaluateResult — critic rubric 通道（无 verifyCommand）", () => {
	it("verified 直通（score/reasons/blame 原样）+ spawn 契约与 rubric 素材齐备", async () => {
		const fake = new FakeRpc().script({
			reply: fencedEvaluation({
				verdict: "verified",
				score: 92,
				reasons: ["覆盖了全部验收标准"],
				blame: [],
			}),
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("verified");
		expect(evaluation.score).toBe(92);
		expect(evaluation.reasons).toEqual(["覆盖了全部验收标准"]);
		expect(evaluation.blame).toEqual([]);

		// spawn 契约：researcher 兼任 critic、fresh 上下文、不指定 model（继承会话默认）
		expect(fake.spawns).toHaveLength(1);
		const spawn = fake.spawns[0];
		expect(spawn.agent).toBe("researcher");
		expect(spawn.context).toBe("fresh");
		expect("model" in spawn).toBe(false);

		// rubric 素材契约：任务原文 + 步骤执行记录（id/状态/失败原因/验收标准/产出引用）
		// + 输出契约（```json 围栏——reasons 之外的旁白不作为结论）
		const text = spawn.task ?? "";
		expect(text).toContain(TASK);
		expect(text).toContain("survey");
		expect(text).toContain("synth");
		expect(text).toContain("失败原因：综合报告写出超时");
		expect(text).toContain("至少引用三个一手来源");
		expect(text).toContain(OUTPUT_REF);
		expect(text).toContain("```json");
		expect(text).toContain("验收标准");

		// 完成等待口径：按受理 runId 等待，10 分钟超时（consts.ts 单一真源口径）
		expect(fake.waits).toEqual([{ runId: spawn.runId, timeoutMs: 10 * 60_000 }]);
	});

	it("partial 直通：判定权在 critic（verified/fail 的中间态不由 evaluator 生成）", async () => {
		const fake = new FakeRpc().script({
			reply: fencedEvaluation({
				verdict: "partial",
				score: 55,
				reasons: ["三步中两步达标"],
				blame: ["synth"],
			}),
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("partial");
		expect(evaluation.score).toBe(55);
		expect(evaluation.blame).toEqual(["synth"]);
	});

	it("fail + blame 指认（存在的 stepId 原样保留、顺序保序）", async () => {
		const fake = new FakeRpc().script({
			reply: fencedEvaluation({
				verdict: "fail",
				score: 20,
				reasons: ["产出不达标"],
				blame: ["survey", "synth"],
			}),
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(20);
		expect(evaluation.blame).toEqual(["survey", "synth"]);
	});

	it("输出污染键攻击：__proto__ 键被净化剔除，评审照常成立（原型零污染）", async () => {
		// 原始 JSON 文本手动构造——JSON.stringify 无法产出自有 __proto__ 键的字符串
		const poisoned =
			'{"__proto__":{"polluted":"pwned"},"verdict":"verified","score":81,"reasons":["证据充分"],"blame":["constructor","survey"]}';
		const fake = new FakeRpc().script({ reply: fenceEvaluation(poisoned) });
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		// 危险键被剔除后评审照常解析（净化不误伤合法字段）
		expect(evaluation.verdict).toBe("verified");
		expect(evaluation.score).toBe(81);
		// "constructor" 是字符串值不是攻击键——按幽灵 stepId 过滤并附警告；survey 保留
		expect(evaluation.blame).toEqual(["survey"]);
		expect(joinedReasons(evaluation)).toContain('"constructor"');
		expect(joinedReasons(evaluation)).toContain("已过滤");
		// 原型未被污染（净化在副本上发生，危险键的赋值从未执行）
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("blame 引用不存在的 stepId（幽灵 id）→ 过滤该 id 且 reasons 附真实警告", async () => {
		const fake = new FakeRpc().script({
			reply: fencedEvaluation({
				verdict: "fail",
				score: 20,
				reasons: ["产出不达标"],
				blame: ["ghost-404"],
			}),
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.blame).toEqual([]);
		const joined = joinedReasons(evaluation);
		expect(joined).toContain("ghost-404");
		expect(joined).toContain("【警告】");
	});

	it("score 越界 clamp（150→100、-5→0）与四舍五入（88.4→88）", async () => {
		const cases: Array<[number, number]> = [
			[150, 100],
			[-5, 0],
			[88.4, 88],
		];
		for (const [given, expected] of cases) {
			const fake = new FakeRpc().script({
				reply: fencedEvaluation({
					verdict: "verified",
					score: given,
					reasons: ["ok"],
					blame: [],
				}),
			});
			const evaluation = await evaluateResult(baseInput(), { rpc: fake });
			expect(evaluation.score).toBe(expected);
		}
	});

	it("坏形状（verdict 枚举外 / score 字符串 / reasons 混入非字符串）→ fail + 指明字段的 reasons", async () => {
		const badShapes: Array<Record<string, unknown>> = [
			{ verdict: "excellent", score: 99, reasons: ["很棒"], blame: [] },
			{ verdict: "verified", score: "88", reasons: ["ok"], blame: [] },
			{ verdict: "fail", score: 12, reasons: ["ok", 42], blame: [] },
		];
		for (const shape of badShapes) {
			const fake = new FakeRpc().script({ reply: fencedEvaluation(shape) });
			const evaluation = await evaluateResult(baseInput(), { rpc: fake });
			expect(evaluation.verdict).toBe("fail");
			expect(evaluation.score).toBe(0);
			expect(evaluation.blame).toEqual([]);
			expect(joinedReasons(evaluation)).toContain("形状非法");
		}
		// 错误消息指明字段与实际值（可读性锚点）
		const fake = new FakeRpc().script({
			reply: fencedEvaluation({
				verdict: "excellent",
				score: 99,
				reasons: ["很棒"],
				blame: [],
			}),
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });
		expect(joinedReasons(evaluation)).toContain("verdict");
		expect(joinedReasons(evaluation)).toContain("excellent");
	});

	it("回复无围栏 → fail（铁律：拿不到证据不自判通过）", async () => {
		const fake = new FakeRpc().script({
			reply: "我认为这个任务已经全部完成了，都很好。",
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(evaluation.blame).toEqual([]);
		expect(joinedReasons(evaluation)).toContain("围栏");
	});

	it("围栏内 JSON 解析失败 → fail + 解析错误如实", async () => {
		const fake = new FakeRpc().script({ reply: fenceEvaluation("{not-json]") });
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(joinedReasons(evaluation)).toContain("解析失败");
	});

	it("末位启发：回复含两个围栏（前坏后好）→ 取最后一个", async () => {
		const reply = [
			"初步印象（顺手核对的示例结构，不是最终结论）：",
			"```json",
			'{"verdict": "excellent", "score": 300}',
			"```",
			"",
			"复核后的最终结论：",
			"```json",
			JSON.stringify({
				verdict: "fail",
				score: 30,
				reasons: ["最终结论"],
				blame: [],
			}),
			"```",
		].join("\n");
		const fake = new FakeRpc().script({ reply });
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		// 取首围栏（坏）会以形状错误收尾；取末围栏得到 fail + score 30 + 原文 reasons
		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(30);
		expect(evaluation.reasons).toEqual(["最终结论"]);
	});

	it("critic spawn 失败 → fail + 原因如实；绝不自判通过（铁律断言）", async () => {
		const fake = new FakeRpc().script({
			spawnError: new Error("RPC spawn 失败: RPC spawn 超时（30000ms 无 reply）"),
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(evaluation.blame).toEqual([]);
		expect(joinedReasons(evaluation)).toContain("critic spawn 失败");
		// 诚实遥测铁律（SPEC §7.4）的直白锁定
		expect(evaluation.verdict).not.toBe("verified");
	});

	it("critic 完成等待超时（waitForCompletion → null）→ fail + 超时 reasons", async () => {
		const fake = new FakeRpc().script({ completionTimeout: true });
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(evaluation.blame).toEqual([]);
		expect(joinedReasons(evaluation)).toContain("完成等待超时");
	});

	it("完成事件报告 critic 执行失败 → fail + 失败详情如实", async () => {
		const fake = new FakeRpc().script({
			errorMessage: "critic 模型上下文超限崩溃",
		});
		const evaluation = await evaluateResult(baseInput(), { rpc: fake });

		expect(evaluation.verdict).toBe("fail");
		expect(joinedReasons(evaluation)).toContain("critic 模型上下文超限崩溃");
	});

	it("调用前已中止 → fail + 零 spawn（不起 critic）", async () => {
		const controller = new AbortController();
		controller.abort();
		const fake = new FakeRpc();
		const evaluation = await evaluateResult(baseInput(), {
			rpc: fake,
			signal: controller.signal,
		});

		expect(evaluation.verdict).toBe("fail");
		expect(joinedReasons(evaluation)).toContain("中止");
		expect(fake.spawns).toHaveLength(0);
	});

	it("在途等待中止 → 尽力 stop 在途 run + fail 收尾（不自判通过）", async () => {
		const fake = new FakeRpc().script({ hold: true });
		const controller = new AbortController();
		const pending = evaluateResult(baseInput(), {
			rpc: fake,
			signal: controller.signal,
		});

		// 微任务沉降后进入完成等待（waitForCompletion 已按 runId 订阅）
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const evaluation = await pending;

		expect(evaluation.verdict).toBe("fail");
		expect(evaluation.score).toBe(0);
		expect(joinedReasons(evaluation)).toContain("中止");
		// abort 收尾尽力 stop 在途 critic run（受理的 runId 一个不少）
		expect(fake.stopCalls).toEqual([fake.spawns[0].runId]);
	});
});

describe("deepSanitize — defend-json 共享真源（critic 产物的净化防线）", () => {
	it("顶层与嵌套对象/数组内的危险键一律剔除；合法键零损耗；绝不 mutate 原输入", () => {
		const raw = JSON.parse(
			'{"__proto__":{"polluted":1},"constructor":{"x":2},"prototype":[3],"ok":true,"nested":{"__proto__":"deep","real":[1,"two",{"prototype":0}]},"arr":[{"constructor":1,"k":2}]}',
		);
		const cleaned = deepSanitize(raw);

		// 危险键剔除（顶层）
		const cleanRecord = cleaned as Record<string, unknown>;
		expect(Object.keys(cleanRecord).sort()).toEqual(["arr", "nested", "ok"]);
		// 嵌套对象的危险键剔除
		const nested = cleanRecord.nested as Record<string, unknown>;
		expect(Object.keys(nested)).toEqual(["real"]);
		// 数组内对象的危险键剔除
		const firstArrayItem = (cleanRecord.arr as unknown[])[0] as Record<
			string,
			unknown
		>;
		expect(Object.keys(firstArrayItem)).toEqual(["k"]);
		const innerArrayItem = (nested.real as unknown[])[2] as Record<
			string,
			unknown
		>;
		expect(Object.keys(innerArrayItem)).toEqual([]);
		// 合法键零损耗（值原样保留）
		expect(cleanRecord.ok).toBe(true);
		expect(nested.real).toEqual([1, "two", {}]);
		// 原输入不被 mutate（JSON.parse 的自有 __proto__ 键原样在场——净化只发生在副本上）
		expect(Object.hasOwn(raw, "__proto__")).toBe(true);
		// 原型未被污染
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("非对象输入原样返回（原始值直通）", () => {
		expect(deepSanitize(5)).toBe(5);
		expect(deepSanitize("x")).toBe("x");
		expect(deepSanitize(true)).toBe(true);
		expect(deepSanitize(null)).toBe(null);
		expect(deepSanitize(undefined)).toBe(undefined);
	});
});
