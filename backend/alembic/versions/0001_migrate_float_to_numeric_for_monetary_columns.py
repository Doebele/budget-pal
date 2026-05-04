"""migrate float to numeric for monetary columns

Revision ID: 0001
Revises:
Create Date: 2025-01-01 00:00:00.000000

This migration converts all monetary columns from PostgreSQL FLOAT (double precision)
to NUMERIC(15, 2) to eliminate floating-point rounding errors in financial calculations.

Affected tables and columns:
  - accounts.balance
  - transactions.amount
  - transactions.original_amount
  - budgets.amount
  - recurring_plan.amount
  - assets.current_value
  - mortgage_tranches.principal_amount
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Convert monetary columns from FLOAT to NUMERIC(15, 2)."""

    # accounts.balance
    op.execute(
        "ALTER TABLE accounts ALTER COLUMN balance TYPE NUMERIC(15, 2) USING balance::NUMERIC(15, 2)"
    )

    # transactions.amount
    op.execute(
        "ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(15, 2) USING amount::NUMERIC(15, 2)"
    )

    # transactions.original_amount (nullable — handle NULL gracefully)
    op.execute(
        "ALTER TABLE transactions ALTER COLUMN original_amount TYPE NUMERIC(15, 2) USING original_amount::NUMERIC(15, 2)"
    )

    # budgets.amount
    op.execute(
        "ALTER TABLE budgets ALTER COLUMN amount TYPE NUMERIC(15, 2) USING amount::NUMERIC(15, 2)"
    )

    # recurring_plan.amount
    op.execute(
        "ALTER TABLE recurring_plan ALTER COLUMN amount TYPE NUMERIC(15, 2) USING amount::NUMERIC(15, 2)"
    )

    # assets.current_value
    op.execute(
        "ALTER TABLE assets ALTER COLUMN current_value TYPE NUMERIC(15, 2) USING current_value::NUMERIC(15, 2)"
    )

    # mortgage_tranches.principal_amount
    op.execute(
        "ALTER TABLE mortgage_tranches ALTER COLUMN principal_amount TYPE NUMERIC(15, 2) USING principal_amount::NUMERIC(15, 2)"
    )


def downgrade() -> None:
    """Revert monetary columns from NUMERIC(15, 2) back to FLOAT (double precision)."""

    # mortgage_tranches.principal_amount
    op.execute(
        "ALTER TABLE mortgage_tranches ALTER COLUMN principal_amount TYPE FLOAT USING principal_amount::FLOAT"
    )

    # assets.current_value
    op.execute(
        "ALTER TABLE assets ALTER COLUMN current_value TYPE FLOAT USING current_value::FLOAT"
    )

    # recurring_plan.amount
    op.execute(
        "ALTER TABLE recurring_plan ALTER COLUMN amount TYPE FLOAT USING amount::FLOAT"
    )

    # budgets.amount
    op.execute("ALTER TABLE budgets ALTER COLUMN amount TYPE FLOAT USING amount::FLOAT")

    # transactions.original_amount
    op.execute(
        "ALTER TABLE transactions ALTER COLUMN original_amount TYPE FLOAT USING original_amount::FLOAT"
    )

    # transactions.amount
    op.execute(
        "ALTER TABLE transactions ALTER COLUMN amount TYPE FLOAT USING amount::FLOAT"
    )

    # accounts.balance
    op.execute(
        "ALTER TABLE accounts ALTER COLUMN balance TYPE FLOAT USING balance::FLOAT"
    )
