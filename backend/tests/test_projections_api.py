"""
Budget-Pal Backend — Projektions-API

Fuer `app/api/projections.py` gab es bisher keine einzige Zeile Abdeckung.
Diese Tests sichern die Verdrahtung `Scenario.parameters_json` → Simulation ab
und halten zwei Fehler fest, die vorher unbemerkt blieben:

  * `DELETE /scenarios/{id}` rief `db.delete()` ohne `commit()` — get_db
    committet nicht, das Loeschen war wirkungslos.
  * `POST /run` cachte auf (user_id, scenario_id) und ignorierte den Body:
    zwei verschiedene Parametersaetze lieferten 24 Stunden lang dasselbe.
"""

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.projections import _params_from_scenario
from app.api.wizard import SAVINGS_INCREASE_PCT
from app.core.database import Base, get_db
from app.core.security import create_access_token
from app.models.models import Scenario, User

pytestmark = pytest.mark.anyio


BASE_BODY = {
    "current_net_worth": 100_000.0,
    "annual_savings": 12_000.0,
    "annual_income": 90_000.0,
    "years_to_project": 10,
}

WIZARD_PARAMS = {
    "wizard_onboarding": True,
    "inflation_rate": 0.015,
    "retirement_age": 65,
    "life_expectancy": 90,
    "monthly_income": 7_500.0,
    "monthly_expenses": 6_000.0,
    "ahv_avg_lohn": 81_200.0,
    "active_scenarios": [],
    "savings_increase_pct": 0.0,
}


# ── Reine Abbildung, ohne DB ──────────────────────────────────


class TestParamsFromScenario:
    def test_savings_from_monthly_surplus(self):
        out = _params_from_scenario(WIZARD_PARAMS)
        # (7500 - 6000) * 12
        assert out["annual_savings"] == pytest.approx(18_000.0)

    def test_income_uses_gross_not_net(self):
        """monthly_income ist netto (wizard.py rechnet x0.72) — fuer die
        Simulation zaehlt der Bruttolohn aus dem AHV-Auszug."""
        out = _params_from_scenario(WIZARD_PARAMS)
        assert out["annual_income"] == pytest.approx(81_200.0)
        assert out["annual_income"] != pytest.approx(7_500.0 * 12)

    def test_savings_increase_is_applied(self):
        out = _params_from_scenario({**WIZARD_PARAMS, "savings_increase_pct": 10.0})
        assert out["annual_savings"] == pytest.approx(19_800.0)

    def test_negative_surplus_clamps_to_zero(self):
        out = _params_from_scenario(
            {**WIZARD_PARAMS, "monthly_income": 4_000.0, "monthly_expenses": 6_000.0}
        )
        assert out["annual_savings"] == 0.0

    def test_missing_keys_are_omitted_not_defaulted(self):
        """Fehlende Schluessel duerfen den Request-Body nicht ueberschreiben."""
        assert _params_from_scenario({}) == {}
        assert "annual_savings" not in _params_from_scenario({"monthly_income": 100})


# ── Endpunkte mit echtem Session-Lebenszyklus ─────────────────


@pytest_asyncio.fixture
async def isolated(tmp_path, app):
    """Datei-DB und eine eigene Session pro Request — wie in Produktion.

    Mit der geteilten Session der uebrigen Suite waere ein fehlendes
    `commit()` unsichtbar, weil `flush()` in derselben Session schon zaehlt.
    """
    url = f"sqlite+aiosqlite:///{tmp_path}/proj.db"
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Factory() as session:
        user = User(email="proj@test.local", hashed_password="x", name="P")
        session.add(user)
        await session.flush()
        scenario = Scenario(
            user_id=user.id,
            name="Finanzplan (empirische Angaben)",
            parameters_json=dict(WIZARD_PARAMS),
        )
        session.add(scenario)
        await session.commit()
        ids = (user.id, scenario.id)

    async def per_request_session():
        async with Factory() as session:
            yield session

    app.dependency_overrides[get_db] = per_request_session
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers["Authorization"] = f"Bearer {create_access_token(str(ids[0]))}"
        yield client, Factory, ids
    app.dependency_overrides.clear()
    await engine.dispose()


