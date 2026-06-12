# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Common Commands

### Docker (primary workflow)
```bash
make dev              # Build + start all 3 services (db, backend, frontend)
make build            # Build images without starting
make restart-backend  # Restart only the backend container
make logs-backend     # Stream backend logs
make logs             # Stream all logs
make stop             # Stop all services
make down             # Stop + remove containers
make down-volumes     # DESTRUCTIVE: also deletes DB volume
```

### Database migrations
```bash
make db-migrate                          # Run pending Alembic migrations
make db-migrate-create MSG="add foo"     # Autogenerate new migration
make db-downgrade                        # Roll back one migration step
make db-status                           # Show current migration head
```

### Testing
```bash
make test-backend                        # All backend tests (inside container)
# Run a single test file:
docker compose exec budget-pal-backend pytest tests/test_auth.py -v
docker compose exec budget-pal-backend pytest tests/services/test_categorization.py -v -k "test_keyword"
```

### Frontend (local dev, without Docker)
```bash
cd frontend && npm install
npm run dev          # Vite dev server — proxies /api → http://localhost:8010
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint
```

### Feature-branch workflow (direct pushes to `main` are blocked by pre-push hook)
```bash
make feature name=my-feature   # Creates branch feat/my-feature from main
make pr msg="feat: description" # Stage all → commit → push → gh pr create
make sync                       # git fetch + rebase origin/main
```
After cloning fresh: run `git config core.hooksPath .githooks` once to activate the pre-push guard.

---

## Architecture

### Stack
- **Backend**: Python 3.11, FastAPI (async), SQLAlchemy 2.0 async, Alembic, PostgreSQL 15
- **Frontend**: React 18, TypeScript, Vite, TailwindCSS, TanStack Query, Recharts / Nivo
- **Deployment**: Docker Compose — 3 services: `budget-pal-db`, `budget-pal-backend`, `budget-pal-frontend`
- **Build context**: Repo root (`.`) for both backend and frontend Dockerfiles

### Backend structure (`backend/app/`)

```
core/
  config.py       # Pydantic Settings — all env vars with Swiss financial constants
  database.py     # Async SQLAlchemy engine, Base, get_db() dependency, init_db()
  security.py     # JWT creation/verification, bcrypt password hashing, get_current_user
  taxonomy.py     # Loads shared/taxonomy.json, WIZARD_TO_TXN mapping helpers
  json_type.py    # PortableJSON: JSONB on Postgres, JSON on SQLite

models/
  models.py       # All ORM models in one file. Key tables: User, Account, Transaction,
                  # Category, Budget, RecurringPlan, Goal, Asset, MortgageTranche,
                  # Scenario, ImportLog, ActivityLog, PeerGroupBenchmark

api/              # One router per domain, all mounted in main.py under /api/<name>
  auth.py         # /auth — register, login, /me, update profile
  transactions.py # /transactions — CRUD, stats, bulk-categorize, archived, restore
  accounts.py     # /accounts — CRUD + bulk-delete/preview (soft & hard delete)
  imports.py      # /imports — CSV/PDF upload, preview, history
  projections.py  # /projections — Monte Carlo scenarios, CRUD
  budgets.py      # /budgets — monthly budget per supercategory
  recurring_plan.py # /recurring-plan — Budgetplan CRUD
  taxonomy.py     # /taxonomy — supercategory list + per-user hidden labels
  pension.py      # /pension — AHV/BVG/3a data
  assets.py       # /assets — net worth items
  wizard.py       # /wizard — empirical financial profile setup
  currency.py     # /currency — live exchange rates (ECB, cached)
  goals.py        # /goals — financial goals
  forecasting.py  # /forecasting — predictive budget scenarios

services/
  categorization.py   # 5-stage AI pipeline: manual cache → keyword → fuzzy → embedding → OpenAI
  projection.py       # Monte Carlo simulation + Swiss AHV/BVG/3a pension math
  currency_service.py # ECB rate fetch with file cache (rates.json)
  import_parsers/     # Bank CSV/PDF parsers: UBS, N26, Revolut, comdirect
  audit_log.py        # record_activity() — writes to activity_log for all destructive ops
  peer_group_seed.py  # Seeds peer_group_benchmarks on startup
```

### Database startup policy
`backend/start.sh` handles two cases:
- **Fresh DB** (no public tables): runs `SQLAlchemy create_all()` then `alembic stamp head`
- **Existing DB**: runs `alembic upgrade head` normally

This is because the original Alembic baseline migration was generated on a pre-existing DB and does not create tables itself — only incremental migrations add/alter things.

### Frontend structure (`frontend/src/`)

```
lib/
  api.ts          # Single Axios instance with JWT interceptor. All API calls grouped by domain:
                  # authApi, accountsApi, transactionsApi, importsApi, projectionsApi, etc.
  auth.tsx        # AuthContext + useAuth() — token in localStorage (key: budget_pal_token)
  categories.ts   # useTaxonomy() hook — merges shared/taxonomy.json with per-user /api/taxonomy

pages/            # One file per route. Pages own their data-fetching via TanStack Query.
hooks/
  useBulkDelete.ts  # Reusable bulk archive/hard-delete logic for account transaction modals

components/
  transactions/   # TransactionOverviewHeader (bulk archive modal), DeletedTransactionsView
  charts/         # MonteCarloChart (Recharts), SankeyChart (Nivo)
  wizard/         # Multi-step onboarding wizard components
  layout/         # LoadingScreen, navigation shell
```

### Shared taxonomy (`shared/taxonomy.json`)
Central definition of all 11 supercategories (wohnen, essen, mobilitaet, versicherungen, freizeit, abos, shopping, bildung, steuern, sparen, sonstiges). Both backend and frontend import this directly. The backend mounts it at `/shared/taxonomy.json` inside the container. Per-user label overrides are stored as JSON in `User.taxonomy_hidden_json`.

### Key patterns

**Soft delete**: Transactions have `is_deleted` + `deleted_at`. All normal queries filter `is_deleted.isnot(True)`. Archived transactions are accessible at `/transactions/archived`.

**Async sessions**: All DB access goes through `get_db()` dependency. Sessions do NOT auto-commit — routers must call `await db.commit()` or `await db.flush()` explicitly.

**TanStack Query**: `staleTime=2min`, `gcTime=10min`. Query keys follow `["resource", filters]` pattern. Mutations invalidate related queries on success.

**JWT flow**: Token stored in `localStorage` → attached by Axios request interceptor → 401 response clears token and redirects to `/login`.

**PortableJSON**: Use `PortableJSON` (not raw `JSON`/`JSONB`) for any JSON columns so the app works on both PostgreSQL and the optional SQLite deployment (`docker-compose.sqlite.yml`).

### Swiss-specific domain logic
- AHV (Pillar 1): contribution years × average salary → capped at `AHV_MAX_PENSION_CHF`
- BVG (Pillar 2): accumulated capital × `AHV_CONVERSION_RATE_BVG` (6.8%)
- Pillar 3a: compound interest, max `PILLAR_3A_MAX_CONTRIBUTION` CHF/year tax-deductible
- All monetary projections are inflation-adjusted using `SWISS_INFLATION_RATE` (default 1.5%)
- Monte Carlo: 10,000 runs, percentile bands p10/p25/p50/p75/p90
