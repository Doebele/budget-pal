"""Stresstest: fester Markteinbruch im ersten Jahr der Pensionierung."""
from datetime import datetime

import pytest

from app.services.projection import ProjectionService

SERVICE = ProjectionService()


def _run(crash, **kw):
    base = dict(
        current_net_worth=500_000, annual_savings=20_000, annual_income=100_000, years=20,
        mean_return=0.05, volatility=0.0, inflation_rate=0.0,
        date_of_birth=f"{datetime.now().year - 60}-06-01", retirement_age=65, runs=10,
        retirement_spending=0.0, tax_in_retirement=False, seed=1, retirement_crash=crash,
    )
    base.update(kw)
    return SERVICE.run(**base)


def test_crash_hits_only_the_first_retirement_year():
    calm, crash = _run(0.0), _run(0.3)
    i = calm["retirement_idx"]
    assert crash["p50"][: i + 1] == calm["p50"][: i + 1]
    # Im Crashjahr -30 % statt +5 % auf dasselbe Vermoegen; der Jahresfluss
    # kommt in beiden Laeufen gleich dazu
    lost = calm["p50"][i] * (1.05 - 0.7)
    assert calm["p50"][i + 1] - crash["p50"][i + 1] == pytest.approx(lost)


def test_crash_after_horizon_is_ignored():
    assert _run(0.3, years=3)["p50"] == _run(0.0, years=3)["p50"]
