// pi-loop 工作区管理 单元测试（M1-T3）
// 场景：目录幂等创建、run.json 骨架初值、临时目录隔离、同毫秒 id 防碰撞
// 全部使用临时目录且只清理自己创建的目录（T2 review 的 deferred minor 引以为戒）
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	createRunRecord,
	defaultDataDir,
	ensureWorkspace,
	taskPreview,
} from "../src/storage/workspace.ts";

/** 本文件创建的临时目录清单——只删这些，不做全局前缀扫描 */
const createdDirs: string[] = [];

/** 建一次性临时目录并登记，afterAll 逐个清理 */
function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-ws-test-"));
	createdDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of createdDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("ensureWorkspace", () => {
	it("创建 runs/cases/methods 三目录并返回根路径", () => {
		const dir = makeTempDir();
		const returned = ensureWorkspace(dir);
		expect(returned).toBe(dir);
		for (const sub of ["runs", "cases", "methods"]) {
			expect(fs.statSync(path.join(dir, sub)).isDirectory()).toBe(true);
		}
	});

	it("幂等：两次调用不报错，目录仍正确", () => {
		const dir = makeTempDir();
		expect(() => ensureWorkspace(dir)).not.toThrow();
		expect(() => ensureWorkspace(dir)).not.toThrow();
		for (const sub of ["runs", "cases", "methods"]) {
			expect(fs.statSync(path.join(dir, sub)).isDirectory()).toBe(true);
		}
	});

	it("自动创建缺失的中间目录（dataDir 本身不存在也能建）", () => {
		const dir = path.join(makeTempDir(), "nested", "deeper");
		ensureWorkspace(dir);
		expect(fs.statSync(path.join(dir, "runs")).isDirectory()).toBe(true);
	});

	it("defaultDataDir 指向 ~/.pi/loop", () => {
		expect(defaultDataDir()).toBe(path.join(os.homedir(), ".pi", "loop"));
	});
});

describe("createRunRecord", () => {
	it("run.json 骨架初值正确且已落盘", () => {
		const dir = ensureWorkspace(makeTempDir());
		const record = createRunRecord(dir, "研究 tokio 调度器", "low");
		// 返回对象字段
		expect(record.id).toMatch(/^r-[0-9a-z]+-[0-9a-f]{6}$/);
		expect(record.task).toBe("研究 tokio 调度器");
		expect(record.taskPreview).toBe("研究 tokio 调度器");
		expect(record.effort).toBe("low");
		expect(record.status).toBe("created");
		expect(record.iterations).toEqual([]);
		expect(() => new Date(record.createdAt).toISOString()).not.toThrow();
		// 落盘内容与返回对象一致
		const onDisk = JSON.parse(
			fs.readFileSync(path.join(dir, "runs", record.id, "run.json"), "utf8"),
		);
		expect(onDisk).toEqual(record);
	});

	it("taskPreview 截断：长任务预览 80 字符 + 省略号，task 保留全文", () => {
		const dir = ensureWorkspace(makeTempDir());
		const longTask = "很".repeat(200);
		const record = createRunRecord(dir, longTask, "medium");
		expect(record.task).toHaveLength(200);
		expect(record.taskPreview).toHaveLength(81); // 80 + 省略号
		expect(record.taskPreview.endsWith("…")).toBe(true);
	});

	it("同毫秒多次创建 id 不碰撞", () => {
		const dir = ensureWorkspace(makeTempDir());
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) {
			ids.add(createRunRecord(dir, `任务${i}`, "high").id);
		}
		expect(ids.size).toBe(50);
	});

	it("隔离：两个临时目录的 runs 互不可见", () => {
		const dirA = ensureWorkspace(makeTempDir());
		const dirB = ensureWorkspace(makeTempDir());
		const recA = createRunRecord(dirA, "A 的任务", "low");
		const recB = createRunRecord(dirB, "B 的任务", "low");
		expect(recA.id).not.toBe(recB.id);
		expect(
			fs.existsSync(path.join(dirB, "runs", recA.id, "run.json")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(dirA, "runs", recB.id, "run.json")),
		).toBe(false);
	});
});

describe("taskPreview", () => {
	it("压缩空白为单空格并去首尾", () => {
		expect(taskPreview("  hello \n\t world  ")).toBe("hello world");
	});

	it("不超过 80 字符时原样返回", () => {
		expect(taskPreview("x".repeat(80))).toBe("x".repeat(80));
	});
});
