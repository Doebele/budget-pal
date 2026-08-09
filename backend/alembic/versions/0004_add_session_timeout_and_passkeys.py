"""add users.session_timeout plus WebAuthn credential and challenge tables

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa


revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "session_timeout",
            sa.String(8),
            nullable=False,
            server_default="30m",
        ),
    )

    op.create_table(
        "webauthn_credentials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("credential_id", sa.String(512), nullable=False, unique=True),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("device_name", sa.String(120), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_webauthn_credentials_user_id", "webauthn_credentials", ["user_id"]
    )
    op.create_index(
        "ix_webauthn_credentials_credential_id",
        "webauthn_credentials",
        ["credential_id"],
    )

    # Challenges liegen in der DB, nicht im Speicher: das Backend laeuft mit
    # mehreren Workern, und die Verifikation trifft nicht zwingend den Prozess,
    # der die Challenge ausgestellt hat.
    op.create_table(
        "webauthn_challenges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("challenge", sa.String(255), nullable=False, unique=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("purpose", sa.String(16), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_webauthn_challenges_challenge", "webauthn_challenges", ["challenge"]
    )


def downgrade() -> None:
    op.drop_table("webauthn_challenges")
    op.drop_table("webauthn_credentials")
    op.drop_column("users", "session_timeout")
