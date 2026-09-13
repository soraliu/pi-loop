// pi-loop 相似检索单元测试（M5-T2）
// 纯函数零 IO——全部断言基于手算特征集（中文 2-gram + ASCII \w+ token 小写归一）。
// 公式（与 src/core/retrieval.ts 同源）：
//   方法分 = 适用面命中率（召回口径）× (1 + uses/(uses+2) × avgScore/100)
//   案例分 = Dice(task, case.task) + verified × 0.1（相似度>0 为入选门槛）
// 断言口径：行为锁（id 的相对位次/入选与否），不断言精确浮点值——常数留给实现、
// 排序留给行为（手算数值以注释标注入参旁，便于审阅时对账）。

import { describe, expect, it } from "vitest";

import { retrieve } from "../src/core/retrieval.ts";
import type { Case, MethodologyEntry } from "../src/types.ts";

/** 最小合法方法条目（appliesTo/fitness 为用例主变量，其余字段固定） */
function makeMethod(
	id: string,
	appliesTo: { taskTypes: string[]; signals: string[] },
	fitness: { uses: number; avgScore: number } = { uses: 0, avgScore: 0 },
): MethodologyEntry {
	return {
		id,
		name: `方法 ${id}`,
		appliesTo,
		playbook: {
			steps: [{ agent: "researcher", taskHint: "围绕 {task} 展开" }],
		},
		fitness,
		lineage: {},
		updatedAt: "2026-09-13T00:00:00.000Z",
	};
}

/** 最小合法案例（task/verified 为用例主变量） */
function makeCase(id: string, task: string, verified = false): Case {
	return {
		id,
		task,
		methodIds: [],
		origin: "designer",
		plan: { steps: 2 },
		runId: "r-x",
		finalScore: 50,
		verified,
		lessons: ["教训一", "教训二"],
		createdAt: "2026-09-13T00:00:00.000Z",
	};
}

describe("retrieve — 中文 2-gram 命中（方法适用面召回）", () => {
	// 任务 bigram：{研究 究并 并改 改进 进代 代码 码评 评审 审的 的流 流程}
	const TASK_CN = "研究并改进代码评审的流程";

	it("命中排序：多 bigram 信号（研究改进/评审流程 4/6）> 长 taskTypes 全命中（代码评审 3/3）> 少命中（研究评估 1/3）", () => {
		const full = makeMethod("m-type", { taskTypes: ["代码评审"], signals: [] });
		const strong = makeMethod("m-strong", {
			taskTypes: [],
			// 特征：{研究 究改 改进 评审 审流 流程}——命中 4/6
			signals: ["研究改进", "评审流程"],
		});
		const weak = makeMethod("m-weak", {
			taskTypes: [],
			// 特征：{研究 究评 评估}——仅"研究"命中 1/3
			signals: ["研究评估"],
		});
		const miss = makeMethod("m-miss", {
			taskTypes: [],
			signals: ["部署", "监控"],
		});
		// 入参乱序——排序是真实亮牌，非入参透传
		const result = retrieve(TASK_CN, {
			methods: [weak, miss, strong, full],
			cases: [],
		});
		expect(result.methods.map((m) => m.id)).toEqual([
			"m-type",
			"m-strong",
			"m-weak",
		]);
		expect(result.cases).toEqual([]);
	});

	it("中英混合特征同池计分（bigram 与 token 一并命中）", () => {
		// 特征：{改进 的检 检索 索质 质量 / js runtime}
		const task = "改进 JS runtime 的检索质量";
		const method = makeMethod("m-mixed", {
			taskTypes: ["检索"],
			signals: ["runtime"],
		});
		// 案例特征：{改进 进检 检索 实验 / runtime}——dice 6/12 = 0.5 > 0
		const similar = makeCase("c-mixed", "改进检索 runtime 实验");
		const result = retrieve(task, {
			methods: [method],
			cases: [similar],
		});
		expect(result.methods.map((m) => m.id)).toEqual(["m-mixed"]);
		expect(result.cases.map((c) => c.id)).toEqual(["c-mixed"]);
	});

	it("空格分隔防跨信号伪 bigram（信号条目独立取特征，不互相串接）", () => {
		// 任务 bigram：{探究 究评 评审 审流 流程}——含"究评"但不含"研究/评估"。
		// 若实现直拼信号串（"研究"+"评估" → "研究评估"）会伪造"究评"特征而虚增命中
		const task = "探究评审流程";
		const joined = makeMethod("m-cross", {
			taskTypes: [],
			signals: ["研究", "评估"],
		});
		const hit = makeMethod("m-hit", { taskTypes: [], signals: ["评审"] });
		const result = retrieve(task, { methods: [joined, hit], cases: [] });
		expect(result.methods.map((m) => m.id)).toEqual(["m-hit"]);
	});

	it("输入数组不被重排或截断（纯函数承诺）", () => {
		const methods = [
			makeMethod("m-b", { taskTypes: [], signals: ["改进"] }),
			makeMethod("m-a", { taskTypes: [], signals: ["研究", "改进"] }),
		];
		const cases = [makeCase("c-1", "研究改进方案"), makeCase("c-2", "无关部署")];
		retrieve("研究改进", { methods, cases });
		expect(methods.map((m) => m.id)).toEqual(["m-b", "m-a"]);
		expect(cases.map((c) => c.id)).toEqual(["c-1", "c-2"]);
	});
});

