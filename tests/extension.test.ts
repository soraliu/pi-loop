// loop_task 工具与 /loop 命令的测试（M1-T4；M2-T4 扩展真实调度双行为）
// 全部用例通过 PI_LOOP_DATA_DIR 注入临时目录——绝不触碰真实 ~/.pi/loop/。
// fake pi 对象只捕获注册的 definition/handler，直接调用以覆盖 execute 逻辑；
// 真实路径的 fake RPC 总线（受理/完成/缺席三态）经 fake pi 的 events 注入。

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PlanUpdate } from "../src/core/orchestrator.ts";
import type { SubagentEventBus } from "../src/core/rpc.ts";
import type {
  CommandContext,
  PiExtensionApi,
  ToolDefinition,
} from "../src/extension/api.ts";
import { registerLoopTools } from "../src/extension/tools.ts";
import {
  parseLoopArgs,
  registerLoopCommands,
  listRecentRuns,
  makeStepNotifier,
} from "../src/extension/commands.ts";
import {
  resolveDataDir,
  runLoopTask,
  runLoopTaskStub,
} from "../src/extension/loop-task.ts";
import type { LoopToolResult } from "../src/types.ts";

// ---------- 临时目录纪律（登记制清理，仅清理本文件创建的目录） ----------
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-ext-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- fake pi 捕获注册 ----------
interface CapturedCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: CommandContext) => void | Promise<void>;
}

function makeFakePi(events?: SubagentEventBus): {
  pi: PiExtensionApi;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CapturedCommand>;
} {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CapturedCommand>();
  const pi: PiExtensionApi = {
    registerTool: (def: ToolDefinition) => {
      tools.set(def.name, def);
      return undefined;
    },
    registerCommand: (
      name: string,
      options: { description: string; handler: CapturedCommand["handler"] },
    ) => {
      commands.set(name, {
        name,
        description: options.description,
        handler: options.handler,
      });
      return undefined;
    },
    events, // 真实路径经此注入 fake RPC 总线（对齐宿主 pi.events 的结构挂点）
  };
  return { pi, tools, commands };
}

/** 构造 CommandContext 的 notify 收集器 */
function makeNotifyCtx(): {
  ctx: CommandContext;
  messages: Array<{ text: string; level?: string }>;
} {
  const messages: Array<{ text: string; level?: string }> = [];
  return {
    ctx: {
      ui: { notify: (text, level) => void messages.push({ text, level }) },
    },
    messages,
  };
}

// ---------- 环境双开关（PI_LOOP_DATA_DIR 定盘 / PI_LOOP_STUB 切行为） ----------
function snapshotEnv(...names: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of names) saved[name] = process.env[name];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * 注入临时 dataDir + 强制双行为之一：stub=PI_LOOP_STUB=1（M1 语义）；
 * real=确保 PI_LOOP_STUB 清除（防外环境泄漏，走真实调度）。
 * 返回待恢复的环境快照（finally 里 restoreEnv）。
 */
function setLoopEnv(
  dir: string,
  mode: "stub" | "real",
): Record<string, string | undefined> {
  const saved = snapshotEnv("PI_LOOP_DATA_DIR", "PI_LOOP_STUB");
  process.env.PI_LOOP_DATA_DIR = dir;
  if (mode === "stub") process.env.PI_LOOP_STUB = "1";
  else delete process.env.PI_LOOP_STUB;
  return saved;
}

// ---------- fake RPC 总线（模拟 pi-subagents 三态：应答 / 缺席） ----------
/** async-complete 的投递延迟：晚于 waitForCompletion 的订阅（宏任务足够） */
const FAKE_COMPLETE_DELAY_MS = 5;

/** 宿主 onUpdate 回调捕获的消息形状（api.ts 契约的 content 单项） */
interface HostUpdate {
  content: Array<{ type: string; text: string }>;
}

