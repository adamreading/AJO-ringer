#!/bin/sh
# Check: engine/runner.py claims a queued task and turns it into a real swarm run
# end-to-end, via the ZERO-COST mock engine. Files the phase2-mock-mechanics
# manifest as a task body, runs run_once, and asserts the task lands 'done' with a
# DONE receipt referencing the child run — plus the bad-body -> needs_input path.
# Uses a THROWAWAY queue schema (never touches live queue data); the child mock
# run is real but free (engine=mock, no tokens). Needs RINGER_DB_DSN + the venv.
set -u

: "${RINGER_DB_DSN:?FAIL: RINGER_DB_DSN not set (source ~/.config/ringer/engine.env)}"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found at $PY"; exit 1; }
test -f /home/ajo/ringer/engine/runner.py || { echo "FAIL: engine/runner.py not found"; exit 1; }
test -f /home/ajo/ringer/manifests/phase2-mock-mechanics.json || { echo "FAIL: mock manifest missing"; exit 1; }

cd /home/ajo/ringer
"$PY" - <<'PY'
import json, os, sys
from pathlib import Path
import psycopg
from engine.store import Store
from engine import runner

SCHEMA = f"engine_runner_test_{os.getpid()}"
dsn = os.environ["RINGER_DB_DSN"]
store = Store(dsn, schema=SCHEMA)

problems = []
def check(cond, msg):
    if not cond: problems.append(msg)

def rtypes(tid):
    return [r["receipt_type"] for r in store.get_task(tid)["receipts"]]

try:
    store.init_schema()

    # 1. Happy path: a valid mock manifest body -> full swarm run -> done + DONE.
    body = Path("manifests/phase2-mock-mechanics.json").read_text(encoding="utf-8")
    t = store.file_task(agent_code="ringer", title="mock mechanics", body=body)
    tid = t["id"]
    # dashboard=False keeps the check hermetic (automated-test exception to the
    # never-go-dark rule); python3 = stdlib ringer, matching production.
    final = runner.run_once(store, agent_code="ringer", identity="engine-runner-check",
                            dashboard=False, timeout=180)
    check(final is not None, "run_once returned None (claimed nothing?)")
    if final:
        check(final["id"] == tid, "run_once acted on the wrong task")
        check(final["status"] == "done", f"expected status 'done', got {final['status']!r}")
        check(not final.get("claimed_by"), "done task must have its claim cleared")
    rts = rtypes(tid)
    check("CLAIMED" in rts, "must have a CLAIMED receipt")
    check("DONE" in rts, "must have a DONE receipt")
    # DONE receipt must reference the child run with rc=0 and all-pass.
    done = [r for r in store.get_task(tid)["receipts"] if r["receipt_type"] == "DONE"][-1]
    summ = json.loads(done["body"])
    check(summ.get("returncode") == 0, f"DONE summary returncode must be 0, got {summ.get('returncode')}")
    check(summ.get("child_run_id"), "DONE summary must carry the child run_id")
    check((summ.get("fail") or 0) == 0, f"mock run should have 0 failures, got fail={summ.get('fail')}")
    check((summ.get("pass") or 0) >= 1, f"mock run should have >=1 pass, got pass={summ.get('pass')}")

    # 2. Idle: nothing left to claim -> None.
    check(runner.run_once(store, agent_code="ringer", dashboard=False) is None,
          "run_once must return None when the queue is drained")

    # 2b. Plain-text BRIEF (Lunk's lane) must be IGNORED by the headless runner —
    # it's for the orchestrator brain, not the engine. run_once leaves it untouched.
    brief = store.file_task(agent_code="ringer", title="a plain question?",
                            body="just some plain text, not a manifest", task_kind="brief")
    check(runner.run_once(store, agent_code="ringer", dashboard=False) is None,
          "runner must NOT claim a plain-text brief (task_kind=brief)")
    check(store.get_task(brief["id"])["task"]["status"] == "todo",
          "brief must stay 'todo' for the orchestrator to pick up (not needs_input/failed)")

    # 3. Bad body: not a manifest -> needs_input + BLOCKED (graceful, not a crash).
    b = store.file_task(agent_code="ringer", title="junk", body="this is not json")
    fb = runner.run_once(store, agent_code="ringer", dashboard=False)
    check(fb and fb["id"] == b["id"] and fb["status"] == "needs_input",
          f"bad body must -> needs_input, got {fb and fb['status']!r}")
    check(fb and fb.get("blocked_reason"), "bad body must set blocked_reason")
    check("BLOCKED" in rtypes(b["id"]), "bad body must write a BLOCKED receipt")

finally:
    try:
        with psycopg.connect(dsn) as c, c.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    except Exception as e:
        print(f"WARN: could not drop test schema {SCHEMA}: {e!r}", file=sys.stderr)

if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("PASS: engine/runner.py — claim -> ringer.py run (mock) -> DONE receipt; bad-body -> needs_input")
PY
