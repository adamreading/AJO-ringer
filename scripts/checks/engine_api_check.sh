#!/bin/sh
# Check: engine/routes.py (FastAPI agent-API) is correct end-to-end. Drives the
# REAL FastAPI app via fastapi.testclient.TestClient (httpx transport, in-process
# ASGI — no port binding) against a THROWAWAY schema on the ringer DB, so live
# queue data is never touched. Covers all 9 routes + the wake receiver + the
# CODE-ENFORCED human gate. Needs RINGER_DB_DSN + the repo venv. POSIX/dash-safe.
set -u

: "${RINGER_DB_DSN:?FAIL: RINGER_DB_DSN not set (source ~/.config/ringer/engine.env)}"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found at $PY"; exit 1; }
test -f /home/ajo/ringer/engine/routes.py || { echo "FAIL: engine/routes.py not found"; exit 1; }

cd /home/ajo/ringer
"$PY" - <<'PY'
import os, sys

SCHEMA = f"engine_api_test_{os.getpid()}"
os.environ["RINGER_DB_SCHEMA"] = SCHEMA  # the app + routes read this for datastore isolation

import psycopg
from engine.store import Store
from engine.app import app
from fastapi.testclient import TestClient

dsn = os.environ["RINGER_DB_DSN"]
Store(dsn, schema=SCHEMA).init_schema()
client = TestClient(app)

problems = []
def check(cond, msg):
    if not cond: problems.append(msg)

def rtypes(task_id):
    r = client.get(f"/agent-tasks/{task_id}")
    return [x["receipt_type"] for x in r.json().get("receipts", [])]

