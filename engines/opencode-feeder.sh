#!/bin/sh
# opencode-feeder.sh — per-invocation OpenCode state isolation for parallel
# Ringer workers on Linux/WSL.
#
# WHY: OpenCode keeps a shared SQLite state DB at XDG_DATA_HOME/opencode/
# opencode.db; concurrent workers race on it and die with "database is locked"
# (bit the phase4-feeder-telemetry round-1 swarm, 2026-07-14). Each invocation
# gets a private XDG_DATA_HOME instead. XDG_CONFIG_HOME is untouched, so the
# global feeder provider config (~/.config/opencode/opencode.json) still loads.
#
# This wrapper is Ringer's [engines.opencode] bin on this machine. It is NOT a
# sandbox (the macOS Seatbelt wrapper does not run here) — containment stays
# worktrees + scoped manifests + the human consequence-gate.
set -u

# opportunistic cleanup of state dirs older than 4h
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'ringer-oc-state.*' -mmin +240 \
  -exec rm -rf {} + 2>/dev/null || true

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ringer-oc-state.XXXXXX")"

# Spend-cap transport: when the runner sets RINGER_RUN_ID, bake a literal
# X-Run-Id header into a per-invocation OpenCode config (full-config replacement
# via OPENCODE_CONFIG) so Feeder can enforce the per-(consumer,run_id) budget.
# No RINGER_RUN_ID → we set nothing and behave exactly as before (global config
# loads from XDG_CONFIG_HOME untouched). Fail-open: any bake error → run uncapped
# rather than blocked.
if [ -n "${RINGER_RUN_ID:-}" ] && [ -f "$HOME/.config/opencode/opencode.json" ]; then
  BAKED="$STATE_DIR/opencode.json"
  if python3 /home/ajo/ringer/engines/inject_run_id.py \
       "$HOME/.config/opencode/opencode.json" "$RINGER_RUN_ID" "$BAKED" 2>/dev/null; then
    chmod 600 "$BAKED" 2>/dev/null || true
    export OPENCODE_CONFIG="$BAKED"
  fi
fi

XDG_DATA_HOME="$STATE_DIR" exec /home/ajo/.opencode/bin/opencode "$@"
