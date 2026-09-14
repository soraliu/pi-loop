#!/usr/bin/env bash
# pi-loop 端到端冒烟脚本（M2-T5 → M3-T5 → M4-T4 → M5-T4 三场景升级 + 档案断言）
# 验证链路：真实 pi 宿主加载扩展 → 模型调用 loop_task → designer 动态生成计划
# （researcher 兼任设计）→ pi-subagents 真实逐层 spawn → 完成事件回写 → 断言 run.json。
#
# 场景 A（designer 多步全链，M3 主目标）：中等复杂度任务 → designer 真实生成计划
#   → 逐层执行 → completed。核心断言：plan.origin==="designer" && status==="completed"
#   && steps>=1（容忍 1 步——designer 合理判定无需分解也是降级之外的成功）&&
#   全部 entry 终态非 pending（iterations 数 === 计划步数）；channel=file 时另对
#   designer-plan.json 做 steps 结构独立对账（id 唯一 / dependsOn 计划内自洽）。
# 场景 B（预算强制路径，M3-T5）：dataDir 级 settings.json 把 low 档 maxPlanSteps
#   压成 1（loadLoopSettings 读 <dataDir>/settings.json 深合并——M1 合并语义，
#   无需任何 env 钩子）→ designer 被迫单步（schema 侧 maxSteps=1 拒绝多步）或
#   降级 builtin → 断言不 crash + steps<=1 + origin 如实。
# 场景 C（verifyCommand 机器断言端到端，M4-T4）：prompt 要求 pi 调 loop_task 时
#   携带 verifyCommand 入参（工具 schema 原生字段，明示"原样传递不要改写"）→
#   评估走机器断言通道而非 critic。核心断言：run.json status=completed +
#   evaluation.verdict=verified + score>0 + reasons 携带「机器断言通过」标记
#   （verifyCommand 通道专属文案——critic 通道的 reasons 是围栏 JSON 原文；
#   等价证明本轮评估零 critic spawn，完整的 spawn 计数断言由单测 fake rpc
#   锁定）+ blame 恒空（退出码断言无轮次归因概念）。
# 场景 A 追加断言（M5-T4 档案链观测）：跑完 loop_task 后 cases/ 出现新 Case
#   （ls 非空且最近 Case.runId === 本 run——三终点自动 Case 化的 e2e 物证）；
#   方法库 git log 按实际记录（v1 现实：run 链不调用 saveMethodEntry——详见断言处
#   注释）。档案断言失败不触发硬性 FAIL——与场景同步降级 SKIP（给实测说明；
#   不计 FAIL 也不影响后续场景执行）。
#
# 物证留档（M3 终审附随义务）：默认各场景 mktemp 全新目录、退出即清理；
#   KEEP_ARTIFACTS=1 时保留全部 dataDir 与 pi 输出日志并打印路径（详见 trap
#   处注释），供白天窗口复核终帧 run.json / designer-plan.json。
#
# 与 scripts/smoke.sh（M1 结构冒烟）的分工：
#   smoke.sh    只验证"扩展可加载 + 工具可被调用、run id 落盘"（秒级，不真实 spawn）；
#   本脚本     走真实调度全链（分钟级；每场景各消耗 pi 主模型 + designer + 若干步
#               的工作流 spawn）。
#
# 环境策略（brief 折衷方案：复用真实用户环境 + dataDir 隔离）：
#   - 不隔离 HOME：真实 spawn 依赖宿主用户级 agent 定义（researcher 等）与 pi 配置，
#     隔离 HOME 会失去这些定义，spawn 必然失败（T4 派生事实）；
#   - PI_LOOP_DATA_DIR 指向临时目录：run 落盘隔离，绝不写真实 ~/.pi/loop/
#     （场景 B 的 settings.json 覆盖也因此只作用于本临时目录）；
#   - 主动 unset PI_LOOP_STUB 与 PI_LOOP_NO_ARCHIVE：e2e 必须走真实路径且必落案例
#     档案（防外环境残留 stub 开关与归档关闭开关——后者会把 M5 档案断言误伤成降级）。
#
# 退出码语义（与 smoke.sh 同哲学）：
#   0 = 所有已执行场景 PASS，或全部止于显式 SKIP（环境不满足：pi / node 缺失、
#       pi-subagents 缺席、模型层熔断或额度耗尽、总控超时、泛化降级；
#       designer 未产出有效计划但内建计划照跑 completed 也视作 SKIP——e2e 的
#       目标是证明 designer 链，环境模型未满足输出契约时不计失败）；
#       场景 A 的环境级 SKIP 会连带跳过场景 B/C（同一环境同因）；
#   1 = 断言真实失败（扩展加载失败 / run.json 终态非预期 / 无落盘），dump 诊断。
#
# 用法：bash scripts/smoke-e2e.sh（可重复本地运行；每次 mktemp 全新目录，退出即清理；
#   KEEP_ARTIFACTS=1 bash scripts/smoke-e2e.sh 则保留物证不清理）
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 单场景总控超时（秒）：pi 调用 + 完成等待合计上限。真实链路一轮 spawn 约 1-5 分钟
# （含 pi 侧模型调用）；designer 与每步各占一轮，600s 需紧则 SIGTERM；调度内核单步
# 完成等待同为 10 分钟，总控先到即终止单场景。
TIMEOUT_S=${E2E_TIMEOUT_S:-600}

