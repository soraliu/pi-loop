// pi-loop 存储层：激进度预设表与 settings.json 加载（M1-T2）
// 依据 docs/SPEC.md §5（数据模型）、§6（Effort 预设表）。
// dataDir 由调用方注入（生产为 ~/.pi/loop/，测试为临时目录）——本模块绝不写死用户路径。

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	EffortLevel,
	EffortPreset,
	EffortPresetsMap,
	LoopSettings,
	MetaTrigger,
} from "../types.ts";

/** 合法档位（resolveEffort 的枚举真源） */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
	"low",
	"medium",
	"high",
	"max",
];

/** 默认档位：未显式指定 effort 时的落点 */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "medium";

/** SPEC §6 预设表：唯一权威数据源（settings.json 可深合并覆盖；maxPlanSteps 为 M3-T1 增补） */
export const DEFAULT_EFFORT_PRESETS: EffortPresetsMap = {
	low: {
		maxResultIterations: 1,
		maxParallelSubagents: 2,
		maxPlanSteps: 3,
		metaTrigger: { kind: "off" },
	},
	medium: {
		maxResultIterations: 2,
		maxParallelSubagents: 4,
		maxPlanSteps: 5,
		metaTrigger: { kind: "manual" },
	},
	high: {
		maxResultIterations: 3,
		maxParallelSubagents: 6,
		maxPlanSteps: 8,
		metaTrigger: { kind: "caseThreshold", count: 5 },
	},
	max: {
		maxResultIterations: 5,
		maxParallelSubagents: 8,
		maxPlanSteps: 12,
		metaTrigger: { kind: "caseThreshold", count: 3 },
	},
};

/** 是否为合法档位字符串 */
export function isEffortLevel(value: unknown): value is EffortLevel {
	return (
		typeof value === "string" &&
		(EFFORT_LEVELS as readonly string[]).includes(value)
	);
}

/**
 * 解析档位输入为预设快照。
 * @param input 用户输入（可缺省）；非法值（非四个合法档位之一）抛 TypeError 并列举合法值
 */
export function resolveEffort(input?: EffortLevel): EffortPreset {
	if (input === undefined) {
		return structuredClone(DEFAULT_EFFORT_PRESETS[DEFAULT_EFFORT_LEVEL]);
	}
	if (!isEffortLevel(input)) {
		throw new TypeError(
			`非法 effort 档位: ${JSON.stringify(input)}。合法值: ${EFFORT_LEVELS.join(" | ")}`,
		);
	}
	return structuredClone(DEFAULT_EFFORT_PRESETS[input]);
}

/** MetaTrigger 的深拷贝（避免调用方篡改默认表） */
function cloneMetaTrigger(t: MetaTrigger): MetaTrigger {
	return t.kind === "caseThreshold"
		? { kind: "caseThreshold", count: t.count }
		: { kind: t.kind };
}

/** 单档预设的部分覆盖合并：字段级深合并，未给字段保持默认 */
function mergePreset(base: EffortPreset, patch: unknown): EffortPreset {
	if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
		return structuredClone(base); // 非对象覆盖值视为无效，保持默认（宽松容错）
	}
	const p = patch as Record<string, unknown>;
	const merged: EffortPreset = { ...structuredClone(base) };
	if (
		typeof p.maxResultIterations === "number" &&
		Number.isInteger(p.maxResultIterations) &&
		p.maxResultIterations >= 0
	) {
		merged.maxResultIterations = p.maxResultIterations;
	}
	if (
		typeof p.maxParallelSubagents === "number" &&
		Number.isInteger(p.maxParallelSubagents) &&
		p.maxParallelSubagents >= 1
	) {
		merged.maxParallelSubagents = p.maxParallelSubagents;
	}
	// maxPlanSteps（M3-T1）：计划步数预算硬顶；非法值忽略回落默认（同其他键的宽松容错）
	if (
		typeof p.maxPlanSteps === "number" &&
		Number.isInteger(p.maxPlanSteps) &&
		p.maxPlanSteps >= 1
	) {
		merged.maxPlanSteps = p.maxPlanSteps;
	}
	if (p.metaTrigger !== undefined && isMetaTrigger(p.metaTrigger)) {
		merged.metaTrigger = cloneMetaTrigger(p.metaTrigger);
	}
	return merged;
}

/** MetaTrigger 结构校验（settings.json 是外部输入，必须校验形状） */
function isMetaTrigger(value: unknown): value is MetaTrigger {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.kind === "off" || v.kind === "manual")
		return Object.keys(v).length === 1;
	if (v.kind === "caseThreshold") {
		return (
			typeof v.count === "number" && Number.isInteger(v.count) && v.count >= 1
		);
	}
	return false;
}

/**
 * 读取 settings.json 并与默认预设深合并。
 * - 文件不存在：返回纯默认配置（非错误）
 * - 文件损坏（JSON 解析失败）：console.warn 告警后回退默认配置
 * - 文件合法：字段级覆盖（未给字段保持默认；覆盖值形状非法时该字段忽略）
 */
export function loadLoopSettings(dataDir: string): LoopSettings {
	const settingsPath = path.join(dataDir, "settings.json");
	if (!fs.existsSync(settingsPath)) {
		return { effortPresets: structuredClone(DEFAULT_EFFORT_PRESETS) };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	} catch (error) {
		console.warn(
			`[pi-loop] settings.json 解析失败（${settingsPath}），已回退默认配置: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return { effortPresets: structuredClone(DEFAULT_EFFORT_PRESETS) };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		console.warn(
			`[pi-loop] settings.json 顶层必须是对象（${settingsPath}），已回退默认配置`,
		);
		return { effortPresets: structuredClone(DEFAULT_EFFORT_PRESETS) };
	}
	const patches = (raw as Record<string, unknown>).effortPresets;
	const presets = structuredClone(DEFAULT_EFFORT_PRESETS);
	if (patches !== undefined) {
		if (
			patches === null ||
			typeof patches !== "object" ||
			Array.isArray(patches)
		) {
			console.warn(
				`[pi-loop] settings.json 的 effortPresets 必须是对象，该字段已忽略`,
			);
		} else {
			for (const level of EFFORT_LEVELS) {
				const patch = (patches as Record<string, unknown>)[level];
				if (patch !== undefined) {
					presets[level] = mergePreset(presets[level], patch);
				}
			}
		}
	}
	return { effortPresets: presets };
}
