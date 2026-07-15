"""Ringer Engine runner — the consumer loop that turns queued tasks into swarms.

One pass (run_once):
  1. heartbeat the ledger
  2. claim_next() a task (race-safe; lease + attempt-cap handled in the store)
  3. materialize the task body as a ringer manifest and invoke `ringer.py run`
  4. record the outcome as a receipt and transition the task:
       all tasks passed  -> done   + DONE   receipt
       some tasks failed -> review + DONE   receipt (human look; artifacts exist)
       run crashed       -> failed + FAILED receipt
     a body that isn't a valid manifest -> needs_input + BLOCKED (can't run it)

Maps blueprint §4 step 6/7 onto Ringer: a queue task == a swarm run request.
The runner NEVER crosses the consequence gate — it only produces + verifies swarm
work (autonomous-OK); applying a result to the world stays human-gated in the store.

Spend-cap note (P4b, pending feeder): run_once exports RINGER_RUN_ID=<task_id> so a
per-invocation opencode config can bake a literal X-Run-Id header for Feeder to
enforce on. That transport is gated on a joint wire probe; setting the env now is
harmless and ready.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .store import Store

RINGER_PY = str(Path(__file__).resolve().parent.parent / "ringer.py")
DEFAULT_STATE_DIR = Path.home() / ".ringer"

# Spend-cap (feeder lane). run_id = agent_tasks.id, carried to Feeder as the baked
# X-Run-Id header (opencode-feeder.sh). Declared ONCE at claim; Feeder's in-mem
# counter is live truth after that. Default HIGH + fail-loud (Adam's directive):
# the cap is a runaway BACKSTOP, not rationing, and a breach must never be silent.
FEEDER_BASE = os.environ.get("RINGER_FEEDER_BASE", "http://localhost:3001")
DEFAULT_BUDGET_TOKENS = int(os.environ.get("RINGER_RUN_BUDGET_TOKENS", "500000"))


def _feeder_json(method: str, path: str, body: dict | None = None) -> Any:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        FEEDER_BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def declare_budget(task_id: int, max_tokens: int) -> dict | None:
    """Declare the per-run token ceiling BEFORE workers fire. Fail-OPEN: an infra
    hiccup here leaves the run uncapped (matches Feeder) rather than blocking it."""
    try:
        return _feeder_json("POST", "/api/swarm/budget",
                            {"run_id": str(task_id), "max_tokens": int(max_tokens)})
    except Exception:  # noqa: BLE001 - fail-open by design
        return None


def budget_status(task_id: int) -> dict | None:
    """Live {budget, spent} for the run, or None if undeclared/unreachable (404)."""
    try:
        return _feeder_json("GET", f"/api/swarm/budget?run_id={task_id}")
    except Exception:  # noqa: BLE001 - 404 (undeclared) or unreachable -> no breach
        return None


def _materialize_manifest(body: str | None) -> tuple[Path | None, str | None]:
    """Write the task body to a temp manifest file. Returns (path, error)."""
    if not body or not body.strip():
        return None, "task body is empty; expected a ringer manifest (JSON)"
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, TypeError) as exc:
        return None, f"task body is not valid ringer manifest JSON: {exc}"
    if not isinstance(parsed, dict) or "tasks" not in parsed:
        return None, "task body JSON is not a ringer manifest (no 'tasks' key)"
    fd, name = tempfile.mkstemp(prefix="ringer-engine-task-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(parsed, fh)
    return Path(name), None


def _find_child_run(state_dir: Path, since_ts: float) -> dict[str, Any]:
    """The run JSON `ringer.py run` just wrote (newest file touched since launch)."""
    runs_dir = state_dir / "runs"
    try:
        cand = [p for p in runs_dir.glob("*.json") if p.is_file() and p.stat().st_mtime >= since_ts - 2]
    except OSError:
        return {}
    if not cand:
        return {}
    newest = max(cand, key=lambda p: p.stat().st_mtime)
    try:
        return json.loads(newest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _summarize(run: dict[str, Any], rc: int) -> str:
    return json.dumps({
        "child_run_id": run.get("run_id"),
        "run_name": run.get("run_name"),
        "returncode": rc,
        "pass": run.get("pass"),
        "fail": run.get("fail"),
        "tokens": run.get("tokens"),
        "report_path": run.get("report_path"),
    }, sort_keys=True)


def run_once(store: Store, *, agent_code: str = "ringer", identity: str = "ringer-engine",
             python_exe: str = "python3", dashboard: bool = True,
             lease_seconds: float = 3600, max_attempts: int = 3,
             budget_tokens: int | None = DEFAULT_BUDGET_TOKENS,
             timeout: float | None = None) -> dict[str, Any] | None:
    """Claim and execute ONE task. Returns the final task row, or None if idle."""
    store.upsert_ledger(agent_code, last_queue_result="polling")
    task = store.claim_next(agent_code, lease_seconds=lease_seconds, max_attempts=max_attempts)
    if task is None:
        return None
    task_id = task["id"]

    manifest_path, err = _materialize_manifest(task.get("body"))
    if err:
        # Can't run it — ask for a valid manifest instead of failing outright.
        store.transition(task_id, status="needs_input", agent_code=agent_code,
                         blocked_reason=err, receipt_type="BLOCKED", receipt_body=err)
        return store.get_task(task_id)["task"]

    # Declare the run budget ONCE, before workers fire (spend-cap backstop).
    if budget_tokens:
        declare_budget(task_id, budget_tokens)

    cmd = [python_exe, RINGER_PY, "run", str(manifest_path), "--identity", identity]
    if not dashboard:
        cmd.append("--no-dashboard")

    env = dict(os.environ)
    env["RINGER_RUN_ID"] = str(task_id)  # baked as X-Run-Id by opencode-feeder.sh

    started = time.time()
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        store.transition(task_id, status="failed", agent_code=agent_code,
                         receipt_type="FAILED", receipt_body=f"ringer.py run timed out after {timeout}s")
        return store.get_task(task_id)["task"]
    except Exception as exc:  # noqa: BLE001 - any spawn failure -> FAILED, never hang the task
        store.transition(task_id, status="failed", agent_code=agent_code,
                         receipt_type="FAILED", receipt_body=f"ringer.py run failed to execute: {exc!r}")
        return store.get_task(task_id)["task"]
    finally:
        with contextlib.suppress(OSError):
            manifest_path.unlink()

    run = _find_child_run(DEFAULT_STATE_DIR, started)
    summary = _summarize(run, rc)

    # FAIL LOUD on a spend-cap breach (Adam's directive): if Feeder shows the run
    # hit its ceiling, that's terminal — mark it failed with the budget details so
    # it shows RED on the wall, regardless of the child rc. (Over-budget worker
    # calls were rejected pre-route, so zero provider tokens were burned on them.)
    bstat = budget_status(task_id)
    if bstat and bstat.get("budget") is not None and (bstat.get("spent") or 0) >= bstat["budget"]:
        breach = json.dumps({"code": "run_budget_exceeded", "run_id": task_id,
                             "spent": bstat.get("spent"), "budget": bstat.get("budget"),
                             "child": json.loads(summary)}, sort_keys=True)
        store.transition(task_id, status="failed", agent_code=agent_code,
                         receipt_type="FAILED", receipt_body=breach)
        return store.get_task(task_id)["task"]

    if rc == 0:
        store.transition(task_id, status="done", agent_code=agent_code,
                         receipt_type="DONE", receipt_body=summary)
    elif rc == 1:
        # Some tasks failed but the orchestrator ran — leave artifacts for a human look.
        store.transition(task_id, status="review", agent_code=agent_code,
                         receipt_type="DONE", receipt_body=summary)
    else:
        store.transition(task_id, status="failed", agent_code=agent_code,
                         receipt_type="FAILED", receipt_body=summary + f" | stderr_tail={proc.stderr[-400:]!r}")
    return store.get_task(task_id)["task"]


def serve(store: Store, *, agent_code: str = "ringer", poll_interval: float = 120.0,
          **kwargs: Any) -> None:
    """Slow-poll backstop loop (the wake receiver drives faster claims). One task
    per pass, exactly as blueprint §4 prescribes."""
    while True:
        try:
            result = run_once(store, agent_code=agent_code, **kwargs)
        except Exception:  # a bad pass must never kill the loop
            result = None
        if result is None:
            time.sleep(poll_interval)
