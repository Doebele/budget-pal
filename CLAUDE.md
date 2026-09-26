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
make build-nosw       # Frontend build without the service worker — otherwise the
                      #   browser serves the previous version after `make build`
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

### Deployment (Strato)
A push to `main` deploys: CI builds images to GHCR, then (if the repo variable
`DEPLOY_ENABLED=true`) SSHes to the server and runs `./deploy.sh <sha7>` with
`docker-compose.prod.yml`. So **merging a PR goes live**. `deploy.sh` dumps the DB
first (`scripts/backup-db.sh`) and falls back to the last healthy tag. Setup and
secrets: README, "Deployment auf Strato".

---

## Domain vocabulary — read this first

Two terms run through the whole app, and both mean the **opposite** of what
everyday usage suggests. Getting them backwards leads to wrong code.

| Term (UI) | Term (code) | What it actually is |
|---|---|---|
| **Empirische Angaben** / *Empirical Data* | `wizard`, `empirical` | **Assumed and statistical** values the user entered in the 8-step wizard, seeded from Swiss FSO (BFS) peer-group averages. These are estimates and plans — *not* observations. |
| **Reale Angaben** / *Actual Data* | `actual`, `past`, `historical` | **Measured** values: transactions that came in through CSV/PDF import from real bank statements. |

So "empirical" here means *modelled*, and "actual" means *observed* — the
reverse of the ordinary meaning of "empirical". The naming is established
across the UI, the i18n keys, the API (`mode=wizard` vs. `mode=past`) and the
database; do not rename it, but never infer the meaning from the word alone.

Where the distinction matters:
- `Budget` rows with a non-null `notes` field come from the wizard (empirical);
  `Transaction` rows come from import (actual).
- `/api/budget/multi-analysis?mode=` — `wizard` = empirical, `past` = actual,
  `combined` = 60 % actual + 40 % empirical, `peer` = FSO benchmark.
- The Health Score has three modes: `historical` (actual), `empirical`
  (wizard), `plan` (RecurringPlan — a third source, neither of the two).
- `RecurringPlan` (Budgetplan) is a **separate** plan world from the wizard
  `Budget` rows. Both feed different views; they are not synchronised.

---

## Architecture

### Stack
- **Backend**: Python 3.11, FastAPI (async), SQLAlchemy 2.0 async, Alembic, PostgreSQL 15
- **Frontend**: React 18, TypeScript, Vite, TailwindCSS, TanStack Query, ECharts (+ Recharts)
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
  auth.py         # /auth — register, login, /me, update profile, password
                  #   forgot/reset (mail link) and change
  transactions.py # /transactions — CRUD, stats, bulk-categorize, archived, restore
  accounts.py     # /accounts — CRUD + bulk-delete/preview (soft & hard delete)
  imports.py      # /imports — CSV/PDF upload, preview, history
  projections.py  # /projections — Monte Carlo scenarios, CRUD
  budgets.py      # /budgets — monthly budget per supercategory
  recurring_plan.py # /recurring-plan — Budgetplan CRUD, /reconciliation (Plan-Ist),
                  #   /batch (create+update+delete in one transaction)
  onboarding.py   # /onboarding — status, demo data (load/remove), merchant review
  taxonomy.py     # /taxonomy — supercategory list + per-user hidden labels
  pension.py      # /pension — AHV/BVG/3a data
  assets.py       # /assets — net worth items
  wizard.py       # /wizard — empirical profile (assumed/statistical, see glossary)
  currency.py     # /currency — live exchange rates (ECB, cached)
  goals.py        # /goals — financial goals
  forecasting.py  # /forecasting — predictive budget scenarios
  backup.py       # /backup — JSON export/import of all data + settings (v1.1).
                  #   GET /export never contains API keys; POST /export-secrets does,
                  #   but only with the account password (rate-limited, 403 not 401 —
                  #   a 401 logs the frontend out). Restoring settings is opt-in.

services/
  categorization.py   # 5-stage pipeline: manual cache → keyword → fuzzy → embedding → LLM
                      #   (the LLM is whatever the user picked, via ai_client)
  ai_client.py        # Provider-agnostic LLM client. 18 providers in PROVIDER_CATALOG
                      #   (same list as fintools); Anthropic uses its Messages API,
                      #   every other provider the OpenAI-compatible API. One profile
                      #   per provider in users.ai_config_json; the old flat format is
                      #   still read. API keys never leave the server (has_key only).
  projection.py       # Monte Carlo simulation + Swiss AHV/BVG/3a pension math
  currency_service.py # ECB rate fetch with file cache (rates.json)
  import_parsers/     # Bank CSV/PDF parsers: UBS, N26, Revolut, comdirect
  audit_log.py        # record_activity() — writes to activity_log for all destructive ops
  peer_group_seed.py  # Seeds system categories on startup (NOT the benchmark table —
                      #   `peer_group_benchmarks` is empty; peer values come from
                      #   peer_group.py constants)
  peer_group.py       # BFS HABE reference values: income medians, savings rates,
                      #   canton multipliers. peer_savings_rate() feeds the health score.
  plan_schedule.py    # Which months a plan entry falls in, and how often per month.
                      #   Frontend twin: frontend/src/lib/planSchedule.ts — keep in sync.
  demo_data.py        # Anonymous sample household (fixed seed → reproducible)
