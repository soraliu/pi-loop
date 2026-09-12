// pi-loop 内核共享常量与竞速工具（M4-T0 新建，M3 终审 M-5 债收口）
// 此前 designer.ts 与 orchestrator.ts 在 M3 并行期各自本地固化了同口径的
// 10 分钟完成等待 / 10 秒 stop 收尾 / abortWatch 竞速哨兵（有意隔离，漂移由测试
// 的 timeoutMs 断言锁定）；M4 起收敛为单一真源——常量值与函数行为逐字保持
// （只是搬家），两文件的既有 timeoutMs 断言零回归。
// 依据 docs/plans/m4-evaluator.md（M-5：常量收敛为 src/core/consts.ts 单一真源）。

/** 单次在途 run 的完成等待上限：真实研究 agent 可跑数分钟，取保守宽裕值（10 分钟；M2 固定口径，M4 再与 effort 档位挂钩） */
export const COMPLETION_TIMEOUT_MS = 10 * 60_000;

/** abort 收尾时 stop 的等待上界：超时即放弃确认（不阻断失败/降级收尾） */
export const STOP_TIMEOUT_MS = 10_000;

/** abort 竞速哨兵：完成 payload 是对象或 null，Symbol 保证不与之混淆（两消费方共享同一 symbol，identity 比较的单一真源） */
export const ABORTED = Symbol("pi-loop:aborted");

/**
 * signal → 一次性 settle 的"已中止"哨兵 promise（与完成/超时等待 Promise.race 竞速）。
 * 无状态可共享：每次调用创建独立的 promise 与 listener，无任何跨调用可变状态——
 * 此前 designer/orchestrator 两份实现逐字等值（仅 Symbol 描述串与注释差异），故合并。
 */
export function createAbortWatch(signal?: AbortSignal): {
	promise: Promise<typeof ABORTED>;
	dispose: () => void;
} {
	let resolveAbort!: (value: typeof ABORTED) => void;
	const promise = new Promise<typeof ABORTED>((resolve) => {
		resolveAbort = resolve;
	});
	const onAbort = (): void => resolveAbort(ABORTED);
	if (signal?.aborted) onAbort(); // 已中止：立即 settle（调用方各检查点之外的最后兜底）
	signal?.addEventListener("abort", onAbort, { once: true });
	return {
		promise,
		dispose: () => signal?.removeEventListener("abort", onAbort),
	};
}
