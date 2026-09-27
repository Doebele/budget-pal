from datetime import datetime

import pytest

from app.services.projection import ProjectionService
from app.services.swiss_medians import median_wealth


def test_group_midpoints_and_limits():
    """Linear zwischen den Mitten der Gruppen (55-64: 59.5), danach flach."""
    assert median_wealth(72) == pytest.approx(240_700)
    assert median_wealth(59) == pytest.approx(49_700 + (104_600 - 49_700) * 9.5 / 10)
    assert median_wealth(17) is None and median_wealth(75) is None
    assert median_wealth(72, married=True) == pytest.approx(240_700 * 1.5)


def test_series_in_the_projection():
    r = ProjectionService().run(
        current_net_worth=0, annual_savings=0, annual_income=0, years=20,
        date_of_birth=f"{datetime.now().year - 60}-06-01", runs=10,
    )
    assert r["peer_wealth"][0] == pytest.approx(median_wealth(60))
    assert r["peer_wealth"][15] is None   # 75
    assert r["peer_pensions"]["bvg_monthly"]["men"] == 2_042


def test_retiree_income_median():
    from app.services.swiss_medians import retiree_income_monthly
    assert retiree_income_monthly() == pytest.approx(44_899 / 12)
    assert retiree_income_monthly(married=True) == pytest.approx(44_899 / 12 * 1.5)
