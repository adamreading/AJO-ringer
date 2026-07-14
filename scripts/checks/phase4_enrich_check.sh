#!/bin/sh
# Phase-4 check: scripts/feeder_enrich.py aggregation contract (fixture mode).
# Runs with cwd = the task's git worktree of the ringer repo.
set -u

mkdir -p /tmp/ringer-phase4-telemetry/patches
git add -A 2>/dev/null && git diff --cached > /tmp/ringer-phase4-telemetry/patches/enrich-script.patch 2>/dev/null
test -s /tmp/ringer-phase4-telemetry/patches/enrich-script.patch || {
  echo 'FAIL: exported patch is empty — no staged changes in the worktree'; exit 1; }
test -f scripts/feeder_enrich.py || { echo 'FAIL: scripts/feeder_enrich.py missing'; exit 1; }

python3 - <<'PY'
import json, pathlib, subprocess, sys, tempfile

tmp = pathlib.Path(tempfile.mkdtemp(prefix="enrich-check-"))
work = tmp / "work" / "alpha"
work.mkdir(parents=True)
(work / "worker.log").write_text(
    'noise line\n'
    '{"type":"step_start","sessionID":"ses_test1","part":{}}\n'
    'more {"sessionID":"ses_test1"} repeats should dedupe\n'
)
state_path = tmp / "state.json"
state_path.write_text(json.dumps({
    "run_id": "check-run", "run_name": "check-run",
    "tasks": [{"key": "alpha", "status": "pass"}],
}))
rows = {"ses_test1": [
    {"platform": "sambanova", "model_id": "DeepSeek-V3.1", "status": "success",
     "output_tokens": 20, "input_tokens": 100, "latency_ms": 600, "created_at": "2026-07-14T12:00:01Z"},
    {"platform": "sambanova", "model_id": "DeepSeek-V3.1", "status": "success",
     "output_tokens": 18, "input_tokens": 120, "latency_ms": 620, "created_at": "2026-07-14T12:00:02Z"},
    {"platform": "sambanova", "model_id": "DeepSeek-V3.1", "status": "429",
     "output_tokens": 0, "input_tokens": 0, "latency_ms": 150, "created_at": "2026-07-14T12:00:03Z"},
    {"platform": "nvidia", "model_id": "mistral-large-3", "status": "success",
     "output_tokens": 2, "input_tokens": 140, "latency_ms": 900, "created_at": "2026-07-14T12:00:04Z"},
]}
fixture = tmp / "rows.json"
fixture.write_text(json.dumps(rows))

proc = subprocess.run(
    [sys.executable, "scripts/feeder_enrich.py",
     "--state", str(state_path), "--workdir", str(tmp / "work"),
     "--fixture", str(fixture)],
    capture_output=True, text=True)
if proc.returncode != 0:
    print("FAIL: feeder_enrich.py exited", proc.returncode)
    print(proc.stdout); print(proc.stderr); sys.exit(1)

task = json.loads(state_path.read_text())["tasks"][0]
fb = task.get("feeder")
if not fb:
    print("FAIL: no task['feeder'] block written back to the state JSON"); sys.exit(1)

def expect(name, got, want):
    if got != want:
        print(f"FAIL: feeder.{name} = {got!r}, expected {want!r}"); sys.exit(1)

expect("sessions", fb.get("sessions"), ["ses_test1"])
expect("served", fb.get("served"), [
    {"platform": "sambanova", "model_id": "DeepSeek-V3.1", "calls": 2, "output_tokens": 38},
    {"platform": "nvidia", "model_id": "mistral-large-3", "calls": 1, "output_tokens": 2},
])
expect("failovers", fb.get("failovers"), 1)
expect("mixed_models", fb.get("mixed_models"), True)
expect("requests", fb.get("requests"), 4)
expect("errors_429", fb.get("errors_429"), 1)
expect("latency_ms_total", fb.get("latency_ms_total"), 2270)
expect("latency_ms_p50", fb.get("latency_ms_p50"), 610)
print("PASS: aggregation contract satisfied —", json.dumps(fb, indent=1)[:400])
PY
status=$?
test $status -eq 0 || exit $status
echo "enrich check: all assertions green; patch exported to /tmp/ringer-phase4-telemetry/patches/enrich-script.patch"