class TestRunWithoutScenario:
    def test_body_only_still_works(self, isolated):
        """Regression: die drei Pflichtfelder wurden optional, damit ein
        Szenario sie liefern kann. Bestehende Clients duerfen das nicht merken."""
        client, _, _ = isolated
        r = client.post("/api/projections/run", json=BASE_BODY)
        assert r.status_code == 200, r.text
        assert len(r.json()["p50"]) == 11  # years_to_project + Jahr 0

    def test_missing_required_fields_are_rejected(self, isolated):
        client, _, _ = isolated
        r = client.post("/api/projections/run", json={"years_to_project": 5})
        assert r.status_code == 400
        detail = r.json()["detail"]
        for field in ("current_net_worth", "annual_savings", "annual_income"):
            assert field in detail


class TestRunWithScenario:
    def test_scenario_supplies_missing_parameters(self, isolated):
        """Ohne annual_savings im Body muss der Wert aus dem Szenario kommen."""
        client, _, (_, scenario_id) = isolated
        r = client.post(
            f"/api/projections/run?scenario_id={scenario_id}",
            json={"current_net_worth": 100_000.0, "years_to_project": 5},
        )
        assert r.status_code == 200, r.text

    def test_unknown_scenario_is_404(self, isolated):
        client, _, _ = isolated
        r = client.post("/api/projections/run?scenario_id=999999", json=BASE_BODY)
        assert r.status_code == 404

    def test_body_overrides_scenario(self, isolated):
        """Regler im UI muessen das Szenario uebersteuern koennen."""
        client, _, (_, scenario_id) = isolated
        low = client.post(
            f"/api/projections/run?scenario_id={scenario_id}",
            json={"current_net_worth": 0.0, "annual_savings": 0.0,
                  "annual_income": 90_000.0, "years_to_project": 20,
                  "return_volatility": 0.0},
        ).json()
        high = client.post(
            f"/api/projections/run?scenario_id={scenario_id}",
            json={"current_net_worth": 0.0, "annual_savings": 50_000.0,
                  "annual_income": 90_000.0, "years_to_project": 20,
                  "return_volatility": 0.0},
        ).json()
        assert high["p50"][-1] > low["p50"][-1]

    def test_two_runs_same_scenario_differ(self, isolated):
        """Faellt vor dem Entfernen des Caches durch: der Key war
        (user_id, scenario_id) und ignorierte den Body 24 Stunden lang."""
        client, _, (_, scenario_id) = isolated
        first = client.post(
            f"/api/projections/run?scenario_id={scenario_id}",
            json={**BASE_BODY, "current_net_worth": 10_000.0, "return_volatility": 0.0},
        ).json()
        second = client.post(
            f"/api/projections/run?scenario_id={scenario_id}",
            json={**BASE_BODY, "current_net_worth": 900_000.0, "return_volatility": 0.0},
        ).json()
        assert second["p50"][-1] > first["p50"][-1]


class TestSavingsPlanScenario:
    async def test_increase_raises_the_median(self, isolated):
        """Der Sparplan-Schalter muss die Kurve messbar anheben.

        Volatilitaet auf 0 gesetzt: der Monte Carlo saet nicht fest
        (projection.py ruft np.random.seed(None)), ohne Streuung ist der
        Vergleich trotzdem deterministisch.
        """
        client, Factory, (user_id, scenario_id) = isolated
        body = {"current_net_worth": 0.0, "annual_income": 90_000.0,
                "years_to_project": 20, "return_volatility": 0.0}

        without = client.post(
            f"/api/projections/run?scenario_id={scenario_id}", json=body
        ).json()

        async with Factory() as session:
            row = (
                await session.execute(select(Scenario).where(Scenario.id == scenario_id))
            ).scalar_one()
            row.parameters_json = {
                **WIZARD_PARAMS,
                "active_scenarios": ["increase_savings"],
                "savings_increase_pct": SAVINGS_INCREASE_PCT,
            }
            await session.commit()

        with_plan = client.post(
            f"/api/projections/run?scenario_id={scenario_id}", json=body
        ).json()

        assert with_plan["p50"][-1] > without["p50"][-1]


class TestScenarioDeletePersists:
    async def test_delete_actually_removes_the_row(self, isolated):
        """Faellt vor dem Fix durch: db.delete() ohne commit(), 204 zurueck,
        Zeile blieb stehen."""
        client, Factory, (_, scenario_id) = isolated

        response = client.delete(f"/api/projections/scenarios/{scenario_id}")
        assert response.status_code == 204

        async with Factory() as session:
            still_there = (
                await session.execute(select(Scenario).where(Scenario.id == scenario_id))
            ).scalar_one_or_none()
        assert still_there is None
