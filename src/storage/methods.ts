// pi-loop 存储层：方法论库（M5-T1）——方法条目读写 + 方法库 git 化
// 依据 docs/SPEC.md §5（methods/ 为 git 仓库）、docs/plans/m5-archivist.md。
// dataDir 由调用方注入（生产 ~/.pi/loop/，测试临时目录）——本模块绝不写死用户路径。
//
// git 化语义（SPEC §9 M5 行）：methods/ 目录自身即 git 仓库（惰性 init——首个
// save 时建立；local user 归因 pi-loop，无全局 git 身份的环境也能 commit）；
// 每次条目新增/修订/fitness 更新各一次 commit。git 不在场（`git --version` 探测
// 失败）或 git 步骤失败 → console.warn + 降级跳过版本化，文件照写——诚实：
// 缺席不伪装成已版本化（不在条目元数据里记任何 git 状态）。

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { MethodologyEntry } from "../types.ts";

/** 方法库子目录名（相对 dataDir——SPEC §5：methods/ 是独立 git 仓库） */
const METHODS_DIR = "methods";

/** git 子进程缺省超时（本地仓库的 init/add/commit 均为毫秒级，10s 只兜挂起） */
const GIT_TIMEOUT_MS = 10_000;

/** 子进程输出的尾部截取（错误信息的可读性——口径仿 evaluator 的 stderrTail） */
function stdTail(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > 300 ? `${collapsed.slice(-300)}…` : collapsed;
}

/** git 子进程的 Promise 包装（execFile、shell:false——与 evaluator 的 verify 通道同安全口径） */
function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: GIT_TIMEOUT_MS, shell: false, encoding: "utf8" },
			(error, _stdout, stderr) => {
				if (error === null) {
					resolve(_stdout);
					return;
				}
				const echoed = stdTail(String(stderr ?? ""));
				reject(
					new Error(
						`git ${args.join(" ")} 失败：${error.message}${
							echoed.length > 0 ? `（${echoed}）` : ""
						}`,
					),
				);
			},
		);
	});
}

/** git 可用性探测（brief 指定口径：`git --version`——一切失败视为缺席） */
async function isGitAvailable(): Promise<boolean> {
	try {
		await runGit(["--version"], process.cwd());
		return true;
	} catch {
		return false;
	}
}