/**
 * 自动应答的 fake 事件总线（M2-T4：经 fake pi 的 events 注入，工具/命令层两用）。
 * 时序与真实总线同构的最小仿真：spawn 请求 → 微任务内回受理 reply（含 runId）
 * → 宏任务定时器投递 async-complete（此时 waitForCompletion 必已订阅）。
 * mode="silent"：收到请求不应答（pi-subagents 缺席——只能靠客户端超时兜底）。
 */
function makeFakeSubagentsBus(
  opts: { mode?: "respond" | "silent" } = {},
): SubagentEventBus {
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  let counter = 0;
  const deliver = (event: string, payload: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  };
  return {
    emit: (event: string, payload?: unknown) => {
      if (event !== "subagents:rpc:v1:request" || opts.mode === "silent") {
        return undefined;
      }
      const req = payload as { requestId: string };
      const runId = `fake-run-${++counter}`;
      // 受理应答：微任务（in-process 即时应答）
      queueMicrotask(() =>
        deliver(`subagents:rpc:v1:reply:${req.requestId}`, {
          requestId: req.requestId,
          success: true,
          data: { runId },
        }),
      );
      // 完成事件：延迟宏任务（晚于 waitForCompletion 的订阅）
      setTimeout(
        () =>
          deliver("subagent:async-complete", {
            runId,
            status: "succeeded",
            summary: "研究结论：tokio 采用 work-stealing 调度",
            output: "/runs/fake/research-transcript.md",
          }),
        FAKE_COMPLETE_DELAY_MS,
      );
      return undefined;
    },
    on: (event: string, handler: (payload: unknown) => unknown) => {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
}

// ---------- 工具：loop_task ----------
describe("loop_task 工具", () => {
  it("注册后可被捕获且名称正确", () => {
    const { pi, tools } = makeFakePi();
    registerLoopTools(pi);
    expect(tools.has("loop_task")).toBe(true);
    expect(tools.get("loop_task")?.label).toBe("Loop Task");
  });

  it("缺 task 参数 → 错误 content 含说明（不抛裸异常）", async () => {
    const { pi, tools } = makeFakePi();
    registerLoopTools(pi);
    const def = tools.get("loop_task")!;
    const res = await def.execute(
      "t1",
      { effort: "low" },
      new AbortController().signal,
      () => {},
      {},
    );
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("task");
  });

  it("非法 effort → 错误 content 含四个合法值", async () => {
    // 隔离 dataDir：M2-T4 起该用例走真实路径的校验分支，effort 始终仅
    // 在 ensureWorkspace 之后报错——不注入临时目录会写真实 ~/.pi/loop/（M1 遗留窗口）
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const { pi, tools } = makeFakePi();
      registerLoopTools(pi);
      const def = tools.get("loop_task")!;
      const res = await def.execute(
        "t2",
        { task: "研究 X", effort: "turbo" },
        new AbortController().signal,
        () => {},
        {},
      );
      expect(res.content[0].text).toContain("low");
      expect(res.content[0].text).toContain("medium");
      expect(res.content[0].text).toContain("high");
      expect(res.content[0].text).toContain("max");
      expect((res.details as { error?: string }).error).toBeDefined();
    } finally {
      restoreEnv(saved);
    }
  });

  it("合法调用（PI_LOOP_STUB=1）→ stub 结果 + run.json 落盘（M1 语义回归）", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "stub");
    try {
      const { pi, tools } = makeFakePi();
      registerLoopTools(pi);
      const def = tools.get("loop_task")!;
      const res = await def.execute(
        "t3",
        { task: "研究 rust tokio 调度器", effort: "high" },
        new AbortController().signal,
        () => {},
        {},
      );
      // 返回结构
      expect(res.content[0].text).toContain("stub");
      const details = res.details as { runId: string; status: string };
      expect(details.status).toBe("stub");
      expect(details.runId).toMatch(/^r-/);
      // 磁盘一致性
      const runFile = path.join(tmp, "runs", details.runId, "run.json");
      expect(fs.existsSync(runFile)).toBe(true);
      const record = JSON.parse(fs.readFileSync(runFile, "utf-8")) as {
        effort: string;
        task: string;
      };
      expect(record.effort).toBe("high");
      expect(record.task).toBe("研究 rust tokio 调度器");
    } finally {
      restoreEnv(saved);
    }
  });
});

