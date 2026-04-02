# Database Migrations Policy

Budget-Pal follows a migrations-first approach.

## Rules

- Production/staging must use Alembic migrations.
- `AUTO_CREATE_SCHEMA` should stay `false` outside local experimentation.
- Startup `create_all()` is disabled by default.

## Typical flow

1. Generate migration:
   - `make db-migrate-create MSG="describe change"`
2. Apply migration:
   - `make db-migrate`
3. Verify state:
   - `make db-status`

## Why

This avoids schema drift between environments and keeps upgrades auditable.

