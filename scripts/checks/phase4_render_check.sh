#!/bin/sh
# Phase-4 check: ringer.py renders a "Served by" telemetry strip for tasks
# carrying a task["feeder"] block, and stays byte-safe when the block is absent.
# Runs with cwd = the task's git worktree of the ringer repo.
set -u

mkdir -p /tmp/ringer-phase4-telemetry/patches
git add -A 2>/dev/null && git diff --cached > /tmp/ringer-phase4-telemetry/patches/render-hook.patch 2>/dev/null
test -s /tmp/ringer-phase4-telemetry/patches/render-hook.patch || {
  echo 'FAIL: exported patch is empty — no staged changes in the worktree'; exit 1; }

python3 -m py_compile ringer.py || { echo 'FAIL: ringer.py does not compile'; exit 1; }

python3 - <<'PY'
import sys
sys.path.insert(0, ".")
import ringer

feeder_block = {
    "sessions": ["ses_test1"],
    "served": [
        {"platform": "sambanova", "model_id": "DeepSeek-V3.1", "calls": 2, "output_tokens": 38},
        {"platform": "nvidia", "model_id": "mistral-large-3", "calls": 1, "output_tokens": 2},
    ],
    "failovers": 1, "mixed_models": True, "requests": 4, "errors_429": 1,
    "latency_ms_total": 2270, "latency_ms_p50": 610,
}
state = {
    "run_id": "check-run", "run_name": "check-run", "identity": "check",
    "tasks": [
        {"key": "alpha", "status": "pass", "engine": "opencode",
         "model": "feeder/auto/coding", "attempts": 1, "elapsed_s": 8.1,
         "feeder": feeder_block},
        {"key": "bravo", "status": "pass", "engine": "opencode",
         "model": "feeder/auto/coding", "attempts": 1, "elapsed_s": 8.1},
    ],
}
try:
    html = ringer.render_final_report_html(state, renderer=None, page_path=None)
except Exception as exc:  # noqa: BLE001
    print(f"FAIL: render_final_report_html raised {type(exc).__name__}: {exc}")
    sys.exit(1)

low = html.lower()
problems = []
if "served by" not in low:
    problems.append("no 'Served by' strip anywhere in the report")
if "deepseek-v3.1" not in low:
    problems.append("served model DeepSeek-V3.1 not shown")
if "mistral-large-3" not in low:
    problems.append("failover model mistral-large-3 not shown")
if low.count("served by") != 1:
    problems.append(
        f"'Served by' appears {low.count('served by')} time(s) — expected exactly 1 "
        "(alpha has telemetry, bravo must render without it)")
if problems:
    print("FAIL:", "; ".join(problems))
    sys.exit(1)
print("PASS: report shows the telemetry strip for alpha only; bravo unchanged; render is fail-open")
PY
status=$?
test $status -eq 0 || exit $status
echo "render check: green; patch exported to /tmp/ringer-phase4-telemetry/patches/render-hook.patch"
