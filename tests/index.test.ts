import { describe, expect, it } from "vitest";
import registerPiLoop from "../index.js";

// M1-T1 占位测试：验证入口默认导出存在且可安全调用（骨架冒烟）
describe("index 入口", () => {
  it("默认导出是函数且可空调用", () => {
    expect(typeof registerPiLoop).toBe("function");
    expect(() => registerPiLoop(undefined)).not.toThrow();
  });
});
