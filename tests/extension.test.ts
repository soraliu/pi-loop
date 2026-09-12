// loop_task 工具与 /loop 命令的测试（M1-T4）
// 全部用例通过 PI_LOOP_DATA_DIR 注入临时目录——绝不触碰真实 ~/.pi/loop/。
// fake pi 对象只捕获注册的 definition/handler，直接调用以覆盖 execute 逻辑。

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
} from "../src/extension/commands.ts";
import { resolveDataDir, runLoopTaskStub } from "../src/extension/loop-task.ts";

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

function makeFakePi(): {
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
  });

  it("合法调用 → stub 结果 + run.json 落盘（PI_LOOP_DATA_DIR 注入）", async () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
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
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
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
  it("执行后 notify 含 runId 且 run.json 落盘", async () => {
    const tmp = makeTempDir();
    const prev = process.env.PI_LOOP_DATA_DIR;
    process.env.PI_LOOP_DATA_DIR = tmp;
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
      if (prev === undefined) delete process.env.PI_LOOP_DATA_DIR;
      else process.env.PI_LOOP_DATA_DIR = prev;
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
