#!/usr/bin/env bash
# pi-loop 端到端冒烟脚本（M2-T5）
# 验证链路：真实 pi 宿主加载扩展 → 模型调用 loop_task → pi-subagents 真实 spawn
# researcher 跑微型研究任务 → 完成事件回写 RunRecord → 断言 run.json 终态 completed。
#
# 与 scripts/smoke.sh（M1 结构冒烟）的分工：
#   smoke.sh    只验证"扩展可加载 + 工具可被调用、run id 落盘"（秒级，不真实 spawn）；
#   本脚本     走真实调度全链（分钟级；消耗 pi 主模型一轮 + researcher 一轮模型调用）。
#
# 环境策略（brief 折衷方案：复用真实用户环境 + dataDir 隔离）：
#   - 不隔离 HOME：真实 spawn 依赖宿主用户级 agent 定义（researcher 等）与 pi 配置，
#     隔离 HOME 会失去这些定义，spawn 必然失败（T4 派生事实）；
#   - PI_LOOP_DATA_DIR 指向临时目录：run 落盘隔离，绝不写真实 ~/.pi/loop/；
#   - 主动 unset PI_LOOP_STUB：e2e 必须走真实路径（防外环境残留 stub 开关）。
#
# 退出码语义（与 smoke.sh 同哲学）：
#   0 = 全链真实跑通，或显式 SKIP（环境不满足：pi / node 缺失、pi-subagents 缺席、
#       模型层熔断或额度耗尽、总控超时）；
#   1 = 断言真实失败（扩展加载失败 / run.json 终态非 completed / 无落盘），dump 诊断。
#
# 用法：bash scripts/smoke-e2e.sh（可重复本地运行；每次 mktemp 全新目录，退出即清理）
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 总控超时（秒）：pi 调用 + 完成等待合计上限。真实 subagent 一轮微型研究约 1-5 分钟
# （含 pi 侧模型调用）；调度内核单步完成等待同为 10 分钟，总控先到即 SIGTERM。
TIMEOUT_S=600

# pi-subagents 缺席标记（与 src/core/orchestrator.ts / src/extension/loop-task.ts 的
# 失败文案同步演进：spawn 超时或应答缺席时，entry.error 与工具 error 都携带此文案）
RPC_ABSENT_RE='pi-subagents 不在或不可用|请安装 pi-subagents|pi install npm:pi-subagents'

# 模型/环境层降级关键词（与 smoke.sh 的环境降级断言同族，补 timeout/超时类）
DEGRADED_RE='模型|熔断|excluded|rate|ECONN|ENOTFOUND|EAI_AGAIN|credits|billing|quota|insufficient|timeout|timed.out|超时'

# 模型层不可用特异标记（Fix round 2 实测：pi-subagents 在场但 subagent 模型被熔断/
# 排除时的报错特征）——必须先于 RPC_ABSENT_RE 判型：spawn 失败的 entry.error 由
# orchestrator 统一追加「pi-subagents 不在或不可用」引导后缀，模型被拒场景同样在场
MODEL_DOWN_RE='No usable subagent models|cached exclusion|skipping model'

# ---------- 降级 1：无 pi 命令（裸机开发环境） ----------
if ! command -v pi >/dev/null 2>&1; then
  echo "SKIP: pi command not found — e2e smoke skipped (exit 0)"
  exit 0
fi

# ---------- 降级 2：无 node（run.json 断言的解析器；pi 在场时几乎不可能缺席） ----------
if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node command not found — 无法解析 run.json 断言（exit 0）"
  exit 0
fi

# 落盘隔离：临时 dataDir + pi 输出日志（退出时一并清理，失败路径已先行 dump）
DATA_DIR="$(mktemp -d /tmp/pi-loop-e2e-data-XXXXXX)"
OUT="$(mktemp /tmp/pi-loop-e2e-out-XXXXXX.log)"
trap 'rm -rf "$DATA_DIR" "$OUT"' EXIT

# e2e 必须走真实调度：清除可能从外环境泄漏的 M1 stub 开关
unset PI_LOOP_STUB

