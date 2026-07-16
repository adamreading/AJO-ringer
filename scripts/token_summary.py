#!/usr/bin/env python3
"""One-line token-burn summary for a run, for the orchestrator to quote in the Relay
response (Adam's directive 2026-07-16). Reads `feeder_totals` from an enriched run
state — run scripts/feeder_enrich.py first. Never raises: prints a clear note and
exits 0 if totals are absent, so it can be dropped into any post-run flow.

    python3 scripts/token_summary.py --state ~/.ringer/runs/<run>.json [--top 3]
"""
import argparse
import json
import sys


def _fmt(n: int) -> str:
    return f"{n:,}"


def summarize(state: dict, top: int = 3) -> str:
    name = state.get("run_name", "run")
    ft = state.get("feeder_totals")
    if not ft:
        return f"({name}: token totals unavailable — run feeder_enrich first)"
    models = ft.get("by_model", [])[:top]
    parts = [
        f"{m['model_id']} ({_fmt(m['total_tokens'])} over {m['calls']} "
        f"call{'s' if m['calls'] != 1 else ''})"
        for m in models
    ]
    tail = ("; ".join(parts)) if parts else "n/a"
    return (f"{name} used {_fmt(ft['total_tokens'])} tokens "
            f"(input {_fmt(ft['input_tokens'])} / output {_fmt(ft['output_tokens'])}) "
            f"across {ft['calls']} calls on {ft['models']} model(s). "
            f"Top: {tail}.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Token-burn summary for a run's Relay response")
    ap.add_argument("--state", required=True, help="Path to the (enriched) run state JSON")
    ap.add_argument("--top", type=int, default=3, help="How many top models to name (default 3)")
    ap.add_argument("--json", action="store_true", help="Emit the feeder_totals dict instead of a line")
    args = ap.parse_args()
    try:
        with open(args.state, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"(token summary unavailable: {e})")
        return 0
    if args.json:
        print(json.dumps(state.get("feeder_totals") or {}, indent=2))
    else:
        print(summarize(state, top=args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())