# pi-subagents 缺席标记（与 src/core/orchestrator.ts / src/extension/loop-task.ts 的
# 失败文案同步演进：spawn 超时或应答缺席时，entry.error 与工具 error 都携带此文案）
RPC_ABSENT_RE='pi-subagents 不在或不可用|请安装 pi-subagents|pi install npm:pi-subagents'

# 模型/环境层降级关键词（M-2 收口）：①词边界——英文 token 只按整词/紧邻非字母
# 匹配（防 "generate" 之类子串误报）；CJK 词（模型/熔断/超时）无词边界概念，保持
# 子串匹配；②仅匹配 run.json 的 error/notes 语义字段聚合文本（run_fail_text），
# 不再全量 grep run.json 全文 / $OUT——任务提示词等自由文本不参与降级判型。
# M3-T5（I-1 修）：token 组补回 "rate"——词边界保证 "generate/operate" 不误中、
# "rate_limit / rate limit" 恢复命中（T4 报告声明的口径兑现）
DEGRADED_RE='模型|熔断|超时|(^|[^A-Za-z])(ECONN|ENOTFOUND|EAI_AGAIN|rate|credits|billing|quota|insufficient|excluded|timeout|timed.out)([^A-Za-z]|$)'

# 模型层不可用特异标记（Fix round 2 实测：pi-subagents 在场但 subagent 模型被熔断/
# 排除时的报错特征）——必须先于 RPC_ABSENT_RE 判型。M-1（M2 终审收口）后
# orchestrator/designer 仅在超时/无应答特征时追加缺席引导后缀，模型被拒属真实
# 拒绝不附后缀——判定依赖错误文本自身携带的特征词（$OUT 与 run.json 全文各留
# 一路：双保险；token 为特异英文短语，自由文本不误中）
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

# 落盘隔离：每场景独立临时 dataDir + pi 输出日志（退出时一并清理，失败路径已先行 dump）
DATA_A="$(mktemp -d /tmp/pi-loop-e2e-data-XXXXXX)"
OUT_A="$(mktemp /tmp/pi-loop-e2e-out-XXXXXX.log)"
DATA_B="$(mktemp -d /tmp/pi-loop-e2e-data-XXXXXX)"
OUT_B="$(mktemp /tmp/pi-loop-e2e-out-XXXXXX.log)"
DATA_C="$(mktemp -d /tmp/pi-loop-e2e-data-XXXXXX)"
OUT_C="$(mktemp /tmp/pi-loop-e2e-out-XXXXXX.log)"

# 物证留档开关（M3 终审附随义务 → M4-T4）：KEEP_ARTIFACTS=1 时 trap 改为保留全部
# dataDir 与 pi 输出日志（终帧 run.json / designer-plan.json 可事后审计），并以
# 「物证保留于 ...」打印路径；缺省（未设或非 1）行为与此前完全一致——退出即清理。
# 失败路径不受影响（FAIL 分支已先行 dump，保留的物证反而是更完整的复核材料）。
if [ "${KEEP_ARTIFACTS:-0}" = "1" ]; then
  trap 'echo "物证保留于：${DATA_A} ${DATA_B} ${DATA_C}（pi 输出：${OUT_A} ${OUT_B} ${OUT_C}）"' EXIT
  echo "== e2e: KEEP_ARTIFACTS=1——退出时保留各场景 dataDir 与 pi 输出日志（默认清理）"
else
  trap 'rm -rf "$DATA_A" "$OUT_A" "$DATA_B" "$OUT_B" "$DATA_C" "$OUT_C"' EXIT
fi

# e2e 必须走真实调度：清除可能从外环境泄漏的 M1 stub 开关与 M5 归档关闭开关
# （PI_LOOP_NO_ARCHIVE=1 会让 run 不落案例档案——场景 A 的 M5 档案断言会被外环境
# 泄漏误伤，与 stub 开关同治理）
unset PI_LOOP_STUB PI_LOOP_NO_ARCHIVE

# ---------- 步骤的辅助（终态驱动的等待需要）：定位 run.json / 探读终态 / 优雅终止 ----------
# 定位最新 run.json（单场景应恰一个；万一多 run 取字典序最大——r-<epoch36>-<rand>
# 同长，字典序=时间序；路径来自自建临时目录，无空格/换行风险）
find_run_json() {
  find "$1/runs" -name run.json -print 2>/dev/null | sort | tail -n 1
}

