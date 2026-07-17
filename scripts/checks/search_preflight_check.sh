#!/bin/sh
# Check: search_preflight.py compiles and returns coherent state/exit-code pairs.
# It probes the LIVE Feeder augment path, so it asserts the contract (state token
# matches exit code), not a fixed verdict (Ollama may legitimately be throttled).
set -u
cd /home/ajo/ringer
PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

"$PY" -c "import ast; ast.parse(open('scripts/search_preflight.py').read())" \
  || { echo "FAIL: search_preflight.py does not parse"; exit 1; }

out=$("$PY" scripts/search_preflight.py --quiet 2>/dev/null); rc=$?
case "$out:$rc" in
  live:0)       echo "PASS: augmentation LIVE (exit 0) — research routes through Feeder";;
  throttled:2)  echo "PASS: augmentation THROTTLED (exit 2) — fallback to Opus grounding fires";;
  error:1)      echo "PASS: probe ERROR (exit 1) — Feeder unreachable, fallback to Opus grounding";;
  *) echo "FAIL: state/exit mismatch — got out='$out' exit=$rc (want live:0|throttled:2|error:1)"; exit 1;;
esac