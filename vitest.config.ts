import { defineConfig } from "vitest/config";

export default defineConfig({
  // 测试只认 tests/ 目录下的 *.test.ts
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