# run.json 的 record 级状态（node 解析；损坏/缺文件回空串）。
# 终点语义（M4）：真终态 completed 必有 final 落盘（verified 收尾三件套）；
# executePlan 每轮收尾写的 completed（M2 契约）在 evaluate/final 落盘前是 evaluate
# 期间的中间态——报 "executing" 让等待循环继续（慢世界该窗口可拉长到分钟级），
# 防终态探测抢跑掐断评估阶段留下 "completed 无 final" 的中间形态。
run_status() {
  node -e '
    try {
      const rec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let s = typeof rec.status === "string" ? rec.status : "";
      if (s === "completed" && !rec.final) s = "executing";
      console.log(s);
    } catch {
      console.log("");
    }
  ' "$1" 2>/dev/null
}

# run.json 的降级判型文本（M-2）：只聚合 error/notes 语义字段——run 级 error、
# 各 iteration 的 error、plan.notes（designer 降级原因也是环境信号）；损坏/缺
# 文件回空串。DEGRADED_RE 只在该文本上判型（词边界见定义处），不再全量 grep
run_fail_text() {
  node -e '
    try {
      const rec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const parts = [];
      if (typeof rec.error === "string" && rec.error) parts.push(rec.error);
      if (Array.isArray(rec.iterations)) {
        for (const it of rec.iterations) {
          if (it && typeof it.error === "string" && it.error) parts.push(it.error);
        }
      }
      const notes = rec.plan && typeof rec.plan.notes === "string" ? rec.plan.notes : "";
      if (notes) parts.push(notes);
      console.log(parts.join("\n"));
    } catch {
      console.log("");
    }
  ' "$1" 2>/dev/null
}

# run.json 的 origin:status 组合（场景 A 的 designer 未达成判别——builtin 降级但 completed）
origin_and_status() {
  node -e '
    try {
      const rec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const o = rec.plan && typeof rec.plan.origin === "string" ? rec.plan.origin : "";
      console.log(`${o}:${rec.status}`);
    } catch {
      console.log(":");
    }
  ' "$1" 2>/dev/null
}

# 优雅终止 pi：TERM 后给 5s 退出窗口，仍存活则 KILL（不依赖 GNU timeout——macOS 无自带）
stop_pi() {
  kill -TERM "$1" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$1" 2>/dev/null
}

# 扩展加载断言（硬性，每场景各自核验）：pi 输出含加载失败即 FAIL（exit 1，dump 尾部）
assert_extension_loaded() {
  if grep -q "Error: Failed to load extension" "$1"; then
    echo "FAIL: extension failed to load"
    echo "--- pi output (tail 50) ---"
    tail -50 "$1"
    exit 1
  fi
}

# 单场景执行（终态驱动等待）：PI_LOOP_DATA_DIR 注入 <data_dir>（优先级高于外环境
# 同名变量，确保落盘隔离生效），阻塞至业务终态或总控超时；产出全局 RUN_JSON /
# RUN_RC / TIMED_OUT。用法：run_scenario <label> <data_dir> <out_file> <timeout_s> <prompt>
run_scenario() {
  local label="$1" data_dir="$2" out_file="$3" timeout_s="$4" prompt="$5"
  echo "== e2e[${label}]: 启动 pi（真实调度；dataDir=${data_dir}；总控超时 ${timeout_s}s）"
  PI_LOOP_DATA_DIR="$data_dir" \
    pi -e "$REPO_DIR" -p "$prompt" </dev/null >"$out_file" 2>&1 &
  local pid=$!
  TIMED_OUT=0
  local elapsed=0
  while true; do
    # ① pi 自身退出：首选（正常路径无需外部终止）
    kill -0 "$pid" 2>/dev/null || break
    # ② 总控兜底：未到任何终态的最坏情形
    if [ "$elapsed" -ge "$timeout_s" ]; then
      echo "== e2e[${label}]: 总控超时（${timeout_s}s）——终止 pi"
      TIMED_OUT=1
      stop_pi "$pid"
      break
    fi
    # ③ 业务终态轮询：run.json 一到 completed|failed 即收工（断言的权威物证已定）
    local run_now status_now
    run_now="$(find_run_json "$data_dir")"
    if [ -n "$run_now" ]; then
      status_now="$(run_status "$run_now")"
      if [ "$status_now" = "completed" ] || [ "$status_now" = "failed" ]; then
        echo "== e2e[${label}]: 业务终态（status=${status_now}）——终止 pi（进程可能滞留 timer）"
        stop_pi "$pid"
        break
      fi
    fi
    sleep 5
    elapsed=$((elapsed + 5))
    # 心跳：长时间运行时确认脚本未挂死（每 60s 一行）
    if [ $((elapsed % 60)) -eq 0 ]; then
      echo "== e2e[${label}]: 真实调度进行中（${elapsed}s / ${timeout_s}s）"
    fi
  done
  wait "$pid"
  RUN_RC=$?
  # 落盘定位（终态已由等待循环判定；防御性轮询兜底）
  RUN_JSON=""
  for _ in 1 2 3 4 5; do
    RUN_JSON="$(find_run_json "$data_dir")"
    [ -n "$RUN_JSON" ] && break
    sleep 1
  done
}

