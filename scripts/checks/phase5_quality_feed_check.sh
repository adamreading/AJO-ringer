#!/bin/sh
# Phase-5 check: scripts/quality_feed.py sample-building contract (dry-run mode).
# Runs with cwd = the task's git worktree of the ringer repo.
set -u

mkdir -p /tmp/ringer-phase5-quality/patches
git add -A 2>/dev/null && git diff --cached > /tmp/ringer-phase5-quality/patches/quality-feed.patch 2>/dev/null
test -s /tmp/ringer-phase5-quality/patches/quality-feed.patch || {
  echo 'FAIL: exported patch is empty — no staged changes in the worktree'; exit 1; }
test -f scripts/quality_feed.py || { echo 'FAIL: scripts/quality_feed.py missing'; exit 1; }

python3 - <<'PY'
import json, pathlib, subprocess, sys, tempfile

tmp = pathlib.Path(tempfile.mkdtemp(prefix="qfeed-check-"))
state = {
    "run_id": "check-run", "run_name": "check-run",
    "tasks": [
        {"key": "alpha", "status": "pass", "model": "feeder/auto/coding",
         "feeder": {"served": [{"platform": "sambanova", "model_id": "DeepSeek-V3.1",
                                 "calls": 2, "output_tokens": 38}],
                     "mixed_models": False, "failovers": 0}},
        {"key": "bravo", "status": "pass", "model": "feeder/auto/reasoning",
         "feeder": {"served": [{"platform": "sambanova", "model_id": "DeepSeek-V3.1",
                                 "calls": 2, "output_tokens": 30},
                                {"platform": "nvidia", "model_id": "mistral-large-3",
                                 "calls": 1, "output_tokens": 2}],
                     "mixed_models": True, "failovers": 1}},
        {"key": "charlie", "status": "fail", "model": "feeder/auto/coding"},
        {"key": "delta", "status": "pass", "model": "feeder/auto/coding",
         "feeder": {"served": [{"platform": "zhipu", "model_id": "glm-5.1",
                                 "calls": 3, "output_tokens": 60}],
                     "mixed_models": False, "failovers": 0}},
    ],
}
state_path = tmp / "state.json"
state_path.write_text(json.dumps(state))

proc = subprocess.run(
    [sys.executable, "scripts/quality_feed.py", "--state", str(state_path),
     "--grade", "alpha=0.9", "--dry-run"],
    capture_output=True, text=True)
if proc.returncode != 0:
    print("FAIL: quality_feed.py exited", proc.returncode)
    print(proc.stdout); print(proc.stderr); sys.exit(1)
try:
    out = json.loads(proc.stdout)
except json.JSONDecodeError:
    print("FAIL: --dry-run stdout is not a single JSON document:")
    print(proc.stdout[:800]); sys.exit(1)

expected_samples = [
    {"model_id": "sambanova/DeepSeek-V3.1", "task_class": "coding",
     "quality_score": 0.9, "judge": "ringer"},
    {"model_id": "zhipu/glm-5.1", "task_class": "coding",
     "quality_score": 0.8, "judge": "ringer"},
]
if out.get("samples") != expected_samples:
    print("FAIL: samples mismatch.")
    print("  expected:", json.dumps(expected_samples))
    print("  got:     ", json.dumps(out.get("samples"))); sys.exit(1)

skipped = {s.get("key"): s.get("reason") for s in out.get("skipped", [])}
if set(skipped) != {"bravo", "charlie"}:
    print(f"FAIL: skipped keys {sorted(skipped)}, expected ['bravo', 'charlie']"); sys.exit(1)
if "mixed" not in str(skipped["bravo"]).lower():
    print(f"FAIL: bravo skip reason {skipped['bravo']!r} should mention mixed models"); sys.exit(1)
if "served" not in str(skipped["charlie"]).lower():
    print(f"FAIL: charlie skip reason {skipped['charlie']!r} should mention no served model"); sys.exit(1)

bad = subprocess.run(
    [sys.executable, "scripts/quality_feed.py", "--state", str(state_path),
     "--grade", "alpha=1.7", "--dry-run"],
    capture_output=True, text=True)
if bad.returncode == 0:
    print("FAIL: out-of-range grade 1.7 was accepted (must exit nonzero)"); sys.exit(1)

print("PASS: samples exact (graded + default-pass), mixed/no-model skipped with reasons, bad grade rejected")
PY
status=$?
test $status -eq 0 || exit $status
echo "quality-feed check: green; patch exported to /tmp/ringer-phase5-quality/patches/quality-feed.patch"
