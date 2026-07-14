#!/bin/sh
# Check: feeder_enrich.py --rerender re-renders a run's artifact pages so the
# enriched "Served by" strips actually appear. Runs with cwd = task worktree.
set -u

mkdir -p /tmp/ringer-rerender/patches
git add -A 2>/dev/null && git diff --cached > /tmp/ringer-rerender/patches/rerender.patch 2>/dev/null
test -s /tmp/ringer-rerender/patches/rerender.patch || {
  echo 'FAIL: exported patch is empty — no staged changes in the worktree'; exit 1; }

python3 - <<'PY'
import json, pathlib, subprocess, sys, tempfile

tmp = pathlib.Path(tempfile.mkdtemp(prefix="rerender-check-"))
work = tmp / "work" / "alpha"; work.mkdir(parents=True)
(work / "worker.log").write_text('{"type":"x","sessionID":"ses_test1"}\n')
state_path = tmp / "state.json"
state_path.write_text(json.dumps({
    "run_id": "check-run-id", "run_name": "check-run-name",
    "tasks": [{"key": "alpha", "status": "pass", "model": "feeder/auto/coding"}],
}))
fixture = tmp / "rows.json"
fixture.write_text(json.dumps({"ses_test1": [
    {"platform": "sambanova", "model_id": "DeepSeek-V3.1", "status": "success",
     "output_tokens": 20, "input_tokens": 100, "latency_ms": 600,
     "created_at": "2026-07-14T12:00:01Z"},
]}))
art = tmp / "artifacts"; (art / "live").mkdir(parents=True)
report = art / "check-run-id-report.html"; report.write_text("stub")
live = art / "live" / "check-run-name.html"; live.write_text("stub")
status_page = art / "check-run-id.html"; status_page.write_text("stub")
stray = art / "live" / "other-run.html"; stray.write_text("stub")

proc = subprocess.run(
    [sys.executable, "scripts/feeder_enrich.py",
     "--state", str(state_path), "--workdir", str(tmp / "work"),
     "--fixture", str(fixture), "--rerender", "--artifacts-dir", str(art)],
    capture_output=True, text=True)
if proc.returncode != 0:
    print("FAIL: exited", proc.returncode); print(proc.stdout); print(proc.stderr); sys.exit(1)

problems = []
for out in (report, live, status_page):
    html = out.read_text()
    if "served by" not in html.lower():
        problems.append(f"{out.name} has no 'Served by' strip after --rerender")
    if "deepseek-v3.1" not in html.lower():
        problems.append(f"{out.name} does not show the served model")
if stray.read_text() != "stub":
    problems.append("a different run's live page was touched — must only render THIS run's pages")

proc2 = subprocess.run(
    [sys.executable, "scripts/feeder_enrich.py",
     "--state", str(state_path), "--workdir", str(tmp / "work"),
     "--fixture", str(fixture)],
    capture_output=True, text=True)
if proc2.returncode != 0:
    problems.append("running WITHOUT --rerender broke (must stay the default no-render behavior)")

if problems:
    print("FAIL:", "; ".join(problems)); sys.exit(1)
print("PASS: --rerender rewrote exactly this run's report + live pages with the strips; no-flag path unchanged")
PY
status=$?
test $status -eq 0 || exit $status
echo "rerender check: green; patch exported to /tmp/ringer-rerender/patches/rerender.patch"