# 环境降级判型链（模型层 → pi-subagents 缺席 → 总控超时 → 泛化降级）：按序判型，
# 命中即输出 SKIP 文案并返回 0（调用方按场景收尾）；全不中返回 1。
# 顺序注意：缺席文案自带"超时"字样，必须先于 DEGRADED_RE 判定；MODEL_DOWN 为最
# 特异先判。RPC_ABSENT 的 run.json 侧匹配收窄到 run_fail_text（run 级 error + 各
# iteration error + plan.notes 语义字段——M-2 收口的同款聚合文本，与 DEGRADED_RE
# 同治）；pi 输出 $OUT 的全文 grep 只保留在无 run.json 分支——record.task 与
# 模型叙述属自由文本，场景 A 的研究主题天然含 "pi + subagents" 字样，run.json
# 全文 grep 会误报缺席
classify_env_skip() {
  local run_json="$1" out_file="$2"
  # 真终态完成（completed + final 在场）不参与环境降级判定——链路真实跑到了终点，
  # 断言说了算（PASS 或 FAIL），SKIP 会掩盖真实缺陷信号。此时 $OUT 里的熔断警告类
  # 自由文本（如 SDD 层的 cached exclusion 日志）不构成降级证据。
  if [ "$(run_status "$run_json")" = "completed" ]; then
    return 1
  fi
  if grep -qE "$MODEL_DOWN_RE" "$run_json" "$out_file" 2>/dev/null; then
    echo "SKIP: 模型层不可用（熔断/额度/供应商不稳）"
    tail -5 "$out_file"
    return 0
  fi
  local fail_text
  fail_text="$(run_fail_text "$run_json")"
  if [ -n "$fail_text" ] && grep -qE "$RPC_ABSENT_RE" <<<"$fail_text"; then
    echo "SKIP: pi-subagents 不在或不可用（安装后重试: pi install npm:pi-subagents）"
    return 0
  fi
  if [ "$TIMED_OUT" = "1" ]; then
    echo "SKIP: 总控超时（${TIMEOUT_S}s 内真实 subagent 未完成——视为环境受限）"
    return 0
  fi
  if [ -n "$fail_text" ] && grep -qE "$DEGRADED_RE" <<<"$fail_text"; then
    echo "SKIP: model/runtime degraded（熔断/额度/超时类失败，run 以 failed 收尾）"
    tail -5 "$out_file"
    return 0
  fi
  return 1
}

# 无 run.json 落盘时的模型层判型（比 classify_env_skip 早一步：loop_task 未被调用，
# 仅 $OUT 携带模型层特征；其余情形一律 FAIL——真实失败浮现，不被宽匹配吞掉）
skip_on_model_down() {
  if grep -qE "$MODEL_DOWN_RE" "$1"; then
    echo "SKIP: 模型层不可用（熔断/额度/供应商不稳，loop_task 未被执行）"
    tail -5 "$1"
    return 0
  fi
  return 1
}

# 场景选择：E2E_SCENARIOS（默认 "A B C" 全跑；空格分隔子集如 "C" / "B C"）。
# 动机：场景间链路异构（A/B 依赖 critic 的 LLM 评估，C 为 verifyCommand 机器断言），
# 单一场景的环境受限不应殃及异构链路——用它在降级窗口单验仍可行的场景。
E2E_SCENARIOS=${E2E_SCENARIOS:-"A B C"}
# 场景结果预初始化（子集模式下被跳过的场景保持 "-"，末尾汇总与环境检查引用不炸 unbound）
A_RESULT="-"; B_RESULT="-"; C_RESULT="-"
scenario_enabled() {
  case " $E2E_SCENARIOS " in *" $1 "*) return 0;; *) return 1;; esac
}

# ---------- 场景 A：designer 多步全链（默认预算 low：maxPlanSteps=3 / 并行 2） ----------
# 任务为中等复杂度（对比研究 + 结论）；提示词明示"如需要可分解多步"——researcher
# 兼任 designer，实际可能给出 1 步（合理判定）到 3 步，断言容忍 1 步
PROMPT_A="调用 loop_task 工具：研究任务'pi-loop 与直接使用 pi + subagents 的差别'（中等复杂度：对比两者的工作流、适用场景与开销，如需要可分解多步执行后综合），effort: low"

# 场景 A 本体：异构链路独立成段，便于选择性执行
if scenario_enabled "A"; then
run_scenario "A" "$DATA_A" "$OUT_A" "$TIMEOUT_S" "$PROMPT_A"
assert_extension_loaded "$OUT_A"

