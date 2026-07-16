#!/bin/sh
# Check: the job token-burn strip renders on the final report (render_job_token_strip
# + its call site in render_final_report_html). Asserts it shows the total + top model
# when feeder_totals is present, and renders cleanly (no strip, no crash) when absent
# or malformed. Pure-python, no network.
set -u
PY=/home/ajo/ringer/.venv/bin/python
[ -x "$PY" ] || PY=python3
cd /home/ajo/ringer

"$PY" - <<'PY'
import sys
import ringer

problems = []
def ck(c, m):
    if not c:
        problems.append(m)

state = {
    "run_name": "tok-demo", "run_id": "tok1", "tasks": [{"key": "a", "status": "pass"}],
    "feeder_totals": {
        "input_tokens": 31032, "output_tokens": 559, "total_tokens": 31591,
        "calls": 11, "models": 5,
        "by_model": [{"platform": "p", "model_id": "poolside/laguna", "calls": 3,
                      "input_tokens": 11600, "output_tokens": 53, "total_tokens": 11653}],
    },
}
html = ringer.render_final_report_html(state, renderer=None, page_path=None)
ck("Token burn:" in html, "report must show 'Token burn:'")
ck("31,591 total" in html, "must show comma-formatted job total")
ck("31,032 in / 559 out" in html, "must show input/output split")
ck("poolside/laguna" in html, "must name the top model")
ck("11,653" in html and "3 calls" in html, "top model must show its total + call count")

# helper fail-open: absent / malformed -> "" (no crash)
ck(ringer.render_job_token_strip({"tasks": []}) == "", "no feeder_totals -> empty strip")
ck(ringer.render_job_token_strip({"feeder_totals": {"total_tokens": "bad"}}) == "",
   "malformed total -> empty strip, no crash")

# full report renders fine when totals absent (byte-identical path preserved)
html2 = ringer.render_final_report_html(
    {"run_name": "x", "run_id": "x", "tasks": [{"key": "a", "status": "pass"}]},
    renderer=None, page_path=None)
ck("Token burn:" not in html2, "no strip when totals absent")

if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("PASS: job token strip renders total+top-model when present; empty + no crash when absent")
PY
