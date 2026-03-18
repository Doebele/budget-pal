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
from app.core.database import init_db
from app.api import auth, transactions, imports, projections, accounts, categories, budgets, pension, assets

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