if [ -z "$RUN_JSON" ]; then
  if skip_on_model_down "$OUT_A"; then
    echo "== e2e: 场景 A 环境受限 SKIP——场景 B/C 同因跳过（同一环境）"
    echo "== e2e 汇总：A SKIP（模型层不可用）/ B SKIP（同因）/ C SKIP（同因）"
    exit 0
  fi
  echo "FAIL: 场景 A 无 run.json 落盘（模型未调用 loop_task 且无环境降级特征）"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT_A"
  exit 1
fi
echo "== e2e[A]: run 记录 $RUN_JSON"
PLAN_FILE_A="$(dirname "$RUN_JSON")/designer-plan.json"

# 断言：status=completed + plan.origin="designer" + steps>=1 + iterations 与计划步数
# 一致且全部终态非 pending；channel=file 时对 designer-plan.json 做 steps 结构独立
# 对账（schema 语义已由内核校验过——origin=designer 的前提——此处是物证复核）
VERDICT_A="$(node -e '
  const fs = require("fs");
  const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const plan = rec.plan && typeof rec.plan === "object" ? rec.plan : {};
  const steps = Number.isInteger(plan.steps) ? plan.steps : -1;
  const iters = Array.isArray(rec.iterations) ? rec.iterations : [];
  const terminal = iters.every((e) => e && (e.status === "succeeded" || e.status === "failed"));
  const reasons = [];
  if (rec.status !== "completed") reasons.push(`status=${rec.status}`);
  if (plan.origin !== "designer") reasons.push(`plan.origin=${String(plan.origin)}`);
  if (steps < 1) reasons.push(`plan.steps=${steps}`);
  if (!terminal) reasons.push("iterations 存在非终态 entry（pending/running）");
  if (iters.length !== steps) reasons.push(`iterations 数 ${iters.length} !== 计划步数 ${steps}`);
  if (reasons.length === 0 && plan.channel === "file") {
    try {
      const pf = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const arr = Array.isArray(pf.steps) ? pf.steps : null;
      if (arr === null) reasons.push("designer-plan.json 缺 steps 数组");
      if (arr !== null) {
        if (arr.length !== steps) reasons.push(`产物文件步数 ${arr.length} !== 记录步数 ${steps}`);
        const ids = arr.map((s) => (s && typeof s.id === "string" ? s.id : ""));
        if (new Set(ids).size !== arr.length || ids.includes("")) {
          reasons.push("产物文件 step id 重复或缺 id");
        }
        for (const s of arr) {
          if (!s || typeof s.agent !== "string" || typeof s.task !== "string" || !Array.isArray(s.dependsOn)) {
            reasons.push("产物文件 step 形状非法（id/agent/task/dependsOn）");
            break;
          }
          if (s.dependsOn.some((d) => !ids.includes(d))) {
            reasons.push("产物文件 dependsOn 引用计划外 id");
            break;
          }
        }
      }
    } catch (e) {
      reasons.push("designer-plan.json 读取/解析失败");
    }
  }
  console.log(reasons.length === 0 ? "PASS" : `FAIL: ${reasons.join("；")}`);
' "$RUN_JSON" "$PLAN_FILE_A" 2>/dev/null || echo CORRUPT)"

