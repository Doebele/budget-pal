#!/bin/sh
# ── Budget-Pal Backend Startup ──────────────────────────────
# 1. Run Alembic migrations (idempotent — safe to run every boot)
# 2. Start Uvicorn application server
set -e

echo "[startup] Running Alembic migrations..."
alembic upgrade head

echo "[startup] Migrations complete. Starting server..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
