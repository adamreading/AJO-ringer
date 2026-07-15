#!/usr/bin/env python3
"""Wake Ringer-Claude (the orchestrator brain) when a brief needs it.

The headless auto-runner ignores task_kind='brief' by design (those are for the
orchestrator, not the engine), so nothing else surfaces them — a brief left
unwatched just sits 'todo'. Ringer-Claude arms this under the Monitor tool
(persistent) at session start, exactly like peer-watch:

    while true; do python3 scripts/brief_watch.py || true; sleep 15; done

Each run prints one line per brief that is 'todo' NOW but wasn't last poll — a
freshly-filed brief, OR a needs_input brief just answered back to todo. A brief
being actively orchestrated stays todo across polls and does NOT re-fire. State
persists in ~/.ringer so restarts are clean. Fail-open: a transient error exits 0
(the loop retries next poll) rather than killing the Monitor.
"""
import json, os, sys, urllib.request

BASE = os.environ.get("RINGER_ENGINE_BASE", "http://127.0.0.1:8700")
STATE = os.path.expanduser("~/.ringer/brief_watch.state")

try:
    with urllib.request.urlopen(f"{BASE}/agent-tasks?status=todo&limit=200", timeout=8) as r:
        tasks = json.loads(r.read() or "[]")
except Exception:
    sys.exit(0)  # transient — try again next poll, never kill the monitor

cur = {str(t["id"]): (t.get("title") or "") for t in tasks if t.get("task_kind") == "brief"}
try:
    prev = set(open(STATE).read().split())
except OSError:
    prev = set()

for tid, title in cur.items():
    if tid not in prev:
        print(f"NEW BRIEF #{tid} needs orchestration: {title}", flush=True)

os.makedirs(os.path.dirname(STATE), exist_ok=True)
with open(STATE, "w") as f:
    f.write(" ".join(cur))
