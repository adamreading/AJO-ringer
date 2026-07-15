#!/bin/sh
# Check: the X-Run-Id spend-cap transport bake (engines/inject_run_id.py +
# opencode-feeder.sh guard). Asserts the injector bakes a LITERAL X-Run-Id into
# every provider's options.headers while preserving existing headers + the rest
# of the config, and that the wrapper only activates the bake when RINGER_RUN_ID
# is set (no env → byte-identical to the untouched config = zero risk to current
# runs). Stdlib-only, no network, no opencode spawn. POSIX/dash-safe.
set -u

PY=/home/ajo/ringer/.venv/bin/python
test -x "$PY" || PY=python3
test -f /home/ajo/ringer/engines/inject_run_id.py || { echo "FAIL: injector missing"; exit 1; }
test -f /home/ajo/ringer/engines/opencode-feeder.sh || { echo "FAIL: wrapper missing"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd /home/ajo/ringer

# A representative source config (mirrors the real opencode.json shape).
cat > "$TMP/src.json" <<'JSON'
{"$schema":"x","provider":{"feeder":{"options":{"baseURL":"http://localhost:3001/v1","apiKey":"SECRET","headers":{"X-Consumer":"ringer","X-Augment":"off"}}}},"mcp":{"tavily":{"command":["node","x"]}}}
JSON

"$PY" engines/inject_run_id.py "$TMP/src.json" "task-4242" "$TMP/out.json" || { echo "FAIL: injector exited nonzero"; exit 1; }

"$PY" - "$TMP/out.json" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
p = []
h = cfg["provider"]["feeder"]["options"]["headers"]
if h.get("X-Run-Id") != "task-4242": p.append(f"X-Run-Id not baked: {h.get('X-Run-Id')!r}")
if h.get("X-Consumer") != "ringer": p.append("X-Consumer header lost")
if h.get("X-Augment") != "off": p.append("X-Augment header lost")
if cfg["provider"]["feeder"]["options"].get("apiKey") != "SECRET": p.append("apiKey/rest of config not preserved")
if cfg.get("mcp", {}).get("tavily"): pass
else: p.append("unrelated config (mcp) not preserved")
if p:
    print("FAIL:")
    for x in p: print("  -", x)
    sys.exit(1)
PYEOF
[ $? -ne 0 ] && exit 1

# Wrapper guard: without RINGER_RUN_ID, no OPENCODE_CONFIG bake path is taken.
# Assert the guard condition references RINGER_RUN_ID and OPENCODE_CONFIG export
# sits behind it (static check — we don't spawn opencode).
grep -q 'RINGER_RUN_ID' engines/opencode-feeder.sh || { echo "FAIL: wrapper missing RINGER_RUN_ID guard"; exit 1; }
grep -q 'OPENCODE_CONFIG=' engines/opencode-feeder.sh || { echo "FAIL: wrapper missing OPENCODE_CONFIG export"; exit 1; }
# The export must be inside the RINGER_RUN_ID guard block (appear after the guard 'if').
awk '/if \[ -n "\$\{RINGER_RUN_ID:-\}"/{g=1} /OPENCODE_CONFIG=/{if(!g){print "FAIL: OPENCODE_CONFIG set outside RINGER_RUN_ID guard"; exit 1}} END{}' engines/opencode-feeder.sh || exit 1

echo "PASS: X-Run-Id bake — literal header injected, existing headers/config preserved, wrapper guarded on RINGER_RUN_ID"
