"""Buchungen gelöschter Konten ins Archiv

Revision ID: 0012
Revises: 0011

Ein gelöschtes Konto wurde nur deaktiviert; seine Buchungen zählten in allen
Auswertungen weiter (z. B. alte Konten neben ihren Nachfolgern nach einem
Backup-Import). Jetzt archiviert das Löschen sie mit; hier für bestehende
gelöschte Konten nachgeholt. Wiederherstellbar über das Archiv.
"""
from alembic import op


revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE transactions SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP
        WHERE COALESCE(is_deleted, FALSE) = FALSE
          AND account_id IN (SELECT id FROM accounts WHERE is_active = FALSE)
        """
    )


def downgrade() -> None:
    pass  # nicht umkehrbar ohne Markierung; wiederherstellen über das Archiv
