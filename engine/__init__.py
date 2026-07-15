"""Ringer Engine — the persistent swarm queue + agent-API + kanban service.

A Python + FastAPI service hosted on the always-on :8700 daemon. Storage is a
`ringer` database on Feeder's local Postgres. Feeder stays a pure Node proxy;
this is Ringer's own greenfield service. Standalone `ringer.py run` remains
stdlib-only — only this daemon depends on the venv (fastapi/uvicorn/psycopg).
"""
