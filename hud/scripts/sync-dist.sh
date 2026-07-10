#!/usr/bin/env bash
# Sync the shared dashboard + hud bridge into dist/ before every Tauri build.
# Self-locating: immune to whatever cwd the Tauri CLI uses.
set -euo pipefail
HUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(dirname "$HUD_DIR")"
echo "sync-dist: cwd=$(pwd) hud=$HUD_DIR" >> /tmp/ringside-sync.log
mkdir -p "$HUD_DIR/dist"
cp "$REPO_DIR/dashboard/dashboard.html" "$HUD_DIR/dist/index.html"
cp "$HUD_DIR/frontend/hud.js" "$HUD_DIR/dist/hud.js"
