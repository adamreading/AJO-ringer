#!/bin/sh
# Check: job-level token rollup (feeder_agg.token_totals) + the Relay response line
# (token_summary.summarize). Asserts: ALL rows counted (incl. 429/resend = real burn),
# input+output+total sums, by_model sorted by total desc, graceful empties, and the
# summary line format Adam specified. Pure-python, no network.
set -u
PY=/home/ajo/ringer/.venv/bin/python
[ -x "$PY" ] || PY=python3
cd /home/ajo/ringer

"$PY" - <<'PY'
import sys
sys.path.insert(0, "scripts")
import feeder_agg, token_summary

problems = []
def ck(c, m):
    if not c:
        problems.append(m)

rows = [
    {"platform": "p1", "model_id": "big",   "input_tokens": 100, "output_tokens": 10, "status": "success"},
    {"platform": "p1", "model_id": "big",   "input_tokens": 200, "output_tokens": 20, "status": "429"},
    {"platform": "p2", "model_id": "small", "input_tokens": 30,  "output_tokens": 3,  "status": "success"},
]
t = feeder_agg.token_totals(rows)
ck(t["input_tokens"] == 330, f"input sum {t['input_tokens']}")
ck(t["output_tokens"] == 33, f"output sum {t['output_tokens']}")
ck(t["total_tokens"] == 363, f"total {t['total_tokens']}")
ck(t["calls"] == 3, f"calls must count ALL rows incl 429 (real burn), got {t['calls']}")
ck(t["models"] == 2, f"models {t['models']}")
ck(t["by_model"][0]["model_id"] == "big" and t["by_model"][0]["total_tokens"] == 330,
   f"top by total must be big/330, got {t['by_model'][0]}")
ck(t["by_model"][0]["calls"] == 2, f"big calls must be 2, got {t['by_model'][0]['calls']}")
ck(t["by_model"][1]["model_id"] == "small", "second must be small")

z = feeder_agg.token_totals([])
ck(z["total_tokens"] == 0 and z["by_model"] == [], "empty rows -> zeroed totals, no crash")

line = token_summary.summarize({"run_name": "demo", "feeder_totals": t})
ck("demo used 363 tokens" in line, f"summary total wrong: {line}")
ck("input 330" in line and "output 33" in line, f"summary in/out wrong: {line}")
ck("big (330 over 2 calls)" in line, f"summary top-model wrong: {line}")
ck("unavailable" in token_summary.summarize({"run_name": "x"}), "missing totals must degrade gracefully")

# byte-compat: aggregate_rows (the per-task block) must be UNCHANGED (no input_tokens leak)
agg = feeder_agg.aggregate_rows(rows)
ck("input_tokens" not in agg["served"][0], "aggregate_rows served must stay byte-compatible (no input_tokens)")

if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("PASS: token_totals rollup + summary line correct; aggregate_rows byte-compat preserved")
PY
