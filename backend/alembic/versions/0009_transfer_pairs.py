"""add transactions.transfer_pair_id and transfer_rejected (Kontoübertrag-Paare)

Revision ID: 0009
Revises: 0008
"""
from alembic import op
import sqlalchemy as sa


revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("transfer_pair_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_transactions_transfer_pair", "transactions", "transactions",
        ["transfer_pair_id"], ["id"], ondelete="SET NULL",
    )
    op.add_column(
        "transactions",
        sa.Column("transfer_rejected", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("transactions", "transfer_rejected")
    op.drop_constraint("fk_transactions_transfer_pair", "transactions", type_="foreignkey")
    op.drop_column("transactions", "transfer_pair_id")
