"""Ringer Engine queue store (Postgres / psycopg3).

The durable substrate of the swarm queue: three tables (tasks, receipts, ledger)
in the `ringer` database on Feeder's local Postgres. An agent files a task, a
runner claims one at a time (race-safe via FOR UPDATE SKIP LOCKED), writes an
append-only receipt thread, and transitions the task through a status lifecycle
with a CODE-ENFORCED human gate on consequential steps. Leases + an attempt-cap
mean an abandoned claim auto-recovers instead of hanging forever.

Design notes:
- Connect-per-operation (short-lived psycopg connections) → thread-safe under the
  FastAPI/uvicorn daemon without a shared-connection or pool dependency.
- `schema` lets a caller isolate tables (default "public"); the test suite uses a
  throwaway schema so it never touches live queue data.
- Rows are returned as plain dicts (psycopg dict_row).
"""
from __future__ import annotations

import os
import re
from typing import Any

import psycopg
from psycopg.rows import dict_row

VALID_STATUS = {
    "standing", "todo", "working", "needs_input", "review", "done", "failed",
}
VALID_RECEIPT = {
    "CLAIMED", "DONE", "BLOCKED", "UNBLOCKED", "HUMAN_HOLD", "HUMAN_ANSWERED",
    "RESUMED", "FAILED", "APPLIED", "FOLLOW_UP", "LEASE_EXPIRED",
}
_UNSET = object()  # sentinel: distinguish "not passed" from "explicitly None (clear)"
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class Store:
    def __init__(self, dsn: str | None = None, *, schema: str = "public") -> None:
        self.dsn = dsn or os.environ.get("RINGER_DB_DSN")
        if not self.dsn:
            raise ValueError("RINGER_DB_DSN is not set and no dsn was passed")
        if not _IDENT.match(schema):
            raise ValueError(f"invalid schema name: {schema!r}")
        self.schema = schema

    # ---- internals ----
    def _conn(self) -> psycopg.Connection:
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def _t(self, name: str) -> str:
        return f'"{self.schema}"."{name}"'

    # ---- schema ----
    def init_schema(self) -> None:
        tasks, receipts, ledger = self._t("agent_tasks"), self._t("agent_task_receipts"), self._t("agent_status_ledger")
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.schema}"')
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {tasks} (
                    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    agent_code        text NOT NULL,
                    title             text NOT NULL,
                    body              text,
                    task_kind         text NOT NULL DEFAULT 'task',
                    status            text NOT NULL DEFAULT 'todo',
                    claimed_by        text,
                    claimed_at        timestamptz,
                    lease_expires_at  timestamptz,
                    attempts          int  NOT NULL DEFAULT 0,
                    priority          int  NOT NULL DEFAULT 0,
                    parent_id         bigint REFERENCES {tasks}(id) ON DELETE SET NULL,
                    blocked_reason    text,
                    hold_reason       text,
                    created_at        timestamptz NOT NULL DEFAULT now(),
                    updated_at        timestamptz NOT NULL DEFAULT now(),
                    status_updated_at timestamptz NOT NULL DEFAULT now()
                )""")
            # Self-migrate: who to wake on a terminal state (the outbound wake-in,
            # blueprint §7). Nullable; null = no wake (receipts + poll are the backstop).
            cur.execute(f'ALTER TABLE {tasks} ADD COLUMN IF NOT EXISTS notify_agent text')
            cur.execute(f'CREATE INDEX IF NOT EXISTS idx_tasks_code_status ON {tasks}(agent_code, status)')
            cur.execute(f'CREATE INDEX IF NOT EXISTS idx_tasks_claim ON {tasks}(status, priority DESC, created_at ASC)')
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {receipts} (
                    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    task_id      bigint NOT NULL REFERENCES {tasks}(id) ON DELETE CASCADE,
                    agent_code   text NOT NULL,
                    receipt_type text NOT NULL,
                    body         text,
                    created_at   timestamptz NOT NULL DEFAULT now()
                )""")
            cur.execute(f'CREATE INDEX IF NOT EXISTS idx_receipts_task ON {receipts}(task_id, created_at)')
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {ledger} (
                    agent_code        text PRIMARY KEY,
                    notify_url        text,
                    last_heartbeat    timestamptz,
                    last_queue_result text,
                    notes             text,
                    updated_at        timestamptz NOT NULL DEFAULT now()
                )""")

    # ---- tasks ----
    def file_task(self, *, agent_code: str, title: str, body: str | None = None,
                  priority: int = 0, parent_id: int | None = None,
                  task_kind: str = "task", notify_agent: str | None = None) -> dict[str, Any]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"""INSERT INTO {self._t('agent_tasks')}
                    (agent_code, title, body, priority, parent_id, task_kind, notify_agent, status)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'todo') RETURNING *""",
                (agent_code, title, body, priority, parent_id, task_kind, notify_agent),
            )
            return cur.fetchone()

    def _add_receipt(self, cur: psycopg.Cursor, task_id: int, *, receipt_type: str,
                     agent_code: str, body: str | None = None) -> dict[str, Any]:
        if receipt_type not in VALID_RECEIPT:
            raise ValueError(f"invalid receipt_type: {receipt_type!r}")
        cur.execute(
            f"""INSERT INTO {self._t('agent_task_receipts')} (task_id, agent_code, receipt_type, body)
                VALUES (%s,%s,%s,%s) RETURNING *""",
            (task_id, agent_code, receipt_type, body),
        )
        return cur.fetchone()

    def add_receipt(self, task_id: int, *, receipt_type: str, agent_code: str,
                    body: str | None = None) -> dict[str, Any]:
        with self._conn() as conn, conn.cursor() as cur:
            return self._add_receipt(cur, task_id, receipt_type=receipt_type,
                                     agent_code=agent_code, body=body)

    def claim_next(self, agent_code: str, *, lease_seconds: float = 900,
                   max_attempts: int = 3) -> dict[str, Any] | None:
        tasks = self._t("agent_tasks")
        with self._conn() as conn, conn.cursor() as cur:
            # (A) reclaim expired leases FIRST — race-safe, in this same transaction.
            cur.execute(
                f"""UPDATE {tasks} SET status='failed', claimed_by=NULL, claimed_at=NULL,
                        lease_expires_at=NULL, updated_at=now(), status_updated_at=now()
                    WHERE status='working' AND lease_expires_at IS NOT NULL
                          AND lease_expires_at <= now() AND attempts >= %s
                    RETURNING id""",
                (max_attempts,),
            )
            for row in cur.fetchall():
                self._add_receipt(cur, row["id"], receipt_type="FAILED", agent_code="engine",
                                  body="lease expired and attempt cap reached")
            cur.execute(
                f"""UPDATE {tasks} SET status='todo', claimed_by=NULL, claimed_at=NULL,
                        lease_expires_at=NULL, updated_at=now(), status_updated_at=now()
                    WHERE status='working' AND lease_expires_at IS NOT NULL
                          AND lease_expires_at <= now() AND attempts < %s
                    RETURNING id""",
                (max_attempts,),
            )
            for row in cur.fetchall():
                self._add_receipt(cur, row["id"], receipt_type="LEASE_EXPIRED", agent_code="engine",
                                  body="lease expired, returned to queue")
            # (B) claim the single best-eligible todo, race-safe.
            cur.execute(
                f"""SELECT id FROM {tasks}
                    WHERE status='todo' AND (agent_code=%s OR agent_code='all')
                    ORDER BY priority DESC, created_at ASC
                    FOR UPDATE SKIP LOCKED LIMIT 1""",
                (agent_code,),
            )
            pick = cur.fetchone()
            if not pick:
                return None
            cur.execute(
                f"""UPDATE {tasks} SET status='working', claimed_by=%s, claimed_at=now(),
                        lease_expires_at = now() + make_interval(secs => %s),
                        attempts = attempts + 1, updated_at=now(), status_updated_at=now()
                    WHERE id=%s RETURNING *""",
                (agent_code, float(lease_seconds), pick["id"]),
            )
            task = cur.fetchone()
            self._add_receipt(cur, task["id"], receipt_type="CLAIMED", agent_code=agent_code,
                              body=None)
            return task

    def claim_task(self, task_id: int, agent_code: str, *,
                   lease_seconds: float = 900) -> dict[str, Any] | None:
        """Atomic claim of ONE task by id (kanban 'assign to me'). Returns the
        working row, or None if it was not 'todo' (someone else won → 409)."""
        tasks = self._t("agent_tasks")
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"""UPDATE {tasks} SET status='working', claimed_by=%s, claimed_at=now(),
                        lease_expires_at = now() + make_interval(secs => %s),
                        attempts = attempts + 1, updated_at=now(), status_updated_at=now()
                    WHERE id=%s AND status='todo' RETURNING *""",
                (agent_code, float(lease_seconds), task_id),
            )
            task = cur.fetchone()
            if not task:
                return None
            self._add_receipt(cur, task["id"], receipt_type="CLAIMED",
                              agent_code=agent_code, body=None)
            return task

    def get_task(self, task_id: int) -> dict[str, Any]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(f"SELECT * FROM {self._t('agent_tasks')} WHERE id=%s", (task_id,))
            task = cur.fetchone()
            cur.execute(
                f"SELECT * FROM {self._t('agent_task_receipts')} WHERE task_id=%s ORDER BY created_at ASC, id ASC",
                (task_id,),
            )
            receipts = cur.fetchall()
        return {"task": task, "receipts": receipts}

    #: columns a PATCH may free-set (reassign_to maps onto agent_code)
    _SETTABLE = ("title", "body", "priority", "agent_code")

    def transition(self, task_id: int, *, status: str | None = None, agent_code: str,
                   receipt_type: str | None = None, receipt_body: str | None = None,
                   blocked_reason: Any = _UNSET, hold_reason: Any = _UNSET,
                   set_fields: dict[str, Any] | None = None,
                   human_authorized: bool = False, consequential: bool = False) -> dict[str, Any]:
        """The PATCH workhorse. status is optional (None = free-set fields / add a
        receipt without a lifecycle change). ->todo/->done clear the claim."""
        if status is not None and status not in VALID_STATUS:
            raise ValueError(f"invalid status: {status!r}")
        # CODE-ENFORCED GATE: an autonomous caller cannot self-authorize a consequential
        # step. Only a human-directed caller passes human_authorized=True.
        if consequential and not human_authorized:
            raise PermissionError("consequential transition requires human_authorized=True")

        sets = ["updated_at=now()"]
        params: list[Any] = []
        if status is not None:
            sets += ["status=%s", "status_updated_at=now()"]
            params.append(status)
            if status in ("todo", "done"):
                sets += ["claimed_by=NULL", "claimed_at=NULL", "lease_expires_at=NULL"]
        if blocked_reason is not _UNSET:
            sets.append("blocked_reason=%s"); params.append(blocked_reason)
        if hold_reason is not _UNSET:
            sets.append("hold_reason=%s"); params.append(hold_reason)
        for col in self._SETTABLE:
            if set_fields and col in set_fields:
                sets.append(f"{col}=%s"); params.append(set_fields[col])
        params.append(task_id)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"UPDATE {self._t('agent_tasks')} SET {', '.join(sets)} WHERE id=%s RETURNING *",
                params,
            )
            task = cur.fetchone()
            if not task:
                raise ValueError(f"no such task: {task_id}")
            if receipt_type is not None:
                self._add_receipt(cur, task_id, receipt_type=receipt_type,
                                  agent_code=agent_code, body=receipt_body)
            return task

    def list_tasks(self, *, agent_code: str | None = None, status: str | None = None,
                   limit: int = 100) -> list[dict[str, Any]]:
        where, params = [], []
        if agent_code is not None:
            where.append("agent_code=%s"); params.append(agent_code)
        if status is not None:
            where.append("status=%s"); params.append(status)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        params.append(int(limit))
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT * FROM {self._t('agent_tasks')} {clause} "
                f"ORDER BY priority DESC, created_at ASC LIMIT %s",
                params,
            )
            return cur.fetchall()

    def list_ledger(self, *, agent_code: str | None = None) -> list[dict[str, Any]]:
        where, params = "", []
        if agent_code is not None:
            where = "WHERE agent_code=%s"; params.append(agent_code)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT * FROM {self._t('agent_status_ledger')} {where} ORDER BY agent_code ASC",
                params,
            )
            return cur.fetchall()

    def upsert_ledger(self, agent_code: str, *, notify_url: str | None = None,
                      last_queue_result: str | None = None, notes: str | None = None) -> dict[str, Any]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"""INSERT INTO {self._t('agent_status_ledger')}
                        (agent_code, notify_url, last_queue_result, notes, last_heartbeat, updated_at)
                    VALUES (%s,%s,%s,%s, now(), now())
                    ON CONFLICT (agent_code) DO UPDATE SET
                        notify_url        = COALESCE(EXCLUDED.notify_url, {self._t('agent_status_ledger')}.notify_url),
                        last_queue_result = COALESCE(EXCLUDED.last_queue_result, {self._t('agent_status_ledger')}.last_queue_result),
                        notes             = COALESCE(EXCLUDED.notes, {self._t('agent_status_ledger')}.notes),
                        last_heartbeat    = now(),
                        updated_at        = now()
                    RETURNING *""",
                (agent_code, notify_url, last_queue_result, notes),
            )
            return cur.fetchone()