/** 深排序 key 的锁（同形条目字节级一致——git diff 噪声最小化、平台无关） */
function sortKeysDeep<T>(value: T): T {
	if (Array.isArray(value)) {
		// SAFETY: 仅重排对象 key、逐元素递归同构——map 结果与原数组同形状，T 不变
		return (value as unknown[]).map((item) => sortKeysDeep(item)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		// Object.create(null)：JSON 产物的 "__proto__" own-key 不落进原型（防原型污染）
		const sorted: Record<string, unknown> = Object.create(null);
		const source = value as Record<string, unknown>;
		for (const key of Object.keys(source).sort()) {
			sorted[key] = sortKeysDeep(source[key]);
		}
		// SAFETY: 键集合与嵌套形状不变（仅 key 排序），与 T 的结构同构
		return sorted as unknown as T;
	}
	return value;
}

/** 条目落盘序列化（2 空格缩进 + key 序稳定 + 尾换行） */
function serializeEntry(entry: MethodologyEntry): string {
	return `${JSON.stringify(sortKeysDeep(entry), null, 2)}\n`;
}

/** 条目 id 的文件名安全（防路径逃逸——id 经 M6 起可能有模型输出源头） */
function assertSafeEntryId(id: string): void {
	if (
		id.length === 0 ||
		id.includes("/") ||
		id.includes("\\") ||
		id === "." ||
		id === ".."
	) {
		throw new Error(`非法方法条目 id（文件名安全）：${JSON.stringify(id)}`);
	}
}

/**
 * 方法库的 git 版本化（save / fitness 更新后调用）：
 * 仓库未建立 → 惰性 `git init` + local 身份配置（归因 pi-loop——CI/沙箱等无全局
 * git 身份的环境也能 commit；用户全局配置不受影响——local 只作用于 methods 仓库）；
 * 随后 `git add -A .` + `git commit`（execFile、shell:false，两步各一次调用）。
 * git 缺席（探测失败）→ warn 降级跳过；git 步骤失败 → warn 跳过（文件已落盘——
 * 版本化失败不阻塞存储主流程）。
 */
async function gitCommitAll(
	methodsDir: string,
	message: string,
): Promise<void> {
	if (!(await isGitAvailable())) {
		console.warn(
			"[pi-loop] git 不在场（git --version 探测失败），方法库跳过 git 版本化——文件照写",
		);
		return;
	}
	try {
		if (!fs.existsSync(path.join(methodsDir, ".git"))) {
			await runGit(["init"], methodsDir);
			await runGit(["config", "user.name", "pi-loop"], methodsDir);
			await runGit(["config", "user.email", "pi-loop@local"], methodsDir);
		}
		await runGit(["add", "-A", "."], methodsDir);
		await runGit(["commit", "-m", message], methodsDir);
	} catch (error) {
		console.warn(
			`[pi-loop] 方法库 git commit 失败（跳过，文件已写）："${message}"：${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * 保存方法条目：写 `<dataDir>/methods/<id>.json`（2 空格缩进 + key 序稳定），
 * 随后方法库 git 留痕一次。
 * @param commitMessage 提交主题（英文，如 "methods: <id> add"/"methods: <id> revise"）
 * @throws 条目 id 非法（文件名安全）时
 */
export async function saveMethodEntry(
	dataDir: string,
	entry: MethodologyEntry,
	commitMessage: string,
): Promise<void> {
	assertSafeEntryId(entry.id);
	const methodsDir = path.join(dataDir, METHODS_DIR);
	fs.mkdirSync(methodsDir, { recursive: true });
	fs.writeFileSync(
		path.join(methodsDir, `${entry.id}.json`),
		serializeEntry(entry),
	);
	await gitCommitAll(methodsDir, commitMessage);
}

/**
 * 方法条目列表：扫描 `<dataDir>/methods/` 下的 *.json（目录不存在 → 空数组；
 * 坏文件跳过并 console.warn——容错口径同 loadLoopSettings）。返回按文件名
 * （即条目 id）字典序——跨平台确定序，排序权交给消费方（检索/展示各取所需）。
 */
export async function listMethods(
	dataDir: string,
): Promise<MethodologyEntry[]> {
	const methodsDir = path.join(dataDir, METHODS_DIR);
	if (!fs.existsSync(methodsDir)) return [];
	const names = fs
		.readdirSync(methodsDir, { withFileTypes: true })
		.filter((d) => d.isFile() && d.name.endsWith(".json"))
		.map((d) => d.name)
		.sort();
	const entries: MethodologyEntry[] = [];
	for (const name of names) {
		const file = path.join(methodsDir, name);
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("顶层不是对象");
			}
			entries.push(parsed as MethodologyEntry);
		} catch (error) {
			console.warn(
				`[pi-loop] 方法条目读取失败（跳过）：${file}：${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return entries;
}

/**
 * 方法 fitness 更新：读改写（磁盘为事实源——口径同 run.json 的收口路径），
 * 随后 git commit（"methods: <id> fitness update"）。
 * 数学（平滑累计均值——严格等价于全体历史 score 的算术平均，不舍入保持精度）：
 *   uses' = uses + 1；avgScore' = (avgScore×uses + score) / (uses + 1)
 * 只记真实 run 结果：score 应为该次 run 的 final.score（evaluator 已 clamp 0-100）。
 * @throws 条目文件不存在时（存储层如实报错，不静默吞——调用方负责降级收口）
 */
export async function updateFitness(
	dataDir: string,
	id: string,
	score: number,
): Promise<void> {
	const file = path.join(dataDir, METHODS_DIR, `${id}.json`);
	if (!fs.existsSync(file)) {
		throw new Error(`方法条目不存在，无法更新 fitness：${file}`);
	}
	const entry = JSON.parse(fs.readFileSync(file, "utf-8")) as MethodologyEntry;
	const uses = entry.fitness.uses;
	entry.fitness.avgScore = (entry.fitness.avgScore * uses + score) / (uses + 1);
	entry.fitness.uses = uses + 1;
	entry.updatedAt = new Date().toISOString();
	fs.writeFileSync(file, serializeEntry(entry));
	await gitCommitAll(
		path.join(dataDir, METHODS_DIR),
		`methods: ${id} fitness update`,
	);
}