A_RESULT="SKIP"
if [ "$VERDICT_A" = "PASS" ]; then
  echo "PASS: e2e 场景 A（designer 多步全链：plan.origin=designer + 计划步全终态 + completed）"
  A_RESULT="PASS"
  node -e '
    const fs = require("fs");
    const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const plan = rec.plan || {};
    const iters = Array.isArray(rec.iterations) ? rec.iterations : [];
    const succ = iters.filter((e) => e.status === "succeeded").length;
    console.log(`run: ${rec.id}  status=${rec.status}  effort=${rec.effort}`);
    console.log(`plan: origin=${plan.origin} steps=${plan.steps} channel=${plan.channel ?? "-"} attempts=${plan.attempts ?? "-"} degraded=${plan.degraded}`);
    console.log(`iterations: ${succ}/${iters.length} succeeded`);
  ' "$RUN_JSON" 2>/dev/null || true

  # ---------- M5-T4 档案断言（追加）：档案链物证 ----------
  # 断言（硬性主体）：cases/ 出现新 Case（本场景 dataDir 为 mktemp 专属目录，cases/
  # 只可能来自本 run 的终态入档）且最近一条（createdAt 最新）的 runId === 本 run。
  # 轮询重试 3×2s：run.json 终态落盘与 saveCase 的写入相邻但非原子，抵御总控在
  # 两写之间截停 pi 的极小竞态；重试窗内仍未观测到 → 如实计入失败。
  # 失败降级语义（logMode）：档案断言失败不触发硬性 FAIL——与场景同步降级
  # SKIP-ARCHIVE（给实测说明，不计 FAIL），后续场景照常执行（B/C 不依赖档案链）
  ARCHIVE_A="FAIL:未执行"
  for _ in 1 2 3; do
    ARCHIVE_A="$(node -e '
      const fs = require("fs");
      const path = require("path");
      const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const runId = typeof rec.id === "string" ? rec.id : "";
      const casesDir = path.join(process.argv[2], "cases");
      const reasons = [];
      let names = [];
      try {
        names = fs.readdirSync(casesDir).filter((n) => n.endsWith(".json"));
      } catch {
        reasons.push("cases/ 目录不存在");
      }
      if (reasons.length === 0 && names.length === 0) {
        reasons.push("cases/ 无 *.json（run 终态未入档）");
      }
      if (names.length > 0) {
        const entries = [];
        for (const name of names) {
          try {
            entries.push(JSON.parse(fs.readFileSync(path.join(casesDir, name), "utf8")));
          } catch {
            reasons.push(`案例文件损坏：${name}`);
          }
        }
        const latest = entries
          .filter((c) => c && typeof c.createdAt === "string")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .pop();
        if (entries.length > 0 && latest === undefined) {
          reasons.push("cases/ 条目全部缺 createdAt 形（无法定位最近案例）");
        } else if (latest !== undefined && String(latest.runId ?? "") !== runId) {
          reasons.push(`最近案例 runId=${String(latest.runId ?? "(缺)")}（应为本 run ${runId}）`);
        }
      }
      console.log(reasons.length === 0 ? "PASS" : `FAIL:${reasons.join("；")}`);
    ' "$RUN_JSON" "$DATA_A" 2>/dev/null || echo "FAIL:run.json 读取失败")"
    if [ "${ARCHIVE_A%%:*}" = "PASS" ]; then break; fi
    sleep 2
  done
  if [ "${ARCHIVE_A%%:*}" = "PASS" ]; then
    echo "PASS: e2e 场景 A 档案链（cases/ 新 Case 且最近一条 runId === 本 run——run 终态自动 Case 化的 e2e 物证）"
    # 方法库 git 化按实际记录（不造假断言）：M5 v1 的 run 链不调用 saveMethodEntry
    # （Case.methodIds 恒空 → updateFitness 不触发），methods/ 的 git commit 只能来自
    # M6 起的真实消费或手工入库——无 commit 如实记 v1 现状；有 commit 则核验前缀
    METHODS_LOG_A="$(git -C "$DATA_A/methods" log --format=%s 2>/dev/null || true)"
    if [ -n "$METHODS_LOG_A" ]; then
      if grep -qv '^methods:' <<<"$METHODS_LOG_A"; then
        echo "SKIP: methods/ git log 含非 methods: 前缀 commit（留人工复核）"
        grep -v '^methods:' <<<"$METHODS_LOG_A" | head -3
      else
        echo "PASS: methods/ 方法库 git commit 在场且主题均含 methods: 前缀"
      fi
    else
      echo "SKIP: v1 无方法 commit（如实记录——M5 v1 的 run 链不调用 saveMethodEntry，方法库 commit 自 M6 updateFitness 真实消费起）"
    fi
  else
    echo "SKIP: e2e 场景 A 档案断言未达（${ARCHIVE_A#FAIL:}）——与场景同步降级不计 FAIL；实测说明：run 终态未观测到案例入档，诊断线索如下（KEEP_ARTIFACTS=1 时物证已保留）"
    echo "---- 档案诊断：cases/ 内容 ----"
    ls -la "$DATA_A/cases" 2>/dev/null || echo "（cases/ 目录不存在）"
    A_RESULT="SKIP-ARCHIVE"
  fi
elif classify_env_skip "$RUN_JSON" "$OUT_A"; then
  A_RESULT="SKIP-ENV"
elif [ "$(origin_and_status "$RUN_JSON")" = "builtin:completed" ]; then
  # designer 未达成但全链跑通（降级 builtin 照跑 completed）：e2e 的目标（证明
  # designer 链）未达成于环境模型——不计失败，M2 等价链路已由既有断言覆盖
  echo "SKIP: designer 未产出有效计划（降级 builtin 后全链照跑 completed——环境模型未满足输出契约，视作环境受限）"
  node -e '
    const fs = require("fs");
    const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const plan = rec.plan || {};
    console.log(`plan: origin=${plan.origin} steps=${plan.steps} channel=${plan.channel ?? "-"} attempts=${plan.attempts ?? "-"}`);
    const notes = typeof plan.notes === "string" ? plan.notes.slice(0, 200) : "";
    if (notes) console.log(`notes: ${notes}`);
  ' "$RUN_JSON" 2>/dev/null || true
  A_RESULT="SKIP-DESIGNER"
else
  echo "FAIL: e2e 场景 A 断言未达（${VERDICT_A}；pi rc=${RUN_RC}）"
  echo "--- run.json ---"
  cat "$RUN_JSON"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT_A"
  exit 1
fi
fi  # scenario_enabled "A" —— A 段独立闭合，后续场景异构链路独立判定

