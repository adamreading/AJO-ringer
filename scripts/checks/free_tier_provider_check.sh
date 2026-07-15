#!/bin/sh
# Check: a provider-scout research task produced a real, decision-ready report backed
# by LIVE web search. Substance over format (dash/POSIX-safe; cwd = task dir).
#   1. report.md exists with the decision sections: Verdict, Free tier, Credit card,
#      At limit, Sources (case-insensitive; matched loosely).
#   2. The Verdict states ADD or SKIP (a clear recommendation, not a shrug).
#   3. >=2 distinct https:// sources cited (external evidence).
#   4. worker.log contains a real Tavily tool_use event — PROOF the agent searched
#      the live web instead of answering from stale priors (URLs alone can be faked).
set -u

REPORT=report.md
LOG=worker.log

test -f "$REPORT" || { echo "FAIL: $REPORT not found in $(pwd)"; exit 1; }

for section in Verdict "Free tier" "Credit card" "At limit" Sources; do
  grep -qiE "^#{1,4}[[:space:]]*.*$section" "$REPORT" \
    || { echo "FAIL: report.md missing a section matching '## $section'"; exit 1; }
done

# The verdict must be a real call: ADD or SKIP appears somewhere in the report.
grep -qiE '\b(ADD|SKIP)\b' "$REPORT" \
  || { echo "FAIL: report.md has no clear ADD/SKIP verdict"; exit 1; }

urls=$(grep -oE 'https://[^ )>"]+' "$REPORT" | sort -u | wc -l | tr -d ' ')
[ "${urls:-0}" -ge 2 ] || { echo "FAIL: need >=2 distinct https:// sources, found ${urls:-0}"; exit 1; }

test -f "$LOG" || { echo 'FAIL: worker.log not found; cannot prove the web tool was used'; exit 1; }
if grep -a '"type":"tool_use"' "$LOG" | grep -aq '"tool":"[^"]*tavily'; then
  calls=$(grep -a '"type":"tool_use"' "$LOG" | grep -ac '"tool":"[^"]*tavily')
  echo "PASS: decision-ready report, $urls sources, $calls live Tavily search call(s)"
else
  echo 'FAIL: no Tavily tool_use in worker.log — the agent did NOT actually search the web'
  exit 1
fi
