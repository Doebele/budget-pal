"""add users.password_changed_at and password reset token columns

Revision ID: 0005
Revises: 0004
"""
from alembic import op
import sqlalchemy as sa


revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("password_reset_hash", sa.String(64), nullable=True))
    op.add_column("users", sa.Column("password_reset_expires", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_users_password_reset_hash", "users", ["password_reset_hash"])


def downgrade() -> None:
    op.drop_index("ix_users_password_reset_hash", table_name="users")
    op.drop_column("users", "password_reset_expires")
    op.drop_column("users", "password_reset_hash")
    op.drop_column("users", "password_changed_at")
