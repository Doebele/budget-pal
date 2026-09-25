"""Vorsorge-API: Schaetzung, Umwandlungssatz, Szenario Fruehpensionierung
und Backup-Import mehrerer 3a-Konten."""
from datetime import datetime

import pytest
from sqlalchemy import select

from app.models.models import PensionData, PensionPillar


def test_estimate_from_inputs(client):
    res = client.post("/api/pension/estimate", json={
        "current_age": 50, "retirement_age": 65,
        "ahv_contribution_years": 30, "ahv_average_income": 100_000,
        "bvg_balance": 300_000, "bvg_annual_contribution": 20_000,
        "bvg_conversion_rate": 0.055,
        "pillar_3a": [{"balance": 50_000, "annual_contribution": 3_629}],
        "inflation_rate": 0.0,
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["ahv_monthly"] == pytest.approx(2_520 * 13 / 12)
    assert data["bvg_conversion_rate"] == 0.055
    assert data["bvg_monthly"] == pytest.approx(data["bvg_capital"] * 0.055 / 12)


def test_estimate_rejects_absurd_conversion_rate(client):
    res = client.post("/api/pension/estimate", json={"current_age": 50, "bvg_conversion_rate": 0.5})
    assert res.status_code == 422


def test_conversion_rate_round_trips(client):
    res = client.post("/api/pension", json={
        "pillar": "2", "current_balance": 100_000, "conversion_rate": 0.054,
    })
    assert res.status_code == 201, res.text
    assert client.get("/api/pension").json()[0]["conversion_rate"] == 0.054
    est = client.get("/api/pension/estimate").json()
    assert est["bvg_conversion_rate"] == 0.054


def test_early_retirement_scenario_shows_the_early_pensions(client):
    """Das Rentendiagramm zeigte im Szenario die Renten mit dem geplanten Alter."""
    scenario = client.post("/api/projections/scenarios", json={
        "name": "Frueh", "parameters": {
            "active_scenarios": ["early_retirement"], "retirement_age": 65,
            "early_retirement_years": 3, "monthly_income": 8_000, "monthly_expenses": 6_000,
            "ahv_avg_lohn": 100_000,
        },
    }).json()
    dob = f"{datetime.now().year - 50}-06-01"
    res = client.post(f"/api/projections/run?scenario_id={scenario['id']}", json={
        "current_net_worth": 200_000, "years_to_project": 30, "date_of_birth": dob,
    })
    assert res.status_code == 200, res.text
    assert res.json()["retirement_idx"] == 12  # 62, nicht 65


async def test_backup_import_keeps_every_3a_account(client, db_session, test_user):
    """Frueher gab es pro Saeule nur einen Abgleich: das zweite 3a-Konto ging
    verloren, und bei zwei vorhandenen brach der Import ab."""
    uid = test_user.id
    backup = {
        "format": "budgetpal-backup", "version": "1.1",
        "pension_data": [
            {"pillar": "3a", "provider": "VIAC", "current_balance": 40_000},
            {"pillar": "3a", "provider": "VIAC", "current_balance": 25_000},
            {"pillar": "2", "provider": "PK", "current_balance": 200_000, "conversion_rate": 0.056},
        ],
    }
    for _ in range(2):  # zweiter Import darf nichts doppelt anlegen
        res = client.post("/api/backup/import", json={"backup": backup})
        assert res.status_code == 200, res.text

    rows = (await db_session.execute(
        select(PensionData).where(PensionData.user_id == uid)
    )).scalars().all()
    assert sorted(r.current_balance for r in rows if r.pillar == PensionPillar.pillar_3a) == [25_000, 40_000]
    bvg = [r for r in rows if r.pillar == PensionPillar.pillar_2]
    assert len(bvg) == 1 and bvg[0].conversion_rate == 0.056
