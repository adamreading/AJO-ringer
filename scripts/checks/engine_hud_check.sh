#!/bin/sh
# Check: the Ringside HUD/wall routes are correctly re-homed onto the FastAPI app
# (engine/hud.py), so the single :8700 service serves BOTH the agent-API and the
# wall. Drives the real FastAPI app via fastapi.testclient.TestClient (in-process
# ASGI). Asserts route parity with ringer.py's PersistentHudServer + byte-identity
# of the served wall assets (the wall JS/CSS are unchanged, so the earlier
# Playwright-verified expand-all/grade behavior is preserved iff bytes match).
# Read-only against live ~/.ringer state. Needs the repo venv. POSIX/dash-safe.
set -u

PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || { echo "FAIL: venv python not found at $PY"; exit 1; }
test -f /home/ajo/ringer/engine/hud.py || { echo "FAIL: engine/hud.py not found"; exit 1; }

cd /home/ajo/ringer
"$PY" - <<'PY'
import sys
from pathlib import Path
from engine.app import app, HUD_MOUNTED
from fastapi.testclient import TestClient

client = TestClient(app)
problems = []
def check(cond, msg):
    if not cond: problems.append(msg)

# 0. HUD actually mounted alongside the agent-API + engine health.
check(HUD_MOUNTED, "hud: router must be mounted on the app")
h = client.get("/engine/health").json()
check(h.get("hud_mounted") is True, "health: hud_mounted must be true")

# The wall page.
r = client.get("/")
check(r.status_code == 200 and "text/html" in r.headers.get("content-type", ""), "/: serves HTML")
check(len(r.content) > 200, "/: HTML non-trivial")

# /api/runs — the wsl health probe endpoint; must keep {runs:list, active:dict}.
r = client.get("/api/runs")
check(r.status_code == 200, f"/api/runs: 200, got {r.status_code}")
j = r.json()
check(isinstance(j.get("runs"), list), "/api/runs: runs is a list")
check(isinstance(j.get("active"), dict), "/api/runs: active is a dict")
check(r.headers.get("cache-control") == "no-store", "/api/runs: no-store")

# Model/canon/usage/library JSON routes return 200 dicts.
for path in ("/api/models", "/api/canon", "/api/usage", "/api/library"):
    r = client.get(path)
    check(r.status_code == 200 and isinstance(r.json(), dict), f"{path}: 200 JSON object")
check("models" in client.get("/api/canon").json(), "/api/canon: has models key")

# Wall assets: served bytes MUST equal the on-disk files (unchanged frontend).
for name, ctype in (("ringside-v2.js", "javascript"), ("ringside-v2.css", "css")):
    r = client.get(f"/{name}")
    disk = (Path("dashboard") / name).read_bytes()
    check(r.status_code == 200, f"/{name}: 200")
    check(ctype in r.headers.get("content-type", ""), f"/{name}: content-type {ctype}")
    check(r.content == disk, f"/{name}: served bytes identical to dashboard/{name}")

# /static/* path (same file, via the static prefix).
r = client.get("/static/ringside-v2.js")
check(r.status_code == 200 and b"" != r.content, "/static/ringside-v2.js: served")

# Path-param routes fail gracefully (404 / fail-open), never 500.
check(client.get("/logs/nope-run/nope-task").status_code == 404, "/logs: missing -> 404")
check(client.get("/transcript/nope-run/nope-task").status_code == 404, "/transcript: missing -> 404")
r = client.get("/live-model/nope-run/nope-task")
check(r.status_code == 200 and isinstance(r.json(), dict), "/live-model: fail-open 200 dict")

# The agent-API must still be co-registered on the SAME app (co-tenancy) — assert
# by the OpenAPI path table (include_router wraps routes lazily), DB-independent.
paths = set(app.openapi().get("paths", {}))
check("/agent-tasks" in paths, "co-tenancy: /agent-tasks route still registered")
check("/engine/wake" in paths, "co-tenancy: /engine/wake route still registered")
check("/api/runs" in paths and "/" in paths, "co-tenancy: HUD routes registered")

if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("PASS: engine/hud.py — Ringside HUD/wall re-homed onto FastAPI; routes + asset byte-parity green")
PY
