// pi-loop 存储层：工作区管理与 run 记录骨架（M1-T3）
// 依据 docs/SPEC.md §5（~/.pi/loop/ 布局）、§7.5（幂等工作区，不污染用户 cwd）。
// dataDir 由调用方注入（生产为 ~/.pi/loop/，测试为临时目录）——本模块绝不写死用户路径。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EffortLevel, IterationEntry, RunSummary } from "../types.ts";

/** 生产环境默认数据根目录（~/.pi/loop/） */
export function defaultDataDir(): string {
	return path.join(os.homedir(), ".pi", "loop");
}

/** run.json 骨架的形状（M2 调度内核会往里追加执行与迭代数据） */
export interface RunRecord extends RunSummary {
	/** 任务全文（不截断；taskPreview 是其截断视图） */
	task: string;
	/** 迭代记录（Orchestrator 按计划步骤追加；M1 阶段恒为空数组） */
	iterations: IterationEntry[];
}

/** run id：`r-<epoch36>` 加短随机后缀，防同毫秒碰撞且按创建时间天然有序 */
function newRunId(now: number): string {
	const epoch36 = now.toString(36);
	const rand = crypto.randomBytes(3).toString("hex"); // 6 个十六进制字符，同毫秒碰撞概率可忽略
	return `r-${epoch36}-${rand}`;
}

/** 任务描述的单行预览（与 RunSummary.taskPreview 契约一致：截断换行与长度） */
export function taskPreview(taskText: string, maxLength = 80): string {
	const oneLine = taskText.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLength
		? oneLine.slice(0, maxLength) + "…"
		: oneLine;
}

/**
 * 确保工作区目录结构存在：`<dataDir>/{runs,cases,methods}`。
 * 幂等（目录已存在时不报错）；自动创建缺失的中间目录。
 * @param dataDir 数据根目录；缺省为 ~/.pi/loop/
 * @returns 传入的数据根目录（原样返回，不另做路径解析）
 */
export function ensureWorkspace(dataDir: string = defaultDataDir()): string {
	for (const sub of ["runs", "cases", "methods"]) {
		fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
	}
	return dataDir;
}

/**
 * 创建一次 Run 的记录骨架：`<dataDir>/runs/<id>/run.json`。
 * @param dataDir 数据根目录（不会自动 ensureWorkspace；调用方先建工作区）
 * @param taskText 用户任务全文
 * @param effort 本次运行的激进度档位
 * @returns 已落盘的记录对象（与 run.json 内容一致）
 */
export function createRunRecord(
	dataDir: string,
	taskText: string,
	effort: EffortLevel,
): RunRecord {
	const id = newRunId(Date.now());
	const record: RunRecord = {
		id,
		task: taskText,
		taskPreview: taskPreview(taskText),
		effort,
		status: "created",
		createdAt: new Date().toISOString(),
		iterations: [],
	};
	const runDir = path.join(dataDir, "runs", id);
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(
		path.join(runDir, "run.json"),
		JSON.stringify(record, null, "\t") + "\n",
	);
	return record;
}
