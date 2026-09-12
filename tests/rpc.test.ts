// pi-subagents RPC 客户端单元测试（M2-T1）
// 全部使用 fake 事件总线（Map<event, handlers>），不真连宿主。
// 覆盖：正常 reply 解包、success:false 拒绝、超时、并发串扰、waitForCompletion 命中/超时、listener 卸载。
import { afterAll, describe, expect, it } from "vitest";

import {
	SubagentsRpcClient,
	type SubagentEventBus,
	type RpcReply,
} from "../src/core/rpc.ts";

/** fake 事件总线：同步分派；记录全部 emit 供断言 */
class FakeBus implements SubagentEventBus {
	readonly handlers = new Map<string, Set<(payload: unknown) => unknown>>();
	/** 仅记录 request（reply 不入列），replyLast 按 FIFO 消费 */
	readonly requests: Array<{ requestId: string; payload: unknown }> = [];

	emit(event: string, payload?: unknown): unknown {
		if (event === "subagents:rpc:v1:request") {
			const req = payload as { requestId: string };
			this.requests.push({ requestId: req.requestId, payload });
		}
		const set = this.handlers.get(event);
		if (!set) return undefined;
		// 复制一份：handler 可能在执行中注销自己（含自身）
		for (const h of [...set]) h(payload);
		return undefined;
	}

	on(event: string, handler: (payload: unknown) => unknown): unknown {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		set.add(handler);
		return () => this.off(event, handler);
	}

	off(event: string, handler: (payload: unknown) => unknown): void {
		this.handlers.get(event)?.delete(handler);
	}

	/** 对最近一个未回复的 request 回复（不消费队列——重复 reply 场景需要重放） */
	replyLast(payload: Omit<RpcReply, "requestId">): void {
		if (this.requests.length === 0)
			throw new Error("fake bus: 尚无 request 可回复");
		const { requestId } = this.requests[this.requests.length - 1];
		this.emit(`subagents:rpc:v1:reply:${requestId}`, { requestId, ...payload });
	}
}

const tempDirs: string[] = [];
afterAll(() => {
	void tempDirs; // 本文件无临时目录；占位保持登记制风格一致
});

describe("SubagentsRpcClient.request", () => {
	it("正常 reply → data 解包", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.request<{ pong: boolean }>("ping");
		bus.replyLast({ success: true, data: { pong: true } });
		await expect(pending).resolves.toEqual({ pong: true });
		// 协议包字段校验：version/requestId/method 齐备
		const req = bus.requests[0].payload as {
			version: number;
			requestId: string;
			method: string;
		};
		expect(req.version).toBe(1);
		expect(req.method).toBe("ping");
		expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("success:false → reject 携带 error.code/message", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.request("spawn", { agent: "x" });
		bus.replyLast({
			success: false,
			error: { code: "NOT_READY", message: "subagents 未就绪" },
		});
		await expect(pending).rejects.toThrow(/subagents 未就绪/);
		await expect(pending).rejects.toMatchObject({
			code: "NOT_READY",
			method: "spawn",
		});
	});

	it("超时 → reject 且错误标 timeout", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 20 });
		await expect(client.request("ping")).rejects.toThrow(/超时/);
	});

	it("并发 3 请求乱序回复各自拿到各自的 data", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const p1 = client.request<string>("ping");
		const p2 = client.request<string>("spawn", { agent: "a" });
		const p3 = client.request<string>("status");
		// 乱序回复：3 → 1 → 2
		const ids = bus.requests.map((r) => r.requestId);
		const reply = (requestId: string, data: string) =>
			bus.emit(`subagents:rpc:v1:reply:${requestId}`, {
				requestId,
				success: true,
				data,
			});
		reply(ids[2], "third");
		reply(ids[0], "first");
		reply(ids[1], "second");
		await expect(p1).resolves.toBe("first");
		await expect(p2).resolves.toBe("second");
		await expect(p3).resolves.toBe("third");
	});

	it("重复 reply 只结算一次（防御性）", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.request("ping");
		bus.replyLast({ success: true, data: 1 });
		// 第二次同 requestId 的 reply 不应抛"已结算"错误，也不改变结果
		expect(() => bus.replyLast({ success: true, data: 2 })).not.toThrow();
		await expect(pending).resolves.toBe(1);
	});
});

describe("SubagentsRpcClient.waitForCompletion", () => {
	it("runId 匹配的 async-complete → resolve payload", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.waitForCompletion("r-abc", 1000);
		bus.emit("subagent:async-complete", { runId: "r-other" }); // 不匹配，应被忽略
		bus.emit("subagent:async-complete", { runId: "r-abc", ok: true });
		await expect(pending).resolves.toEqual({ runId: "r-abc", ok: true });
	});

	it("runId 字段名不确定时防御性匹配 id / run.id", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const viaId = client.waitForCompletion("r-1", 1000);
		bus.emit("subagent:async-complete", { id: "r-1" });
		await expect(viaId).resolves.toEqual({ id: "r-1" });

		const viaNested = client.waitForCompletion("r-2", 1000);
		bus.emit("subagent:async-complete", { run: { id: "r-2" } });
		await expect(viaNested).resolves.toEqual({ run: { id: "r-2" } });
	});

	it("不匹配的完成事件被忽略，超时 → resolve(null)", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 20 });
		const pending = client.waitForCompletion("r-none", 20);
		bus.emit("subagent:async-complete", { runId: "r-else" });
		await expect(pending).resolves.toBeNull();
	});

	it("无 runId 参数时任何完成事件都命中", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.waitForCompletion(undefined, 1000);
		bus.emit("subagent:async-complete", { whatever: true });
		await expect(pending).resolves.toEqual({ whatever: true });
	});
});

