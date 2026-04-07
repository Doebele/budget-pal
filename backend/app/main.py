"""
Budget-Pal FastAPI Application Entry Point
"""
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import AsyncSessionLocal, init_db
from app.api import auth, transactions, imports, projections, accounts, categories, budgets, pension, assets, wizard, currency, forecasting, budget_multimodal
from app.api import settings as settings_api
from app.services.currency_service import currency_service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle."""
    logger.info("Starting Budget-Pal backend...")
    try:
        await init_db()
        logger.info("Database initialized successfully.")
    except Exception as e:
        logger.error(f"Database init failed: {e}")
        raise

    # Ensure new tables added after initial migrations exist
    try:
        from app.core.database import engine
        from sqlalchemy import text
        async with engine.begin() as conn:
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS wizard_category_mappings (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    wizard_label VARCHAR(200) NOT NULL,
                    transaction_category VARCHAR(200) NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    UNIQUE (user_id, wizard_label)
                )
            """))
        logger.info("wizard_category_mappings table ensured.")
    except Exception as e:
        logger.warning("wizard_category_mappings table creation skipped: %s", e)

    try:
        from app.core.database import engine
        from sqlalchemy import text
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "ALTER TABLE user_wizard_config "
                    "ADD COLUMN IF NOT EXISTS peer_group_defaults_json TEXT"
                )
            )
        logger.info("user_wizard_config.peer_group_defaults_json column ensured.")
    except Exception as e:
        logger.warning("peer_group_defaults_json column migration skipped: %s", e)

    try:
        from app.core.database import engine
        from sqlalchemy import text
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "ALTER TABLE user_wizard_config "
                    "ADD COLUMN IF NOT EXISTS wizard_data_json TEXT"
                )
            )
        logger.info("user_wizard_config.wizard_data_json column ensured.")
    except Exception as e:
        logger.warning("wizard_data_json column migration skipped: %s", e)

    try:
        from app.services.peer_group_seed import seed_peer_group_system_categories

        async with AsyncSessionLocal() as session:
            n = await seed_peer_group_system_categories(session)
            await session.commit()
            if n:
                logger.info("Seeded %d peer-group system categories.", n)
    except Exception as e:
        logger.warning("Peer-group category seed skipped: %s", e)

    # Migrate English category names → German (idempotent)
    try:
        from app.services.categorization import EN_TO_DE_CATEGORY
        from app.core.database import engine
        from sqlalchemy import text
        async with engine.begin() as conn:
            for en, de in EN_TO_DE_CATEGORY.items():
                await conn.execute(
                    text(
                        "UPDATE transactions SET category = :de "
                        "WHERE LOWER(category) = :en AND category != :de"
                    ),
                    {"de": de, "en": en},
                )
        logger.info("Category language migration completed.")
    except Exception as e:
        logger.warning("Category language migration skipped: %s", e)

    # Load currency exchange rates
    try:
        rates = await currency_service.load_rates()
        logger.info(f"Loaded {len(rates)} currency exchange rates")
    except Exception as e:
        logger.error(f"Failed to load currency rates: {e}")
        # Non-fatal: fallback rates will be used

    yield

    logger.info("Shutting down Budget-Pal backend.")


app = FastAPI(
    title="Budget-Pal API",
    description="Personal financial planning API — Swiss context, AI categorization, Monte Carlo projections",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────

app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(transactions.router, prefix="/api/transactions", tags=["transactions"])
app.include_router(imports.router, prefix="/api/imports", tags=["imports"])
app.include_router(projections.router, prefix="/api/projections", tags=["projections"])
app.include_router(accounts.router, prefix="/api/accounts", tags=["accounts"])
app.include_router(categories.router, prefix="/api/categories", tags=["categories"])
app.include_router(budgets.router, prefix="/api/budgets", tags=["budgets"])
app.include_router(pension.router, prefix="/api/pension", tags=["pension"])
app.include_router(assets.router, prefix="/api/assets", tags=["assets"])
app.include_router(wizard.router, prefix="/api/wizard", tags=["wizard"])
app.include_router(currency.router, prefix="/api/currency", tags=["currency"])
app.include_router(forecasting.router, prefix="/api/forecasting", tags=["forecasting"])
app.include_router(budget_multimodal.router, prefix="/api/budget", tags=["budget"])
app.include_router(settings_api.router, prefix="/api/settings", tags=["settings"])


# ── Health Check ──────────────────────────────────────────────

@app.get("/api/health", tags=["system"])
async def health_check():
    """Liveness probe endpoint."""
    return JSONResponse(content={"status": "ok", "service": "budget-pal-backend", "version": "1.0.0"})


@app.get("/api/version", tags=["system"])
async def version():
    """Version information."""
    return {
        "version": "1.0.0",
        "environment": settings.environment,
    }
