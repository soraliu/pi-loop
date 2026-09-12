// pi-subagents RPC 客户端（M2-T1）
// 通过 pi-subagents 官方 in-process RPC（事件总线协议）与 subagent 调度器通信。
// 协议锚点（源自 pi-subagents docs/extension-api.md 与源码核实，controller 2026-09-12）：
//   请求   emit("subagents:rpc:v1:request", { version: 1, requestId, method, params })
//   回复   on("subagents:rpc:v1:reply:<requestId>") → { version, requestId, success, data | error }
//   就绪   on("subagents:rpc:v1:ready")（在场信号；不作为请求前置条件）
//   完成   on("subagent:async-complete")——spawn 的 reply 只是"已受理"，受理形态
//          （pi-subagents src/runs/background/async-execution.ts:2091 + extension/rpc.ts
//          dataFromToolResult，M3-T5 Fix round 2 e2e 实跑校准）为
//          { text: "Async: <agent> [<runId>]…(受理 guidance)",
//            details: { mode: "single", runId, asyncId, results: [], … } }
//          ——顶层无 runId，藏在 details（text 首行受理头另有副本）——spawn() 内
//          做归一化（见 normalizeSpawnAcceptance）；真正完成经此事件通知，
//          payload 结构未完全文档化，做防御性 runId 匹配。
// 设计约束：一次请求一次 reply；不重试、不自动重连；pi-subagents 不在场时由超时兜底。

import { randomUUID } from "node:crypto";

/** 宿主 pi.events 的最小结构接口（测试注入 fake 总线） */
export interface SubagentEventBus {
	emit: (event: string, payload?: unknown) => unknown;
	on: (event: string, handler: (payload: unknown) => unknown) => unknown;
}

/** pi-subagents RPC 请求包（协议 v1） */
export interface RpcRequest {
	version: 1;
	requestId: string;
	method: string;
	params?: unknown;
}

/** pi-subagents RPC 回复包：成功携带 data，失败携带 error */
export interface RpcReply {
	version?: number;
	requestId: string;
	success: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

/** RPC 错误（含方法与 requestId，便于遥测归因） */
export class RpcError extends Error {
	constructor(
		message: string,
		readonly method: string,
		readonly requestId: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcError";
	}
}

/** spawn 受理结果（async-only：reply 即受理，完成需等 subagent:async-complete）。
 * runId 经 spawn() 的归一化通道提取（M3-T5 Fix round 2）：顶层 / details.runId /
 * details.asyncId / text 受理头四通道；消费方只需读顶层 runId。 */
export interface SpawnAcceptance {
	runId?: string;
	[key: string]: unknown;
}

/** async-complete 事件的防御性读取：结构未完全文档化，尝试常见 runId 字段 */
function extractRunId(payload: unknown): string | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	const direct = p.runId ?? p.id;
	if (typeof direct === "string") return direct;
	const nested = p.run;
	if (nested !== null && typeof nested === "object") {
		const nestedId = (nested as Record<string, unknown>).id;
		if (typeof nestedId === "string") return nestedId;
	}
	return undefined;
}

/** 受理头 runId 提取正则（宿主受理 text 首行："Async: <agent> [<runId>]"——^ 锚定首行语义，
 *  正文中间出现的 "Async: …" 只是文字内容不作受理头；M4-T0 补锚，M3 终审 M-2 债） */
const ASYNC_HEADER_RUN_ID_RE = /^Async: \S+ \[([^\]]+)\]/;

/** 非空字符串判定（受理 runId 候选的统一形状校验） */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * spawn 受理 data 的归一化（M3-T5 Fix round 2，e2e 实跑校准）：宿主真实受理形态的
 * runId 不在顶层（藏在 details，text 首行受理头另有副本）——若不提取，多步计划的
 * orchestrator 防线（“spawn 受理未返回 runId：多步计划下无法区分各步的完成事件”）
 * 会拒绝一切多步执行。M2 未暴露：单步计划缺省 runId 可退化为“等任意完成事件”。
 * runId 提取的优先级（双通道防御，与 readCompletion 的 outputRef 宽候选集同风格）：
 *   ① 顶层 runId（M2 造形与既有 fake 的向后兼容——在场即权威）；
 *   ② details.runId / details.asyncId（宿主真实形态，async-execution.ts:2091）；
 *   ③ text 首行受理头正则（details 变形/缺失时的兜底）。
 * 其余字段（text/details 等）原样透传在返回对象上（消费者可能用）；返回浅拷贝，
 * 不 mutate reply data。
 */
function normalizeSpawnAcceptance(data: unknown): SpawnAcceptance {
	if (data === null || typeof data !== "object") return {};
	const raw = data as SpawnAcceptance & { text?: unknown; details?: unknown };
	if (isNonEmptyString(raw.runId)) return { ...raw };
	if (raw.details !== null && typeof raw.details === "object") {
		const details = raw.details as Record<string, unknown>;
		if (isNonEmptyString(details.runId)) return { ...raw, runId: details.runId };
		if (isNonEmptyString(details.asyncId))
			return { ...raw, runId: details.asyncId };
	}
	if (typeof raw.text === "string") {
		const match = ASYNC_HEADER_RUN_ID_RE.exec(raw.text);
		if (match !== null) return { ...raw, runId: match[1] };
	}
	return { ...raw };
}

