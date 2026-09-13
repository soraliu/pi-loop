// pi-loop 方法论库存储 单元测试（M5-T1）
// 场景：save/list 往返（2 空格 + key 序排序锁）+ git 仓库惰性 init 与 git log
// 原文断言（真实 git 仓库）+ 坏 JSON 跳过 + git 缺席降级（PATH 剥离的可移植
// 模拟——execFile 按 PATH 定位 git，指向不存在目录即 ENOENT）+ fitness
// 平滑累计数学。
// 全部临时目录注入（禁真实 ~/.pi/loop）；git 断言直接 -C <dataDir>/methods 查询。
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	listMethods,
	saveMethodEntry,
	updateFitness,
} from "../src/storage/methods.ts";
import type { MethodologyEntry } from "../src/types.ts";

/** 本文件创建的临时目录清单——只删这些，不做全局前缀扫描 */
const createdDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-methods-test-"));
	createdDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** 最小合法方法条目（Partial 字段覆盖） */
function makeEntry(
	id: string,
	overrides: Partial<MethodologyEntry> = {},
): MethodologyEntry {
	return {
		id,
		name: `方法 ${id}`,
		appliesTo: { taskTypes: ["research"], signals: ["调研", "对比"] },
		playbook: {
			steps: [{ agent: "researcher", taskHint: "围绕 {task} 展开调研" }],
		},
		fitness: { uses: 0, avgScore: 0 },
		lineage: {},
		updatedAt: "2026-09-13T00:00:00.000Z",
		...overrides,
	};
}

/** methods 仓库的提交主题列表（--reverse：时间序——旧在前，与断言的因果序一致） */
function commitSubjects(dataDir: string): string[] {
	const out = execFileSync(
		"git",
		["-C", path.join(dataDir, "methods"), "log", "--reverse", "--format=%s"],
		{ encoding: "utf-8" },
	);
	return out
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);
}

describe("saveMethodEntry / listMethods", () => {
	it("save 落盘 + list 往返：内容全等、2 空格缩进、key 序排序锁（appliesTo 首键）", async () => {
		const dir = makeTempDir();
		await saveMethodEntry(dir, makeEntry("m-alpha"), "methods: m-alpha add");
		const listed = await listMethods(dir);
		expect(listed).toEqual([makeEntry("m-alpha")]);
		const raw = fs.readFileSync(
			path.join(dir, "methods", "m-alpha.json"),
			"utf-8",
		);
		// 排序锁：字典序首键是 appliesTo（id 排在中间）——同形条目字节级一致
		expect(raw.startsWith('{\n  "appliesTo"')).toBe(true);
		// 嵌套结构同 2 空格缩进；尾换行收口
		expect(raw).toContain('\n  "fitness": {\n    "avgScore"');
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw.endsWith("\n\n")).toBe(false);
	});

	it("两条目 save → list 按文件名字典序返回", async () => {
		const dir = makeTempDir();
		await saveMethodEntry(dir, makeEntry("m-beta"), "methods: m-beta add");
		await saveMethodEntry(dir, makeEntry("m-alpha"), "methods: m-alpha add");
		const listed = await listMethods(dir);
		expect(listed.map((m) => m.id)).toEqual(["m-alpha", "m-beta"]);
	});

	it("坏 JSON 条目跳过并 console.warn（好条目不受影响）", async () => {
		const dir = makeTempDir();
		await saveMethodEntry(dir, makeEntry("m-good"), "methods: m-good add");
		fs.writeFileSync(path.join(dir, "methods", "m-broken.json"), "{ 这不是 JSON");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const listed = await listMethods(dir);
			expect(listed.map((m) => m.id)).toEqual(["m-good"]);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("m-broken.json");
		} finally {
			warn.mockRestore();
		}
	});

	it("目录不存在 → listMethods 空数组（非错误）", async () => {
		const dir = makeTempDir();
		expect(await listMethods(dir)).toEqual([]);
	});

	it("非法 id（路径逃逸形态）→ 拒写抛错（文件名安全）", async () => {
		const dir = makeTempDir();
		await expect(
			saveMethodEntry(dir, makeEntry("../escape"), "methods: escape add"),
		).rejects.toThrow(/非法方法条目 id/);
		expect(await listMethods(dir)).toEqual([]);
	});
});

describe("方法库 git 化", () => {
	it("首次 save 惰性 git init（.git 建立）+ 首次 commit 主题如实", async () => {
		const dir = makeTempDir();
		expect(fs.existsSync(path.join(dir, "methods", ".git"))).toBe(false);
		await saveMethodEntry(dir, makeEntry("m-git"), "methods: m-git add");
		expect(fs.existsSync(path.join(dir, "methods", ".git"))).toBe(true);
		expect(commitSubjects(dir)).toEqual(["methods: m-git add"]);
	});

	it("每条目/每次 fitness 各一次 commit（git log 原文断言：add / fitness update）", async () => {
		const dir = makeTempDir();
		await saveMethodEntry(dir, makeEntry("m-fit"), "methods: m-fit add");
		await saveMethodEntry(dir, makeEntry("m-other"), "methods: m-other add");
		await updateFitness(dir, "m-fit", 90);
		await updateFitness(dir, "m-fit", 70);
		expect(commitSubjects(dir)).toEqual([
			"methods: m-fit add",
			"methods: m-other add",
			"methods: m-fit fitness update",
			"methods: m-fit fitness update",
		]);
	});
});

describe("updateFitness", () => {
	it("平滑累计均值数学：两次 update 后 uses=2、avg=(90+70)/2=80", async () => {
		const dir = makeTempDir();
		await saveMethodEntry(dir, makeEntry("m-math"), "methods: m-math add");
		await updateFitness(dir, "m-math", 90);
		let listed = await listMethods(dir);
		expect(listed[0]?.fitness).toEqual({ uses: 1, avgScore: 90 });
		await updateFitness(dir, "m-math", 70);
		listed = await listMethods(dir);
		expect(listed[0]?.fitness).toEqual({ uses: 2, avgScore: 80 });
	});

	it("条目不存在 → 抛错（不静默吞——调用方负责降级）", async () => {
		const dir = makeTempDir();
		await expect(updateFitness(dir, "m-absent", 50)).rejects.toThrow(
			/方法条目不存在/,
		);
	});
});

describe("git 缺席降级", () => {
	it("PATH 剥离（execFile 找不到 git）→ warn + 文件照写、不建 .git、不抛出", async () => {
		const dir = makeTempDir();
		const savedPath = process.env.PATH;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// 可移植模拟：PATH 指向不存在的目录——execFile 的可执行文件查找
			// （libuv 按子进程 env 的 PATH 定位）必然 ENOENT，与平台安装路径无关
			process.env.PATH = path.join(dir, "no-git-here");
			await saveMethodEntry(dir, makeEntry("m-nogit"), "methods: m-nogit add");
			await updateFitness(dir, "m-nogit", 60);
			// 文件照写：save 与 fitness 各落一次盘（读回验证数学不受降级影响）
			const listed = await listMethods(dir);
			expect(listed.map((m) => m.id)).toEqual(["m-nogit"]);
			expect(listed[0]?.fitness).toEqual({ uses: 1, avgScore: 60 });
			// 不建 .git、不抛出；warn 有且仅有降级告警（save 与 fitness 各一条）
			expect(fs.existsSync(path.join(dir, "methods", ".git"))).toBe(false);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(String(warn.mock.calls[0]?.[0])).toContain("git 不在场");
		} finally {
			warn.mockRestore();
			// 先恢复 PATH 再走 finally 的其余清理（commitSubjects 类断言依赖 git 在场）
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
		}
	});
});
