"""
Cross-dialect JSON: PostgreSQL keeps JSONB; SQLite uses generic JSON (TEXT).
"""
from sqlalchemy import JSON, TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB


class PortableJSON(TypeDecorator):
    """JSONB on PostgreSQL, JSON elsewhere (e.g. SQLite file deployments)."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())
