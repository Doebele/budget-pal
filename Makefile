.PHONY: dev build stop restart logs logs-backend logs-frontend \
        db-migrate db-migrate-create db-downgrade backup restore \
        shell-backend shell-db shell-frontend \
        test lint format clean prune

# Load .env if it exists
ifneq (,$(wildcard ./.env))
    include .env
    export
endif

COMPOSE = docker compose
BACKEND_CONTAINER = budget-pal-backend
DB_CONTAINER = budget-pal-db
FRONTEND_CONTAINER = budget-pal-frontend
POSTGRES_USER ?= budgetpal
POSTGRES_DB ?= budgetpal
BACKUP_DIR = ./data/backups
TIMESTAMP := $(shell date +%Y%m%d_%H%M%S)

# ── Development ───────────────────────────────────────────────

## Start all services in detached mode
dev:
	$(COMPOSE) up -d --build
	@echo ""
	@echo "  Budget-Pal is starting up..."
	@echo "  Frontend: http://localhost:$(FRONTEND_PORT)"
	@echo "  Backend:  http://localhost:$(BACKEND_PORT)/docs"
	@echo ""

## Build all Docker images without starting
build:
	$(COMPOSE) build

## Build with no cache (full rebuild)
build-clean:
	$(COMPOSE) build --no-cache

## Start without rebuilding
up:
	$(COMPOSE) up -d

## Stop all services
stop:
	$(COMPOSE) stop

## Stop and remove containers
down:
	$(COMPOSE) down

## Stop, remove containers AND volumes (destructive!)
down-volumes:
	@echo "WARNING: This will DELETE the database! Are you sure? [y/N]"
	@read -r ans && [ "$$ans" = "y" ] || (echo "Aborted." && exit 1)
	$(COMPOSE) down -v

## Restart all services
restart:
	$(COMPOSE) restart

## Restart only backend
restart-backend:
	$(COMPOSE) restart $(BACKEND_CONTAINER)

# ── Logs ─────────────────────────────────────────────────────

## Stream logs for all services
logs:
	$(COMPOSE) logs -f

## Stream backend logs only
logs-backend:
	$(COMPOSE) logs -f $(BACKEND_CONTAINER)

## Stream frontend logs only
logs-frontend:
	$(COMPOSE) logs -f $(FRONTEND_CONTAINER)

## Stream database logs only
logs-db:
	$(COMPOSE) logs -f $(DB_CONTAINER)

# ── Database Migrations ───────────────────────────────────────

## Run all pending Alembic migrations
db-migrate:
	$(COMPOSE) exec $(BACKEND_CONTAINER) alembic upgrade head

## Create a new migration (usage: make db-migrate-create MSG="add users table")
db-migrate-create:
	$(COMPOSE) exec $(BACKEND_CONTAINER) alembic revision --autogenerate -m "$(MSG)"

## Downgrade one migration step
db-downgrade:
	$(COMPOSE) exec $(BACKEND_CONTAINER) alembic downgrade -1

## Show current migration state
db-status:
	$(COMPOSE) exec $(BACKEND_CONTAINER) alembic current

## Show migration history
db-history:
	$(COMPOSE) exec $(BACKEND_CONTAINER) alembic history --verbose

# ── Backup & Restore ──────────────────────────────────────────

## Backup PostgreSQL database to ./data/backups/
backup:
	@mkdir -p $(BACKUP_DIR)
	$(COMPOSE) exec -T $(DB_CONTAINER) pg_dump -U $(POSTGRES_USER) $(POSTGRES_DB) | \
		gzip > $(BACKUP_DIR)/backup_$(TIMESTAMP).sql.gz
	@echo "Backup saved: $(BACKUP_DIR)/backup_$(TIMESTAMP).sql.gz"
	@ls -lh $(BACKUP_DIR)/*.gz | tail -5

## Restore from a backup file (usage: make restore FILE=./data/backups/backup_xxx.sql.gz)
restore:
	@test -n "$(FILE)" || (echo "Usage: make restore FILE=path/to/backup.sql.gz" && exit 1)
	@echo "Restoring from $(FILE)..."
	zcat $(FILE) | $(COMPOSE) exec -T $(DB_CONTAINER) psql -U $(POSTGRES_USER) $(POSTGRES_DB)
	@echo "Restore complete."

# ── Shells ────────────────────────────────────────────────────

## Open a bash shell in the backend container
shell-backend:
	$(COMPOSE) exec $(BACKEND_CONTAINER) /bin/bash

## Open a psql shell in the database container
shell-db:
	$(COMPOSE) exec $(DB_CONTAINER) psql -U $(POSTGRES_USER) $(POSTGRES_DB)

## Open a shell in the frontend container
shell-frontend:
	$(COMPOSE) exec $(FRONTEND_CONTAINER) /bin/sh

# ── Testing ───────────────────────────────────────────────────

## Run backend tests
test-backend:
	$(COMPOSE) exec $(BACKEND_CONTAINER) pytest tests/ -v --tb=short

## Run frontend tests
test-frontend:
	cd frontend && npm run test

# ── Linting & Formatting ──────────────────────────────────────

## Lint Python backend (ruff)
lint-backend:
	$(COMPOSE) exec $(BACKEND_CONTAINER) ruff check app/

## Format Python backend (ruff + black)
format-backend:
	$(COMPOSE) exec $(BACKEND_CONTAINER) ruff format app/

## Lint frontend (eslint)
lint-frontend:
	cd frontend && npm run lint

## Type-check frontend
typecheck-frontend:
	cd frontend && npm run typecheck

# ── Cleanup ───────────────────────────────────────────────────

## Remove unused Docker images and volumes
prune:
	docker system prune -f
	docker volume prune -f

## Remove frontend node_modules and dist
clean-frontend:
	rm -rf frontend/node_modules frontend/dist

## Remove Python build artifacts
clean-backend:
	find backend -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find backend -name "*.pyc" -delete 2>/dev/null || true
	find backend -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true

## Full clean (node_modules, dist, pycache)
clean: clean-frontend clean-backend

# ── Status ────────────────────────────────────────────────────

## Show running containers and ports
ps:
	$(COMPOSE) ps

## Show resource usage
stats:
	docker stats $(BACKEND_CONTAINER) $(DB_CONTAINER) $(FRONTEND_CONTAINER)

## Print help
help:
	@echo ""
	@echo "Budget-Pal Makefile Commands"
	@echo "=============================="
	@grep -E '^## ' Makefile | sed 's/## /  /'
	@echo ""