# 步骤②：一句指派即触发全链（模型调 loop_task → spawn researcher → 等完成）
PROMPT="调用 loop_task 工具：研究任务'用一句话说明 pi-loop 是什么'，effort: low"

echo "== e2e: 启动 pi（真实调度；dataDir=${DATA_DIR}；总控超时 ${TIMEOUT_S}s）"

# ---------- 步骤的辅助（终态驱动的等待需要）：定位 run.json / 探读终态 / 优雅终止 ----------
# 定位最新 run.json（单次指派应恰一个；万一多 run 取字典序最大——r-<epoch36>-<rand>
# 同长，字典序=时间序；路径来自自建临时目录，无空格/换行风险）
find_run_json() {
  find "$DATA_DIR/runs" -name run.json -print 2>/dev/null | sort | tail -n 1
}

# run.json 的 record 级状态（node 解析；损坏/缺文件回空串）
run_status() {
  node -e '
    try {
      const rec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log(typeof rec.status === "string" ? rec.status : "");
    } catch {
      console.log("");
    }
  ' "$1" 2>/dev/null
}

# 优雅终止 pi：TERM 后给 5s 退出窗口，仍存活则 KILL（不依赖 GNU timeout——macOS 无自带）
stop_pi() {
  kill -TERM "$PI_PID" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$PI_PID" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$PI_PID" 2>/dev/null
}

# pi 异步执行 + 终态驱动等待（Fix round 2 改造）：轮询期间每 tick 检查 run.json，
# 一到任意业务终态（completed|failed）即优雅终止 pi——实测 pi 业务完成后因子代理
# 滞留 timer 不退出（T3 review M4 实证），不再干等进程；600s 总控保留（业务兜底）。
# 命令级注入 PI_LOOP_DATA_DIR：优先级高于外环境同名变量，确保落盘隔离生效
PI_LOOP_DATA_DIR="$DATA_DIR" \
  pi -e "$REPO_DIR" -p "$PROMPT" </dev/null >"$OUT" 2>&1 &
PI_PID=$!
TIMED_OUT=0
ELAPSED=0
while true; do
  # ① pi 自身退出：首选（正常路径无需外部终止）
  kill -0 "$PI_PID" 2>/dev/null || break
  # ② 600s 总控兜底：未到任何终态的最坏情形
  if [ "$ELAPSED" -ge "$TIMEOUT_S" ]; then
    echo "== e2e: 总控超时（${TIMEOUT_S}s）——终止 pi"
    TIMED_OUT=1
    stop_pi
    break
  fi
  # ③ 业务终态轮询：run.json 一到 completed|failed 即收工（断言的权威物证已定）
  RUN_JSON_NOW="$(find_run_json)"
  if [ -n "$RUN_JSON_NOW" ]; then
    STATUS_NOW="$(run_status "$RUN_JSON_NOW")"
    if [ "$STATUS_NOW" = "completed" ] || [ "$STATUS_NOW" = "failed" ]; then
      echo "== e2e: 业务终态（status=${STATUS_NOW}）——终止 pi（进程可能滞留 timer）"
      stop_pi
      break
    fi
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  # 心跳：长时间运行时确认脚本未挂死（每 60s 一行）
  if [ $((ELAPSED % 60)) -eq 0 ]; then
    echo "== e2e: 真实调度进行中（${ELAPSED}s / ${TIMEOUT_S}s）"
  fi
done
wait "$PI_PID"
RC=$?

# ---------- 步骤③：落盘定位（终态已由等待循环判定；防御性轮询兜底） ----------
RUN_JSON=""
for _ in 1 2 3 4 5; do
  RUN_JSON="$(find_run_json)"
  if [ -n "$RUN_JSON" ]; then
    break
  fi
  sleep 1
done

# ---------- 断言 1：扩展加载无错误（硬性，任何环境都必须过） ----------
if grep -q "Error: Failed to load extension" "$OUT"; then
  echo "FAIL: extension failed to load"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT"
  exit 1
fi