try:
    # 0. health still served alongside the router
    r = client.get("/engine/health")
    check(r.status_code == 200 and r.json().get("ok"), "health: /engine/health must be ok")

    # 4. POST /agent-tasks -> 201 todo, body round-trips
    r = client.post("/agent-tasks", json={"agent_code": "ringer", "title": "job A", "body": "manifestA"})
    check(r.status_code == 201, f"file: expected 201, got {r.status_code}")
    t = r.json(); tid = t["id"]
    check(t["status"] == "todo", f"file: new task must be todo, got {t['status']!r}")
    check(t["body"] == "manifestA", "file: body (manifest) must round-trip")

    # 3. GET /agent-tasks/:id -> {task, receipts}
    r = client.get(f"/agent-tasks/{tid}")
    check(r.status_code == 200 and r.json()["task"]["id"] == tid, "get: must return the task")
    check(isinstance(r.json().get("receipts"), list), "get: receipts must be a list")
    # 404 on missing
    check(client.get("/agent-tasks/99999999").status_code == 404, "get: missing task -> 404")

    # 1. GET /agent-tasks?status=todo -> includes it
    r = client.get("/agent-tasks", params={"status": "todo"})
    check(r.status_code == 200 and any(x["id"] == tid for x in r.json()), "list: todo must include filed task")

    # 2. claim-next -> full row, working, attempts=1, CLAIMED receipt; then null when drained
    r = client.post("/agent-tasks/claim-next", json={"agent_code": "ringer"})
    c = r.json()
    check(r.status_code == 200 and c and c["id"] == tid, "claim-next: must return filed task")
    check(c["status"] == "working" and c["claimed_by"] == "ringer", "claim-next: working + claimed_by")
    check(int(c["attempts"]) == 1, f"claim-next: attempts=1, got {c['attempts']}")
    check("CLAIMED" in rtypes(tid), "claim-next: writes CLAIMED receipt")
    check(client.post("/agent-tasks/claim-next", json={"agent_code": "ringer"}).json() is None,
          "claim-next: null when no eligible todo remains")

    # 6. PATCH ->done: clears claim, inline receipt
    r = client.patch(f"/agent-tasks/{tid}", json={"agent_code": "ringer", "status": "done",
                                                  "receipt_type": "DONE", "receipt_body": "answer"})
    check(r.status_code == 200 and r.json()["status"] == "done", "patch: ->done sets done")
    check(not r.json().get("claimed_by"), "patch: ->done clears claim")
    check("DONE" in rtypes(tid), "patch: inline receipt written")
    # invalid status -> 400
    check(client.patch(f"/agent-tasks/{tid}", json={"agent_code": "ringer", "status": "banana"}).status_code == 400,
          "patch: invalid status -> 400")

    # 6b. CODE-ENFORCED GATE over HTTP
    tg = client.post("/agent-tasks", json={"agent_code": "ringer", "title": "gate", "body": "x"}).json()["id"]
    client.post("/agent-tasks/claim-next", json={"agent_code": "ringer"})
    r = client.patch(f"/agent-tasks/{tg}", json={"agent_code": "ringer", "status": "done",
                                                 "consequential": True, "human_authorized": False,
                                                 "receipt_type": "APPLIED", "receipt_body": "publish!"})
    check(r.status_code == 403, f"gate: consequential w/o human_authorized -> 403, got {r.status_code}")
    r = client.patch(f"/agent-tasks/{tg}", json={"agent_code": "adam", "status": "done",
                                                 "consequential": True, "human_authorized": True,
                                                 "receipt_type": "APPLIED", "receipt_body": "approved"})
    check(r.status_code == 200, "gate: consequential WITH human_authorized -> allowed")
    check("APPLIED" in rtypes(tg), "gate: authorized transition records its receipt")

    # 5. atomic claim by id -> 200 then 409
    tc = client.post("/agent-tasks", json={"agent_code": "ringer", "title": "byid", "body": "x"}).json()["id"]
    check(client.post(f"/agent-tasks/{tc}/claim", json={"agent_code": "ringer"}).status_code == 200,
          "claim-by-id: first claim 200")
    check(client.post(f"/agent-tasks/{tc}/claim", json={"agent_code": "ringer"}).status_code == 409,
          "claim-by-id: second claim 409")

    # 6c. PATCH free-set (no status change) + reassign
    tf = client.post("/agent-tasks", json={"agent_code": "ringer", "title": "old", "body": "x"}).json()["id"]
    r = client.patch(f"/agent-tasks/{tf}", json={"agent_code": "ringer", "priority": 9, "title": "new"})
    check(r.status_code == 200 and r.json()["priority"] == 9 and r.json()["title"] == "new",
          "patch free-set: priority+title updated")
    check(r.json()["status"] == "todo", "patch free-set: status unchanged")
    r = client.patch(f"/agent-tasks/{tf}", json={"agent_code": "ringer", "reassign_to": "someoneelse"})
    check(r.json()["agent_code"] == "someoneelse", "patch: reassign_to changes agent_code")

    # 7. standalone receipt (+404 on missing task)
    r = client.post(f"/agent-tasks/{tf}/receipts", json={"receipt_type": "FOLLOW_UP", "agent_code": "ringer", "body": "note"})
    check(r.status_code == 201, "receipts: standalone -> 201")
    check("FOLLOW_UP" in rtypes(tf), "receipts: appears on the thread")
    check(client.post("/agent-tasks/99999999/receipts", json={"receipt_type": "DONE", "agent_code": "ringer"}).status_code == 404,
          "receipts: missing task -> 404")

    # needs_input -> answer -> re-queue, over HTTP
    tn = client.post("/agent-tasks", json={"agent_code": "ringer", "title": "ask", "body": "x"}).json()["id"]
    client.post("/agent-tasks/claim-next", json={"agent_code": "ringer"})
    r = client.patch(f"/agent-tasks/{tn}", json={"agent_code": "ringer", "status": "needs_input",
                                                 "blocked_reason": "which repo?", "receipt_type": "BLOCKED",
                                                 "receipt_body": "which repo?"})
    check(r.json()["status"] == "needs_input" and r.json()["blocked_reason"], "needs_input: status+reason set")
    r = client.patch(f"/agent-tasks/{tn}", json={"agent_code": "adam", "status": "todo",
                                                 "blocked_reason": None, "receipt_type": "UNBLOCKED",
                                                 "receipt_body": "the ringer repo"})
    check(r.json()["status"] == "todo" and not r.json()["blocked_reason"] and not r.json()["claimed_by"],
          "answer: ->todo re-queues + clears reason/claim")
    check(client.post("/agent-tasks/claim-next", json={"agent_code": "ringer"}).json()["id"] == tn,
          "answer: re-queued task re-claimable")

    # 8/9. ledger upsert + list (wake registration)
    r = client.put("/agent-ledger/ringer", json={"notify_url": "http://127.0.0.1:8700/wake", "notes": "online"})
    check(r.status_code == 200 and r.json()["notify_url"].endswith("/wake"), "ledger: PUT upserts notify_url")
    r = client.get("/agent-ledger", params={"agent_code": "ringer"})
    check(r.status_code == 200 and any(x["agent_code"] == "ringer" for x in r.json()), "ledger: GET lists agent")

    # local wake receiver
    r = client.post("/engine/wake", json={"agent_code": "ringer", "task_id": tn})
    check(r.status_code == 200 and r.json().get("woke") is True, "wake: receiver acknowledges")

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
print("PASS: engine/routes.py (FastAPI agent-API) — 9 routes + wake + human gate all green")
PY
