#!/usr/bin/env python3
"""Bake a literal X-Run-Id header into an OpenCode config (spend-cap transport).

Usage: inject_run_id.py <src_config.json> <run_id> <dst_config.json>

OpenCode does NOT substitute {env:VAR} inside a provider's headers block (proven
by probe-opencode-env-session, 2026-07-14), so the per-run spend key can't be an
env-interpolated header. Instead the opencode-feeder.sh wrapper generates a
per-invocation config (full-config replacement via OPENCODE_CONFIG) with the run
id baked LITERALLY into every provider's options.headers as X-Run-Id — which
Feeder reads (same path as X-Consumer) and enforces the per-(consumer,run_id)
budget on. stdlib-only; the wrapper stays dependency-free.
"""
from __future__ import annotations

import json
import sys


def inject(cfg: dict, run_id: str) -> dict:
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
                headers["X-Run-Id"] = run_id
    return cfg


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print("usage: inject_run_id.py <src> <run_id> <dst>", file=sys.stderr)
        return 2
    src, run_id, dst = argv[1], argv[2], argv[3]
    with open(src, encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg = inject(cfg, run_id)
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
