// 迟到完成对账（reconcile）单测：目录契约解算 + result 文件的读取/防御
// B-1 修复（实证见 runs/r-mu1bxsy5-aae820 与 r-mu1fdvo5-37fe3d，2026-09-14）的对账层。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createLateCompletionReader,
	resolveResultsDirs,
} from "../src/core/reconcile.ts";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveResultsDirs（目录契约解算）", () => {
	it("PI_SUBAGENTS_TEMP_ROOT 在场 → 显式根首候选（探测继续，但命中秩序优先）", () => {
		const dirs = resolveResultsDirs({ PI_SUBAGENTS_TEMP_ROOT: "/tmp/custom-root" });
		expect(dirs[0]).toBe("/tmp/custom-root");
		expect(dirs.length).toBeGreaterThanOrEqual(1);
	});

	it("缺省（无环境变量）→ os.tmpdir() 下的 pi-subagents-<scope> 形态候选", () => {
		const dirs = resolveResultsDirs({});
		expect(dirs.length).toBeGreaterThanOrEqual(1);
		for (const dir of dirs) {
			expect(dir.startsWith(path.join(os.tmpdir(), "pi-subagents-"))).toBe(true);
			expect(dir.endsWith(path.join("async-subagent-results"))).toBe(true);
		}
		// uid 平台（posix 常规）首候选应为 uid-<getuid>（契约：pi-subagents resolveTempScopeId）
		if (typeof process.getuid === "function") {
			expect(dirs[0]).toBe(
				path.join(
					os.tmpdir(),
					`pi-subagents-uid-${process.getuid()}`,
					"async-subagent-results",
				),
			);
		}
	});
});

describe("createLateCompletionReader（result 文件读取）", () => {
	it("result 文件存在 → 解析返回（与事件 payload 同源的持久形态）", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-reconcile-"));
		createdDirs.push(root);
		fs.writeFileSync(
			path.join(root, "run-42.json"),
			JSON.stringify({
				id: "run-42",
				success: true,
				state: "complete",
				exitCode: 0,
				results: [{ outputReference: "/tmp/out.md" }],
			}),
			"utf-8",
		);
		const read = createLateCompletionReader({
			PI_SUBAGENTS_TEMP_ROOT: root,
		});
		const payload = read("run-42");
		expect(payload).toMatchObject({ id: "run-42", success: true });
	});

	it("无该 run 的 result 文件（已投递删除或未完成）→ undefined", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-reconcile-"));
		createdDirs.push(root);
		const read = createLateCompletionReader({
			PI_SUBAGENTS_TEMP_ROOT: root,
		});
		expect(read("run-none")).toBeUndefined();
		// 空 runId 防御
		expect(read("")).toBeUndefined();
	});

	it("result 文件损坏（非法 JSON / 非 object）→ undefined（宁可漏收不可误判）", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-reconcile-"));
		createdDirs.push(root);
		fs.writeFileSync(path.join(root, "bad-json.json"), "{broken", "utf-8");
		fs.writeFileSync(path.join(root, "bad-shape.json"), '"just a string"', "utf-8");
		const read = createLateCompletionReader({
			PI_SUBAGENTS_TEMP_ROOT: root,
		});
		expect(read("bad-json")).toBeUndefined();
		expect(read("bad-shape")).toBeUndefined();
	});

	it("多候选目录：显式根未命中时继续探测缺省候选（uid 目录）", () => {
		// 显式根写一个，uid 根写另一个（同名不同内容——首个命中返回）
		const explicitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-reconcile-explicit-"));
		createdDirs.push(explicitRoot);
		fs.writeFileSync(
			path.join(explicitRoot, "dup.json"),
			JSON.stringify({ id: "dup", origin: "explicit" }),
			"utf-8",
		);
		if (typeof process.getuid === "function") {
			const uidDir = path.join(
				os.tmpdir(),
				`pi-subagents-uid-${process.getuid()}`,
				"async-subagent-results",
			);
			fs.mkdirSync(uidDir, { recursive: true });
			fs.writeFileSync(
				path.join(uidDir, "dup.json"),
				JSON.stringify({ id: "dup", origin: "uid-default" }),
				"utf-8",
			);
			try {
				const read = createLateCompletionReader({
					PI_SUBAGENTS_TEMP_ROOT: explicitRoot,
				});
				expect(read("dup")).toMatchObject({ origin: "explicit" });
			} finally {
				fs.rmSync(path.join(uidDir, "dup.json"), { force: true });
			}
		}
	});
});
