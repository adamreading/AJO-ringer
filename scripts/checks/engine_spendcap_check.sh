#!/bin/sh
# Check: the runner's spend-cap wiring (engine/runner.py budget-set + loud-breach).
#  (a) LIVE feeder: declare_budget + budget_status round-trip against the running
#      enforcer (POST/GET /api/swarm/budget).
#  (b) FAIL-LOUD: a budget breach -> task 'failed' + FAILED receipt carrying
#      code=run_budget_exceeded {spent,budget} (Adam's directive), regardless of rc.
#  (c) no breach -> normal 'done'.
# (b)/(c) drive the ZERO-COST mock engine on a throwaway queue schema. Needs the
# venv + RINGER_DB_DSN; (a) needs feeder up (skips gracefully if not). POSIX/dash.
set -u

: "${RINGER_DB_DSN:?FAIL: RINGER_DB_DSN not set (source ~/.config/ringer/engine.env)}"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found"; exit 1; }
cd /home/ajo/ringer

"$PY" - <<'PY'
import json, os, sys
from pathlib import Path
import psycopg
from engine.store import Store
from engine import runner

problems = []
def check(cond, msg):
    if not cond: problems.append(msg)

# (a) LIVE feeder round-trip (skip if feeder unreachable — not a failure of ours).
fake = f"ringer-spendcap-check-{os.getpid()}"
declared = runner.declare_budget(fake, 500000)
if declared is None:
    print("NOTE: feeder unreachable — skipping live budget round-trip (a)")
else:
    check(declared.get("budget") == 500000, f"(a) declare budget must echo 500000, got {declared.get('budget')}")
    st = runner.budget_status(fake)
    check(st and st.get("budget") == 500000, "(a) budget_status must read back the declared ceiling")
    check(runner.budget_status("nonexistent-xyz-000") is None, "(a) undeclared run -> None (404 handled)")

SCHEMA = f"engine_spendcap_test_{os.getpid()}"
dsn = os.environ["RINGER_DB_DSN"]
store = Store(dsn, schema=SCHEMA)
orig_status = runner.budget_status
try:
    store.init_schema()
    body = Path("manifests/phase2-mock-mechanics.json").read_text(encoding="utf-8")

    # (b) FAIL-LOUD breach: force budget_status to report over-budget.
    runner.budget_status = lambda tid: {"budget": 1, "spent": 50}
    b = store.file_task(agent_code="ringer", title="breach", body=body)
    fb = runner.run_once(store, agent_code="ringer", identity="spendcap-check",
                         dashboard=False, budget_tokens=None, timeout=180)
    check(fb and fb["status"] == "failed", f"(b) breach must -> failed, got {fb and fb['status']!r}")
    recs = store.get_task(b["id"])["receipts"]
    fr = [r for r in recs if r["receipt_type"] == "FAILED"]
    check(fr, "(b) breach must write a FAILED receipt")
    if fr:
        payload = json.loads(fr[-1]["body"])
        check(payload.get("code") == "run_budget_exceeded", "(b) FAILED receipt must carry code=run_budget_exceeded")
        check(payload.get("spent") == 50 and payload.get("budget") == 1, "(b) FAILED receipt must carry {spent,budget}")

    # (c) no breach -> normal done.
    runner.budget_status = lambda tid: None
    c = store.file_task(agent_code="ringer", title="ok", body=body)
    fc = runner.run_once(store, agent_code="ringer", identity="spendcap-check",
                         dashboard=False, budget_tokens=None, timeout=180)
    check(fc and fc["status"] == "done", f"(c) no-breach must -> done, got {fc and fc['status']!r}")

finally:
    runner.budget_status = orig_status
    try:
        with psycopg.connect(dsn) as cn, cn.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    except Exception as e:
        print(f"WARN: could not drop test schema: {e!r}", file=sys.stderr)

if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("PASS: engine/runner.py spend-cap — live budget round-trip + fail-loud breach (FAILED receipt) + clean done")
PY
