#!/bin/sh
# Check: the always-on runner activation (engine/runner.py serve/wake/start_background
# + engine/app.py lifespan gating). Verifies: (a) serve() drains queued tasks one
# per pass (zero-cost mock); (b) wake() signals an immediate claim; (c) the app
# starts the runner ONLY when RINGER_ENGINE_AUTORUN=1 (default OFF — safe). Uses a
# throwaway queue schema. Needs venv + RINGER_DB_DSN. POSIX/dash-safe.
set -u

: "${RINGER_DB_DSN:?FAIL: RINGER_DB_DSN not set}"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found"; exit 1; }
cd /home/ajo/ringer

"$PY" - <<'PY'
import json, os, sys, time
from pathlib import Path
import psycopg
from engine.store import Store
from engine import runner

problems = []
def check(cond, msg):
    if not cond: problems.append(msg)

# (b) wake() sets the wake event.
runner._WAKE.clear()
runner.wake()
check(runner._WAKE.is_set(), "(b) wake() must set the wake event")

SCHEMA = f"engine_autorun_test_{os.getpid()}"
dsn = os.environ["RINGER_DB_DSN"]
store = Store(dsn, schema=SCHEMA)
try:
    store.init_schema()
    body = Path("manifests/phase2-mock-mechanics.json").read_text(encoding="utf-8")

    # (a) serve() drains queued tasks one-per-pass (bounded via max_passes; mock=free).
    t1 = store.file_task(agent_code="ringer", title="a", body=body)
    t2 = store.file_task(agent_code="ringer", title="b", body=body)
    runner.serve(store, dashboard=False, budget_tokens=None, poll_interval=0.1, max_passes=2)
    s1 = store.get_task(t1["id"])["task"]["status"]
    s2 = store.get_task(t2["id"])["task"]["status"]
    check(s1 == "done" and s2 == "done", f"(a) serve() must drain both tasks to done, got {s1!r},{s2!r}")

    # (a') serve() returns promptly on an empty queue (idle wait honored, wake breaks it).
    runner._STOP.clear(); runner.wake()  # pre-wake so the idle wait returns immediately
    t0 = time.time()
    runner.serve(store, dashboard=False, budget_tokens=None, poll_interval=30, max_passes=1)
    check(time.time() - t0 < 5, "(a') idle serve() with a pending wake must not block on poll_interval")

finally:
    try:
        with psycopg.connect(dsn) as c, c.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    except Exception as e:
        print(f"WARN: could not drop test schema: {e!r}", file=sys.stderr)

if problems:
    print("FAIL:")
    for p in problems: print("  -", p)
    sys.exit(1)
print("PASS: runner serve()/wake() drain + signal OK")
PY
[ $? -ne 0 ] && exit 1

# (c) app gates autorun on the env flag — module-level read, no thread started here.
echo "--- autorun flag gating ---"
OFF=$("$PY" -c "import os; os.environ.pop('RINGER_ENGINE_AUTORUN',None); import engine.app as a; print(a.AUTORUN)")
ON=$(RINGER_ENGINE_AUTORUN=1 "$PY" -c "import engine.app as a; print(a.AUTORUN)")
test "$OFF" = "False" || { echo "FAIL: AUTORUN must default False (got $OFF)"; exit 1; }
test "$ON" = "True"   || { echo "FAIL: RINGER_ENGINE_AUTORUN=1 must enable AUTORUN (got $ON)"; exit 1; }

echo "PASS: engine autorun — serve/wake drain+signal, app gates on RINGER_ENGINE_AUTORUN (default OFF)"
