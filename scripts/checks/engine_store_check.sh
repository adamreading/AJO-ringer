#!/bin/sh
# Check: engine/store.py (Postgres queue store) is correct. Drives executable
# scenarios against a THROWAWAY schema on the ringer DB (never touches live queue
# data), covering claim / lease / attempt-cap / gate / needs_input / persistence.
# Needs RINGER_DB_DSN + the repo venv (psycopg). POSIX/dash-safe.
set -u

: "${RINGER_DB_DSN:?FAIL: RINGER_DB_DSN not set (source ~/.config/ringer/engine.env)}"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found at $PY"; exit 1; }
test -f /home/ajo/ringer/engine/store.py || { echo "FAIL: engine/store.py not found"; exit 1; }

cd /home/ajo/ringer
"$PY" - <<'PY'
import os, sys
from engine.store import Store
import psycopg

problems = []
def check(cond, msg):
    if not cond: problems.append(msg)

SCHEMA = f"engine_test_{os.getpid()}"
dsn = os.environ["RINGER_DB_DSN"]
store = Store(dsn, schema=SCHEMA)

def truncate():
    with psycopg.connect(dsn) as c, c.cursor() as cur:
        cur.execute(f'TRUNCATE "{SCHEMA}".agent_task_receipts, "{SCHEMA}".agent_tasks RESTART IDENTITY CASCADE')

def fresh():
    truncate()
    return store

def rtypes(res):
    return [r.get("receipt_type") for r in (res.get("receipts") or [])]

