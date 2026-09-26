"""add pension_data.partial_steps (Teilpensionierung); Lebensversicherung am Ablauf

Revision ID: 0008
Revises: 0007

Die Lebensversicherung aus dem Wizard wurde bisher ab dem Rentenalter ueber 20
Jahre ausbezahlt. Jetzt kommt sie am Ablauf der Police auf einmal: das Alter
steht bis hier nur in den Notizen ("Ablauf: 2034-12-13"). Die Ablaufleistung
ist ein fester Betrag, sie waechst nicht mehr mit 1 %.
"""
import re

from alembic import op
import sqlalchemy as sa

from app.core.json_type import PortableJSON


revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("pension_data", sa.Column("partial_steps", PortableJSON(), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT p.id, p.notes, u.date_of_birth FROM pension_data p "
        "JOIN users u ON u.id = p.user_id "
        "WHERE p.pillar = 'pillar_3b' AND p.provider = 'Lebensversicherung' "
        "AND p.withdrawal_age IS NULL"
    )).fetchall()
    for row_id, notes, dob in rows:
        match = re.search(r"Ablauf: (\d{4})-", notes or "")
        birth_year = int(str(dob)[:4]) if dob else None
        age = int(match.group(1)) - birth_year if match and birth_year else None
        bind.execute(
            sa.text("UPDATE pension_data SET withdrawal_age = :age, expected_return_rate = 0 WHERE id = :id"),
            {"age": age, "id": row_id},
        )


def downgrade() -> None:
    op.drop_column("pension_data", "partial_steps")
