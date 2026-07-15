> **STATUS — PARKED REFERENCE (2026-07-15).** Donated design seed for a future Ringer
> swarm-queue + kanban + agent-API. Captured here because ownership of that build was
> assigned to the Ringer repo. **No build has started and none will until Adam gives a
> direct greenlight.** This is documentation only. See RINGER-PLAN.md when it graduates
> from parked to planned.

# Open Engine → Ringer queue: donor blueprint

**From:** OB-Claude (@windows) · **For:** @ringer-claude (owner/builder) · **Date:** 2026-07-15
**Purpose:** everything Ringer needs to build the swarm queue + kanban + agent-API by **porting** OB's proven Open Engine, not reinventing it. This is a handoff artifact in the shared coordination folder (reachable via `/mnt/c`). Copy what you want into the Ringer repo; the master plan is yours from here.

> **Context reminder.** The product = 2 repos (Feeder + Ringer), any agent, zero OB. Ringer HOSTS the queue+kanban+agent-API on its always-on `:8700` daemon; storage = a separate `ringer` database on Feeder's local Postgres server; Feeder stays a pure proxy (+ per-run spend cap). OB donates this design and becomes an optional consumer (Lunk dogfoods it). Everything below is **verified against OB's live code** (file:line refs given) so you can trust it as a spec.

---

## 0. The model in one paragraph

Open Engine is a **shared agent work-queue + coordination protocol**, deliberately separate from any "content" tables. One intelligent agent **claims one task per pass**, does open-ended judgment work, writes **receipts** (an append-only audit thread on the task), and **stops at a human gate** before anything consequential. It is intentionally *read-mostly from the UI side* — the board is a window + light human steering, not a second write path. For the swarm product, a "task" = a swarm run request: an agent files it, Ringer claims it, runs the swarm, posts the answer back as a receipt, sets the task done.

---

## 1. Schema — 3 tables (port as the `ringer` DB)

Source: `supabase/migrations/20260703060000_open_engine_v1.sql`. OB's is Postgres-native (Supabase), lifts directly into a plain local Postgres `ringer` DB.

### `agent_tasks`
| column | type | notes |
|---|---|---|
| `id` | `bigserial` PK | doubles as the run id |
| `agent_code` | `text NOT NULL` | assignee; `'all'` = any agent may claim. For the product: `'ringer'`. |
| `title` | `text NOT NULL` | |
| `body` | `text` | **the swarm manifest + intent/context** — Ringer's orchestrator reads this |
| `task_kind` | `text NOT NULL DEFAULT 'task'` | CHECK in (`standing`, `task`, `standing_skill`) |
| `status` | `text NOT NULL DEFAULT 'todo'` | CHECK in (`standing`, `todo`, `working`, `needs_input`, `review`, `done`) |
| `claimed_by` | `text` | who took it |
| `claimed_at` | `timestamptz` | |
| `priority` | `int NOT NULL DEFAULT 0` | higher = more urgent |
| `parent_id` | `bigint` FK→`agent_tasks(id)` ON DELETE SET NULL | delegation / sub-tasks |
| `blocked_reason` | `text` | set when `needs_input` and the answer arrives **on the task** |
| `hold_reason` | `text` | set when `needs_input` and the answer arrives **in the operator's own thread** |
| `local_context_version` | `text` | standing-context versioning |
| `created_at` / `updated_at` / `status_updated_at` | `timestamptz NOT NULL DEFAULT now()` | |

Indexes: `(agent_code, status)`; `(status, priority DESC, created_at ASC)` ← the claim-ordering index.

### `agent_task_receipts` (the audit thread)
`id bigserial PK` · `task_id bigint NOT NULL` FK→`agent_tasks(id)` **ON DELETE CASCADE** · `agent_code text NOT NULL` · `receipt_type text NOT NULL` CHECK in the 10 values below · `body text` · `created_at timestamptz`. Index `(task_id, created_at)`.

Receipt types: `CLAIMED, DONE, BLOCKED, UNBLOCKED, HUMAN_HOLD, HUMAN_ANSWERED, RESUMED, FAILED, APPLIED, FOLLOW_UP`.

### `agent_status_ledger` (heartbeat + registry)
PK `agent_code text`. Columns: `human_operator, runtime, automation, automation_state, last_heartbeat timestamptz, last_queue_result, last_successful_run timestamptz, local_context_version, optional_skills jsonb DEFAULT '[]', notes, updated_at`.
**For the agent-agnostic wake, add a `notify_url text` column here** (the URL the host POSTs on DONE — see §7).

---

## 2. Claim RPCs (or equivalents in Ringer's daemon)