```

### API keys
Stored AI keys never leave the server in normal responses (`has_key` only).
A stored key is only ever sent to the endpoint it was saved with
(`ai_client.endpoint_moves`): the connection test, the model list, saving a
new endpoint and a backup import all enforce this. Otherwise a stolen session
token could point a provider at a foreign server and receive the key.

Registration is open, and the server calls the AI endpoint itself. Every AI
request goes through `ai_client._client()`, whose request hook allows only
public `https` addresses unless `ENVIRONMENT=development` or
`AI_ALLOW_PRIVATE_ENDPOINTS=true`. Create new AI HTTP clients only via
`_client()`, never `httpx.AsyncClient` directly.

### Passwords and sessions
Set a password only via `auth._set_password()`: it stamps
`users.password_changed_at`, and `get_current_user` rejects every token issued
before that second — this is how a password change signs out other devices.
Reset links store only the SHA-256 of the token and are built from
`settings.app_base_url`, never from the request's Host header. Mail goes out
through `services/mailer.py` (plain SMTP); without `SMTP_HOST` it only logs.

Passkeys (`api/webauthn.py`): the challenge is looked up from the response's
`clientDataJSON`, never "the newest open one" — otherwise concurrent logins
collide and spamming the open options route blocks everyone. Adding a passkey
needs the current password (a stolen session must not plant a lasting key);
a password *reset* deletes all passkeys. User verification is required. The
RP ID and origin are fixed per deployment (`WEBAUTHN_*` in
`docker-compose.prod.yml`); the default `localhost` makes every browser refuse.
`tests/test_passkey_ceremony.py` runs real ceremonies with a software authenticator.

### Test environment caveats
Tests run against **in-memory SQLite**, which ignores `VARCHAR(n)` limits. A string
that is too long for a column passes every test and then fails on PostgreSQL with
`value too long for type character varying(n)` — this happened with
`activity_log.method` (VARCHAR(16)). When a value goes into a length-limited column,
assert against the model's limit (`Model.column.type.length`), not against the test DB.

There is no frontend test runner: `npm test` starts vitest, but the project has no
vitest config and no DOM environment (`jsdom` is not installed). `npm run lint` also
fails — ESLint finds no configuration file. Only `npm run typecheck` works.

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
  charts/         # MonteCarloChart, PensionOverviewChart (Recharts), SankeyChart /
                  # CategoryGaugeChart / BudgetStackedBarChart (ECharts)
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
- AHV (Pillar 1): two-segment pension formula (`ahv_full_monthly`) × years/44, paid 13×/year
  (13th pension from Dec 2026), in today's CHF — **not deflated** (it follows the mixed
  wage/price index). Drawn at 63-70 (`ahv_start_age`): −6.8 %/year early, deferral supplement late.
- BVG (Pillar 2): contributions stop at retirement; pension = capital at retirement ×
  `pension_data.conversion_rate` (from the certificate) or `BVG_CONVERSION_RATE_DEFAULT` (5.3 %).
  The legal 6.8 % only applies to the mandatory part. Fixed in nominal CHF after retirement.
  Partial retirement (`pension_data.partial_steps`, Art. 13a BVG: at most two steps before the
  final one, first ≥ 20 %): each step releases the share the workload drops by, as capital
  and/or pension; the rest keeps saving at the lower workload. `bvg_steps()` is the one place
  that walks the BVG year by year; the wealth path loses the missing salary
  (`NET_INCOME_SHARE`) and gains the partial pension.
- Pillar 3a: contributions stop at retirement; each account is withdrawn **as capital** at its
  `withdrawal_age` or at the staggered age from `plan_3a_ages` (one account per year, latest
  first, never in the BVG capital year). The series holds the balance until then, 0 after.
  Max `PILLAR_3A_MAX_CONTRIBUTION` CHF/year.
- Pillar 3b / life insurance: paid out **as capital** at `withdrawal_age` (policy expiry; the
  wizard derives it from the expiry date), else at retirement — tax-free. `current_balance` is
  the fixed maturity sum (return 0), so it loses real value until then.
- Capital withdrawals (`ProjectionService.capital_withdrawals`: BVG steps + 3a + 3b) are
  taxed per calendar year by `services/capital_tax.py` (federal tariff 2026 exact, cantonal from
  ESTV data for the cantonal capital; `TAXED_SOURCES` excludes 3b) and flow into free wealth.
- Payout starts (`payout_start_ages`): AHV 63-70, BVG final step 58-70 (conversion rate
  ±`BVG_CONVERSION_STEP` per year vs. 65), 3a 60-70. Before its start a series holds *capital*,
  not income — use `pension_income` from `run()` for cash flows (AHV + BVG pensions incl.
  partial ones), never the raw sum of the series. For charts `run()` also returns the BVG
  split: `capital_bvg` (balance until the final step, then 0) and `income_bvg`.
- Wealth path (`ProjectionService.run`): savings only until retirement, then pensions minus
  `retirement_spending` (plus AHV non-employed contributions until 65); floored at 0. Early
  retirement is just an earlier `retirement_age` — no special window logic.
- One calculation: Wizard and Finanzplan call `/api/pension/estimate`
  (`ProjectionService.estimate_at_retirement`) — never re-implement pension math in the frontend.
- All monetary projections are inflation-adjusted using `SWISS_INFLATION_RATE` (default 1.5%)
- Monte Carlo: 10,000 runs, percentile bands p10/p25/p50/p75/p90