try:
    store.init_schema()

    # 1. file_task -> todo
    try:
        s = fresh()
        t = s.file_task(agent_code="ringer", title="job A", body="manifestA", priority=0)
        tid = t["id"]
        check(t.get("status") == "todo", f"file_task: new task must be 'todo', got {t.get('status')!r}")
        check(t.get("body") == "manifestA", "file_task: body (manifest) must round-trip")
        got = s.get_task(tid)
        check(got.get("task", {}).get("id") == tid, "get_task: must return {'task':...}")
        check(isinstance(got.get("receipts"), list), "get_task: receipts must be a list")
    except Exception as e:
        problems.append(f"file_task/get_task raised {e!r}")

    # 2. claim_next: flip + CLAIMED receipt + None when drained
    try:
        s = fresh()
        a = s.file_task(agent_code="ringer", title="A", body="mA")
        c = s.claim_next("ringer")
        check(c and c.get("id") == a["id"], "claim_next: must return the filed task")
        check(c.get("status") == "working", f"claim_next: must be 'working', got {c.get('status')!r}")
        check(c.get("claimed_by") == "ringer", "claim_next: claimed_by must be set")
        check(int(c.get("attempts") or 0) == 1, f"claim_next: attempts must be 1, got {c.get('attempts')!r}")
        check("CLAIMED" in rtypes(s.get_task(a["id"])), "claim_next: must write CLAIMED receipt")
        check(s.claim_next("ringer") is None, "claim_next: None when no eligible todo remains")
    except Exception as e:
        problems.append(f"claim_next basic raised {e!r}")

    # 3. ordering: priority DESC then created_at ASC
    try:
        s = fresh()
        lo = s.file_task(agent_code="ringer", title="lo", body="x", priority=0)
        hi = s.file_task(agent_code="ringer", title="hi", body="x", priority=5)
        lo2 = s.file_task(agent_code="ringer", title="lo2", body="x", priority=0)
        check(s.claim_next("ringer")["id"] == hi["id"], "ordering: highest priority first")
        check(s.claim_next("ringer")["id"] == lo["id"], "ordering: then oldest of equal priority")
    except Exception as e:
        problems.append(f"ordering raised {e!r}")

    # 4. agent scoping: 'all' claimable; other agents' not
    try:
        s = fresh()
        mine = s.file_task(agent_code="ringer", title="mine", body="x")
        anyone = s.file_task(agent_code="all", title="any", body="x")
        other = s.file_task(agent_code="someoneelse", title="other", body="x")
        got = []
        while True:
            c = s.claim_next("ringer")
            if not c: break
            got.append(c["id"])
        check(mine["id"] in got, "scoping: must claim own task")
        check(anyone["id"] in got, "scoping: must claim an 'all' task")
        check(other["id"] not in got, "scoping: must NOT claim another agent's task")
    except Exception as e:
        problems.append(f"scoping raised {e!r}")

    # 5. lease reclaim (lease_seconds=0 → immediately expired next pass)
    try:
        s = fresh()
        a = s.file_task(agent_code="ringer", title="A", body="x")
        c1 = s.claim_next("ringer", lease_seconds=0, max_attempts=5)
        check(int(c1.get("attempts") or 0) == 1, "lease: first claim attempts=1")
        c2 = s.claim_next("ringer", lease_seconds=0, max_attempts=5)
        check(c2 and c2.get("id") == a["id"], "lease: expired working task must be reclaimable")
        check(int(c2.get("attempts") or 0) == 2, f"lease: reclaim increments attempts to 2, got {c2.get('attempts')!r}")
        check("LEASE_EXPIRED" in rtypes(s.get_task(a["id"])), "lease: reclaim must write LEASE_EXPIRED receipt")
    except Exception as e:
        problems.append(f"lease reclaim raised {e!r}")

    # 6. attempt-cap → failed, nothing left to claim
    try:
        s = fresh()
        a = s.file_task(agent_code="ringer", title="A", body="x")
        s.claim_next("ringer", lease_seconds=0, max_attempts=2)  # attempts=1
        s.claim_next("ringer", lease_seconds=0, max_attempts=2)  # attempts=2 (cap)
        nxt = s.claim_next("ringer", lease_seconds=0, max_attempts=2)
        check(nxt is None, "attempt-cap: nothing left to claim once capped")
        check(s.get_task(a["id"])["task"]["status"] == "failed", "attempt-cap: task must be 'failed'")
        check("FAILED" in rtypes(s.get_task(a["id"])), "attempt-cap: must write FAILED receipt")
    except Exception as e:
        problems.append(f"attempt-cap raised {e!r}")

    # 7. transition ->done clears claim + inline receipt; invalid rejected
    try:
        s = fresh()
        a = s.file_task(agent_code="ringer", title="A", body="x")
        s.claim_next("ringer")
        s.transition(a["id"], status="done", agent_code="ringer", receipt_type="DONE", receipt_body="answer")
        task = s.get_task(a["id"])["task"]
        check(task.get("status") == "done", "transition: ->done sets done")
        check(not task.get("claimed_by"), "transition: ->done clears claim")
        check("DONE" in rtypes(s.get_task(a["id"])), "transition: inline receipt written")
        bad = False
        try:
            bad = not s.transition(a["id"], status="banana", agent_code="ringer")
        except Exception:
            bad = True
        check(bad, "transition: invalid status rejected")
    except Exception as e:
        problems.append(f"transition raised {e!r}")

    # 8. CODE-ENFORCED GATE
    try:
        s = fresh()
        a = s.file_task(agent_code="ringer", title="A", body="x")
        s.claim_next("ringer")
        denied = False
        try:
            denied = not s.transition(a["id"], status="done", agent_code="ringer",
                                      consequential=True, human_authorized=False,
                                      receipt_type="APPLIED", receipt_body="publish!")
        except Exception:
            denied = True
        check(denied, "gate: consequential WITHOUT human_authorized must be REFUSED")
        ok = s.transition(a["id"], status="done", agent_code="adam",
                          consequential=True, human_authorized=True,
                          receipt_type="APPLIED", receipt_body="approved")
        check(bool(ok), "gate: consequential WITH human_authorized must be allowed")
        check("APPLIED" in rtypes(s.get_task(a["id"])), "gate: authorized transition records its receipt")
    except Exception as e:
        problems.append(f"gate raised {e!r}")

    # 9. needs_input -> answer -> re-queue clears claim
    try:
        s = fresh()
        a = s.file_task(agent_code="ringer", title="A", body="x")
        s.claim_next("ringer")
        s.transition(a["id"], status="needs_input", agent_code="ringer",
                     blocked_reason="which repo?", receipt_type="BLOCKED", receipt_body="which repo?")
        t = s.get_task(a["id"])["task"]
        check(t.get("status") == "needs_input" and t.get("blocked_reason"), "needs_input: status+blocked_reason set")
        s.transition(a["id"], status="todo", agent_code="adam", blocked_reason=None,
                     receipt_type="UNBLOCKED", receipt_body="the ringer repo")
        t2 = s.get_task(a["id"])["task"]
        check(t2.get("status") == "todo", "answer: ->todo re-queues")
        check(not t2.get("claimed_by"), "answer: ->todo clears claim")
        check(not t2.get("blocked_reason"), "answer: blocked_reason cleared")
        c = s.claim_next("ringer")
        check(c and c["id"] == a["id"], "answer: re-queued task re-claimable")
    except Exception as e:
        problems.append(f"needs_input flow raised {e!r}")

    # 10. list_tasks filters + persistence across a new Store instance
    try:
        s = fresh()
        s.file_task(agent_code="ringer", title="A", body="x")
        s.file_task(agent_code="ringer", title="B", body="x")
        check(len(s.list_tasks(agent_code="ringer", status="todo")) == 2, "list_tasks: expected 2 todo")
        s2 = Store(dsn, schema=SCHEMA)
        check(len(s2.list_tasks(status="todo")) == 2, "persistence: tasks survive a new Store connection")
    except Exception as e:
        problems.append(f"list_tasks/persistence raised {e!r}")

finally:
    # always drop the throwaway schema
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
print("PASS: engine/store.py (Postgres) — claim/lease/attempt-cap/gate/needs_input/persistence all green")
PY
