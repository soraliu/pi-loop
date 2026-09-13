// pi-loop 存储层：案例档案（M5-T1）——Case 落档与 RunRecord → Case 投影
// 依据 docs/SPEC.md §5（cases/ 目录、Case 形状）、docs/plans/m5-archivist.md。
// Case 消费规范（M4 终审定案）：plan / evaluation / final 一律取 run.json 面
// （record.plan 六元与记录本体）——Case 是 run.json 的投影存档，不自判结论；
// 无 final 的 completed = 异常终止——lessons 追加标记 + verified=false。
// dataDir 由调用方注入（生产 ~/.pi/loop/，测试临时目录）——本模块绝不写死用户路径。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { RunRecord } from "./workspace.ts";
import type { Case } from "../types.ts";

/** 案例子目录名（相对 dataDir；runs/methods 的兄弟目录——ensureWorkspace 同源） */
const CASES_DIR = "cases";

/** 读取单条案例（容错：JSON 解析失败/顶层非对象 → undefined 并 warn——口径同 methods） */
function readCaseFile(file: string): Case | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("顶层不是对象");
		}
		return parsed as Case;
	} catch (error) {
		console.warn(
			`[pi-loop] 案例档案读取失败（跳过）：${file}：${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

/** case id：`c-<epoch36>-<hex6>`——runId 同风格（时间戳天然有序 + 短随机防同毫秒碰撞） */
function newCaseId(now: number): string {
	return `c-${now.toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * 保存案例档案：写 `<dataDir>/cases/<id>.json`（2 空格缩进——与方法条目同款存储
 * 风格；cases 不 git 化——SPEC §5 的 git 仓库仅 methods/）。
 * @throws 条目 id 非法（文件名安全）时
 */
export async function saveCase(dataDir: string, entry: Case): Promise<void> {
	if (
		entry.id.length === 0 ||
		entry.id.includes("/") ||
		entry.id.includes("\\") ||
		entry.id === "." ||
		entry.id === ".."
	) {
		throw new Error(`非法案例 id（文件名安全）：${JSON.stringify(entry.id)}`);
	}
	const casesDir = path.join(dataDir, CASES_DIR);
	fs.mkdirSync(casesDir, { recursive: true });
	fs.writeFileSync(
		path.join(casesDir, `${entry.id}.json`),
		JSON.stringify(entry, null, 2) + "\n",
	);
}

/**
 * 案例列表：按 createdAt 倒序（最新在前；limit 截取前 N 条，N≤0 → 空数组）。
 * 目录不存在 → 空数组；坏文件跳过并 console.warn（容错口径同 methods）。
 */
export async function listCases(
	dataDir: string,
	limit?: number,
): Promise<Case[]> {
	const casesDir = path.join(dataDir, CASES_DIR);
	if (!fs.existsSync(casesDir)) return [];
	const names = fs
		.readdirSync(casesDir, { withFileTypes: true })
		.filter((d) => d.isFile() && d.name.endsWith(".json"))
		.map((d) => d.name)
		.sort();
	const cases: Case[] = [];
	for (const name of names) {
		const parsed = readCaseFile(path.join(casesDir, name));
		if (parsed !== undefined) cases.push(parsed);
	}
	// createdAt 倒序（ISO 8601 字典序即时间序；相等时保持文件名字典序——排序稳定）
	cases.sort((a, b) =>
		a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1,
	);
	return limit === undefined ? cases : cases.slice(0, Math.max(0, limit));
}

/**
 * RunRecord → Case（Case 消费规范——M4 终审定案）：
 * - plan/evaluation/final 取 run.json 面：origin/steps/notes 取 record.plan 的
 *   六元，verified = final?.verdict === "verified"，finalScore = final.score
 *   （final 缺席不落键），lessons 从 evaluation.reasons 摘前 3 条
 * - 无 final 的 completed（mid-loop 基建异常的陈旧终态）→ verified=false +
 *   lessons 追加「异常终止（无 final）」标记——诚实留痕，不推断结论
 * - methodIds 恒空数组（v1：方法关联自 plan 追溯属 M6，先记 origin 二分）
 * @param record run.json 的记录本体（磁盘读取由调用方完成——存储层不感知 runs/ 结构）
 * @param taskId 任务全文（loop_task 的 task 入参——Case.task 的唯一来源，
 *   与 record.task 同值；显式传参对齐调用方持有的任务原文）
 * @throws record 缺 plan 时（从未进入执行闭环的记录无计划可投影——拒绝伪造 origin）
 */
export function caseFromRunRecord(record: RunRecord, taskId: string): Case {
	if (record.plan === undefined) {
		throw new Error(
			`run 记录缺 plan，无法投影 Case（非迭代闭环终态形态，runId=${record.id}）`,
		);
	}
	const final = record.final;
	const verified = final !== undefined && final.verdict === "verified";
	const lessons = (record.evaluation?.reasons ?? []).slice(0, 3);
	if (record.status === "completed" && final === undefined) {
		lessons.push("异常终止（无 final）");
	}
	return {
		id: newCaseId(Date.now()),
		task: taskId,
		methodIds: [],
		origin: record.plan.origin,
		plan: {
			steps: record.plan.steps,
			...(record.plan.notes === undefined ? {} : { notes: record.plan.notes }),
		},
		runId: record.id,
		...(final === undefined ? {} : { finalScore: final.score }),
		verified,
		lessons,
		createdAt: new Date().toISOString(),
	};
}
