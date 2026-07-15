#!/bin/sh
# Check: a research task run with `--agent researcher` actually used LIVE web search.
# Two things must be true, and the second is the one that matters:
#   1. report.md exists with an ## Answer and ## Sources section, citing >=2 distinct
#      https:// URLs (structure + evidence of external material).
#   2. worker.log contains a real Tavily tool_use event — PROOF the agent called the
#      web-search tool rather than answering from stale model priors. A model can
#      hallucinate URLs; it cannot fake a tool_use event in the raw OpenCode log.
# Runs with cwd = task working directory (report.md and worker.log both live here).
# POSIX/dash-safe (checks execute under /bin/sh, not bash).
set -u

REPORT=report.md
LOG=worker.log

test -f "$REPORT" || { echo "FAIL: $REPORT not found in $(pwd)"; exit 1; }

grep -qiE '^##[[:space:]]*Answer'  "$REPORT" || { echo 'FAIL: report.md missing an "## Answer" section'; exit 1; }
grep -qiE '^##[[:space:]]*Sources' "$REPORT" || { echo 'FAIL: report.md missing a "## Sources" section'; exit 1; }

urls=$(grep -oE 'https://[^ )>"]+' "$REPORT" | sort -u | wc -l | tr -d ' ')
[ "${urls:-0}" -ge 2 ] || { echo "FAIL: need >=2 distinct https:// source URLs in report.md, found ${urls:-0}"; exit 1; }

test -f "$LOG" || { echo 'FAIL: worker.log not found; cannot prove the web tool was used'; exit 1; }
# A tool_use event whose tool name contains "tavily" == the agent invoked the Tavily MCP.
if grep -a '"type":"tool_use"' "$LOG" | grep -aq '"tool":"[^"]*tavily'; then
  calls=$(grep -a '"type":"tool_use"' "$LOG" | grep -ac '"tool":"[^"]*tavily')
  echo "PASS: report.md cites $urls sources and worker.log confirms $calls live Tavily web search call(s)"
else
  echo 'FAIL: no Tavily tool_use event in worker.log — the agent did NOT actually search the web'
  exit 1
fi