// ---------- 共享核心：runLoopTaskStub / resolveDataDir ----------
describe("runLoopTaskStub 共享核心", () => {
  it("resolveDataDir 优先读 PI_LOOP_DATA_DIR", () => {
    const prev = process.env.PI_LOOP_DATA_DIR;
    try {
      process.env.PI_LOOP_DATA_DIR = "/tmp/loop-x";
      expect(resolveDataDir()).toBe("/tmp/loop-x");
      delete process.env.PI_LOOP_DATA_DIR;
      expect(resolveDataDir()).not.toContain("loop-x");
      expect(resolveDataDir()).toMatch(/\.pi[\\/]loop$/);
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });

  it("缺省 effort 回落 medium 预设", () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
    try {
      // runLoopTaskStub 必然落盘，注入临时目录保护真实 ~/.pi/loop/
      const result = runLoopTaskStub({ task: "无 effort 任务" });
      expect(result.effort).toBe("medium");
      expect(result.preset.maxResultIterations).toBe(2);
      expect(
        fs.existsSync(path.join(tmp, "runs", result.runId, "run.json")),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });

  it("task 空白 → 抛 TypeError", () => {
    expect(() => runLoopTaskStub({ task: "   " })).toThrow(TypeError);
  });

  it("settings.json 覆盖档位 → preset 快照反映覆盖值（loadLoopSettings 生效链）", () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
    try {
      // 写入覆盖 medium 档的 settings.json（应生效而非回落 DEFAULT 表）
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "settings.json"),
        JSON.stringify({
          effortPresets: { medium: { maxResultIterations: 7 } },
        }),
      );
      const result = runLoopTaskStub({ task: "覆盖验证" }); // 缺省 effort=medium
      expect(result.effort).toBe("medium");
      // I1 核心断言：快照来自生效表而非 DEFAULT（DEFAULT.medium.maxResultIterations = 2）
      expect(result.preset.maxResultIterations).toBe(7);
      // 未覆盖字段保持默认深合并值
      expect(result.preset.maxParallelSubagents).toBe(4);
      // run.json 同盘，磁盘与返回一致
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf8",
        ),
      ) as { effort: string };
      expect(record.effort).toBe("medium");
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });
});

// ---------- 命令：/loop 解析与执行 ----------
describe("parseLoopArgs", () => {
  it('--effort max --verify "npm test" 解析正确', () => {
    const parsed = parseLoopArgs('研究 X --effort max --verify "npm test"');
    expect(parsed.error).toBeUndefined();
    expect(parsed.task).toBe("研究 X");
    expect(parsed.effort).toBe("max");
    expect(parsed.verifyCommand).toBe("npm test");
  });

  it("不传 effort → 无 effort 字段（由核心回落 medium）", () => {
    const parsed = parseLoopArgs("随便做点什么");
    expect(parsed.error).toBeUndefined();
    expect(parsed.task).toBe("随便做点什么");
    expect(parsed.effort).toBeUndefined();
  });

  it("--context 可多次出现", () => {
    const parsed = parseLoopArgs("任务 --context ./a.md --context ./b.md");
    expect(parsed.contextPaths).toEqual(["./a.md", "./b.md"]);
  });

  it("非法 effort → error 含合法值", () => {
    const parsed = parseLoopArgs("任务 --effort turbo");
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("low");
  });

  it("纯旗标无任务 → error 提示用法", () => {
    const parsed = parseLoopArgs("--effort high");
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("任务描述");
  });
});

