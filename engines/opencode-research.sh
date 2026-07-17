#!/bin/sh
# opencode-research.sh — OpenCode wrapper for RESEARCH workers that need free
# web-search grounding via Feeder's Ollama augmentation.
#
# Identical isolation to opencode-feeder.sh (private XDG_DATA_HOME so parallel
# workers don't race OpenCode's sqlite), BUT it ALWAYS bakes a per-invocation
# config that flips the provider headers to X-Consumer: ringer-research +
# X-Augment: force (and X-Run-Id when RINGER_RUN_ID is set, preserving the
# spend cap). Loaded via OPENCODE_CONFIG (full-config replacement).
#
# Use for RESEARCH tasks only (manifest "engine": "opencode-research"). Coding
# tasks stay on [engines.opencode] (never augmented). Fail-open: any bake error
# falls back to the global config (un-augmented) rather than blocking the worker.
set -u

find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'ringer-ocr-state.*' -mmin +240 \
  -exec rm -rf {} + 2>/dev/null || true

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ringer-ocr-state.XXXXXX")"

if [ -f "$HOME/.config/opencode/opencode.json" ]; then
  BAKED="$STATE_DIR/opencode.json"
  if python3 /home/ajo/ringer/engines/bake_research_config.py \
       "$HOME/.config/opencode/opencode.json" "$BAKED" "${RINGER_RUN_ID:-}" 2>/dev/null; then
    chmod 600 "$BAKED" 2>/dev/null || true
    export OPENCODE_CONFIG="$BAKED"
  fi
fi

XDG_DATA_HOME="$STATE_DIR" exec /home/ajo/.opencode/bin/opencode "$@"
