// index 入口组装的测试（M1-T4）
// 新契约：默认导出在有效宿主（fake pi）上完成双注册；无效宿主 fast-fail。
import { describe, expect, it } from "vitest";
import registerPiLoop from "../index.js";
import type { PiExtensionApi } from "../src/extension/api.ts";

describe("index 入口", () => {
  it("默认导出是函数", () => {
    expect(typeof registerPiLoop).toBe("function");
  });

  it("fake 宿主上完成 loop_task 工具与 4 个命令注册", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const pi: PiExtensionApi = {
      registerTool: (def) => {
        tools.push(def.name);
        return undefined;
      },
      registerCommand: (name) => {
        commands.push(name);
        return undefined;
      },
    };
    expect(() => registerPiLoop(pi)).not.toThrow();
    expect(tools).toEqual(["loop_task"]);
    expect(commands.sort()).toEqual([
      "loop",
      "loop-cases",
      "loop-methods",
      "loop-status",
    ]);
  });

  it("无效宿主（undefined）→ fast-fail 抛错", () => {
    expect(() => registerPiLoop(undefined)).toThrow(TypeError);
  });
});
