"""Re-home the persistent Ringside HUD/wall onto the FastAPI app (P3).

Historically the :8700 HUD was its own stdlib ThreadingHTTPServer
(ringer.py:PersistentHudServer). To make the engine ONE service, this router
reproduces every one of its GET routes as FastAPI endpoints — but the logic is
NOT duplicated: each route calls the exact same module-level helpers in
`ringer.py` (scan_hud_run_states, build_models_api_payload, feeder_canon,
live_model_for_task, the transcript parser, ...). ringer.py stays the source of
truth; standalone `ringer.py run` stays stdlib-only. Only the daemon front door
moves from ThreadingHTTPServer → uvicorn.

Route parity with PersistentHudServer.start().Handler.do_GET (ringer.py:4660):
  /                       /api/runs  /api/models  /api/canon  /api/usage
  /api/library            /api/open-folder        /static/*   /ringside-v2.{css,js}
  /artifacts/*            /logs/<run>/<task>       /transcript/<run>/<task>
  /live-model/<run>/<task>
"""
from __future__ import annotations

import contextlib
import json
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Response
from fastapi.responses import HTMLResponse

import ringer as r

router = APIRouter()

# Resolve the same state the `ringer.py hud` command uses (run_persistent_hud):
# state_dir + the eval jsonl that feeds /api/models. AppConfig.load() falls back
# to defaults (~/.ringer) when no config file is present, so this never fails.
_cfg = r.AppConfig.load()
STATE_DIR: Path = _cfg.state_dir
MODEL_LOG_PATH: Path = _cfg.eval.jsonl_path
ARTIFACT_ROOT: Path = r.artifacts_dir(STATE_DIR)

_STATIC_CT = {".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8"}
_NO_STORE = {"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"}


def _json(data: Any) -> Response:
    # Mirror ringer.send_json_response: sorted keys, no-store, permissive CORS.
    body = json.dumps(data, sort_keys=True, default=str).encode("utf-8")
    return Response(content=body, media_type="application/json; charset=utf-8", headers=_NO_STORE)


def _text(body: str, *, no_store: bool = True) -> Response:
    return Response(content=body.encode("utf-8"), media_type="text/plain; charset=utf-8",
                    headers=_NO_STORE if no_store else {"Access-Control-Allow-Origin": "*"})


@router.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse(content=r.read_ringside_html(),
                        headers={"Access-Control-Allow-Origin": "*"})


@router.get("/api/runs")
def api_runs() -> Response:
    # read_active_runs() prunes dead-pid runs so a killed run stops showing LIVE.
    return _json({"runs": r.scan_hud_run_states(STATE_DIR), "active": r.read_active_runs()})


@router.get("/api/models")
def api_models() -> Response:
    try:
        payload = r.build_models_api_payload(
            log_path=MODEL_LOG_PATH or (STATE_DIR / "runs.jsonl"),
            default_log_path=MODEL_LOG_PATH,
            db_path=None,
        )
    except Exception as exc:  # fail-open, mirror the stdlib handler
        payload = {"generated_at": r.utc_now_iso(), "groups": [], "rollup": [],
                   "error": str(exc) or exc.__class__.__name__}
    return _json(payload)


@router.get("/api/canon")
def api_canon() -> Response:
    return _json({"models": r.feeder_canon(), "generated_at": r.utc_now_iso()})


@router.get("/api/usage")
def api_usage() -> Response:
    return _json(r.ringer_usage_payload(STATE_DIR))


@router.get("/api/library")
def api_library() -> Response:
    # A run that died without cleanup must not sit "live" forever — reconcile on read.
    with contextlib.suppress(Exception):
        r.reconcile_artifact_library_dead_runs(STATE_DIR)
    return _json(r.read_json_object(r.artifact_library_path(STATE_DIR), {"artifacts": {}}))


@router.get("/api/open-folder")
def api_open_folder() -> Response:
    # macOS-only in the original; on WSL/Linux there is no local Finder to open.
    if sys.platform == "darwin":
        return Response(status_code=501)  # parity placeholder; not used on this box
    return Response(status_code=501)


@router.get("/static/{filename:path}")
def static_file(filename: str) -> Response:
    return _static(Path(filename).name)


@router.get("/ringside-v2.css")
def ringside_css() -> Response:
    return _static("ringside-v2.css")


@router.get("/ringside-v2.js")
def ringside_js() -> Response:
    return _static("ringside-v2.js")


def _static(name: str) -> Response:
    target = r.DASHBOARD_STATIC_DIR / Path(name).name
    ct = _STATIC_CT.get(target.suffix.lower())
    if ct is None or not target.is_file():
        return Response(status_code=404)
    return Response(content=target.read_bytes(), media_type=ct,
                    headers={"Access-Control-Allow-Origin": "*"})


@router.get("/artifacts/{path:path}")
def artifacts(path: str) -> Response:
    artifact_path = r.resolve_artifact_http_path(ARTIFACT_ROOT, "/artifacts/" + path)
    if artifact_path is None:
        return Response(status_code=404)
    try:
        if not artifact_path.is_file():
            raise FileNotFoundError
        body = artifact_path.read_bytes()
    except (FileNotFoundError, OSError):
        return Response(status_code=404)
    return Response(content=body, media_type=r.artifact_content_type(artifact_path), headers=_NO_STORE)


@router.get("/logs/{run_id}/{task_key:path}")
def logs(run_id: str, task_key: str) -> Response:
    log_path = r.hud_task_log_path(STATE_DIR, run_id, task_key)
    if log_path is None or not log_path.is_file():
        return Response(status_code=404)
    return _text(r.tail_file_text(log_path, max_bytes=r.WORKER_LOG_TAIL_BYTES))


@router.get("/transcript/{run_id}/{task_key:path}")
def transcript(run_id: str, task_key: str) -> Response:
    log_path = r.hud_task_log_path(STATE_DIR, run_id, task_key)
    if log_path is None or not log_path.is_file():
        return Response(status_code=404)
    try:
        text = r.tail_file_text(log_path, max_bytes=r.TRANSCRIPT_MAX_BYTES)
        data = r.transcript_mod.parse_transcript(text)
    except Exception as exc:  # fail-open: degrade, never 500
        data = {"schema": 1, "engine": "unknown", "sessions": [], "status": "error",
                "attempts": [], "tokens_total": 0,
                "parse_warnings": [f"transcript parse failed: {exc}"]}
    return _json(data)


@router.get("/live-model/{run_id}/{task_key:path}")
def live_model(run_id: str, task_key: str) -> Response:
    return _json(r.live_model_for_task(STATE_DIR, run_id, task_key))