describe("retrieve — ASCII 词 token（\\w+ 小写归一）", () => {
	it("词级命中排序 + 大小写不敏感 + 零命中排除", () => {
		const task = "Compare JS Runtime Scheduling";
		// 任务 token：{compare js runtime scheduling}
		const full = makeMethod("m-full", {
			taskTypes: [],
			signals: ["runtime", "scheduling"], // 2/2
		});
		const partial = makeMethod("m-partial", {
			taskTypes: [],
			signals: ["runtime", "rendering"], // 1/2
		});
		const miss = makeMethod("m-miss", {
			taskTypes: [],
			signals: ["渲染", "调研"], // 0
		});
		const result = retrieve(task, {
			methods: [partial, miss, full],
			cases: [],
		});
		expect(result.methods.map((m) => m.id)).toEqual(["m-full", "m-partial"]);
	});
});

describe("retrieve — fitness 证据乘数（uses/(uses+2) 平滑 + avgScore/100 归一）", () => {
	it("同信号面：有实证（uses=10、均分 80 → 乘数 1.667）排在新方法（uses=0 → 乘数 1）之前", () => {
		const fresh = makeMethod(
			"m-fresh",
			{ taskTypes: [], signals: ["研究", "改进"] },
			{ uses: 0, avgScore: 0 },
		);
		const proven = makeMethod(
			"m-proven",
			{ taskTypes: [], signals: ["研究", "改进"] },
			{ uses: 10, avgScore: 80 },
		);
		const result = retrieve("研究改进", {
			methods: [fresh, proven],
			cases: [],
		});
		expect(result.methods.map((m) => m.id)).toEqual(["m-proven", "m-fresh"]);
	});

	it("新方法不埋没：实证方法信号面弱一半（0.5×1.667=0.833）被新方法（1.0×1）反超", () => {
		const fresh = makeMethod(
			"m-fresh",
			{ taskTypes: [], signals: ["研究", "改进"] },
			{ uses: 0, avgScore: 0 },
		);
		const semiProven = makeMethod(
			"m-semi",
			// 命中 2/4 = 0.5
			{ taskTypes: [], signals: ["研究", "改进", "评估", "汇总"] },
			{ uses: 10, avgScore: 80 },
		);
		const result = retrieve("研究并改进", {
			methods: [semiProven, fresh],
			cases: [],
		});
		expect(result.methods.map((m) => m.id)).toEqual(["m-fresh", "m-semi"]);
	});

	it("实证越多乘数越高但收敛（uses 3/10/100 同信号面按实证量降序——百次仍 <2 封顶）", () => {
		const low = makeMethod(
			"m-u3",
			{ taskTypes: [], signals: ["研究", "改进"] },
			{ uses: 3, avgScore: 80 },
		);
		const mid = makeMethod(
			"m-u10",
			{ taskTypes: [], signals: ["研究", "改进"] },
			{ uses: 10, avgScore: 80 },
		);
		const high = makeMethod(
			"m-u100",
			{ taskTypes: [], signals: ["研究", "改进"] },
			{ uses: 100, avgScore: 80 },
		);
		const result = retrieve("研究改进", {
			methods: [low, mid, high],
			cases: [],
		});
		expect(result.methods.map((m) => m.id)).toEqual(["m-u100", "m-u10", "m-u3"]);
	});
});