describe("/loop 命令 handler", () => {
  it("执行后 notify 含 runId 且 run.json 落盘（PI_LOOP_STUB=1 stub 语义）", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "stub");
    try {
      const { pi, commands } = makeFakePi();
      registerLoopCommands(pi);
      const cmd = commands.get("loop")!;
      const { ctx, messages } = makeNotifyCtx();
      await cmd.handler("通过命令启动的任务 --effort low", ctx);
      expect(messages).toHaveLength(1);
      expect(messages[0].level).toBe("info");
      expect(messages[0].text).toMatch(/r-[a-z0-9-]+/);
      expect(messages[0].text).toContain("M2");
      // 磁盘核验：runs 目录下确有对应记录
      const runs = listRecentRuns(tmp);
      expect(runs).toHaveLength(1);
      expect(runs[0].effort).toBe("low");
    } finally {
      restoreEnv(saved);
    }
  });

  it("参数错误 → error notify，不落盘", async () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
    try {
      const { pi, commands } = makeFakePi();
      registerLoopCommands(pi);
      const cmd = commands.get("loop")!;
      const { ctx, messages } = makeNotifyCtx();
      await cmd.handler("--effort turbo 没有任务", ctx);
      expect(messages[0].level).toBe("error");
      expect(listRecentRuns(tmp)).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });
});

describe("/loop-status、/loop-cases、/loop-methods", () => {
  it("loop-status 显示最近 run（含 id 与状态）", async () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
    try {
      runLoopTaskStub({ task: "先跑一次以便列表有内容" });
      const { pi, commands } = makeFakePi();
      registerLoopCommands(pi);
      const { ctx, messages } = makeNotifyCtx();
      await commands.get("loop-status")!.handler("", ctx);
      expect(messages[0].text).toContain("[created]");
      expect(messages[0].text).toContain("r-");
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });

  it("空目录时 loop-status 提示尚无记录", async () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
    try {
      const { pi, commands } = makeFakePi();
      registerLoopCommands(pi);
      const { ctx, messages } = makeNotifyCtx();
      await commands.get("loop-status")!.handler("", ctx);
      expect(messages[0].text).toContain("尚无");
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });

  it("loop-cases / loop-methods 显示目录统计", async () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
    try {
      // 预置工作区（countFiles 只统计文件，不统计目录）
      fs.mkdirSync(path.join(tmp, "cases"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "cases", "case-1.json"), "{}\n");
      fs.mkdirSync(path.join(tmp, "methods"), { recursive: true });
      const { pi, commands } = makeFakePi();
      registerLoopCommands(pi);
      const { ctx, messages } = makeNotifyCtx();
      await commands.get("loop-cases")!.handler("", ctx);
      await commands.get("loop-methods")!.handler("", ctx);
      expect(messages[0].text).toContain("1 个文件");
      expect(messages[1].text).toContain("0 个文件");
    } finally {
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
    }
  });
});

