# Reboot recovery — ringer's role

Full docs: **`~/.hermes/RECOVERY.md`** (authoritative).

The Ringer **HUD** (`ringer.py hud --no-open --port 8700`) has no supervisor, so a
reboot leaves it down. The recovery system starts it from `~/recover-stack.sh`:

- Start: `python3 ~/ringer/ringer.py hud --no-open --port 8700`
- Health probe: `GET :8700/api/runs` (200 JSON)
- **Idempotent by design**: the HUD self-checks :8700 and exits 0 ("already running")
  if one is up, and Ringer runs call `ensure_hud_running` which only spawns if :8700
  is dead — so the boot-time HUD and on-demand runs coexist without double-binding.
- No feeder/DB dependency for the HUD itself; only actual swarm *workers* need feeder :3001.