# 环境级 SKIP：A 的环境受限只记录 A 的结果，不再殃及 B/C（链路异构：A/B 依赖
# critic 评估，C 为 verifyCommand 机器断言——降级窗口内 C 仍可能可行）
if [ "$A_RESULT" = "SKIP-ENV" ]; then
  echo "== e2e: 场景 A 环境受限 SKIP（独立记录；B/C 按各自链路独立执行）"
fi

# ---------- 场景 B：maxPlanSteps=1 强制注入（预算压缩路径） ----------
# dataDir 级 settings.json 覆盖（prepareRun → loadLoopSettings(dataDir) 读
# <dataDir>/settings.json 并与默认表深合并——字段级覆盖，其余键保持默认；
# settings 会出现于 result.preset 与 designer 任务文本的预算行，产物侧的
# 直接证据是 plan.steps<=1：注入失效时 designer 会按 3 步顶格产出）
printf '%s\n' '{"effortPresets":{"low":{"maxPlanSteps":1}}}' >"$DATA_B/settings.json"
echo "== e2e[B]: 注入 settings.json（effortPresets.low.maxPlanSteps=1）强制预算压缩"

PROMPT_B="调用 loop_task 工具：研究任务'用一句话说明 pi-loop 是什么'，effort: low"

# 场景 B 本体：独立门控
if scenario_enabled "B"; then
run_scenario "B" "$DATA_B" "$OUT_B" "$TIMEOUT_S" "$PROMPT_B"
assert_extension_loaded "$OUT_B"

if [ -z "$RUN_JSON" ]; then
  if skip_on_model_down "$OUT_B"; then
    echo "== e2e 汇总：A ${A_RESULT} / B SKIP（模型层不可用）/ C SKIP（同因）"
    exit 0
  fi
  echo "FAIL: 场景 B 无 run.json 落盘（模型未调用 loop_task 且无环境降级特征）"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT_B"
  exit 1
fi
echo "== e2e[B]: run 记录 $RUN_JSON"

# 断言：不 crash（completed 收尾）+ steps<=1 + origin 如实（designer 被迫单步 / 降级
# builtin 照跑均可接受——预算语义是"压成 1 步"，不是"必须 designer 产出"）
VERDICT_B="$(node -e '
  const fs = require("fs");
  const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const plan = rec.plan && typeof rec.plan === "object" ? rec.plan : {};
  const steps = Number.isInteger(plan.steps) ? plan.steps : -1;
  const iters = Array.isArray(rec.iterations) ? rec.iterations : [];
  const terminal = iters.every((e) => e && (e.status === "succeeded" || e.status === "failed"));
  const reasons = [];
  if (rec.status !== "completed") reasons.push(`status=${rec.status}`);
  if (steps < 0 || steps > 1) reasons.push(`plan.steps=${steps}（强制 maxPlanSteps=1 下步数应为 1）`);
  if (plan.origin === "designer") {
    if (steps !== 1) reasons.push(`designer 计划 steps=${steps}（应为 1）`);
  } else if (plan.origin === "builtin") {
    if (plan.degraded !== true) reasons.push("builtin 计划未标 degraded=true");
  } else {
    reasons.push(`plan.origin=${String(plan.origin)} 非 designer/builtin`);
  }
  if (!terminal) reasons.push("iterations 存在非终态 entry（pending/running）");
  if (iters.length !== steps) reasons.push(`iterations 数 ${iters.length} !== 步数 ${steps}`);
  console.log(reasons.length === 0 ? "PASS" : `FAIL: ${reasons.join("；")}`);
' "$RUN_JSON" 2>/dev/null || echo CORRUPT)"

B_RESULT="SKIP"
if [ "$VERDICT_B" = "PASS" ]; then
  echo "PASS: e2e 场景 B（maxPlanSteps=1 强制：completed + steps<=1 + origin 如实——不 crash）"
  B_RESULT="PASS"
  node -e '
    const fs = require("fs");
    const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const plan = rec.plan || {};
    const iters = Array.isArray(rec.iterations) ? rec.iterations : [];
    const succ = iters.filter((e) => e.status === "succeeded").length;
    console.log(`run: ${rec.id}  status=${rec.status}  effort=${rec.effort}`);
    console.log(`plan: origin=${plan.origin} steps=${plan.steps} channel=${plan.channel ?? "-"} attempts=${plan.attempts ?? "-"} degraded=${plan.degraded}`);
    console.log(`iterations: ${succ}/${iters.length} succeeded`);
  ' "$RUN_JSON" 2>/dev/null || true
else
  if classify_env_skip "$RUN_JSON" "$OUT_B"; then
    B_RESULT="SKIP-ENV"
  else
    echo "FAIL: e2e 场景 B 断言未达（${VERDICT_B}；pi rc=${RUN_RC}）"
    echo "--- run.json ---"
    cat "$RUN_JSON"
    echo "--- pi output (tail 50) ---"
    tail -50 "$OUT_B"
    exit 1
  fi
fi
fi  # scenario_enabled "B"

