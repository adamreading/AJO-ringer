#!/usr/bin/env python3
"""Pre-flight: is Feeder's free web-search augmentation live RIGHT NOW?

Ringer research workers get their web grounding for free via Feeder's Ollama
web_search augmentation (consumer opts in with augment='force'/'auto'). The free
Ollama tier has hourly + weekly caps and "throttles hard under a big catalog
sweep" (per Feeder's search config) — when throttled, Feeder silently proceeds
UNaugmented (runWebAugment returns null), which would leave a research worker
guessing blind.

This probe fires ONE cheap augment-forced completion and reads the X-Augmented
response header (Feeder sets 'X-Augmented: web-search' when grounding actually
fired; absent when it didn't). Use it as the fallback gate:

    live      -> route research workers through Feeder augmentation (free)
    throttled -> orchestrator grounds the research itself (WebSearch/WebFetch),
                 bakes facts+sources into the specs, augment OFF (the classic
                 grounded-research pattern) — the Opus-side fallback.

Exit 0 = augmentation live; exit 2 = throttled/unavailable; exit 1 = probe error.
Stdlib only (matches ringer.py). Costs one tiny free-model call.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

FEEDER_BASE = "http://localhost:3001"


def _get_key(base: str, timeout: float) -> str:
    try:
        with urllib.request.urlopen(f"{base}/api/settings/api-key", timeout=timeout) as r:
            return (json.loads(r.read().decode("utf-8")) or {}).get("apiKey", "") or ""
    except Exception:
        return ""  # localhost is trusted tokenless; empty Bearer still works


def probe(base: str = FEEDER_BASE, model: str = "auto/reasoning", timeout: float = 30.0) -> dict:
    """Return {'augmented': bool, 'header': str, 'served': str} or raises on hard error."""
    key = _get_key(base, timeout=6.0)
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "What is today's date and one current news headline?"}],
        "max_tokens": 48,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/v1/chat/completions", data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "X-Consumer": "ringer-research-probe",  # telemetry only; not a blocked label
            "X-Augment": "force",                    # bypass the recency-regex gate
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        header = (r.headers.get("X-Augmented") or "").strip()
        payload = json.loads(r.read().decode("utf-8"))
    served = payload.get("model") or (payload.get("provider") or "?")
    # Feeder sets 'X-Augmented: web-search' only when grounding actually fired.
    augmented = bool(header) and header.lower() not in ("", "off", "false", "0", "none")
    return {"augmented": augmented, "header": header, "served": served}


def main() -> int:
    ap = argparse.ArgumentParser(description="Probe Feeder free web-search availability")
    ap.add_argument("--base", default=FEEDER_BASE)
    ap.add_argument("--model", default="auto/reasoning", help="cheap/free model for the probe")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--quiet", action="store_true", help="only print live|throttled|error")
    args = ap.parse_args()
    try:
        res = probe(args.base, args.model, args.timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as e:
        print("error" if args.quiet else f"PROBE ERROR: {e} — cannot reach Feeder; ground research yourself")
        return 1
    if res["augmented"]:
        print("live" if args.quiet else
              f"LIVE: Feeder web-search augmentation firing (X-Augmented={res['header']}, served {res['served']}). "
              f"Route research workers through augmentation (free).")
        return 0
    print("throttled" if args.quiet else
          f"THROTTLED/OFF: no augmentation fired (X-Augmented={res['header'] or 'absent'}, served {res['served']}). "
          f"FALLBACK: orchestrator grounds research itself (WebSearch), augment off.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
