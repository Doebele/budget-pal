"""
Application configuration — loaded from environment variables via Pydantic Settings.
"""
from typing import List
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Database ─────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://budgetpal:budgetpal@localhost:5432/budgetpal"
    postgres_db: str = "budgetpal"
    postgres_user: str = "budgetpal"
    postgres_password: str = "budgetpal"
    postgres_host: str = "budget-pal-db"
    postgres_port: int = 5432

    # ── Auth / JWT ────────────────────────────────────────────
    jwt_secret_key: str = "CHANGE_ME_in_production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30

    # ── CORS ─────────────────────────────────────────────────
    allowed_origins: str = "http://localhost:5173,http://localhost:8011,https://budgetpal.doebele12.de"

    @property
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    # ── OpenAI (optional) ─────────────────────────────────────
    openai_api_key: str = ""

    @property
    def openai_enabled(self) -> bool:
        return bool(self.openai_api_key)

    # ── Mistral (optional — OCR fallback) ─────────────────────
    mistral_api_key: str = ""

    @property
    def mistral_ocr_enabled(self) -> bool:
        return bool(self.mistral_api_key)

    # ── Uploads ───────────────────────────────────────────────
    uploads_dir: str = "/app/data/uploads"
    max_upload_size_mb: int = 50

    # ── Environment ───────────────────────────────────────────
    environment: str = "production"
    # If false, startup will not run SQLAlchemy create_all() and expects Alembic migrations.
    auto_create_schema: bool = False

    @property
    def is_development(self) -> bool:
        return self.environment.lower() in ("development", "dev", "local")

    # ── Swiss Financial Constants ─────────────────────────────
    swiss_inflation_rate: float = 0.015
    ahv_max_pension_chf: float = 2520.0
    ahv_min_pension_chf: float = 1260.0
    ahv_full_contribution_years: int = 44
    ahv_conversion_rate_bvg: float = 0.068
    bvg_coordination_deduction: float = 25725.0
    bvg_minimum_salary: float = 22050.0
    pillar_3a_max_contribution: float = 7056.0
    pillar_3a_max_self_employed: float = 35280.0

    # ── Projection Defaults ───────────────────────────────────
    default_equity_return: float = 0.07
    default_bond_return: float = 0.02
    default_return_volatility: float = 0.12
    monte_carlo_runs: int = 10000
    projection_cache_ttl: int = 86400  # 24 hours


settings = Settings()
