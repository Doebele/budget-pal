"""Buchungen aus PDF-Importen in der Kontowährung statt CHF

Revision ID: 0011
Revises: 0010

Der PDF-Import gab der KI-Extraktion und den Vorschauzeilen fest «CHF» vor.
Auszüge von N26 und Comdirect (EUR-Konten) landeten so mit currency = CHF,
obwohl der Betrag in Euro gebucht ist — Anzeige und Umrechnung waren falsch, und
der Übertrag-Abgleich hielt gleiche Beträge für einen Währungswechsel.

Korrigiert wird nur genau dieser Fall: CHF auf einem Konto in anderer Währung,
ohne Originalwährung. Ein Auszug bucht immer in der Kontowährung.
"""
from alembic import op


revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE transactions SET currency = (
            SELECT accounts.currency FROM accounts WHERE accounts.id = transactions.account_id
        )
        WHERE currency = 'CHF' AND original_currency IS NULL
          AND account_id IN (SELECT id FROM accounts WHERE currency <> 'CHF')
        """
    )


def downgrade() -> None:
    pass  # die falsche Währung wird nicht wiederhergestellt