export interface SubagentsRpcClientOptions {
	/** request 与 waitForCompletion 的缺省超时（毫秒） */
	defaultTimeoutMs?: number;
}

export class SubagentsRpcClient {
	private readonly bus: SubagentEventBus;
	private readonly defaultTimeoutMs: number;

	constructor(bus: SubagentEventBus, opts: SubagentsRpcClientOptions = {}) {
		this.bus = bus;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
	}

	/**
	 * 发起一次 RPC 请求并等待对应 reply。
	 * @throws RpcError 超时或 success:false（error.code/message 透传）
	 */
	request<T = unknown>(
		method: string,
		params?: unknown,
		timeoutMs?: number,
	): Promise<T> {
		const requestId = randomUUID();
		const timeout = timeoutMs ?? this.defaultTimeoutMs;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const eventName = `subagents:rpc:v1:reply:${requestId}`;
			let unsubscribe: unknown;
			const handler = (payload: unknown): void => {
				// reply 是一次性事件；重复投递忽略（防御性，协议不保证恰好一次）
				if (settled) return;
				settled = true;
				this.detach(eventName, handler, unsubscribe);
				clearTimeout(timer);
				const reply = payload as RpcReply | null;
				if (!reply || typeof reply !== "object") {
					reject(new RpcError("reply payload 非对象", method, requestId));
					return;
				}
				if (reply.success) {
					resolve(reply.data as T);
					return;
				}
				const code = reply.error?.code;
				const message = reply.error?.message ?? "未知 RPC 错误";
				reject(
					new RpcError(`RPC ${method} 失败: ${message}`, method, requestId, code),
				);
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.detach(eventName, handler, unsubscribe);
				reject(
					new RpcError(
						`RPC ${method} 超时（${timeout}ms 无 reply）`,
						method,
						requestId,
						"timeout",
					),
				);
			}, timeout);

			unsubscribe = this.bus.on(eventName, handler);
			this.bus.emit("subagents:rpc:v1:request", {
				version: 1,
				requestId,
				method,
				params,
			});
		});
	}

	/**
	 * 等待一次异步完成事件（subagent:async-complete）。
	 * @param runId 期待完成的 run id；缺省时任何完成事件都命中
	 * @returns 命中的事件 payload；超时返回 null（调用方决定语义）
	 */
	waitForCompletion(
		runId: string | undefined,
		timeoutMs?: number,
	): Promise<unknown | null> {
		const timeout = timeoutMs ?? this.defaultTimeoutMs;
		return new Promise((resolve) => {
			let settled = false;
			const eventName = "subagent:async-complete";
			let unsubscribe: unknown;
			const handler = (payload: unknown): void => {
				if (settled) return;
				if (runId !== undefined) {
					const hit = extractRunId(payload);
					// 结构未文档化：匹配不上就一直等，交给超时兜底
					if (hit !== runId) return;
				}
				settled = true;
				this.detach(eventName, handler, unsubscribe);
				clearTimeout(timer);
				resolve(payload);
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.detach(eventName, handler, unsubscribe);
				resolve(null);
			}, timeout);

			unsubscribe = this.bus.on(eventName, handler);
		});
	}

	/** 探测 pi-subagents 在场与能力声明（method: "ping"） */
	ping(timeoutMs?: number): Promise<unknown> {
		return this.request("ping", undefined, timeoutMs);
	}

	/**
	 * spawn 一个 async run。注意返回值是"受理信息"（归一化后顶层 runId 已提取——
	 * M3-T5 Fix round 2：宿主受理形态的 runId 藏 details/text 受理头，见
	 * normalizeSpawnAcceptance），完成需另行 waitForCompletion。
	 */
	spawn(
		params: {
			workflowScript?: string;
			agent?: string;
			task?: string;
			context?: string;
		},
		timeoutMs?: number,
	): Promise<SpawnAcceptance> {
		return this.request("spawn", { context: "fresh", ...params }, timeoutMs).then(
			(data) => normalizeSpawnAcceptance(data),
		);
	}

	/** 停止一个 async run */
	stop(id: string, timeoutMs?: number): Promise<unknown> {
		return this.request("stop", { id }, timeoutMs);
	}

	/**
	 * 卸载事件 handler：bus.on 若返回 unsubscribe 函数则调用之（宿主与 fake 总线的约定）；
	 * 返回非函数（如 undefined）时无法主动卸载——记 console.warn 提示 handler 泄漏风险，
	 * 由宿主事件的幂等性兜底（settled 守卫保证不会重复结算）。
	 */
	private detach(
		_eventName: string,
		_handler: (payload: unknown) => unknown,
		unsubscribe: unknown,
	): void {
		if (typeof unsubscribe === "function") {
			(unsubscribe as () => void)();
		} else if (unsubscribe !== undefined) {
			console.warn(
				"[pi-loop] bus.on 返回了非函数值，无法卸载 listener（可能泄漏）",
			);
		}
	}
}
