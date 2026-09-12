// pi-loop settings/预设表 单元测试（M1-T2）
// 场景：默认值、自定义覆盖（部分字段深合并）、非法 effort、损坏 settings 回退
// 全部使用临时目录，禁止触碰真实 ~/.pi/loop/
import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DEFAULT_EFFORT_LEVEL,
	DEFAULT_EFFORT_PRESETS,
	EFFORT_LEVELS,
	isEffortLevel,
	loadLoopSettings,
	resolveEffort,
} from "../src/storage/settings.ts";

/** 建一次性临时目录，测试结束后清理 */
function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
}

afterAll(() => {
	// 清理本文件产生的临时目录（mkdtemp 前缀过滤，防误删）
	const tmp = os.tmpdir();
	for (const name of fs.readdirSync(tmp)) {
		if (name.startsWith("pi-loop-test-")) {
			fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
		}
	}
});

describe("DEFAULT_EFFORT_PRESETS（SPEC §6 权威数据）", () => {
	it("四个档位齐全且数值与 SPEC §6 表格一致", () => {
		expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "max"]);
		expect(DEFAULT_EFFORT_PRESETS.low).toEqual({
			maxResultIterations: 1,
			maxParallelSubagents: 2,
			metaTrigger: { kind: "off" },
		});
		expect(DEFAULT_EFFORT_PRESETS.medium).toEqual({
			maxResultIterations: 2,
			maxParallelSubagents: 4,
			metaTrigger: { kind: "manual" },
		});
		expect(DEFAULT_EFFORT_PRESETS.high).toEqual({
			maxResultIterations: 3,
			maxParallelSubagents: 6,
			metaTrigger: { kind: "caseThreshold", count: 5 },
		});
		expect(DEFAULT_EFFORT_PRESETS.max).toEqual({
			maxResultIterations: 5,
			maxParallelSubagents: 8,
			metaTrigger: { kind: "caseThreshold", count: 3 },
		});
		expect(DEFAULT_EFFORT_LEVEL).toBe("medium");
	});
});

describe("resolveEffort", () => {
	it("缺省输入落到默认档（medium）的深拷贝", () => {
		const preset = resolveEffort();
		expect(preset).toEqual(DEFAULT_EFFORT_PRESETS.medium);
		// 深拷贝语义：篡改返回值不得影响默认表
		preset.maxResultIterations = 99;
		expect(DEFAULT_EFFORT_PRESETS.medium.maxResultIterations).toBe(2);
	});

	it("合法档位返回对应预设的深拷贝", () => {
		expect(resolveEffort("low").maxResultIterations).toBe(1);
		expect(resolveEffort("max").metaTrigger).toEqual({ kind: "caseThreshold", count: 3 });
	});

	it("非法档位抛 TypeError 且错误信息列举全部合法值", () => {
		for (const bad of ["ultra", "", "MAX", 42, null, undefined === undefined ? "turbo" : "x"]) {
			expect(() => resolveEffort(bad as never)).toThrow(TypeError);
			try {
				resolveEffort(bad as never);
			} catch (error) {
				const message = (error as Error).message;
				for (const level of EFFORT_LEVELS) {
					expect(message).toContain(level); // 错误信息里能找到每个合法值
				}
			}
		}
	});

	it("isEffortLevel 类型守卫与 resolveEffort 一致", () => {
		expect(isEffortLevel("low")).toBe(true);
		expect(isEffortLevel("nope")).toBe(false);
		expect(isEffortLevel(7)).toBe(false);
	});
});

describe("loadLoopSettings — 默认与缺失", () => {
	it("目录无 settings.json 时返回默认表的深拷贝", () => {
		const dir = makeTempDir();
		const settings = loadLoopSettings(dir);
		expect(settings.effortPresets).toEqual(DEFAULT_EFFORT_PRESETS);
		// 深拷贝：篡改不影响默认表
		settings.effortPresets.high.maxResultIterations = 77;
		expect(DEFAULT_EFFORT_PRESETS.high.maxResultIterations).toBe(3);
	});
});

describe("loadLoopSettings — 自定义覆盖（部分字段深合并）", () => {
	it("只覆盖 max 的轮数字段，其余字段与其余档位保持默认", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				effortPresets: {
					max: { maxResultIterations: 7 },
				},
			}),
		);
		const settings = loadLoopSettings(dir);
		expect(settings.effortPresets.max.maxResultIterations).toBe(7); // 覆盖生效
		expect(settings.effortPresets.max.maxParallelSubagents).toBe(8); // 未给字段保持默认
		expect(settings.effortPresets.max.metaTrigger).toEqual({ kind: "caseThreshold", count: 3 });
		expect(settings.effortPresets.low).toEqual(DEFAULT_EFFORT_PRESETS.low); // 其他档位不动
	});

	it("metaTrigger 整体替换且校验形状（caseThreshold 需合法 count）", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				effortPresets: {
					low: { metaTrigger: { kind: "caseThreshold", count: 9 } },
				},
			}),
		);
		const settings = loadLoopSettings(dir);
		expect(settings.effortPresets.low.metaTrigger).toEqual({ kind: "caseThreshold", count: 9 });
	});

	it("形状非法的覆盖值被忽略并保持默认（宽松容错，不抛错）", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				effortPresets: {
					low: { maxResultIterations: "很多", maxParallelSubagents: -3, metaTrigger: { kind: "whenever" } },
					unknownLevel: { maxResultIterations: 1 }, // 非法档位名直接忽略
				},
			}),
		);
		const settings = loadLoopSettings(dir);
		expect(settings.effortPresets.low.maxResultIterations).toBe(1); // 非法值保持默认
		expect(settings.effortPresets.low.maxParallelSubagents).toBe(2);
		expect(settings.effortPresets.low.metaTrigger).toEqual({ kind: "off" });
		expect(settings.effortPresets).not.toHaveProperty("unknownLevel");
	});
});

describe("loadLoopSettings — 损坏回退", () => {
	it("JSON 解析失败时回退默认并 console.warn 告警", () => {
		const dir = makeTempDir();
		fs.writeFileSync(path.join(dir, "settings.json"), "{ 这不是合法 JSON !!!");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const settings = loadLoopSettings(dir);
			expect(settings.effortPresets).toEqual(DEFAULT_EFFORT_PRESETS);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("settings.json");
		} finally {
			warn.mockRestore();
		}
	});

	it("顶层非对象（如数组）同样回退默认并告警", () => {
		const dir = makeTempDir();
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify([1, 2, 3]));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(loadLoopSettings(dir).effortPresets).toEqual(DEFAULT_EFFORT_PRESETS);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("effortPresets 字段类型非法时仅忽略该字段（其余行为不变）", () => {
		const dir = makeTempDir();
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({ effortPresets: "nope", otherField: 1 }),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(loadLoopSettings(dir).effortPresets).toEqual(DEFAULT_EFFORT_PRESETS);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