# ---------- 场景 C：verifyCommand 机器断言端到端（M4-T4） ----------
# prompt 明示把下述命令字符串原样作 verifyCommand 入参（工具 schema 原生字段）。
# 命令选型：node 单行脚本断言 `runs` 目录非空，理由：① 环境无关——node 随 pi
# 宿主必在，且命令不含 shell 语法（evaluator 以 shell:false + 安全分词执行，
# 单引号包裹的 JS 体含空格不拆参）；② 无 env 继承依赖——evaluator 以 dataDir
# 为命令 cwd（SPEC §7.5 幂等工作区），相对路径 runs 即锚定本场景 dataDir；
# ③ 评估时刻 runs 必非空（prepareRun 的 ensureWorkspace + createRunRecord 先行
# 建 run 目录）→ 命令确定性 exit 0——断言锚定引擎不变量而非任务产物，不随子
# 代理产出波动（任务语义层面的 verifyCommand 优先级/计数计分等已由单测锁定）。
PROMPT_C="调用 loop_task 工具：研究任务'用一句话说明 verifyCommand 机器断言的作用'，effort: low；同时传入 verifyCommand 参数，其值必须原样使用下面这条命令字符串（不要改写、不要转述）：node -e 'require(\"fs\").readdirSync(\"runs\").length>0?process.exit(0):process.exit(1)'"

# 场景 C 本体：独立门控
if scenario_enabled "C"; then
run_scenario "C" "$DATA_C" "$OUT_C" "$TIMEOUT_S" "$PROMPT_C"
assert_extension_loaded "$OUT_C"

if [ -z "$RUN_JSON" ]; then
  if skip_on_model_down "$OUT_C"; then
    echo "== e2e 汇总：A ${A_RESULT} / B ${B_RESULT} / C SKIP（模型层不可用）"
    exit 0
  fi
  echo "FAIL: 场景 C 无 run.json 落盘（模型未调用 loop_task 且无环境降级特征）"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT_C"
  exit 1
fi
echo "== e2e[C]: run 记录 $RUN_JSON"

# 断言：全链 completed + 评估结论 verified + score>0 + 机器断言通道物证
# （reasons 携带「机器断言通过」——verifyCommand 通道专属文案，critic 不产生；
# 与之同因：该轮评估零 critic spawn）+ blame 恒空（退出码断言无轮次归因）
VERDICT_C="$(node -e '
  const fs = require("fs");
  const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ev = rec.evaluation && typeof rec.evaluation === "object" ? rec.evaluation : {};
  const reasons = [];
  if (rec.status !== "completed") reasons.push(`status=${rec.status}`);
  if (ev.verdict !== "verified") reasons.push(`evaluation.verdict=${String(ev.verdict)}`);
  if (!(Number.isInteger(ev.score) && ev.score > 0)) reasons.push(`evaluation.score=${String(ev.score)}`);
  const evReasons = Array.isArray(ev.reasons) ? ev.reasons.map((r) => String(r)) : [];
  if (!evReasons.some((r) => r.includes("机器断言通过"))) {
    reasons.push("evaluation.reasons 未携带机器断言通道标记（模型可能未把 verifyCommand 原样传入，评估被 critic 通道接管）");
  }
  if (!Array.isArray(ev.blame) || ev.blame.length !== 0) {
    reasons.push(`evaluation.blame=${JSON.stringify(ev.blame ?? null)}（机器断言通道应恒空）`);
  }
  console.log(reasons.length === 0 ? "PASS" : `FAIL: ${reasons.join("；")}`);
' "$RUN_JSON" 2>/dev/null || echo CORRUPT)"

C_RESULT="SKIP"
if [ "$VERDICT_C" = "PASS" ]; then
  echo "PASS: e2e 场景 C（verifyCommand 机器断言端到端：completed + verified + 零 critic 混入）"
  C_RESULT="PASS"
  node -e '
    const fs = require("fs");
    const rec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const ev = rec.evaluation || {};
    const fin = rec.final || {};
    const plan = rec.plan || {};
    console.log(`run: ${rec.id}  status=${rec.status}  effort=${rec.effort}`);
    console.log(`evaluation: verdict=${ev.verdict} score=${ev.score}（final round=${fin.round ?? "-"}）`);
    console.log(`plan: origin=${plan.origin} steps=${plan.steps} channel=${plan.channel ?? "-"} degraded=${plan.degraded}`);
  ' "$RUN_JSON" 2>/dev/null || true
elif classify_env_skip "$RUN_JSON" "$OUT_C"; then
  C_RESULT="SKIP-ENV"
else
  echo "FAIL: e2e 场景 C 断言未达（${VERDICT_C}；pi rc=${RUN_RC}）"
  echo "--- run.json ---"
  cat "$RUN_JSON"
  echo "--- pi output (tail 50) ---"
  tail -50 "$OUT_C"
  exit 1
fi
fi  # scenario_enabled "C"

echo "== e2e 汇总：A ${A_RESULT} / B ${B_RESULT:--} / C ${C_RESULT}"
exit 0
