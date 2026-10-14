"""add accounts.balance_date and statement_balances (Stand laut Kontoauszug)

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa

from app.core.json_type import PortableJSON


revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("balance_date", sa.Date(), nullable=True))
    op.add_column("accounts", sa.Column("statement_balances", PortableJSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("accounts", "statement_balances")
    op.drop_column("accounts", "balance_date")
