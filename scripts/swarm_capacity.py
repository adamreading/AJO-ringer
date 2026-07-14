#!/usr/bin/env python3
"""Pre-launch swarm capacity query (locked swarm design, 2026-07-14).

Adam's hard-refuse rule: every concurrent Ringer worker gets a DISTINCT
provider platform. Feeder's GET /api/swarm/capacity?class=<wire_class> returns
{"sessions": N} = distinct healthy provider lanes for that class right now.
The orchestrator launches with --max-parallel = min(manifest.max_parallel, N)
and re-queries per round, so the hard-refuse constraint is always satisfiable.

Usage:
  scripts/swarm_capacity.py <wire_class> [manifest_max_parallel]

Prints the recommended --max-parallel value on stdout (just the integer when
it can be computed). Exit codes: 0 computed; 2 endpoint unavailable/not built
yet -> fall back to the manifest's own max_parallel, conservatively.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

FEEDER_BASE = "http://localhost:3001"


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    wire_class = argv[0]
    manifest_max = int(argv[1]) if len(argv) > 1 else None
    url = f"{FEEDER_BASE}/api/swarm/capacity?class={wire_class}"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.load(resp)
        sessions = int(data["sessions"])
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(
            f"capacity endpoint unavailable ({exc}) — not built yet or feeder down; "
            f"fall back to the manifest max_parallel and rely on feeder backpressure",
            file=sys.stderr,
        )
        return 2
    recommended = sessions if manifest_max is None else min(manifest_max, sessions)
    print(recommended)
    print(
        f"(feeder reports {sessions} distinct healthy '{wire_class}' lanes"
        + (f"; manifest wanted {manifest_max}" if manifest_max is not None else "")
        + ")",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