// ---------- M2-T4：runLoopTask 真实调度（双行为对照） ----------
describe("runLoopTask 真实路径", () => {
  it("fake 总线完成研究：completed、遥测/迭代数落真值、run.json 终态一致", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const updates: PlanUpdate[] = [];
      const result = await runLoopTask(
        { task: "研究 tokio 调度器内幕" },
        { busEnv: makeFakeSubagentsBus(), onUpdate: (u) => updates.push(u) },
      );
      // LoopToolResult 真值（status / 遥测 / 迭代数 / preset 快照 / runId）
      expect(result.status).toBe("completed");
      expect(result.runId).toMatch(/^r-/);
      expect(result.effort).toBe("medium");
      expect(result.preset).toMatchObject({
        maxResultIterations: 2,
        maxParallelSubagents: 4,
      });
      expect(result.telemetry).toEqual({
        steps: 1,
        succeeded: 1,
        failed: 0,
        iterations: 1,
        durationMs: expect.any(Number),
      });
      expect(result.error).toBeUndefined();
      expect(result.summary).toContain("1/1");
      // onUpdate 管线：受理 running → 完成 succeeded（完成摘要透传）
      expect(updates.map((u) => `${u.stepId}:${u.status}`)).toEqual([
        "research:running",
        "research:succeeded",
      ]);
      expect(updates[1]?.summary).toContain("tokio");
      // run.json 终态（与列表视图一致）
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        iterations: Array<Record<string, unknown>>;
      };
      expect(record.status).toBe("completed");
      expect(record.iterations).toHaveLength(1);
      expect(record.iterations[0]).toMatchObject({
        stepId: "research",
        agent: "researcher",
        status: "succeeded",
        outputRef: "/runs/fake/research-transcript.md",
      });
    } finally {
      restoreEnv(saved);
    }
  });

  it("PI_LOOP_STUB=1 → runLoopTask 回归 M1 stub 语义（双行为）", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "stub");
    try {
      const result = await runLoopTask({ task: "stub 回归任务" });
      expect(result.status).toBe("stub");
      expect(result.telemetry).toEqual({
        steps: 0,
        succeeded: 0,
        failed: 0,
        iterations: 0,
        durationMs: 0,
      });
      expect(result.summary).toContain("stub");
      expect(
        fs.existsSync(path.join(tmp, "runs", result.runId, "run.json")),
      ).toBe(true);
    } finally {
      restoreEnv(saved);
    }
  });

  it("总线无应答（fake 超时）→ failed + 安装引导 + run.json failed", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const result = await runLoopTask(
        { task: "缺席场景" },
        {
          busEnv: makeFakeSubagentsBus({ mode: "silent" }),
          rpcTimeoutMs: 25, // 缩短受理等待：快速走完超时兜底
        },
      );
      expect(result.status).toBe("failed");
      expect(result.error).toContain("请安装 pi-subagents");
      expect(result.error).toContain("pi install npm:pi-subagents");
      expect(result.telemetry).toMatchObject({
        steps: 1,
        succeeded: 0,
        failed: 1,
        iterations: 1,
      });
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        iterations: Array<{ error?: string }>;
      };
      expect(record.status).toBe("failed");
      expect(record.iterations[0]?.error).toContain("请安装 pi-subagents");
    } finally {
      restoreEnv(saved);
    }
  });

  it("预中止（signal 已 abort）→ failed、error=aborted、run.json 留 run 级 aborted 落痕", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const controller = new AbortController();
      controller.abort(); // 先中止再启动：层间检查点短路，不产生任何 entry
      const result = await runLoopTask(
        { task: "预中止任务" },
        { busEnv: makeFakeSubagentsBus(), signal: controller.signal },
      );
      expect(result.status).toBe("failed");
      expect(result.error).toBe("aborted");
      expect(result.telemetry).toMatchObject({
        steps: 1,
        succeeded: 0,
        failed: 0,
        iterations: 0,
      });
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as { status: string; error?: string };
      expect(record.status).toBe("failed");
      expect(record.error).toBe("aborted"); // T3 review M1 收口：run 级 abort 落痕
    } finally {
      restoreEnv(saved);
    }
  });
});

