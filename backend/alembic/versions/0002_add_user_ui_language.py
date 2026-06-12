"""add users.ui_language for UI language preference (de/en, extensible)

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa


revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("ui_language", sa.String(5), nullable=False, server_default="de"),
    )


def downgrade() -> None:
    op.drop_column("users", "ui_language")
