// pi-loop 扩展入口（M1-T4 组装完成）
// 组装：loop_task 工具（src/extension/tools.ts）+ /loop* 命令（src/extension/commands.ts）。
// 宿主类型包不在 npm，故入参用 unknown + 本地结构接口窄化（src/extension/api.ts）。
// dataDir 解析优先级：PI_LOOP_DATA_DIR 环境变量 > ~/.pi/loop/（冒烟/测试注入用环境变量）。
import type { PiExtensionApi } from "./src/extension/api.ts";
import { registerLoopCommands } from "./src/extension/commands.ts";
import { registerLoopTools } from "./src/extension/tools.ts";

export default function registerPiLoop(host: unknown): void {
  // 宿主在运行时传入真实 ExtensionAPI；结构不匹配会在注册调用时自然失败（fast-fail）
  const pi = host as PiExtensionApi;
  registerLoopTools(pi);
  registerLoopCommands(pi);
}