// ---------- M2-T4：loop_task 工具真实路径（fake 总线经 pi.events 注入） ----------
describe("loop_task 工具 — 真实调度", () => {
  it("execute 全链：completed、onUpdate 分段投递、details 落真值", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const { pi, tools } = makeFakePi(makeFakeSubagentsBus());
      registerLoopTools(pi);
      const def = tools.get("loop_task")!;
      const hostUpdates: HostUpdate[] = [];
      const res = await def.execute(
        "t-real",
        { task: "研究 rust 生态的测试策略", effort: "high" },
        new AbortController().signal,
        (update) => hostUpdates.push(update),
        {},
      );
      const details = res.details as LoopToolResult;
      expect(details.status).toBe("completed");
      expect(details.effort).toBe("high");
      expect(details.telemetry).toMatchObject({
        steps: 1,
        succeeded: 1,
        iterations: 1,
      });
      // 工具文本面：真值序列化进 content（status/遥测可见）
      expect(res.content[0].text).toContain('"completed"');
      expect(res.content[0].text).toContain('"telemetry"');
      // 宿主 onUpdate：两段进度（running → succeeded），文案含步骤与状态
      expect(hostUpdates).toHaveLength(2);
      expect(hostUpdates[0].content[0]?.text).toContain("research");
      expect(hostUpdates[0].content[0]?.text).toContain("开始执行");
      expect(hostUpdates[1].content[0]?.text).toContain("执行完成");
      // run.json 终态
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", details.runId, "run.json"),
          "utf-8",
        ),
      ) as { status: string };
      expect(record.status).toBe("completed");
    } finally {
      restoreEnv(saved);
    }
  });

  it("onUpdate 缺席（宿主未传）→ 工具照常完成（进度内部吞掉）", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const { pi, tools } = makeFakePi(makeFakeSubagentsBus());
      registerLoopTools(pi);
      const def = tools.get("loop_task")!;
      const res = await def.execute(
        "t-noupdate",
        { task: "无进度回调的调用" },
        new AbortController().signal,
        undefined,
        {},
      );
      expect((res.details as LoopToolResult).status).toBe("completed");
    } finally {
      restoreEnv(saved);
    }
  });
});

// ---------- M2-T4：/loop 命令真实路径与进度节流 ----------
describe("/loop 命令 — 真实调度与进度节流", () => {
  it("真实路径（fake 总线经 pi.events 注入）→ 每步一条进度 + 完成摘要", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const { pi, commands } = makeFakePi(makeFakeSubagentsBus());
      registerLoopCommands(pi);
      const { ctx, messages } = makeNotifyCtx();
      await commands.get("loop")!.handler("研究 X --effort low", ctx);
      // 单步计划：1 条进度（research 开始）+ 1 条完成摘要——每步一条的命令下限
      expect(messages).toHaveLength(2);
      expect(messages[0].level).toBe("info");
      expect(messages[0].text).toContain("research");
      expect(messages[0].text).toContain("[loop]");
      expect(messages[1].text).toMatch(/r-[a-z0-9-]+/);
      expect(messages[1].text).toContain("1/1");
      const runs = listRecentRuns(tmp);
      expect(runs).toHaveLength(1);
      expect(runs[0].effort).toBe("low");
      expect(runs[0].status).toBe("completed");
    } finally {
      restoreEnv(saved);
    }
  });

  it("节流器：3 步 onUpdate（每步 running+succeeded+迟到重复）→ notify 恰好 3 条", () => {
    const messages: Array<{ text: string; level?: string }> = [];
    const notify = makeStepNotifier((text, level) =>
      messages.push({ text, level }),
    );
    // 3 步、每步两段（running → succeeded 带摘要），外加一步迟到的重复更新
    for (const stepId of ["research", "verify", "critic"]) {
      notify({ stepId, agent: "researcher", status: "running" });
      notify({
        stepId,
        agent: "researcher",
        status: "succeeded",
        summary: "结论",
      });
    }
    notify({ stepId: "research", agent: "researcher", status: "succeeded" });
    // 按步去重：恰好 3 条、各对应一个 stepId（首条胜出）
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.text)).toEqual([
      expect.stringContaining("research"),
      expect.stringContaining("verify"),
      expect.stringContaining("critic"),
    ]);
    expect(messages.every((m) => m.level === "info")).toBe(true);
    // 失败步的首条更新走 error 级
    makeStepNotifier((text, level) => messages.push({ text, level }))({
      stepId: "dead",
      agent: "critic",
      status: "failed",
    });
    expect(messages).toHaveLength(4);
    expect(messages[3].level).toBe("error");
  });
});
