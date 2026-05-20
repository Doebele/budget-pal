#!/bin/sh
# ── Budget-Pal Backend Startup ──────────────────────────────────
# Frische DB  → create_all() + alembic stamp head
# Existing DB → alembic upgrade head (inkrementelle Migrationen)
set -e

echo "[startup] Checking database state..."

# Use synchronous psycopg2 to count public tables (no async/import overhead).
# DATABASE_URL is postgresql+asyncpg://...; strip the dialect prefix for psycopg2.
DB_URL=$(echo "$DATABASE_URL" | sed 's/postgresql+asyncpg/postgresql/')

HAS_TABLES=$(python3 -c "
import psycopg2, sys
try:
    conn = psycopg2.connect('$DB_URL')
    cur = conn.cursor()
    cur.execute(\"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'\")
    count = cur.fetchone()[0]
    conn.close()
    print('yes' if count > 0 else 'no')
except Exception as e:
    sys.stderr.write('DB check error: ' + str(e) + '\n')
    print('no')  # assume fresh on any connection error
" 2>&1 | tail -1)

echo "[startup] Has existing tables: $HAS_TABLES"

if [ "$HAS_TABLES" = "yes" ]; then
    echo "[startup] Existing database — running Alembic migrations..."
    alembic upgrade head
else
    echo "[startup] Fresh database detected — bootstrapping via create_all()..."
    python3 - <<'PYEOF'
import asyncio
from app.core.database import engine, Base
from app.models import models  # noqa: F401 — register all ORM models

async def create():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[startup] Full schema created via create_all().")

asyncio.run(create())
PYEOF

    echo "[startup] Stamping Alembic at head (skipping migrations for fresh schema)..."
    alembic stamp head
fi

echo "[startup] Starting server..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
