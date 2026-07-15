"""Ringer Engine agent-API — the HTTP surface any agent (Lunk, another Claude,
a human via the kanban) uses to drive the swarm queue.

Ports the 9-route shape from OB's Open Engine (docs/open-engine-blueprint.md §3),
backed by engine.store.Store, plus a local wake receiver (§7). Every route is a
thin adapter over the store; the queue semantics (claim race-safety, leases,
attempt-cap, the CODE-ENFORCED human gate) live in the store, verified there.

Datastore selection is env-driven so the same app serves prod ("public") and the
executed check (a throwaway schema): RINGER_DB_DSN + optional RINGER_DB_SCHEMA.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .store import Store

router = APIRouter()


def store() -> Store:
    """A fresh Store per request (connect-per-op → cheap, thread-safe)."""
    return Store(schema=os.environ.get("RINGER_DB_SCHEMA", "public"))


# ---- request bodies ----
class FileTaskIn(BaseModel):
    agent_code: str
    title: str
    body: str | None = None
    priority: int = 0
    parent_id: int | None = None
    task_kind: str = "task"


class ClaimNextIn(BaseModel):
    agent_code: str
    lease_seconds: float = 900
    max_attempts: int = 3


class ClaimIn(BaseModel):
    agent_code: str
    lease_seconds: float = 900


class PatchIn(BaseModel):
    agent_code: str  # who is making the change (attribution + gate identity)
    status: str | None = None
    receipt_type: str | None = None
    receipt_body: str | None = None
    blocked_reason: str | None = None
    hold_reason: str | None = None
    reassign_to: str | None = None
    title: str | None = None
    body: str | None = None
    priority: int | None = None
    human_authorized: bool = False
    consequential: bool = False


class ReceiptIn(BaseModel):
    receipt_type: str
    agent_code: str
    body: str | None = None


class LedgerIn(BaseModel):
    notify_url: str | None = None
    last_queue_result: str | None = None
    notes: str | None = None


class WakeIn(BaseModel):
    agent_code: str | None = None
    task_id: int | None = None
    reason: str | None = None


# ---- 1. list ----
@router.get("/agent-tasks")
def list_tasks(agent_code: str | None = None, status: str | None = None, limit: int = 100):
    return store().list_tasks(agent_code=agent_code, status=status, limit=limit)


# ---- 2. claim next (race-safe runner claim) ----
@router.post("/agent-tasks/claim-next")
def claim_next(body: ClaimNextIn):
    # returns the full task row (id + manifest body in one round-trip), or null when idle
    return store().claim_next(body.agent_code, lease_seconds=body.lease_seconds,
                              max_attempts=body.max_attempts)


# ---- 4. file a job ----  (declared before /:id GET so /claim-next isn't shadowed)
@router.post("/agent-tasks", status_code=201)
def file_task(body: FileTaskIn):
    return store().file_task(agent_code=body.agent_code, title=body.title, body=body.body,
                             priority=body.priority, parent_id=body.parent_id,
                             task_kind=body.task_kind)


# ---- 3. thread read ----
@router.get("/agent-tasks/{task_id}")
def get_task(task_id: int):
    res = store().get_task(task_id)
    if not res.get("task"):
        raise HTTPException(status_code=404, detail="no such task")
    return res


# ---- 5. atomic claim by id ----
@router.post("/agent-tasks/{task_id}/claim")
def claim_by_id(task_id: int, body: ClaimIn):
    task = store().claim_task(task_id, body.agent_code, lease_seconds=body.lease_seconds)
    if task is None:
        raise HTTPException(status_code=409, detail="task not claimable (not todo)")
    return task


# ---- 6. the PATCH workhorse ----
@router.patch("/agent-tasks/{task_id}")
def patch_task(task_id: int, body: PatchIn):
    provided = body.model_fields_set
    kwargs: dict[str, Any] = {}
    if "blocked_reason" in provided:
        kwargs["blocked_reason"] = body.blocked_reason
    if "hold_reason" in provided:
        kwargs["hold_reason"] = body.hold_reason
    set_fields: dict[str, Any] = {}
    for f in ("title", "body", "priority"):
        if f in provided:
            set_fields[f] = getattr(body, f)
    if "reassign_to" in provided and body.reassign_to is not None:
        set_fields["agent_code"] = body.reassign_to
    try:
        return store().transition(
            task_id, status=body.status, agent_code=body.agent_code,
            receipt_type=body.receipt_type, receipt_body=body.receipt_body,
            set_fields=set_fields or None,
            human_authorized=body.human_authorized, consequential=body.consequential,
            **kwargs,
        )
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        code = 404 if "no such task" in str(e) else 400
        raise HTTPException(status_code=code, detail=str(e))


# ---- 7. standalone receipt ----
@router.post("/agent-tasks/{task_id}/receipts", status_code=201)
def add_receipt(task_id: int, body: ReceiptIn):
    if not store().get_task(task_id).get("task"):
        raise HTTPException(status_code=404, detail="no such task")
    try:
        return store().add_receipt(task_id, receipt_type=body.receipt_type,
                                   agent_code=body.agent_code, body=body.body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---- 8. list ledger ----
@router.get("/agent-ledger")
def list_ledger(agent_code: str | None = None):
    return store().list_ledger(agent_code=agent_code)


# ---- 9. upsert ledger (heartbeat + wake registration) ----
@router.put("/agent-ledger/{agent_code}")
def upsert_ledger(agent_code: str, body: LedgerIn):
    return store().upsert_ledger(agent_code, notify_url=body.notify_url,
                                 last_queue_result=body.last_queue_result, notes=body.notes)


# ---- local wake receiver (§7) ----
@router.post("/engine/wake")
def wake(body: WakeIn):
    """Agent→Ringer local wake: an agent that just filed a job pokes this so the
    always-on runner claims within ~1s instead of waiting for the slow-poll
    backstop. No-op (but still 200) when the runner isn't running."""
    from . import runner
    runner.wake()
    return JSONResponse({"ok": True, "woke": True,
                         "agent_code": body.agent_code, "task_id": body.task_id})
