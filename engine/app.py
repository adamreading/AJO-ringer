"""FastAPI application for the Ringer Engine — the single :8700 daemon.

One service hosts three things:
  - /engine/health + /engine/wake  (liveness + local wake receiver)
  - the agent-API                  (engine/routes.py: file/claim/get/patch/...)
  - the Ringside HUD/wall          (engine/hud.py: re-homed from ringer.py)

On startup it self-provisions its queue schema (idempotent) so a fresh deploy
just works. Everything is fail-open: a DB that is down or unconfigured degrades
the agent-API but never takes down the wall or the health probe.

Run (dev):  .venv/bin/uvicorn engine.app:app --host 127.0.0.1 --port 8700
Prod needs RINGER_DB_DSN in the environment (systemd: EnvironmentFile).
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from . import runner
from .routes import router as agent_api_router
from .routes import store as _make_store

APP_NAME = "ringer-engine"
APP_VERSION = "0.6.0"

# DB readiness is decided at startup and surfaced on /engine/health.
DB_READY = False
DB_ERROR: str | None = None
# Always-on runner: OFF unless RINGER_ENGINE_AUTORUN=1. When on, the daemon claims
# and runs queued tasks unattended (capped by the tighter auto-run budget + the
# OpenCode step cap + feeder's breaker). AUTORUN_STARTED reflects the live state.
AUTORUN = os.environ.get("RINGER_ENGINE_AUTORUN") == "1"
AUTORUN_STARTED = False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Self-provision the queue schema (CREATE ... IF NOT EXISTS — safe to repeat).
    # Fail-open: if RINGER_DB_DSN is unset or the DB is unreachable, the wall + health
    # still serve; the agent-API surfaces the error rather than crashing the daemon.
    global DB_READY, DB_ERROR, AUTORUN_STARTED
    try:
        _make_store().init_schema()
        DB_READY, DB_ERROR = True, None
    except Exception as exc:  # noqa: BLE001 - intentionally broad; recorded for health
        DB_READY, DB_ERROR = False, repr(exc)
    # Start the always-on runner only when explicitly enabled AND the DB is ready.
    if AUTORUN and DB_READY:
        try:
            runner.start_background(_make_store())
            AUTORUN_STARTED = True
        except Exception:  # noqa: BLE001 - never let the runner take down the daemon
            AUTORUN_STARTED = False
    try:
        yield
    finally:
        if AUTORUN_STARTED:
            runner.stop()


app = FastAPI(title="Ringer Engine", version=APP_VERSION, lifespan=lifespan)

# The agent-API: file / claim / get / patch / receipts / ledger + local wake (P2).
app.include_router(agent_api_router)

# The Ringside HUD/wall — re-homed from ringer.py's PersistentHudServer (P3) so
# the queue API and the wall are one service on :8700. Imported lazily-guarded so
# a missing/oversized ringer import never takes down the agent-API or /engine/health.
try:
    from .hud import router as hud_router
    app.include_router(hud_router)
    HUD_MOUNTED = True
    HUD_IMPORT_ERROR: str | None = None
except Exception as exc:  # pragma: no cover - defensive; surfaced at /engine/health
    HUD_MOUNTED = False
    HUD_IMPORT_ERROR = repr(exc)


@app.get("/engine/health")
def engine_health() -> JSONResponse:
    """Liveness of the engine service itself (distinct from the HUD's /api/runs)."""
    payload: dict = {"ok": True, "service": APP_NAME, "version": APP_VERSION,
                     "hud_mounted": HUD_MOUNTED, "db_ready": DB_READY,
                     "autorun": AUTORUN, "autorun_started": AUTORUN_STARTED}
    if not HUD_MOUNTED:
        payload["hud_import_error"] = HUD_IMPORT_ERROR
    if not DB_READY and DB_ERROR:
        payload["db_error"] = DB_ERROR
    return JSONResponse(payload)
