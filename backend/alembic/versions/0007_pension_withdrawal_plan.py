"""add pension_data.capital_share (BVG Kapitalbezug) and withdrawal_age (3a)

Revision ID: 0007
Revises: 0006
"""
from alembic import op
import sqlalchemy as sa


revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pension_data", sa.Column("capital_share", sa.Float(), nullable=True))
    op.add_column("pension_data", sa.Column("withdrawal_age", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("pension_data", "withdrawal_age")
    op.drop_column("pension_data", "capital_share")