describe("retrieve — 案例任务相似度（Dice）与 verified 加成", () => {
	it('中文任务相似排序："研究改进"案例（dice 6/14）> "研究评估"案例（dice 4/14）——均未验收也不为零', () => {
		// 任务 bigram：{研究 究改 改进 进检 检索 索方 方案}
		const task = "研究改进检索方案";
		const good = makeCase("c-good", "研究改进搜索排序"); // 命中 3（研究/究改/改进）
		const weak = makeCase("c-weak", "研究评估检索效果"); // 命中 2（研究/检索）
		const result = retrieve(task, { methods: [], cases: [weak, good] });
		expect(result.cases.map((c) => c.id)).toEqual(["c-good", "c-weak"]);
	});

	it("同任务文本：verified 案例凭 +0.1 加成排前（相似度同为 1.0）", () => {
		const task = "研究改进检索方案";
		const unverified = makeCase("c-unverified", task, false); // 1.0
		const verified = makeCase("c-verified", task, true); // 1.1
		const result = retrieve(task, {
			methods: [],
			cases: [unverified, verified],
		});
		expect(result.cases.map((c) => c.id)).toEqual(["c-verified", "c-unverified"]);
	});

	it("零相似的老案例即使 verified 也不入选（加成不单独构成资格）", () => {
		const task = "研究改进检索方案";
		const far = makeCase("c-far", "部署集群监控告警", true); // bigram 无交集 → 0
		const good = makeCase("c-good", "研究改进搜索排序");
		const weak = makeCase("c-weak", "研究评估检索效果");
		const result = retrieve(task, { methods: [], cases: [far, good, weak] });
		expect(result.cases.map((c) => c.id)).toEqual(["c-good", "c-weak"]);
	});
});

describe("retrieve — k 截断与并列序（缺省 k=3）", () => {
	// 四档命中率：1.0 / 0.75 / 0.5 / 0.25（signals 渐增未命中项）
	const LADDER: Array<[string, string[]]> = [
		["m-full", ["研究", "改进"]],
		["m-3q", ["研究", "改进", "评审", "评估"]],
		["m-half", ["研究", "改进", "评估", "汇总"]],
		["m-q", ["研究", "评估", "汇总", "部署"]],
	];
	const TASK = "研究并改进代码评审的流程";

	it("四个命中方法缺省留 top3；k=1 只留最相似；k=2 居中截断", () => {
		const methods = [
			makeMethod("m-half", { taskTypes: [], signals: LADDER[2][1] }),
			makeMethod("m-full", { taskTypes: [], signals: LADDER[0][1] }),
			makeMethod("m-q", { taskTypes: [], signals: LADDER[3][1] }),
			makeMethod("m-3q", { taskTypes: [], signals: LADDER[1][1] }),
		];
		_expectIds(retrieve(TASK, { methods, cases: [] }).methods, [
			"m-full",
			"m-3q",
			"m-half",
		]);
		_expectIds(retrieve(TASK, { methods, cases: [], k: 2 }).methods, [
			"m-full",
			"m-3q",
		]);
		const c1 = makeCase("c-1", "研究改进搜索排序");
		const c2 = makeCase("c-2", "研究评估检索效果");
		_expectIds(retrieve(TASK, { methods, cases: [c1, c2], k: 1 }).cases, ["c-1"]);
	});

	it("分值并列保持入参序（确定性）；k=1 取首项", () => {
		const a = makeMethod("m-a", { taskTypes: [], signals: ["研究", "改进"] });
		const b = makeMethod("m-b", { taskTypes: [], signals: ["研究", "改进"] });
		expect(
			retrieve("研究并改进", { methods: [a, b], cases: [] }).methods.map(
				(m) => m.id,
			),
		).toEqual(["m-a", "m-b"]);
	});
});

describe("retrieve — 空库/零命中/k≤0", () => {
	it("空库 → 双空数组（调用方据此省略注入）", () => {
		expect(retrieve("任意任务", { methods: [], cases: [] })).toEqual({
			methods: [],
			cases: [],
		});
	});

	it("零命中（中文与 ASCII 均无交集）与空任务 → 双空数组", () => {
		const miss = makeMethod("m-miss", {
			taskTypes: ["deployment"],
			signals: ["部署", "监控"],
		});
		const far = makeCase("c-far", "部署集群监控告警", true);
		expect(
			retrieve("research benchmark comparison", {
				methods: [miss],
				cases: [far],
			}),
		).toEqual({ methods: [], cases: [] });
		expect(retrieve("", { methods: [miss], cases: [far] })).toEqual({
			methods: [],
			cases: [],
		});
	});

	it("k≤0 → 双空数组（明确不检索）", () => {
		const method = makeMethod("m-hit", { taskTypes: [], signals: ["研究"] });
		const similar = makeCase("c-hit", "研究");
		expect(
			retrieve("研究", { methods: [method], cases: [similar], k: 0 }),
		).toEqual({ methods: [], cases: [] });
	});
});

/** 断言辅助：id 序（泛型——方法/案例两列通用，避免每处重复 map） */
function _expectIds<T extends { id: string }>(
	actual: T[],
	expected: string[],
): void {
	expect(actual.map((x) => x.id)).toEqual(expected);
}
