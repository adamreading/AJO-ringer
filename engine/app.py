"""FastAPI application for the Ringer Engine.

P0 skeleton: a health endpoint proving the venv/FastAPI/uvicorn stack serves.
The queue store, agent-API routes, wake-receiver, runner, and the re-homed
HUD/wall routes are layered on in later phases.

Run (dev):  .venv/bin/uvicorn engine.app:app --host 127.0.0.1 --port 8700
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse

APP_NAME = "ringer-engine"
APP_VERSION = "0.0.1"

app = FastAPI(title="Ringer Engine", version=APP_VERSION)


@app.get("/engine/health")
def engine_health() -> JSONResponse:
    """Liveness of the engine service itself (distinct from the HUD's /api/runs)."""
    return JSONResponse({"ok": True, "service": APP_NAME, "version": APP_VERSION})
