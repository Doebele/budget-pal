"""transactions.is_ignored; Wertpapier-, Fonds- und Kryptokäufe als «Investitionen»

Revision ID: 0013
Revises: 0012

- is_ignored: die Person kann eine Buchung ignorieren; sie bleibt in der Liste,
  zählt aber in keiner Summe.
- Käufe und Verkäufe von Wertpapieren, Fonds und Krypto standen teils unter
  «Lebensmittel», «Kommunikation» oder «Kontoübertrag». Sie bekommen die
  Kategorie «Investitionen» (gleiche Stichworte wie MERCHANT_RULES), ausser die
  Person hat die Kategorie selbst gesetzt. Waren sie als Übertrag verbunden,
  wird das Paar gelöst — eine Anlage ist kein Übertrag zwischen eigenen Konten.
"""
from alembic import op
import sqlalchemy as sa


revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

_INVEST = r"wertpapiere|geldmarktfonds|fondskonto|anlagekonto|robo ?portfolio|kraken"


def upgrade() -> None:
    op.add_column(
        "transactions",
        sa.Column("is_ignored", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    if op.get_bind().dialect.name != "postgresql":
        return
    match = f"description ~* '{_INVEST}' AND COALESCE(user_verified, FALSE) = FALSE"
    # Gegenbuchungen solcher Paare lösen
    op.execute(f"""
        UPDATE transactions SET is_transfer = FALSE, transfer_pair_id = NULL
        WHERE id IN (SELECT transfer_pair_id FROM transactions
                     WHERE {match} AND transfer_pair_id IS NOT NULL)
    """)
    op.execute(f"""
        UPDATE transactions SET category = 'Investitionen', is_transfer = FALSE,
               transfer_pair_id = NULL
        WHERE {match}
    """)


def downgrade() -> None:
    op.drop_column("transactions", "is_ignored")
