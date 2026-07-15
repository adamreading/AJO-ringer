#!/bin/sh
# Check: the OpenCode agent-iteration guardrail is in place. Every agent in the
# live opencode.json MUST declare a bounded `steps` cap (the missing guardrail
# behind the 6M-token 252-round spin, 2026-07-15). Regression guard: if a future
# edit drops `steps`, this fails loudly. Zero spend (config inspection only).
# POSIX/dash-safe.
set -u

CFG="$HOME/.config/opencode/opencode.json"
PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || PY=python3
test -f "$CFG" || { echo "FAIL: opencode.json not found at $CFG"; exit 1; }

MAX_STEPS=60  # a task should never legitimately need this many agentic rounds

"$PY" - "$CFG" "$MAX_STEPS" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
max_steps = int(sys.argv[2])
problems = []
agents = cfg.get("agent") or {}
if not agents:
    problems.append("no agents defined in opencode.json")
for name, body in agents.items():
    steps = (body or {}).get("steps")
    if not isinstance(steps, int):
        problems.append(f"agent '{name}': missing integer `steps` cap (unbounded agent loop!)")
    elif steps <= 0 or steps > max_steps:
        problems.append(f"agent '{name}': steps={steps} out of sane range (1..{max_steps})")
# compaction should be on (default) — flag only if explicitly disabled.
comp = cfg.get("compaction")
if isinstance(comp, dict) and comp.get("auto") is False:
    problems.append("compaction.auto is explicitly false — context can grow unbounded")
if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
caps = ", ".join(f"{n}={b.get('steps')}" for n, b in agents.items())
print(f"PASS: OpenCode step cap present on every agent ({caps}); compaction not disabled")
PY
