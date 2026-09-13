// pi-loop 案例存储 单元测试（M5-T1）
// 场景：caseFromRunRecord 四终态形态（verified / budget_exhausted / fail /
// 无 final completed 异常终止——Case 消费规范的档案面四形）+ lessons 摘取上限 +
// plan 缺席拒投 + save/list 往返与 createdAt 倒序 + 坏文件容错。
import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	caseFromRunRecord,
	listCases,
	saveCase,
} from "../src/storage/cases.ts";
import type { RunRecord } from "../src/storage/workspace.ts";
import type { Case } from "../src/types.ts";

/** 本文件创建的临时目录清单——只删这些，不做全局前缀扫描 */
const createdDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-cases-test-"));
	createdDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** run.json 记录本体的最小 fixture（缺省 = 无 evaluation/final 的 completed 骨架） */
function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "r-m5case01-abc123",
		task: "研究 tokio 调度器",
		taskPreview: "研究 tokio 调度器",
		effort: "medium",
		status: "completed",
		createdAt: "2026-09-13T00:00:00.000Z",
		iterations: [],
		plan: { origin: "designer", steps: 2, degraded: false, notes: "两步走" },
		...overrides,
	};
}

/** 直接构造一条 Case（save/list 用——不经 caseFromRunRecord） */
function makeCase(id: string, createdAt: string): Case {
	return {
		id,
		task: `任务 ${id}`,
		methodIds: [],
		origin: "builtin",
		plan: { steps: 1 },
		runId: "r-x",
		verified: true,
		lessons: [],
		createdAt,
	};
}

describe("caseFromRunRecord（Case 消费规范四形）", () => {
	it("verified 形：final.verdict=verified → verified=true、finalScore=final.score、lessons 摘 reasons 前 3 条", () => {
		const record = makeRecord({
			round: 1,
			evaluation: {
				verdict: "verified",
				score: 92,
				reasons: ["覆盖全部验收标准", "引用充分", "结论可信", "第四条应被截掉"],
				blame: [],
			},
			final: { round: 1, verdict: "verified", score: 92 },
		});
		const c = caseFromRunRecord(record, "研究 tokio 调度器");
		expect(c.id).toMatch(/^c-[0-9a-z]+-[0-9a-f]{6}$/);
		expect(c.task).toBe("研究 tokio 调度器");
		expect(c.methodIds).toEqual([]);
		expect(c.origin).toBe("designer");
		expect(c.plan).toEqual({ steps: 2, notes: "两步走" });
		expect(c.runId).toBe("r-m5case01-abc123");
		expect(c.finalScore).toBe(92);
		expect(c.verified).toBe(true);
		// 摘前 3 条（第 4 条被截）、反常终止标记不在场
		expect(c.lessons).toEqual(["覆盖全部验收标准", "引用充分", "结论可信"]);
		expect(c.lessons).not.toContain("异常终止（无 final）");
		expect(() => new Date(c.createdAt).toISOString()).not.toThrow();
	});

	it("budget_exhausted 形（run.json 面：status=failed + error budget_exhausted: 前缀 + final fail）→ verified=false、finalScore 如实", () => {
		const record = makeRecord({
			status: "failed",
			round: 2,
			evaluation: {
				verdict: "fail",
				score: 10,
				reasons: ["覆盖不足"],
				blame: [],
			},
			final: { round: 2, verdict: "fail", score: 10 },
		});
		// 迭代引擎的预算尽收尾在 run 级落 error（Budget 用 LoopToolResult 面呈现）
		(record as RunRecord & { error?: string }).error =
			"budget_exhausted: 迭代轮数上限 2 轮用尽（共执行 3 轮，最后一轮 verdict=fail）";
		const c = caseFromRunRecord(record, "研究 tokio 调度器");
		expect(c.verified).toBe(false);
		expect(c.finalScore).toBe(10);
		expect(c.lessons).toEqual(["覆盖不足"]);
		expect(c.origin).toBe("designer");
	});

	it("fail 形（中止/失败收尾）：final 在场 verdict=partial → verified=false、finalScore 落键", () => {
		const record = makeRecord({
			status: "failed",
			evaluation: {
				verdict: "partial",
				score: 40,
				reasons: ["部分达成"],
				blame: ["synth"],
			},
			final: { round: 0, verdict: "partial", score: 40 },
		});
		const c = caseFromRunRecord(record, "任务原文");
		expect(c.verified).toBe(false);
		expect(c.finalScore).toBe(40);
		expect(c.lessons).toEqual(["部分达成"]);
	});

	it("无 final 的 completed（异常终止）→ verified=false、finalScore 不落键、lessons 追加异常终止标记", () => {
		const record = makeRecord({
			evaluation: {
				verdict: "fail",
				score: 0,
				reasons: ["等待完成超时"],
				blame: [],
			},
		});
		const c = caseFromRunRecord(record, "异常任务");
		expect(c.verified).toBe(false);
		expect(c).not.toHaveProperty("finalScore");
		expect(c.lessons).toEqual(["等待完成超时", "异常终止（无 final）"]);
	});

	it("evaluation 缺席的异常终止 → lessons 仅含标记（不伪造评估依据）", () => {
		const record = makeRecord();
		const c = caseFromRunRecord(record, "异常任务");
		expect(c.lessons).toEqual(["异常终止（无 final）"]);
	});

	it("plan 缺席（从未进闭环的收口记录）→ 拒绝伪造 origin：抛错", () => {
		const record = makeRecord();
		delete record.plan;
		expect(() => caseFromRunRecord(record, "任务")).toThrow(/缺 plan/);
	});
});

describe("saveCase / listCases", () => {
	it("save 落盘 + list 倒序（createdAt 新在前）+ limit 截取 + 落盘内容全等", async () => {
		const dir = makeTempDir();
		const oldest = makeCase("c-old", "2026-09-12T00:00:00.000Z");
		const newest = makeCase("c-new", "2026-09-13T00:00:00.000Z");
		const middle = makeCase("c-mid", "2026-09-12T12:00:00.000Z");
		await saveCase(dir, oldest);
		await saveCase(dir, newest);
		await saveCase(dir, middle);
		const all = await listCases(dir);
		expect(all.map((c) => c.id)).toEqual(["c-new", "c-mid", "c-old"]);
		expect(await listCases(dir)).toEqual([newest, middle, oldest]);
		expect((await listCases(dir, 2)).map((c) => c.id)).toEqual([
			"c-new",
			"c-mid",
		]);
		// 落盘内容与对象全等（2 空格缩进 + 尾换行）
		const raw = fs.readFileSync(path.join(dir, "cases", "c-new.json"), "utf-8");
		expect(raw).toBe(`${JSON.stringify(newest, null, 2)}\n`);
	});

	it("目录不存在 → 空数组；坏文件跳过并 warn", async () => {
		const dir = makeTempDir();
		expect(await listCases(dir)).toEqual([]);
		await saveCase(dir, makeCase("c-ok", "2026-09-13T00:00:00.000Z"));
		fs.writeFileSync(path.join(dir, "cases", "c-bad.json"), "{ 破 JSON");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const listed = await listCases(dir);
			expect(listed.map((c) => c.id)).toEqual(["c-ok"]);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("c-bad.json");
		} finally {
			warn.mockRestore();
		}
	});
});