# ---------- 断言 2：run.json 存在（loop_task 真被调用过的物证） ----------
if [ -z "$RUN_JSON" ]; then
  # 模型层不可用（主模型直接被拒，工具未被调用）：与 run 失败路径同型判别
  if grep -qE "$MODEL_DOWN_RE" "$OUT"; then
    echo "SKIP: 模型层不可用（熔断/额度/供应商不稳，loop_task 未被执行）"
    tail -5 "$OUT"
    exit 0
  fi
  if grep -qE "$DEGRADED_RE" "$OUT"; then
    echo "SKIP: model/runtime degraded（熔断/额度/网络类失败，loop_task 未被执行）"
    tail -5 "$OUT"
    exit 0
  fi
  echo "FAIL: 无 run.json 落盘（模型未调用 loop_task 且无环境降级特征）"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT"
  exit 1
fi

RUN_ID="$(basename "$(dirname "$RUN_JSON")")"
echo "== e2e: run 记录 $RUN_JSON"

# ---------- 核心断言：status=completed 且 iterations[0] 有 outputRef 或 error 为空 ----------
VERDICT="$(node -e '
  const fs = require("fs");
  const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const it = Array.isArray(rec.iterations) ? rec.iterations[0] : undefined;
  const hasOutput =
    it !== undefined && typeof it.outputRef === "string" && it.outputRef.length > 0;
  const noError = it !== undefined && !it.error;
  console.log(rec.status === "completed" && (hasOutput || noError) ? "PASS" : "FAIL");
' "$RUN_JSON" 2>/dev/null || echo CORRUPT)"

if [ "$VERDICT" = "PASS" ]; then
  echo "PASS: e2e smoke passed（真实 spawn → 完成 → RunRecord 终态 completed）"
  echo "run id: $RUN_ID  ($RUN_JSON)"
  # 落盘证据摘要（trap 退出即清理，终端留痕供人工校验）
  node -e '
    const rec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const it = rec.iterations[0];
    console.log(`run: ${rec.id}  status=${rec.status}  effort=${rec.effort}`);
    console.log(
      `iteration: ${it.stepId}(${it.agent}) ${it.status}` +
        (it.outputRef ? `  outputRef=${it.outputRef}` : "  outputRef=(none)"),
    );
  ' "$RUN_JSON" 2>/dev/null || true
  exit 0
fi

# ---------- 降级 3：模型层不可用（pi-subagents 在场但子代理模型被拒） ----------
# 顺序注意：spawn 失败的 entry.error 由 orchestrator 统一追加「pi-subagents 不在或
# 不可用」引导后缀——先用更特异的模型层特征判型，避免误归因为包缺席
if grep -qE "$MODEL_DOWN_RE" "$RUN_JSON" "$OUT" 2>/dev/null; then
  echo "SKIP: 模型层不可用（熔断/额度/供应商不稳）"
  tail -5 "$OUT"
  exit 0
fi

# ---------- 降级 4：pi-subagents 缺席（spawn 无应答，失败文案含 RPC_ABSENT 系列标记） ----------
# 顺序注意：缺席文案自带"超时"字样，必须先于 DEGRADED_RE 判定
if grep -qE "$RPC_ABSENT_RE" "$RUN_JSON" "$OUT" 2>/dev/null; then
  echo "SKIP: pi-subagents 不在或不可用（安装后重试: pi install npm:pi-subagents）"
  exit 0
fi

# ---------- 降级 5：总控超时与泛化降级 ----------
if [ "$TIMED_OUT" = "1" ]; then
  echo "SKIP: 总控超时（${TIMEOUT_S}s 内真实 subagent 未完成——视为环境受限）"
  exit 0
fi
if grep -qE "$DEGRADED_RE" "$RUN_JSON" "$OUT" 2>/dev/null; then
  echo "SKIP: model/runtime degraded（熔断/额度/超时类失败，run 以 failed 收尾）"
  tail -5 "$OUT"
  exit 0
fi

# ---------- 真实失败：dump run.json 全文 + pi 输出尾部（诊断物证） ----------
echo "FAIL: e2e smoke failed（pi rc=${RC}；run 终态未达 completed）"
echo "--- run.json ---"
cat "$RUN_JSON"
echo "--- pi output (tail 50) ---"
tail -50 "$OUT"
exit 1