describe("SubagentsRpcClient.spawn 的受理归一化（M3-T5 Fix round 2，e2e 实跑校准）", () => {
	it("宿主真实形态：runId 藏 details.runId → 提取到顶层，text/details 原样透传", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.spawn({ agent: "researcher", task: "按步执行" });
		// 宿主受理形态（pi-subagents async-execution.ts:2091）：顶层无 runId，
		// 藏在 details（text 首行受理头另有副本）——不归一化则多步计划被拒
		bus.replyLast({
			success: true,
			data: {
				text: "Async: researcher [r-host-1]\n\n受理 guidance 多行……",
				details: {
					mode: "single",
					runId: "r-host-1",
					asyncId: "r-host-1",
					results: [],
				},
			},
		});
		const acceptance = await pending;
		// runId 归一化到顶层（消费方 orchestrator/designer 只读这一层）
		expect(acceptance.runId).toBe("r-host-1");
		// 其余字段原样透传（浅拷贝，不 mutate 原对象）
		expect(acceptance.text).toContain("Async: researcher [r-host-1]");
		expect(acceptance.details).toMatchObject({
			mode: "single",
			runId: "r-host-1",
		});
	});

	it("details 无 runId（asyncId 形态）→ asyncId 通道提取", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.spawn({ agent: "researcher", task: "asyncId 变体" });
		bus.replyLast({
			success: true,
			data: {
				text: "Async: researcher [r-host-2]……",
				details: { mode: "single", asyncId: "r-host-2", results: [] },
			},
		});
		await expect(pending).resolves.toMatchObject({ runId: "r-host-2" });
	});

	it("details 无 runId/asyncId 但 text 有受理头 → 正则兜底提取", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.spawn({ agent: "researcher", task: "text 兜底" });
		// details 变形（无 runId/asyncId）：受理头正则从 text 首行提取
		bus.replyLast({
			success: true,
			data: {
				text: "Async: researcher [r-fb-9]\n\n(受理 guidance)",
				details: { mode: "single", results: [] },
			},
		});
		await expect(pending).resolves.toMatchObject({ runId: "r-fb-9" });
	});

	it("受理头不在 text 首行 → 正则不命中（^ 锚定收口，M3 终审 M-2 债/M4-T0）", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.spawn({
			agent: "researcher",
			task: "正文提及受理头形态",
		});
		// details 变形（无 runId/asyncId）让受理头正则成为唯一提取通道——而 "Async: …"
		// 出现在第二行（首行是前置说明）：受理头语义是 text 首行，正文中的形态不算
		bus.replyLast({
			success: true,
			data: {
				text:
					"受理 guidance 的前置说明行：\nAsync: researcher [r-not-first-line]\n（正文内容）",
				details: { mode: "single", results: [] },
			},
		});
		const acceptance = await pending;
		// 不误把正文行当受理头（未锚定时会提取 r-not-first-line——本用例即红）
		expect(acceptance.runId).toBeUndefined();
	});

	it("顶层 runId（M2 造形）保持原样——向后兼容", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.spawn({ agent: "researcher", task: "旧形状" });
		// M2 时代 fake/既有用例造的形状：顶层直给 runId——归一化不得破坏
		bus.replyLast({ success: true, data: { runId: "r-legacy-3" } });
		await expect(pending).resolves.toMatchObject({ runId: "r-legacy-3" });
	});
});

describe("listener 卫生", () => {
	it("reply 后 handler 已卸载：再 emit 不再触发", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 1000 });
		const pending = client.request("ping");
		bus.replyLast({ success: true, data: "ok" });
		await pending;
		// 该 requestId 的 reply 频道上不应残留任何 handler
		const req = bus.requests[0].payload as { requestId: string };
		const channel = bus.handlers.get(`subagents:rpc:v1:reply:${req.requestId}`);
		expect(channel === undefined || channel.size === 0).toBe(true);
	});

	it("超时后 handler 也已卸载", async () => {
		const bus = new FakeBus();
		const client = new SubagentsRpcClient(bus, { defaultTimeoutMs: 10 });
		const reqPromise = client.request("ping").catch(() => "rejected");
		await reqPromise;
		const req = bus.requests[0].payload as { requestId: string };
		const channel = bus.handlers.get(`subagents:rpc:v1:reply:${req.requestId}`);
		expect(channel === undefined || channel.size === 0).toBe(true);
	});
});
