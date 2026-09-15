// 迟到完成对账（B-1 修复：超时判死前的真实终态收割）
//
// 背景（实证见 runs/r-mu1bxsy5-aae820 与 r-mu1fdvo5-37fe3d 对账报告，2026-09-14）：
// pi-subagents 的 subagent:async-complete 事件是「观察通道而非交付回执」——事件
// emit 被门控在完成通知（sendMessage → 宿主会话 turn）成功投递之后。当宿主会话
// 正被一个长工具调用占用（典型：pi-loop 的 loop_task 工具调用内的 waitForCompletion
// 自身），通知无法插入 → 事件不 emit → 等待方 600s 超时误判「无产物」。实测同一
// 时刻：subagent 已 state=complete、产物已落盘、result 文件因「投递成功后删除」
// 的生命周期恰好持留在盘上。本模块按 pi-subagents 官方文档背书的对账口径
// （extension-api.md："Read run state from the status files under the async run
// directory rather than from event traffic"）从 result 文件收割真实终态。
//
// 契约来源：pi-subagents src/shared/types.ts（TEMP_ROOT_DIR / RESULTS_DIR 的
// 布局：`$PI_SUBAGENTS_TEMP_ROOT || os.tmpdir()/pi-subagents-<scope>/`，scope 常规
// 为 "uid-<process.getuid()>"）与 src/runs/background/notify.ts 头注（result 文件
// 的留存语义）。布局耦合面收窄在 resolveResultsDirs 单点，pi-subagents 改布局时
// PI_SUBAGENTS_TEMP_ROOT 是显式逃生门。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** ExecutePlanContext.readLateCompletion 的生产实现形态：读不到/读不坏都返回 undefined（调用方按「无凭据」处理） */
export type LateCompletionReader = (runId: string) => unknown | undefined;

/** resolveTempScopeId 的本地复刻（pi-subagents shared/types.ts 同名函数的主路径子集：
 * uid 优先，缺 uid 的平台回退 user-<env>；不做 home/shared 档——pi-loop 只需覆盖
 * 本机大概率形态，探测多个候选目录的成本交给调用侧的「逐个试」） */
function tempScopeCandidates(env: NodeJS.ProcessEnv): string[] {
	const scopes: string[] = [];
	if (typeof process.getuid === "function") {
		scopes.push(`uid-${process.getuid()}`);
	}
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) {
			const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "_";
			const scope = `user-${sanitized}`;
			if (!scopes.includes(scope)) scopes.push(scope);
		}
	}
	return scopes.length > 0 ? scopes : ["shared"];
}

/** result 目录候选（PI_SUBAGENTS_TEMP_ROOT 显式优先；契约见文件头注） */
export function resolveResultsDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	const dirs: string[] = [];
	const explicit = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (explicit) dirs.push(path.resolve(explicit));
	const tmp = os.tmpdir();
	for (const scope of tempScopeCandidates(env)) {
		dirs.push(path.join(tmp, `pi-subagents-${scope}`, "async-subagent-results"));
	}
	return dirs;
}

/**
 * 读一个 run 的迟到完成数据（result 文件 = 完成通知投递前的持久形态，与事件
 * payload 同源）：`<resultsDir>/<runId>.json` 顶层含 id/success/state/exitCode/
 * results[]（outputReference）等字段——解读复用 orchestrator 的 readCompletion
 * 宽容判定（该函数对 success:false / error 在场 / results[0].outputReference 等
 * 都已有防御语义，此处只负责把文件内容原样交给它）。
 * 多候选目录逐个探测（首个命中即返回）；不存在/损坏/非对象 → undefined。
 */
export function createLateCompletionReader(
	env: NodeJS.ProcessEnv = process.env,
): LateCompletionReader {
	const dirs = resolveResultsDirs(env);
	return (runId: string): unknown | undefined => {
		if (runId === "") return undefined;
		for (const dir of dirs) {
			const file = path.join(dir, `${runId}.json`);
			let raw: string;
			try {
				raw = fs.readFileSync(file, "utf-8");
			} catch {
				continue; // 该目录没有这个 run 的 result 文件（未完成或已投递删除）
			}
			try {
				const parsed: unknown = JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object") return parsed;
			} catch {
				// 损坏的 result 文件：视为无凭据（对账宁可漏收不可误判）
			}
		}
		return undefined;
	};
}
