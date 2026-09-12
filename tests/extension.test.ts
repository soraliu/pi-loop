// loop_task 工具与 /loop 命令的测试（M1-T4；M2-T4 扩展真实调度双行为）
// 全部用例通过 PI_LOOP_DATA_DIR 注入临时目录——绝不触碰真实 ~/.pi/loop/。
// fake pi 对象只捕获注册的 definition/handler，直接调用以覆盖 execute 逻辑；
// 真实路径的 fake RPC 总线（受理/完成/缺席三态）经 fake pi 的 events 注入。

import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PlanUpdate, RunOutcome } from "../src/core/orchestrator.ts";
import type { RoundEvent } from "../src/core/iterate.ts";
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

// ---------- executePlan 的 budget 注入捕获（M3-T5：M-1 收口）与返回形注入（M4-T0） ----------
// vi.mock 对整个文件生效：wrapper 透传实际实现（既有用例零影响），只旁路记录
// runLoopTask → executePlan 的 ctx.budget——T4 报告申报的捕获型断言在此兑现；
// M4-T0 另增 outcomeOverrides 返回形注入队列（预算拒绝形态的 tool 层枚举映射用例）。
// vi.mock 工厂会被提升到文件顶部，引用的变量必须经 vi.hoisted 同样提升
const budgetCaptures = vi.hoisted(
  () =>
    [] as Array<
      { maxPlanSteps: number; maxParallelSubagents: number } | undefined
    >,
);
/** executePlan 的返回形注入队列（非空时按序消费其一，绕过真实调度；空则透传真实现） */
const outcomeOverrides = vi.hoisted(() => [] as RunOutcome[]);
vi.mock("../src/core/orchestrator.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/core/orchestrator.ts")>();
  return {
    ...actual,
    executePlan: (
      plan: Parameters<typeof actual.executePlan>[0],
      ctx: Parameters<typeof actual.executePlan>[1],
    ) => {
      budgetCaptures.push(ctx.budget);
      const override = outcomeOverrides.shift();
      if (override !== undefined) return Promise.resolve(override);
      return actual.executePlan(plan, ctx);
    },
  };
});

// ---------- generatePlan 的异常注入（M4-T0：run.json 悬留收口用例） ----------
// 缺省透传真实现（既有用例零影响）；designerFailures 非空时按序消费其一作为
// generatePlan 的拒绝原因——真实实现的降级路径不抛业务异常，此处模拟 fs 类基建故障
const designerFailures = vi.hoisted(() => [] as Error[]);
vi.mock("../src/core/designer.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/core/designer.ts")>();
  return {
    ...actual,
    generatePlan: (...args: Parameters<typeof actual.generatePlan>) => {
      const failure = designerFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      return actual.generatePlan(...args);
    },
  };
});

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

/** critic 完成回复的缺省形态：verified 围栏（迭代闭环的正常通关机器） */
function fencedEvaluationResult(evaluation: Record<string, unknown>): string {
  return `评审小结：过程略。\n\`\`\`json\n${JSON.stringify(evaluation)}\n\`\`\`\n`;
}

/** 缺省 critic 评估结论（verified——单轮通关的既有用例语义保持） */
const DEFAULT_CRITIC_REPLY = fencedEvaluationResult({
  verdict: "verified",
  score: 92,
  reasons: ["覆盖全部验收标准"],
  blame: [],
});

/**
 * 自动应答的 fake 事件总线（M2-T4：经 fake pi 的 events 注入，工具/命令层两用；
 * M4-T2：critic spawn 分诊 + 任务文本台账）。
 * 时序与真实总线同构的最小仿真：spawn 请求 → 微任务内回受理 reply（含 runId）
 * → 宏任务定时器投递 async-complete（此时 waitForCompletion 必已订阅）。
 * 任务文本分诊（M4-T2 迭代闭环的评估输入）：designer 契约行 / critic 评审提示词 /
 * 其余=计划步骤；critic spawn 的完成回复带围栏评估结论（criticReply 可脚本化轮次）。
 * mode="silent"：收到请求不应答（pi-subagents 缺席——只能靠客户端超时兜底）。
 */
