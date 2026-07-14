#!/usr/bin/env python3
"""Validate Ringer manifests against the fleet's Feeder wire-class contract.

Contract (Adam-approved, 2026-07-14; see CLAUDE.md "TASK-CLASS CONTRACT"):
- The wire vocabulary is EXACTLY seven classes (below) plus the implicit
  `overall` (= bare `auto`, never pinned explicitly).
- Feeder does NOT validate the wire class: `auto/<anything>` is accepted and an
  unrecognised class SILENTLY degrades to `overall` in routing AND in the
  quality feed. Enforcement is therefore 100% Ringer-side — this script.
- Local manifest `task_type` stays Ringer's native vocabulary (local
  scoreboard). Every feeder-routed task ADDITIONALLY records an explicit
  `wire_class` in the manifest — chosen by the orchestrator, auditable, never
  re-guessed at runtime. The task's `model` field must agree:
  `feeder/auto/<wire_class>` (or `feeder/auto` when wire_class is "auto").

Usage:
  scripts/wire_class.py MANIFEST.json [MANIFEST2.json ...]   validate manifests
  scripts/wire_class.py --check-enum                         no-drift check vs live Feeder
  scripts/wire_class.py --map                                print the default mapping table

Exit codes: 0 ok, 1 contract violation, 2 enum drift detected.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

FEEDER_BASE = "http://localhost:3001"

# The seven approved wire classes — both valid wire keys AND equal to their
# feeder task_scores task_type (the no-drift sweet spot). Do NOT add feeder's
# aliases (code/writing/puzzle/long/...): they work but invite drift.
WIRE_CLASSES = {
    "coding",
    "math",
    "reasoning",
    "creative_writing",
    "instruction_following",
    "long_query",
    "multi_turn",
}

# Default local-task_type -> wire_class mapping (WSL starter map, Ringer-owned).
# None = genuinely ambiguous: the orchestrator MUST decide per task and the
# explicit wire_class field is the only source of truth.
DEFAULT_MAP: dict[str, str | None] = {
    "code-feature": "coding",
    "code-fix": "coding",
    "refactor": "coding",
    "test-hardening": "coding",
    "site-build": "coding",
    "data-pipeline": "coding",
    "probe": "coding",  # probe scripts are code-shaped by default; override per task
    "code-review": "reasoning",
    "research": "reasoning",
    "persona-review": "multi_turn",
    "copywriting": "creative_writing",
    "format-conversion": "instruction_following",
    "docs": None,      # README/prose -> creative_writing; API-schema doc ->
                       # instruction_following; design rationale -> reasoning
    "bakeoff": None,   # the class of the thing being baked off
    "motion-design": None,
    "image-gen": None,
}


def is_feeder_routed(task: dict) -> bool:
    model = task.get("model", "") or ""
    return model.startswith("feeder/") or (
        task.get("engine") == "opencode" and not model
    )


def validate_manifest(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    errors: list[str] = []
    for task in manifest.get("tasks", []):
        key = task.get("key", "<no-key>")
        model = task.get("model", "") or ""
        wire_class = task.get("wire_class")
        if not is_feeder_routed(task):
            if wire_class is not None:
                print(f"  note [{key}]: wire_class set on a non-feeder task (unused on the wire)")
            continue
        if wire_class is None:
            errors.append(
                f"[{key}] feeder-routed task has NO wire_class field — the contract "
                f"requires an explicit, auditable class (one of {sorted(WIRE_CLASSES)} or 'auto')"
            )
            continue
        if wire_class != "auto" and wire_class not in WIRE_CLASSES:
            errors.append(
                f"[{key}] wire_class '{wire_class}' is not in the approved 7-token vocab — "
                f"feeder would SILENTLY degrade it to 'overall'"
            )
            continue
        expected_model = "feeder/auto" if wire_class == "auto" else f"feeder/auto/{wire_class}"
        if model != expected_model:
            errors.append(
                f"[{key}] model '{model}' disagrees with wire_class '{wire_class}' — "
                f"expected '{expected_model}' (the model field is what actually reaches the wire)"
            )
        local = task.get("task_type", "")
        mapped = DEFAULT_MAP.get(local)
        if mapped and wire_class != "auto" and wire_class != mapped:
            print(
                f"  note [{key}]: wire_class '{wire_class}' overrides default map "
                f"({local} -> {mapped}) — allowed, orchestrator decides; stating for the audit trail"
            )
    return errors


def check_enum() -> int:
    """No-drift check: compare our 7 tokens against Feeder's live canon."""
    url = f"{FEEDER_BASE}/api/canon/task-types"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"enum check SKIPPED: {url} unavailable ({exc}) — using baked-in vocab")
        return 0
    live = {t for t in (data if isinstance(data, list) else data.get("task_types", []))}
    live.discard("overall")
    if live == WIRE_CLASSES:
        print(f"enum check OK: live feeder canon matches the approved 7 tokens")
        return 0
    print("enum DRIFT DETECTED:")
    print(f"  live-only:  {sorted(live - WIRE_CLASSES)}")
    print(f"  local-only: {sorted(WIRE_CLASSES - live)}")
    print("  -> reconcile with feeder-claude on the board before any non-coding run")
    return 2


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    if argv[0] == "--check-enum":
        return check_enum()
    if argv[0] == "--map":
        for local, wire in sorted(DEFAULT_MAP.items()):
            print(f"  {local:20s} -> {wire or 'ORCHESTRATOR DECIDES per task'}")
        return 0
    failed = False
    for path in argv:
        errors = validate_manifest(path)
        if errors:
            failed = True
            print(f"{path}: {len(errors)} contract violation(s)")
            for e in errors:
                print(f"  ERROR {e}")
        else:
            print(f"{path}: wire-class contract OK")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
