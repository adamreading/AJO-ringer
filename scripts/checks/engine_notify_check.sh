#!/bin/sh
# Check: the outbound wake-in (blueprint §7) — on a terminal state, the runner
# POSTs the task's notify_agent's registered notify_url. Uses a local HTTP sink to
# capture the POST, a throwaway queue schema, and the zero-cost mock engine.
# Verifies: (a) a task with notify_agent + a registered notify_url gets a terminal
# POST carrying {task_id,status}; (b) a task WITHOUT notify_agent gets NO POST;
# (c) fail-open — a dead notify_url never fails the task. Needs venv + RINGER_DB_DSN.
set -u

: "${RINGER_DB_DSN:?FAIL: RINGER_DB_DSN not set}"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found"; exit 1; }
cd /home/ajo/ringer

"$PY" - <<'PY'
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import psycopg
from engine.store import Store
from engine import runner

received = []
class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        received.append(json.loads(self.rfile.read(n) or "{}"))
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass

srv = HTTPServer(("127.0.0.1", 0), Sink)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
SINK = f"http://127.0.0.1:{port}/wake"

problems = []
def check(c, m):
    if not c: problems.append(m)

SCHEMA = f"engine_notify_test_{os.getpid()}"
dsn = os.environ["RINGER_DB_DSN"]
store = Store(dsn, schema=SCHEMA)
try:
    store.init_schema()
    body = Path("manifests/phase2-mock-mechanics.json").read_text(encoding="utf-8")
    store.upsert_ledger("lunk", notify_url=SINK)

    # (a) task WITH notify_agent -> terminal POST to the sink
    t = store.file_task(agent_code="ringer", title="notify", body=body, notify_agent="lunk")
    runner.run_once(store, agent_code="ringer", identity="notify-check",
                    dashboard=False, budget_tokens=None, timeout=180)
    time.sleep(0.3)  # let the POST land
    mine = [r for r in received if r.get("task_id") == t["id"]]
    check(len(mine) == 1, f"(a) expected 1 wake POST for task {t['id']}, got {len(mine)}")
    if mine:
        check(mine[0].get("status") == "done", f"(a) wake status must be done, got {mine[0].get('status')!r}")
        check(str(mine[0].get("run_id")) == str(t["id"]), "(a) wake must carry run_id=task_id")
        check(mine[0].get("notify_agent") == "lunk", "(a) wake must name the notify_agent")

    # (b) task WITHOUT notify_agent -> NO POST
    received.clear()
    t2 = store.file_task(agent_code="ringer", title="silent", body=body)
    runner.run_once(store, agent_code="ringer", identity="notify-check",
                    dashboard=False, budget_tokens=None, timeout=180)
    time.sleep(0.3)
    check(len(received) == 0, f"(b) task without notify_agent must not POST, got {len(received)}")

    # (c) fail-open: dead notify_url must not fail the task
    store.upsert_ledger("deadagent", notify_url="http://127.0.0.1:1/nope")
    t3 = store.file_task(agent_code="ringer", title="failopen", body=body, notify_agent="deadagent")
    f3 = runner.run_once(store, agent_code="ringer", identity="notify-check",
                         dashboard=False, budget_tokens=None, timeout=180)
    check(f3 and f3["status"] == "done", f"(c) dead notify_url must not fail the task, got {f3 and f3['status']!r}")

    # (d) PATCH-path wake: the ORCHESTRATOR posts the answer via the API on a BRIEF
    # (never touched by the runner) → the terminal transition must fire the wake too.
    os.environ["RINGER_DB_SCHEMA"] = SCHEMA
    from fastapi.testclient import TestClient
    from engine.app import app as _app
    received.clear()
    tb = store.file_task(agent_code="ringer", title="a plain brief", body="a plain question",
                         task_kind="brief", notify_agent="lunk")
    with TestClient(_app) as client:
        r = client.patch(f"/agent-tasks/{tb['id']}", json={
            "agent_code": "ringer-claude", "status": "done",
            "receipt_type": "DONE", "receipt_body": "here is the orchestrated answer"})
        check(r.status_code == 200, f"(d) PATCH brief->done must 200, got {r.status_code}")
    time.sleep(0.3)
    hit = [x for x in received if x.get("task_id") == tb["id"] and x.get("status") == "done"]
    check(len(hit) == 1, f"(d) orchestrator PATCH->terminal must fire ONE wake, got {len(hit)}")

    # (e) artifact_path rides the wake ONLY when it's a real file under ~/.ringer/artifacts
    #     (Adam's deliverable policy) — an out-of-dir path is rejected by the guard.
    art_root = Path(runner._ARTIFACTS_ROOT); art_root.mkdir(parents=True, exist_ok=True)
    good = art_root / f"notify_check_{os.getpid()}.html"
    good.write_text("<h1>deliverable</h1>", encoding="utf-8")
    bad = Path("/tmp") / f"notify_check_evil_{os.getpid()}.txt"
    bad.write_text("nope", encoding="utf-8")
    try:
        received.clear()
        te = store.file_task(agent_code="ringer", title="brief+artifact", body="q",
                             task_kind="brief", notify_agent="lunk")
        with TestClient(_app) as client:
            client.patch(f"/agent-tasks/{te['id']}", json={
                "agent_code": "ringer-claude", "status": "done", "receipt_type": "DONE",
                "receipt_body": "answer + artifact", "artifact_path": str(good)})
        time.sleep(0.3)
        he = [x for x in received if x.get("task_id") == te["id"]]
        want = os.path.realpath(str(good))
        check(len(he) == 1 and he[0].get("artifact_path") == want,
              f"(e) valid artifact_path must ride the wake, got {he and he[0].get('artifact_path')!r}")

        received.clear()
        tf = store.file_task(agent_code="ringer", title="brief+evil", body="q",
                             task_kind="brief", notify_agent="lunk")
        with TestClient(_app) as client:
            client.patch(f"/agent-tasks/{tf['id']}", json={
                "agent_code": "ringer-claude", "status": "done", "receipt_type": "DONE",
                "receipt_body": "answer", "artifact_path": str(bad)})
        time.sleep(0.3)
        hf = [x for x in received if x.get("task_id") == tf["id"]]
        check(len(hf) == 1 and "artifact_path" not in hf[0],
              f"(e) out-of-dir artifact_path must be rejected, got {hf and hf[0].get('artifact_path')!r}")
    finally:
        good.unlink(missing_ok=True); bad.unlink(missing_ok=True)

finally:
    srv.shutdown()
    try:
        with psycopg.connect(dsn) as c, c.cursor() as cur:
            cur.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
    except Exception as e:
        print(f"WARN: could not drop test schema: {e!r}", file=sys.stderr)

if problems:
    print("FAIL:")
    for p in problems: print("  -", p)
    sys.exit(1)
print("PASS: outbound wake-in — terminal POST to notify_agent's url; silent w/o notify_agent; fail-open on dead url")
PY
