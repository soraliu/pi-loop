// pi-loop 扩展入口（M1 骨架占位实现）
// 真正的工具/命令注册在 M1 后续任务中落地（src/extension/tools.ts、commands.ts）。
// 类型 ExtensionAPI 由 pi 宿主在运行时提供；此处仅以最小占位保证 typecheck 通过。
export default function registerPiLoop(pi: unknown): void {
  // 占位：M1-Task4 将替换为完整的注册逻辑
  void pi;
}