function makeFakeSubagentsBus(
  opts: {
    mode?: "respond" | "silent";
    /** 完成事件投递前按 spawn 的任务文本同步回调（M3-T5：designer 成功通道——模拟
     * designer agent 先写 designer-plan.json 再完成，与真实时序同构） */
    preComplete?: (task: string) => void;
    /** critic 完成回复脚本（缺省 verified 围栏；函数形按 critic 调用序取 0 起计的轮次） */
    criticReply?: string | ((criticCallIndex: number) => string);
  } = {},
): SubagentEventBus & { spawnedTasks: string[] } {
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  const spawnedTasks: string[] = [];
  let counter = 0;
  let criticCalls = 0;
  const deliver = (event: string, payload: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  };
  const bus: SubagentEventBus & { spawnedTasks: string[] } = {
    emit: (event, payload?: unknown) => {
      if (event !== "subagents:rpc:v1:request" || opts.mode === "silent") {
        return undefined;
      }
      const req = payload as {
        requestId: string;
        params?: { task?: string };
      };
      const task = req.params?.task ?? "";
      spawnedTasks.push(task);
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
      setTimeout(() => {
        // preComplete 先于完成事件同步执行——产物文件对 extractPlan 先可见
        opts.preComplete?.(task);
        if (task.includes("研究任务评审员")) {
          // critic 完成：围栏评估结论（迭代闭环的评估输入）
          const reply =
            typeof opts.criticReply === "function"
              ? opts.criticReply(criticCalls++)
              : (opts.criticReply ?? DEFAULT_CRITIC_REPLY);
          deliver("subagent:async-complete", {
            runId,
            status: "succeeded",
            output: reply,
          });
          return;
        }
        deliver("subagent:async-complete", {
          runId,
          status: "succeeded",
          summary: "研究结论：tokio 采用 work-stealing 调度",
          output: "/runs/fake/research-transcript.md",
        });
      }, FAKE_COMPLETE_DELAY_MS);
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
    spawnedTasks,
  };
  return bus;
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
    // M2-T5 收口：校验类 TypeError → 参数错误前缀（与执行链异常区分）
    expect(res.content[0].text).toContain("参数错误");
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
      // M2-T5 收口：非法 effort 同为校验类 TypeError → 参数错误前缀
      expect(res.content[0].text).toContain("参数错误");
      expect((res.details as { error?: string }).error).toBeDefined();
    } finally {
      restoreEnv(saved);
    }
  });

  it("执行链异常（非 TypeError）→ 前缀'执行出错'（与参数错误区分）", async () => {
    // dataDir 指向普通文件：ensureWorkspace 的 mkdir 抛 ENOTDIR（Error 而非
    // TypeError）——走 catch 的执行链分支而非参数分支，锁定前缀区分的另一半
    const tmp = makeTempDir();
    const notDir = path.join(tmp, "occupied");
    fs.writeFileSync(notDir, "x");
    const saved = setLoopEnv(notDir, "real");
    try {
      const { pi, tools } = makeFakePi();
      registerLoopTools(pi);
      const def = tools.get("loop_task")!;
      const res = await def.execute(
        "t-exec-err",
        { task: "参数合法但执行链异常的任务" },
        new AbortController().signal,
        () => {},
        {},
      );
      expect(res.content[0].text).toContain("loop_task 执行出错");
      expect(res.content[0].text).not.toContain("参数错误");
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
  it("fake 总线完成研究：completed、遥测/迭代数落真值、run.json 终态一致（critic verified 一轮通关）", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      // M4-T2：onUpdate 联合事件分采（步骤事件 + 轮次事件）
      const stepUpdates: PlanUpdate[] = [];
      const roundEvents: RoundEvent[] = [];
      const result = await runLoopTask(
        { task: "研究 tokio 调度器内幕" },
        {
          busEnv: makeFakeSubagentsBus(),
          onUpdate: (u) => {
            if ("kind" in u) roundEvents.push(u);
            else stepUpdates.push(u);
          },
        },
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
      // M4-T2：evaluation 摘要（verdict/score/round——首轮通关）
      expect(result.evaluation).toEqual({
        verdict: "verified",
        score: 92,
        round: 0,
      });
      // onUpdate 管线：步骰受理 running → 完成 succeeded（完成摘要透传）
      expect(stepUpdates.map((u) => `${u.stepId}:${u.status}`)).toEqual([
        "research:running",
        "research:succeeded",
      ]);
      expect(stepUpdates[1]?.summary).toContain("tokio");
      // 轮次事件：start → end(done)（一轮通关无 retry）
      expect(roundEvents.map((e) => `${e.phase}:${String(e.next)}`)).toEqual([
        "start:undefined",
        "end:done",
      ]);
      // M3-T4 接线：通用 fake 应答无产物文件/围栏 → designer 3 次校验尝试耗尽后降级
      // builtin 照跑（M2 等价链路，M4-T2 起进迭代循环）；LoopToolResult.plan 如实带
      // origin/steps/degraded（降级禁止冒充正常生成）
      expect(result.plan).toEqual({
        origin: "builtin",
        steps: 1,
        degraded: true,
      });
      // run.json 终态（与列表视图一致；plan 全量元信息入档——origin/steps/notes/
      // degraded/channel/attempts + M4-T2 的 round/evaluation/final）
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        round?: number;
        final?: { round: number; verdict: string; score: number };
        plan?: {
          origin: string;
          steps: number;
          notes?: string;
          degraded?: boolean;
          channel?: string;
          attempts?: number;
        };
        iterations: Array<Record<string, unknown>>;
      };
      expect(record.plan).toMatchObject({
        origin: "builtin",
        steps: 1,
        degraded: true,
        channel: "builtin",
        attempts: 3,
      });
      expect(record.plan?.notes).toContain(
        "designer 降级：连续 3 次尝试均未通过校验",
      );
      expect(record.status).toBe("completed");
      expect(record.round).toBe(0);
      expect(record.final).toEqual({
        round: 0,
        verdict: "verified",
        score: 92,
      });
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

  it("总线无应答（fake 超时）→ 迭代烧尽预算后 budget_exhausted + 安装引导（M4-T2：critic 通道失败也如实走完迭代预算）", async () => {
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
      // medium 档（maxResultIterations=2）→ 3 轮均无评估通过 → 预算尽如实枚举
      expect(result.status).toBe("budget_exhausted");
      expect(result.error).toContain("budget_exhausted: 迭代轮数上限 2 轮用尽");
      // 错误优先级：pi-subagents 缺席标记 → 安装引导与运行级文案并列（M2 语义延续）
      expect(result.error).toContain("请安装 pi-subagents");
      expect(result.error).toContain("pi install npm:pi-subagents");
      // 遥测口径：steps/succeeded/failed 按末轮分轮切片，iterations 报累计（3 轮 × 1 步）
      expect(result.telemetry).toMatchObject({
        steps: 1,
        succeeded: 0,
        failed: 1,
        iterations: 3,
      });
      // 评估结论摘要：末轮 critic spawn 失败的 fail 留档
      expect(result.evaluation).toMatchObject({
        verdict: "fail",
        score: 0,
        round: 2,
      });
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        error?: string;
        final?: { round: number; verdict: string; score: number };
        iterations: Array<{ error?: string; round?: number }>;
      };
      expect(record.status).toBe("failed");
      expect(record.error).toContain("budget_exhausted:");
      // 最后 evaluation 留档（末轮 critic spawn 失败的 fail 结论不丢）
      expect(record.final).toEqual({ round: 2, verdict: "fail", score: 0 });
      expect(record.iterations[0]?.error).toContain("请安装 pi-subagents");
      // 3 轮各 1 步：round 标注分轮归组
      expect(record.iterations.map((e) => e.round)).toEqual([0, 1, 2]);
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
      // 工具文本面：真值序列化进 content（status/遥测/计划摘要可见）
      expect(res.content[0].text).toContain('"completed"');
      expect(res.content[0].text).toContain('"telemetry"');
      // M3-T4：计划摘要进工具可见文本（designer 降级路径 → origin=builtin/degraded）
      expect(res.content[0].text).toContain('"plan"');
      expect(res.content[0].text).toContain('"builtin"');
      // 宿主 onUpdate：四段进度（轮次 start → running → succeeded → 轮次 end）
      expect(hostUpdates).toHaveLength(4);
      expect(hostUpdates[0].content[0]?.text).toContain("第 1 轮迭代开始");
      expect(hostUpdates[1].content[0]?.text).toContain("research");
      expect(hostUpdates[1].content[0]?.text).toContain("开始执行");
      expect(hostUpdates[2].content[0]?.text).toContain("执行完成");
      expect(hostUpdates[3].content[0]?.text).toContain(
        "第 1 轮迭代结束：验收通过",
      );
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
  it("真实路径（fake 总线经 pi.events 注入）→ 轮次首尾 + 开始 + 每步终态 + 完成摘要", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      const { pi, commands } = makeFakePi(makeFakeSubagentsBus());
      registerLoopCommands(pi);
      const { ctx, messages } = makeNotifyCtx();
      await commands.get("loop")!.handler("研究 X --effort low", ctx);
      // 单轮通关：轮次 start + 步骰开始 + 步骰终态 + 轮次 end + 完成摘要 = 5 条
      expect(messages).toHaveLength(5);
      expect(messages[0].level).toBe("info");
      expect(messages[0].text).toContain("[loop]");
      expect(messages[0].text).toContain("第 1 轮迭代开始");
      expect(messages[1].level).toBe("info");
      expect(messages[1].text).toContain("research");
      expect(messages[1].text).toContain("[loop]");
      expect(messages[1].text).toContain("开始执行");
      expect(messages[2].level).toBe("info");
      expect(messages[2].text).toContain("research");
      expect(messages[2].text).toContain("执行完成");
      expect(messages[3].level).toBe("info");
      expect(messages[3].text).toContain("第 1 轮迭代结束");
      expect(messages[3].text).toContain("验收通过");
      expect(messages[4].text).toMatch(/r-[a-z0-9-]+/);
      expect(messages[4].text).toContain("1/1");
      const runs = listRecentRuns(tmp);
      expect(runs).toHaveLength(1);
      expect(runs[0].effort).toBe("low");
      expect(runs[0].status).toBe("completed");
    } finally {
      restoreEnv(saved);
    }
  });

  it("节流器（新语义）：3 步含 1 失败 → 1 条开始 + 3 条终态，迟到重复终态去重", () => {
    const messages: Array<{ text: string; level?: string }> = [];
    const notify = makeStepNotifier((text, level) =>
      messages.push({ text, level }),
    );
    // 3 步先到达各自 running（开始信号只发首条，其余并入），再到达终态（critic 失败）
    for (const stepId of ["research", "verify", "critic"]) {
      notify({ stepId, agent: "researcher", status: "running" });
    }
    notify({
      stepId: "research",
      agent: "researcher",
      status: "succeeded",
      summary: "结论",
    });
    notify({ stepId: "verify", agent: "researcher", status: "succeeded" });
    notify({ stepId: "critic", agent: "researcher", status: "failed" });
    // 迟到的重复终态（同 stepId 同终态）：去重吞掉——不产生第 5 条
    notify({ stepId: "critic", agent: "researcher", status: "failed" });
    notify({ stepId: "research", agent: "researcher", status: "succeeded" });
    // 目标语义：notify 数 = 开始条数(1) + 终态条数(3) = 4
    expect(messages).toHaveLength(4);
    expect(messages[0].text).toContain("research");
    expect(messages[0].text).toContain("开始执行");
    expect(messages[0].level).toBe("info");
    expect(messages[1].text).toContain("research");
    expect(messages[1].text).toContain("执行完成");
    expect(messages[1].level).toBe("info");
    expect(messages[2].text).toContain("verify");
    expect(messages[2].text).toContain("执行完成");
    expect(messages[2].level).toBe("info");
    expect(messages[3].text).toContain("critic");
    expect(messages[3].text).toContain("执行失败");
    expect(messages[3].level).toBe("error");
  });

  it("节流器的轮次事件（M4-T2）：每轮首尾各一条，轮边界重置节流——新一轮里同 stepId 的终态重新可见", () => {
    const messages: Array<{ text: string; level?: string }> = [];
    const notify = makeStepNotifier((text, level) =>
      messages.push({ text, level }),
    );
    // 首轮：开始 1 条 + 步骰终态 1 条
    notify({ stepId: "a", agent: "researcher", status: "running" });
    notify({ stepId: "a", agent: "researcher", status: "failed" });
    // 轮终了（未通过 → warning）+ 新一轮开始（重置节流状态）
    notify({
      kind: "round",
      round: 0,
      phase: "end",
      verdict: "fail",
      score: 10,
      next: "retry",
    });
    notify({ kind: "round", round: 1, phase: "start" });
    // 新一轮里同 stepId 的同名终态不能再被去重吞掉（多轮重跑不吞进度）
    notify({ stepId: "a", agent: "researcher", status: "failed" });
    expect(messages).toHaveLength(5);
    expect(messages[0].text).toContain("开始执行");
    expect(messages[1].text).toContain("执行失败");
    expect(messages[2].text).toContain("第 1 轮迭代结束");
    expect(messages[2].text).toContain("注入归因重跑");
    expect(messages[2].level).toBe("warning");
    expect(messages[3].text).toContain("第 2 轮迭代开始");
    expect(messages[3].level).toBe("info");
    expect(messages[4].text).toContain("执行失败");
    expect(messages[4].level).toBe("error");
  });
});

// ---------- M3-T5：designer 成功通道全链 + budget 注入捕获（I-2 / M-1 遗留收口） ----------
describe("runLoopTask — designer 成功通道（M3-T5）", () => {
  it("designer 写出 designer-plan.json（fake 总线 preComplete）→ 全链 origin=designer 两步执行 + executePlan 收到 preset 派生的 budget", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      // 两步计划（survey → synth 依赖链）：产物步数与 RunRecord.plan.steps 的对账
      // 来源——I-2 断言「plan.steps === 文件中的步数」
      const designerPlan = {
        version: 1,
        task: "研究 scheduler 设计空间并给出结论",
        origin: "designer" as const,
        notes: "两步走：先摸底再综合",
        steps: [
          {
            id: "survey",
            agent: "researcher",
            task: "摸底主流并发 scheduler 的设计模型",
            dependsOn: [],
          },
          {
            id: "synth",
            agent: "researcher",
            task: "综合上下游结论并给出最终对比",
            dependsOn: ["survey"],
          },
        ],
      };
      let designerTaskText = "";
      const bus = makeFakeSubagentsBus({
        preComplete: (task) => {
          // 只有 designer 的 spawn 任务含输出契约行（内嵌产物绝对路径——run id 运行时
          // 才产生，从任务文本提取）；步骤 spawn 的任务文本不含该行，回调空转
          const match = /把最终 ResearchPlan 的完整 JSON 写入文件：(\S+)/.exec(
            task,
          );
          if (!match) return;
          designerTaskText = task;
          const planFile = match[1];
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, JSON.stringify(designerPlan));
        },
      });
      const capturesBefore = budgetCaptures.length;
      const result = await runLoopTask(
        { task: "研究 scheduler 设计空间并给出结论" },
        { busEnv: bus },
      );
      // 全链返回：completed + LoopToolResult.plan 的 designer 摘要（未降级）
      expect(result.status).toBe("completed");
      expect(result.error).toBeUndefined();
      expect(result.telemetry).toMatchObject({
        steps: 2,
        succeeded: 2,
        failed: 0,
        iterations: 2,
      });
      expect(result.plan).toEqual({
        origin: "designer",
        steps: 2,
        degraded: false,
      });
      // run.json：plan 全量元信息（attempts=1 一次即成 / channel=file 文件通道）
      // + 逐步骤 entry 终态与计划步数一致
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        plan?: {
          origin: string;
          steps: number;
          degraded: boolean;
          channel?: string;
          attempts?: number;
        };
        iterations: Array<{ stepId: string; status: string }>;
      };
      expect(record.status).toBe("completed");
      expect(record.plan).toMatchObject({
        origin: "designer",
        steps: 2,
        degraded: false,
        channel: "file",
        attempts: 1,
      });
      expect(record.iterations.map((e) => `${e.stepId}:${e.status}`)).toEqual([
        "survey:succeeded",
        "synth:succeeded",
      ]);
      // I-2 的对账点：RunRecord.plan.steps === 产物文件中的步数
      const planFileText = fs.readFileSync(
        path.join(tmp, "runs", result.runId, "designer-plan.json"),
        "utf-8",
      );
      expect(JSON.parse(planFileText).steps).toHaveLength(2);
      // M-1：executePlan 侧捕获的 budget 与生效 preset 原样一致（medium：5/4）
      expect(budgetCaptures).toHaveLength(capturesBefore + 1);
      expect(budgetCaptures[capturesBefore]).toEqual({
        maxPlanSteps: 5,
        maxParallelSubagents: 4,
      });
      // 附带锁定注入链头端：preset → designer 任务文本的预算约束行
      expect(designerTaskText).toContain("计划步骤数上限：5 步");
      expect(designerTaskText).toContain("最多 4 个 subagent");
    } finally {
      restoreEnv(saved);
    }
  });
});