- `claim_agent_task(p_id, p_agent_code)` — atomic single-row: `UPDATE … SET status='working', claimed_by, claimed_at=now() WHERE id=p_id AND status='todo' RETURNING *`. Empty return = someone else won.
- `claim_next_agent_task(p_agent_code)` — picks oldest eligible `todo` where `agent_code = p_agent_code OR 'all'`, `ORDER BY priority DESC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, flips it to `working`. **This is the race-safe runner claim** — use this shape for Ringer's consumer.

> If Ringer's daemon talks SQL directly (not through a PostgREST-style layer), you can inline these as SQL functions or as parameterized queries — the `FOR UPDATE SKIP LOCKED` is the only load-bearing bit for concurrency.

---

## 3. REST surface (what the agent-API should expose)

OB's 9 routes (`rest-api/index.ts:3920-4081`) — port the shape:
1. `GET /agent-tasks?agent_code=&status=&limit=` — list (status CSV → `IN`); ordered priority-first.
2. `POST /agent-tasks/claim-next {agent_code}` — claim next; auto-writes a `CLAIMED` receipt; returns the **full task row** (so the claimer gets `id` + `body`/manifest in one round-trip — this satisfies "hand Ringer the task_id + intent at claim", no second fetch).
3. `GET /agent-tasks/:id` — `{task, receipts}` (receipts ASC) = the thread read.
4. `POST /agent-tasks {agent_code, title, body?, priority?, parent_id?, task_kind?}` — CREATE; status forced to `todo` (or `standing` for standing kinds). **This is the "file a job" endpoint** any agent calls.
5. `POST /agent-tasks/:id/claim` — atomic claim by id; 409 if lost.
6. `PATCH /agent-tasks/:id` — the workhorse: `status` transition (validated); `→done` or `→todo` **clears the claim**; free-set `title/body/blocked_reason/hold_reason/priority`; `reassign_to`; and an **optional inline receipt** (`receipt_type`+`receipt_body`) in the same call.
7. `POST /agent-tasks/:id/receipts {receipt_type, agent_code, body}` — standalone receipt.
8. `GET /agent-ledger?agent_code=` — list ledger.
9. `PUT /agent-ledger/:agent_code` — upsert; heartbeat fields accept `true`/`"true"` as a `now()` sentinel.

---

## 4. RUNNER protocol — one-task-per-pass (`.claude/open-engine/RUNNER.md`)

The consumer loop, top-to-bottom, **stop at the first step that yields work**:
1. **Check in** — heartbeat the ledger.
2. **Standing preflight** — apply any standing context whose version changed; `APPLIED` receipt.
3. **Human-holds** — a `needs_input`+`hold_reason` task whose operator answered → `HUMAN_ANSWERED`+`RESUMED`, finish.
4. **Blocked** — a `needs_input`+`blocked_reason` task that got its on-task answer → `UNBLOCKED`+`RESUMED`, finish.
5. **Delegated** — tasks you created (`parent_id`); `FOLLOW_UP` on the parent if a child changed.
6. **Claim new work** — `claim_next`; empty → idle, stop; on win the `CLAIMED` receipt is auto-written and you **re-read** the task before acting.
7. **Do the scoped work** — done→`DONE`; needs a human look→`review`+`DONE`; missing info answerable-by-anyone→`needs_input`+`blocked_reason`+`BLOCKED`; answerable-only-by-your-operator→`needs_input`+`hold_reason`+`HUMAN_HOLD`; failure→`FAILED` (+ stay `working` if retryable).
8. **Check out** — ledger `run_succeeded`. **STOP — one task per pass.**

Rules: never un-fail or re-claim another agent's `working` task.

**For Ringer:** step 6's claim triggers `ringer.py run` on the claimed `body` (manifest); step 7's outcomes map cleanly — a qualifying question = `needs_input`+`BLOCKED`, the final swarm answer = `DONE` receipt with the result, "wants Adam's eyes" = `review`.

---

## 5. needs_input → answer → re-queue flow (already works in OB)

1. Agent sets `status='needs_input'` + `blocked_reason` (on-task) **or** `hold_reason` (operator-thread), plus a `BLOCKED`/`HUMAN_HOLD` receipt.
2. A human (or the filing agent) answers → `PATCH {status:'todo', blocked_reason:null, hold_reason:null, receipt_type:'UNBLOCKED', receipt_body:<answer>, agent_code:'adam'}`.
3. The `→todo` transition **clears the claim**; the agent re-claims and reads the `UNBLOCKED` receipt on the thread.

This is exactly "Ringer asks a qualifying question, the human/agent answers, Ringer resumes." It's proven in OB (`EngineBoard.tsx:878-923`).

---

## 6. Kanban / board design ("Ringside" extends the :8700 HUD)

OB's `EngineBoard.tsx` — the surface Ringer can mirror:
- **Columns by status**: `todo / working / needs_input / review / done` (done capped at ~15 most-recent). Standing tasks in a separate rail.
- **Task modal** = the receipt thread (`GET /agent-tasks/:id`) + light controls: create, re-queue, mark-done, priority toggle, and an **Answer box on needs_input tasks** that PATCHes → `UNBLOCKED` + `todo`.
- **Poll cadence** was 15s in OB (read-only display). For the product you'll drive the board from Ringer's own daemon state so it's live without a poll; the poll is only a backstop.
- **Design principle to keep:** the board is a **window + light human steering**, NOT a second autonomous write path. Agents run the queue via the protocol; humans watch + answer + steer.

---

## 7. Agent-agnostic wake (the "smooth, no heavy polling" part)

The whole box is local (no public inbound), so **wakes are local peer-to-peer HTTP**, not cloud pushes:
- **File + wake-out (agent→Ringer):** the agent `POST`s the job to Ringer's `/agent-tasks`, then fires a **local** wake to Ringer's `:8700` receiver (e.g. `host.docker.internal:8700` from a container) → Ringer wakes ~1s and claims. The durable queue is source of truth; a **slow poll (~120s) is the backstop** so a missed wake never strands a job.
- **Wake-in (Ringer→agent on DONE):** the agent **registers a wake URL** in the ledger (`notify_url`); Ringer `POST`s it on `DONE`. Reference consumer = Hermes `api_server` (`127.0.0.1:<port>` + shared token); the same register-URL + POST-on-DONE shape generalizes to OpenClaw/any agent with an inbound. The DONE handler on the agent side should resume the operator-facing session and relay the result (wsl owns that mapping for Lunk).
- **No cloud, no pg_net, no Supabase Realtime.** (OB briefly considered a pg_net trigger→webhook; dropped because cloud pg_net can't reach localhost-only endpoints.)

---

## 8. Two HARD-REQUIREMENT fixes to bake in (do NOT port OB's gaps)

OB's current impl has two gaps that were on OB's own fix-list. Since this is a product others run autonomously, **build these in from day one** — cheap now, painful to retrofit:

**(1) Code-enforced human/consequence gate.** In OB the gate is **advisory only** (a RUNNER *instruction*, no code check). Make it a real block at the queue transition: an autonomous orchestrator **cannot self-authorize a consequential step** (publish / deploy / delete stored data / spend / credentials / customer-facing). Mirror OB's escalation approve-guard (`758bfab`): a consequential transition requires a `human_directed`/`human_authorized` flag that an autonomous turn **cannot set** — only a human-directed action (logged session / operator answer) can. Produce+verify swarm work = autonomous-OK; applying a result to the world = gated.

**(2) Lease + attempt-cap.** OB's tables have **neither** — a claimed task with no finisher hangs forever. Add: a **visibility-timeout lease** (a `working` task whose `claimed_at` + lease has elapsed returns to `todo` for re-claim) + an **attempt-cap** (after N reclaim/fail cycles → `failed`/`needs_input`, don't loop forever). This is enforced runaway-recovery for the "stuck/abandoned swarm" mode.

---

## 9. Spend cap interface (feeder-lane, but here's the contract)

- **run_id = the `agent_tasks.id`.** Ringer stamps every worker call `X-Session-Id="<task_id>:<attempt>"` so feeder's per-request token log keys exactly to the queue task.
- **Ringer is the budget-SETTER:** at claim, POST `feeder /api/swarm/budget {run_id=<task_id>, max_tokens}` over localhost (set-once / lower-only — un-raisable mid-run; localhost-trust for v1).
- **Feeder enforces:** cumulative `(consumer, run_id)` tokens ≥ ceiling → typed `429 run_budget_exceeded` (terminal for the run — Ringer STOPS, doesn't retry). Fail-open on budget-store errors (never a false denial).
- This is runaway-mode (a) "token burn"; the lease/attempt-cap (§8.2) is runaway-mode (b) "stuck task". Two enforced boundaries.

---

## 10. What NOT to port
- Supabase/PostgREST specifics (OB runs the queue behind PostgREST; Ringer talks local PG directly). The **egress rule that bit OB was about OB's CLOUD project** — a local PG has no such concern.
- The 8 MCP tools + Next dashboard proxies (OB-specific surfaces). Ringer's `:8700` HUD is the board; the agent-API is your own.
- OB keeps its own Open Engine internally; the product doesn't depend on it.

---

*Questions → @windows on the board. The master plan is Ringer's from here; this is the seed. — OB-Claude*
