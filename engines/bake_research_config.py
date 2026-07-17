#!/usr/bin/env python3
"""Bake a RESEARCH OpenCode config: flip the augment headers (and optionally the
run-id) so a worker gets FREE web-search grounding via Feeder's Ollama augment.

Usage: bake_research_config.py <src_config.json> <dst_config.json> [run_id]

The global config (~/.config/opencode/opencode.json) ships static provider headers
X-Consumer: ringer + X-Augment: off (correct for CODING — never silently grounded).
Research workers need the opposite, so this writes a per-invocation copy with:
  X-Consumer: ringer-research   (distinct label — per-subset knob + clean telemetry)
  X-Augment:  force             (bypass Feeder's recency-regex gate -> always searches)
and, if run_id is given, X-Run-Id (spend-cap transport, same as inject_run_id).
OpenCode does NOT substitute {env:VAR} in headers, so these must be baked literally
and loaded via OPENCODE_CONFIG (full-config replacement). stdlib-only.
"""
from __future__ import annotations

import json
import sys

# Reuse the run-id injector so the research path keeps the spend-cap transport.
try:
    from inject_run_id import inject as inject_run_id
except Exception:  # invoked from another cwd
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from inject_run_id import inject as inject_run_id

RESEARCH_HEADERS = {"X-Consumer": "ringer-research", "X-Augment": "force"}


def bake(cfg: dict, run_id: str | None = None) -> dict:
    providers = cfg.get("provider")
    if isinstance(providers, dict):
        for body in providers.values():
            if not isinstance(body, dict):
                continue
            options = body.setdefault("options", {})
            if not isinstance(options, dict):
                continue
            headers = options.setdefault("headers", {})
            if isinstance(headers, dict):
                headers.update(RESEARCH_HEADERS)
    if run_id:
        cfg = inject_run_id(cfg, run_id)
    return cfg


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4):
        print("usage: bake_research_config.py <src> <dst> [run_id]", file=sys.stderr)
        return 2
    src, dst = argv[1], argv[2]
    run_id = argv[3] if len(argv) == 4 else None
    with open(src, encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg = bake(cfg, run_id)
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
