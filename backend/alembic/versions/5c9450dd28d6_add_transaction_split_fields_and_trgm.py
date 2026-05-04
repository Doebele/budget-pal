"""add_transaction_split_fields_and_trgm

Revision ID: 5c9450dd28d6
Revises: 8a1542a8b20d
Create Date: 2026-04-25 05:10:50.515208
"""
from alembic import op
import sqlalchemy as sa


revision = '5c9450dd28d6'
down_revision = '8a1542a8b20d'
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_index(op.f('ix_mortgage_tranches_id'), 'mortgage_tranches', ['id'], unique=False)
    op.add_column('transactions', sa.Column('parent_id', sa.Integer(), nullable=True))
    op.add_column('transactions', sa.Column('is_split', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    op.create_index(op.f('ix_transactions_parent_id'), 'transactions', ['parent_id'], unique=False)
    op.create_foreign_key(None, 'transactions', 'transactions', ['parent_id'], ['id'], ondelete='CASCADE')

def downgrade() -> None:
    op.drop_constraint(None, 'transactions', type_='foreignkey')
    op.drop_index(op.f('ix_transactions_parent_id'), table_name='transactions')
    op.drop_column('transactions', 'is_split')
    op.drop_column('transactions', 'parent_id')
    op.drop_index(op.f('ix_mortgage_tranches_id'), table_name='mortgage_tranches')
