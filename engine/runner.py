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
import threading
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
# Unattended auto-runs get a TIGHTER default ceiling than interactive runs — an
# always-on loop is unwatched, so limit blast radius if a run slips all guards
# (feeder ask, 2026-07-15). Still just a backstop atop the step cap + breaker.
AUTORUN_BUDGET_TOKENS = int(os.environ.get("RINGER_AUTORUN_BUDGET_TOKENS", "250000"))

# Wake/stop signalling for the always-on runner thread. /engine/wake sets _WAKE
# for an immediate claim; the daemon's shutdown sets _STOP.
_WAKE = threading.Event()
_STOP = threading.Event()


def wake() -> None:
    """Poke the always-on runner to claim now (called by /engine/wake)."""
    _WAKE.set()


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


#: Feeder's terminal pre-route rejections — STOP the run, never retry (same broken
#: model/task just re-spins). Handled identically: FAILED receipt + red wall.
TERMINAL_429_CODES = ("run_budget_exceeded", "no_progress_loop")


def _scan_terminal_429(run: dict[str, Any]) -> str | None:
    """Find a terminal Feeder rejection code in the child run's worker output."""
    for task in run.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        blob = " ".join(str(task.get(k) or "") for k in
                        ("log_tail_full", "log_tail", "check_output_tail"))
        for code in TERMINAL_429_CODES:
            if code in blob:
                return code
    return None


#: task states that warrant waking the requester (terminal, or needs their input)
_NOTIFY_STATES = ("done", "review", "failed", "needs_input")


_ARTIFACTS_ROOT = os.path.realpath(os.path.expanduser("~/.ringer/artifacts"))


def _valid_artifact(path: str | None) -> str | None:
    """A caller-supplied artifact_path is honoured ONLY if it is an existing file
    under ~/.ringer/artifacts — so the outbound wake can never point the consumer
    (wsl's Discord bridge) at an arbitrary file on the box. Fail-open: anything
    invalid -> None -> text-only delivery still works."""
    if not path:
        return None
    try:
        ap = os.path.realpath(os.path.expanduser(path))
        if (ap == _ARTIFACTS_ROOT or ap.startswith(_ARTIFACTS_ROOT + os.sep)) and os.path.isfile(ap):
            return ap
    except Exception:  # noqa: BLE001 - defensive; never break the wake
        pass
    return None


def _notify_requester(task: dict[str, Any], receipts: list[dict[str, Any]], store: Store,
                      *, artifact_path: str | None = None) -> None:
    """Outbound wake-in (blueprint §7): POST the task's notify_agent's registered
    notify_url when the task reaches a state worth waking them for. FAIL-OPEN — a
    missed wake never affects the task; the durable queue + polling are the backstop.
    When artifact_path (validated, under the artifacts dir) is given it rides in the
    payload so the consumer can attach it — Adam's deliverable policy (2026-07-16):
    default inline text; artifact only for visual / long structured reports."""
    notify_agent = task.get("notify_agent")
    status = task.get("status")
    if not notify_agent or status not in _NOTIFY_STATES:
        return
    rows = store.list_ledger(agent_code=notify_agent)
    url = rows[0].get("notify_url") if rows else None
    if not url:
        return
    last = receipts[-1] if receipts else {}
    payload = {
        "task_id": task["id"], "run_id": str(task["id"]), "status": status,
        "notify_agent": notify_agent,
        "receipt_type": last.get("receipt_type"), "receipt_body": last.get("body"),
    }
    ap = _valid_artifact(artifact_path)
    if ap:
        payload["artifact_path"] = ap
    body = json.dumps(payload).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:  # noqa: BLE001 - fail-open by design
        pass


def _finish(store: Store, task_id: int) -> dict[str, Any]:
    """Read the finished task + receipts once, fire the outbound wake, return the task."""
    full = store.get_task(task_id)
    task = full.get("task") or {}
    _notify_requester(task, full.get("receipts") or [], store)
    return task


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
        return _finish(store, task_id)

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
        return _finish(store, task_id)
    except Exception as exc:  # noqa: BLE001 - any spawn failure -> FAILED, never hang the task
        store.transition(task_id, status="failed", agent_code=agent_code,
                         receipt_type="FAILED", receipt_body=f"ringer.py run failed to execute: {exc!r}")
        return _finish(store, task_id)
    finally:
        with contextlib.suppress(OSError):
            manifest_path.unlink()

    run = _find_child_run(DEFAULT_STATE_DIR, started)
    summary = _summarize(run, rc)

    # FAIL LOUD on a terminal Feeder rejection (Adam's directive). Two kinds, both
    # terminal → mark failed with the code so it shows RED on the wall, never retry
    # (the same broken model/task just re-spins). Over-budget / spin calls were
    # rejected pre-route, so zero provider tokens were burned on them.
    #   • run_budget_exceeded — detected via the budget endpoint (authoritative)
    #   • no_progress_loop     — detected by scanning the child run's worker output
    bstat = budget_status(task_id)
    breached = bool(bstat and bstat.get("budget") is not None and (bstat.get("spent") or 0) >= bstat["budget"])
    term_code = "run_budget_exceeded" if breached else _scan_terminal_429(run)
    if term_code:
        payload = {"code": term_code, "run_id": task_id, "child": json.loads(summary)}
        if breached:
            payload["spent"] = bstat.get("spent")
            payload["budget"] = bstat.get("budget")
        store.transition(task_id, status="failed", agent_code=agent_code,
                         receipt_type="FAILED", receipt_body=json.dumps(payload, sort_keys=True))
        return _finish(store, task_id)

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
    return _finish(store, task_id)


def serve(store: Store, *, agent_code: str = "ringer", poll_interval: float = 120.0,
          budget_tokens: int | None = AUTORUN_BUDGET_TOKENS, max_passes: int | None = None,
          **kwargs: Any) -> None:
    """One-task-per-pass consumer loop (blueprint §4). Drains eagerly while there
    is work; when idle, waits up to poll_interval OR until wake()d (the /engine/wake
    receiver drives sub-second claims; the poll is the backstop). Stops on stop().
    max_passes bounds the loop for tests."""
    _STOP.clear()
    passes = 0
    while not _STOP.is_set():
        try:
            result = run_once(store, agent_code=agent_code, budget_tokens=budget_tokens, **kwargs)
        except Exception:  # a bad pass must never kill the loop
            result = None
        passes += 1
        if max_passes is not None and passes >= max_passes:
            return
        if result is None:  # queue drained → idle until woken or the poll fires
            _WAKE.wait(timeout=poll_interval)
            _WAKE.clear()


def start_background(store: Store, **kwargs: Any) -> threading.Thread:
    """Run serve() on a daemon thread (the FastAPI lifespan calls this when
    RINGER_ENGINE_AUTORUN=1). Returns the thread."""
    _STOP.clear()
    thread = threading.Thread(target=serve, args=(store,), kwargs=kwargs,
                              name="ringer-engine-runner", daemon=True)
    thread.start()
    return thread


def stop() -> None:
    """Signal the runner loop to exit after its current pass (daemon shutdown)."""
    _STOP.set()
    _WAKE.set()