// ---------- M4-T0：run.json 悬留收口（M3 终审 M-4 债）与 budget_exhausted 枚举映射（M-3 债） ----------
describe("runLoopTask — 执行链异常的 run.json 悬留收口（M4-T0）", () => {
  it("designer 基建异常（recordPlanInRunJson 之前抛出）→ run.json 不再悬留 created：落 failed + error 摘要", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      // generatePlan 的基建形态异常（fs 故障类——真实实现的降级路径不产出业务抛出）：
      // 抛出点在 recordPlanInRunJson 之前，catch 前的 run.json 悬留 status="created"
      // 正是本债的边缘场景
      designerFailures.push(new Error("写 designer-plan.json 时磁盘配额已满"));
      const result = await runLoopTask(
        { task: "悬留收口任务" },
        { busEnv: makeFakeSubagentsBus() },
      );
      // 统一收敛为 failed 结果（不向宿主抛裸异常）——既有语义保持
      expect(result.status).toBe("failed");
      expect(result.error).toContain("磁盘配额已满");
      expect(result.summary).toContain("执行链异常");
      // M-4 兑底：对照 executePlan 前置失败"先标 failed 再上抛"的治法，悬留的
      // created 被收口为 failed + error 摘要（审计面不丢）
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as { status: string; error?: string };
      expect(record.status).toBe("failed");
      expect(record.error).toContain("磁盘配额已满");
      // designer 前抛 → 计划摘要尚未成形（plan 字段缺省）
      expect(result.plan).toBeUndefined();
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("runLoopTask — 预算拒绝的枚举映射（M4-T0，终审 M-3 债）", () => {
  it("executePlan 预算拒绝返回形（error 前缀 budget_exhausted:）→ status=budget_exhausted 而非裸 failed", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      // executePlan 预算拒绝的返回形（orchestrator 侧 M3-T3 用例已锁定：零 spawn、
      // 零 entry、run 级 error 带 budget_exhausted: 前缀）——注入该形锁定 tool 层映射；
      // run.json 断言不作（override 绕过了真实 executePlan 的落盘）
      outcomeOverrides.push({
        steps: 3,
        succeeded: 0,
        failed: 0,
        durationMs: 4,
        iterations: [],
        batches: 0,
        error: "budget_exhausted: plan steps 3 > max 2",
      });
      const result = await runLoopTask(
        { task: "预算拒绝映射任务" },
        {
          busEnv: makeFakeSubagentsBus({ mode: "silent" }),
          rpcTimeoutMs: 25, // spawn 受理快速走完缺席降级（designer 侧不影响 override）
        },
      );
      // SPEC §7.3"超界立即收尾并如实报告 budget_exhausted"——枚举不再只是摆设
      expect(result.status).toBe("budget_exhausted");
      expect(result.error).toBe("budget_exhausted: plan steps 3 > max 2");
      expect(result.summary).toContain("预算耗尽");
      // M4-T2：拒绝轮的合成 fail 结论也走 evaluation 摘要（verdict 如实 + 轮次 0）
      expect(result.evaluation).toEqual({
        verdict: "fail",
        score: 0,
        round: 0,
      });
      // 遥测按 outcome 落真值（3 步计划、零执行、零迭代；durationMs 现为闭环
      // 总墙钟——不再倒传 executePlan 的注入值）
      expect(result.telemetry).toEqual({
        steps: 3,
        succeeded: 0,
        failed: 0,
        iterations: 0,
        durationMs: expect.any(Number),
      });
    } finally {
      restoreEnv(saved);
    }
  });
});

// ---------- M4-T2：迭代闭环接线（verifyCommand 机器循环 + critic 归因注入循环） ----------
describe("runLoopTask — 迭代闭环接线（M4-T2）", () => {
  it("verifyCommand 闭环境：首次验收 fail → 原样重跑 → 次轮 verified（零 critic spawn + 分轮归组 + final 留档）", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      // 状态文件计数器（verifyCommand 的 cwd=dataDir，跨轮状态经盘上文件传递）：
      // 第 1 次执行 exit 1（评估 fail），第 2 次 exit 0（verified）——真实 execFile 通道
      const verify =
        "node -e \"const fs=require('node:fs');const p='attempts.txt';const n=(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1;fs.writeFileSync(p,String(n));if(n<2){console.error('not yet');process.exit(1)}\"";
      const bus = makeFakeSubagentsBus();
      const result = await runLoopTask(
        { task: "迭代闭环验证任务", verifyCommand: verify },
        { busEnv: bus },
      );
      expect(result.status).toBe("completed");
      expect(result.evaluation).toEqual({
        verdict: "verified",
        score: 100,
        round: 1,
      });
      expect(result.summary).toContain("第 2 轮");
      // 互斥锁定（迭代循环内同样成立）：verifyCommand 在场零 critic spawn
      expect(bus.spawnedTasks.some((t) => t.includes("研究任务评审员"))).toBe(
        false,
      );
      // 跨轮状态痕迹：第 2 次执行 verdict 翻转为 verified 的验证依据
      expect(fs.readFileSync(path.join(tmp, "attempts.txt"), "utf-8")).toBe(
        "2",
      );
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        round: number;
        final?: { round: number; verdict: string; score: number };
        iterations: Array<{ round?: number; stepId: string }>;
      };
      expect(record.status).toBe("completed");
      expect(record.round).toBe(1);
      expect(record.final).toEqual({
        round: 1,
        verdict: "verified",
        score: 100,
      });
      // builtin 单步计划 × 两轮：分轮归组 [0, 1]
      expect(record.iterations.map((e) => e.round)).toEqual([0, 1]);
    } finally {
      restoreEnv(saved);
    }
  });

  it("critic 通道：fail（blame 注入）→ 次轮 verified——spawn 任务带前缀、非 blame 原样、run.json final 落在通过轮", async () => {
    const tmp = makeTempDir();
    const saved = setLoopEnv(tmp, "real");
    try {
      // 两步计划（preComplete 通常设计师产物——与 M3-T5 同构）+ critic 按轮次脚本
      const designerPlan = {
        version: 1,
        task: "研究 scheduler 设计空间并给出结论",
        origin: "designer" as const,
        notes: "两步走：先摸底再综合",
        steps: [
          {
            id: "survey",
            agent: "researcher",
            task: "摸底主流方案",
            dependsOn: [],
          },
          {
            id: "synth",
            agent: "researcher",
            task: "综合对比结论",
            dependsOn: ["survey"],
          },
        ],
      };
      let criticCalls = 0;
      const bus = makeFakeSubagentsBus({
        preComplete: (task) => {
          const match = /把最终 ResearchPlan 的完整 JSON 写入文件：(\S+)/.exec(
            task,
          );
          if (!match) return;
          fs.mkdirSync(path.dirname(match[1]), { recursive: true });
          fs.writeFileSync(match[1], JSON.stringify(designerPlan));
        },
        criticReply: () => {
          criticCalls++;
          return criticCalls === 1
            ? fencedEvaluationResult({
                verdict: "fail",
                score: 10,
                reasons: ["引用不足"],
                blame: ["survey"],
              })
            : fencedEvaluationResult({
                verdict: "verified",
                score: 88,
                reasons: ["补齐后达标"],
                blame: [],
              });
        },
      });
      const result = await runLoopTask(
        { task: "研究 scheduler 设计空间并给出结论" },
        { busEnv: bus },
      );
      expect(result.status).toBe("completed");
      expect(result.evaluation).toEqual({
        verdict: "verified",
        score: 88,
        round: 1,
      });
      // 注入面（最小）：二轮 survey 的 spawn 任务 = 失败上下文前缀 + 原 task；
      // 非 blame 的 synth 两轮任务原文一致
      expect(
        bus.spawnedTasks.includes(
          "前一轮失败：引用不足。请修正此步骤避免同类问题：摸底主流方案",
        ),
      ).toBe(true);
      expect(bus.spawnedTasks.includes("综合对比结论")).toBe(true);
      const record = JSON.parse(
        fs.readFileSync(
          path.join(tmp, "runs", result.runId, "run.json"),
          "utf-8",
        ),
      ) as {
        status: string;
        round: number;
        final?: { round: number; verdict: string; score: number };
        iterations: Array<{ round?: number }>;
      };
      expect(record.status).toBe("completed");
      expect(record.round).toBe(1);
      expect(record.final).toEqual({
        round: 1,
        verdict: "verified",
        score: 88,
      });
      expect(record.iterations.map((e) => e.round)).toEqual([0, 0, 1, 1]);
    } finally {
      restoreEnv(saved);
    }
  });
});
