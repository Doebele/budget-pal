"""
Financial projection service.

Features:
- Monte Carlo simulation (10,000 runs by default)
- Returns percentile bands (p10, p25, p50, p75, p90) per year
- Swiss AHV pension calculation
- BVG/Pensionskasse projection
- Pillar 3a compound growth
- Inflation adjustment (real CHF values)
- Scenario support
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

import numpy as np
from app.core.config import settings

logger = logging.getLogger(__name__)


# ── BVG Age Brackets ──────────────────────────────────────────
BVG_CONTRIBUTION_RATES = {
    # (min_age, max_age): total_rate (employee + employer combined)
    (25, 34): 0.07,
    (35, 44): 0.10,
    (45, 54): 0.15,
    (55, 65): 0.18,
}

# Swiss financial constants — loaded from settings (env / .env)
AHV_MAX_PENSION: float = settings.ahv_max_pension_chf
AHV_MIN_PENSION: float = settings.ahv_min_pension_chf
AHV_FULL_YEARS: int = settings.ahv_full_contribution_years
AHV_CONVERSION_RATE: float = settings.ahv_conversion_rate_bvg
BVG_COORD_DEDUCTION: float = settings.bvg_coordination_deduction
PAYOUT_YEARS: int = 20  # 3a/3b annuitization horizon (~age 65→85)
PAYOUT_RESIDUAL_RATE: float = 0.02  # conservative yield during payout phase
#: Ordentliches AHV-Rentenalter (Referenz 65).
AHV_REGULAR_RETIREMENT_AGE: int = 65
#: Lebenslange Kuerzung je vorbezogenem Jahr (Schweiz: 6.8 %).
AHV_EARLY_WITHDRAWAL_REDUCTION: float = 0.068


def _annuity_payout(
    balance: float, years: int = PAYOUT_YEARS, rate: float = PAYOUT_RESIDUAL_RATE
) -> float:
    """
    Convert a capital balance into an annual pension using a level annuity
    formula with residual return during payout:
        annual = balance × r / (1 − (1+r)^−years)
    At r=0 this reduces to balance/years (simple division). The residual
    return accounts for capital that keeps earning while being drawn down,
    which is how Swiss 3a/3b payouts behave in practice (Wertschriftenlösung
    or mixed life insurance).
    """
    if balance <= 0 or years <= 0:
        return 0.0
    if rate <= 0:
        return balance / years
    return balance * rate / (1 - (1 + rate) ** -years)


#: Selbstbehalt Pflegeheim CH — Groessenordnung fuer das Szenario "Pflegekosten
#: ab 80". Ergaenzungsleistungen sind darin nicht beruecksichtigt.
CARE_COST_ANNUAL_DEFAULT: float = 72_000.0
#: Laufzeit, ueber die das Szenario "Hypothek amortisieren" linear tilgt.
AMORTIZATION_YEARS_DEFAULT: int = 15
CARE_START_AGE: int = 80


def build_annual_flows(
    active_scenarios: Sequence[str],
    years: int,
    current_age: int,
    retirement_age: int,
    annual_savings: float = 0.0,
    annual_expenses: float = 0.0,
    lifestyle_factor: float = 0.8,
    pension_series: Optional[Sequence[float]] = None,
    care_cost_annual: float = CARE_COST_ANNUAL_DEFAULT,
    mortgage_debt: float = 0.0,
    mortgage_rate_pct: float = 0.0,
    amortization_years: int = AMORTIZATION_YEARS_DEFAULT,
    inflation_rate: float = 0.015,
    planned_retirement_age: Optional[int] = None,
) -> List[float]:
    """Baut die jaehrlichen Zusatz-Cashflows der aktiven Szenarien.

    Rueckgabe: Liste der Laenge `years`, NOMINALE CHF-Deltas je Jahr, die in
    `ProjectionService.run(annual_flows=...)` auf die Sparrate addiert werden.
    Mehrere Szenarien addieren sich — `active_scenarios` ist eine Liste.

    Zur Einheit: `annual_savings`, `annual_expenses`, `care_cost_annual` und
    `pension_series` kommen in heutigen CHF herein und werden hier pro Jahr auf
    nominal hochgerechnet — die Jahresschleife in `run()` rechnet nominal und
    deflationiert erst am Ende. Hypothekenbetraege bleiben nominal: ein
    Hypothekarvertrag lautet auf einen festen Betrag, er waechst nicht mit der
    Teuerung.

    Reine Funktion, absichtlich ohne DB- oder Modellzugriff, damit sie ohne
    Fixtures testbar bleibt.
    """
    flows = [0.0] * max(0, years)
    if years <= 0:
        return flows
    if planned_retirement_age is None:
        planned_retirement_age = retirement_age

    active = set(active_scenarios or [])
    # Index, ab dem das Rentenalter erreicht ist — wie retirement_idx in
    # _project_pensions, damit Vermoegens- und Rentenpfad zusammenpassen.
    retirement_idx = min(max(0, retirement_age - current_age), years)
    planned_idx = min(max(0, planned_retirement_age - current_age), years)

    if "early_retirement" in active:
        # Nur das Fenster zwischen frueherem und geplantem Rentenalter. Danach
        # sind beide Welten identisch, das Delta ist null. So braucht der
        # Vergleich kein Ausgabenmodell im Basisfall — den gibt es hier nicht.
        for yr in range(retirement_idx, planned_idx):
            nominal = (1 + inflation_rate) ** yr
            # Sparen endet. Der Abzug entspricht exakt dem, was die
            # Jahresschleife in run() addiert — sonst bliebe ein Rest stehen.
            flows[yr] -= annual_savings * nominal
            flows[yr] -= annual_expenses * lifestyle_factor * nominal
            if pension_series is not None and yr < len(pension_series):
                # Serie kommt real herein (siehe _project_pensions).
                flows[yr] += pension_series[yr] * nominal

    if "care_costs_at_80" in active:
        for yr in range(years):
            if current_age + yr >= CARE_START_AGE:
                flows[yr] -= care_cost_annual * (1 + inflation_rate) ** yr

    if "mortgage_amortization" in active and mortgage_debt > 0:
        span = max(1, min(amortization_years, years))
        principal_per_year = mortgage_debt / span
        rate = mortgage_rate_pct / 100
        for yr in range(years):
            if yr < span:
                # Tilgung kostet Liquiditaet ...
                flows[yr] -= principal_per_year
                # ... spart aber Zins auf dem bereits getilgten Teil.
                flows[yr] += principal_per_year * yr * rate
            else:
                # Nach der Tilgung faellt der gesamte Zins weg.
                flows[yr] += mortgage_debt * rate

    return flows


def _bvg_rate_for_age(age: int) -> float:
    """Return the BVG employee contribution rate for a given age."""
    for (min_age, max_age), rate in BVG_CONTRIBUTION_RATES.items():
        if min_age <= age <= max_age:
            return rate
    return 0.0  # under 25 or over 65


class ProjectionService:
    """Runs Monte Carlo + Swiss pension projections."""

    def run(
        self,
        current_net_worth: float,
        annual_savings: float,
        annual_income: float,
        years: int,
        mean_return: float = 0.07,
        volatility: float = 0.12,
        inflation_rate: float = 0.015,
        pension_records: Optional[List[Dict]] = None,
        date_of_birth: Optional[str] = None,
        retirement_age: int = 65,
        runs: int = 10_000,
        annual_flows: Optional[Sequence[float]] = None,
    ) -> Dict[str, Any]:
        """
        Run Monte Carlo simulation and pension projections.

        Returns dict with:
          years, p10, p25, p50, p75, p90,
          pension_ahv, pension_bvg, pension_3a,
          inflation_adjusted
        """
        # ── Pension Projections ───────────────────────────────
        # Vor der Monte-Carlo-Schleife, weil eine Entnahmephase die Rentenserie
        # als Einkommen braucht (siehe build_annual_flows).
        pension_ahv, pension_bvg, pension_3a, pension_3b, retirement_idx = (
            self._project_pensions(
                pension_records=pension_records or [],
                years=years,
                annual_income=annual_income,
                date_of_birth=date_of_birth,
                retirement_age=retirement_age,
                inflation_rate=inflation_rate,
            )
        )

        # ── Monte Carlo ────────────────────────────────────────
        np.random.seed(None)

        # Random annual returns: log-normal distribution
        # ln(1+r) ~ Normal(mu, sigma)
        log_mean = np.log(1 + mean_return) - 0.5 * volatility**2
        annual_log_returns = np.random.normal(
            loc=log_mean,
            scale=volatility,
            size=(runs, years),
        )
        annual_returns = np.exp(annual_log_returns) - 1  # shape (runs, years)

        # Simulate net worth year by year
        portfolio = np.full(runs, current_net_worth, dtype=np.float64)
        all_values = np.zeros((runs, years + 1), dtype=np.float64)
        all_values[:, 0] = portfolio

        # Savings may grow with inflation
        for yr in range(years):
            inflation_factor = (1 + inflation_rate) ** yr
            yr_savings = annual_savings * inflation_factor
            if annual_flows is not None:
                # Szenario-Cashflows sind bereits nominal fuer das jeweilige
                # Jahr gerechnet und werden nicht nochmals inflationiert.
                yr_savings += annual_flows[yr] if yr < len(annual_flows) else 0.0
            portfolio = portfolio * (1 + annual_returns[:, yr]) + yr_savings
            if annual_flows is not None:
                # Ohne Deckel "waechst" ein negatives Portfolio im Folgejahr mit
                # der Rendite weiter — bei Entnahmen ist das Unsinn. Nur im
                # Szenario-Pfad, damit der Default bit-identisch bleibt.
                portfolio = np.maximum(portfolio, 0.0)
            all_values[:, yr + 1] = portfolio

        # Inflation adjust all values to today's CHF (real terms)
        inflation_deflators = np.array(
            [(1 + inflation_rate) ** i for i in range(years + 1)]
        )
        real_values = all_values / inflation_deflators  # broadcasting

        # Compute percentile bands
        p10 = np.percentile(real_values, 10, axis=0).tolist()
        p25 = np.percentile(real_values, 25, axis=0).tolist()
        p50 = np.percentile(real_values, 50, axis=0).tolist()
        p75 = np.percentile(real_values, 75, axis=0).tolist()
        p90 = np.percentile(real_values, 90, axis=0).tolist()

        year_labels = list(range(datetime.now().year, datetime.now().year + years + 1))

        return {
            "years": year_labels,
            "p10": p10,
            "p25": p25,
            "p50": p50,
            "p75": p75,
            "p90": p90,
            "pension_ahv": pension_ahv,
            "pension_bvg": pension_bvg,
            "pension_3a": pension_3a,
            "pension_3b": pension_3b,
            "retirement_idx": retirement_idx,
            "inflation_adjusted": True,
        }

    def project_pension_series(
        self,
        pension_records: List[Dict],
        years: int,
        annual_income: float,
        date_of_birth: Optional[str],
        retirement_age: int,
        inflation_rate: float,
    ) -> List[float]:
        """Summe der jaehrlichen Rente aus allen Saeulen, in realen CHF.

        Wird vom API-Layer gebraucht, um die Entnahmephase eines Szenarios zu
        bauen, bevor `run()` laeuft. Rein rechnerisch, kein Monte Carlo.
        """
        ahv, bvg, p3a, p3b, retirement_idx = self._project_pensions(
            pension_records=pension_records,
            years=years,
            annual_income=annual_income,
            date_of_birth=date_of_birth,
            retirement_age=retirement_age,
            inflation_rate=inflation_rate,
        )
        return [
            (ahv[i] + bvg[i] + p3a[i] + p3b[i]) if i >= retirement_idx else 0.0
            for i in range(len(ahv))
        ]

    def _project_pensions(
        self,
        pension_records: List[Dict],
        years: int,
        annual_income: float,
        date_of_birth: Optional[str],
        retirement_age: int,
        inflation_rate: float,
    ) -> tuple:
        """
        Project AHV, BVG, Pillar 3a and Pillar 3b pension values per year.

        Returns four lists (length = years+1) of annual pension income / capital
        in real CHF. Before retirement: projected balance. After: annual income.
        """
        current_year = datetime.now().year

        # Determine current age — align with frontend (calendar-year difference).
        # Using days/365.25 can be off by ±1 year depending on birth month vs. today,
        # which causes retirement index mismatches between frontend and backend.
        current_age = 40  # fallback
        if date_of_birth:
            try:
                dob = datetime.fromisoformat(date_of_birth)
                current_age = datetime.now().year - dob.year
            except Exception:
                pass

        years_to_retirement = max(0, retirement_age - current_age)
        # Index in the series where age first reaches retirement_age.
        retirement_idx = min(years_to_retirement, years)

        # Extract pension records by pillar
        ahv_record = next((r for r in pension_records if r["pillar"] == "1"), None)
        bvg_record = next((r for r in pension_records if r["pillar"] == "2"), None)
        p3a_records = [r for r in pension_records if r["pillar"] == "3a"]
        p3b_records = [r for r in pension_records if r["pillar"] == "3b"]

        pension_ahv_series = []
        pension_bvg_series = []
        pension_3a_series = []
        pension_3b_series = []

        for yr in range(years + 1):
            age_at_year = current_age + yr
            inflation_deflator = (1 + inflation_rate) ** yr

            # ── AHV ────────────────────────────────────────
            ahv_annual = self._project_ahv(
                age_at_year=age_at_year,
                retirement_age=retirement_age,
                record=ahv_record,
                annual_income=annual_income,
                current_age=current_age,
            )
            pension_ahv_series.append(ahv_annual / inflation_deflator)

            # ── BVG ────────────────────────────────────────
            bvg_annual = self._project_bvg(
                age_at_year=age_at_year,
                retirement_age=retirement_age,
                record=bvg_record,
                annual_income=annual_income,
                years_elapsed=yr,
            )
            pension_bvg_series.append(bvg_annual / inflation_deflator)

            # ── Pillar 3a ──────────────────────────────────
            p3a_total = sum(
                self._project_3a(
                    age_at_year=age_at_year,
                    retirement_age=retirement_age,
                    record=r,
                    years_elapsed=yr,
                )
                for r in p3a_records
            )
            pension_3a_series.append(p3a_total / inflation_deflator)

            # ── Pillar 3b (Lebensversicherung / freie Vorsorge) ────
            p3b_total = sum(
                self._project_3b(
                    age_at_year=age_at_year,
                    retirement_age=retirement_age,
                    record=r,
                    years_elapsed=yr,
                )
                for r in p3b_records
            )
            pension_3b_series.append(p3b_total / inflation_deflator)

        return (
            pension_ahv_series,
            pension_bvg_series,
            pension_3a_series,
            pension_3b_series,
            retirement_idx,
        )

    def _project_ahv(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Optional[Dict],
        annual_income: float,
        current_age: int,
    ) -> float:
        """
        Calculate projected AHV monthly pension (× 12 for annual).
        Returns annual AHV pension income in nominal CHF.

        The wizard stores the user's **today's** contribution years. For the
        projection at retirement, we extrapolate by adding the years between
        "now" and the projected year so the AHV formula reflects the full
        contribution history at retirement (capped at AHV_FULL_YEARS = 44).
        """
        if age_at_year < retirement_age:
            return 0.0

        # Extrapolate: stored years (as of today) + additional years worked
        # between today and the projected retirement/year.
        years_elapsed_since_now = max(0, age_at_year - current_age)

        if record:
            stored_years = record.get("contribution_years")
            if stored_years is None:
                # No explicit value → estimate from age (assume work since 18)
                contribution_years = max(0, age_at_year - 18)
            else:
                contribution_years = stored_years + years_elapsed_since_now
            avg_salary = record.get("average_insured_salary") or annual_income
        else:
            contribution_years = max(0, age_at_year - 18)
            avg_salary = annual_income

        contribution_years = min(contribution_years, AHV_FULL_YEARS)

        # Die Rentenhoehe haengt am massgebenden durchschnittlichen
        # Jahreseinkommen: die Vollrente wird ab dem Sechsfachen der jaehrlichen
        # Minimalrente erreicht, darunter liegt sie zwischen Minimum und Maximum.
        # ponytail: die Rentenskala ist in Wirklichkeit zweistufig geknickt,
        # hier linear interpoliert — Merkblatt 3.01 fuer die exakte Segmentformel.
        full_pension_income = AHV_MIN_PENSION * 12 * 6
        income_factor = min(max(avg_salary / full_pension_income, 0.0), 1.0)
        full_pension_monthly = AHV_MIN_PENSION + income_factor * (
            AHV_MAX_PENSION - AHV_MIN_PENSION
        )

        # Kuerzung um 1/44 je fehlendem Beitragsjahr (Rentenskala). Vorher
        # interpolierte die Formel zwischen Minimal- und Maximalrente, womit ein
        # fehlendes Jahr fast nichts kostete und `avg_salary` gar nicht einging.
        pension_monthly = full_pension_monthly * (contribution_years / AHV_FULL_YEARS)

        # Vorbezugskuerzung: wer die AHV vor dem ordentlichen Rentenalter
        # bezieht, erhaelt sie lebenslang gekuerzt — 6.8 % je vorbezogenem
        # Jahr. Ohne diesen Abzug erscheint eine Fruehpensionierung gratis.
        early_years = max(0, AHV_REGULAR_RETIREMENT_AGE - retirement_age)
        if early_years:
            pension_monthly *= max(
                0.0, 1 - AHV_EARLY_WITHDRAWAL_REDUCTION * early_years
            )

        # Enforce configured maximum
        pension_monthly = min(pension_monthly, settings.ahv_max_pension_chf)

        return pension_monthly * 12

    def _project_bvg(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Optional[Dict],
        annual_income: float,
        years_elapsed: int,
    ) -> float:
        """
        Project BVG pension balance and eventual annual pension.
        Before retirement: returns projected capital (not income).
        After retirement: returns annual pension = capital × conversion_rate.
        """
        if record:
            current_balance = record.get("current_balance", 0.0)
            annual_contribution = record.get("annual_contribution", 0.0)
            return_rate = record.get("expected_return_rate", 0.01)
        else:
            # Estimate from salary — use configured coordination deduction
            insured_salary = max(0, annual_income - BVG_COORD_DEDUCTION)
            bvg_rate = _bvg_rate_for_age(age_at_year)
            current_balance = 0.0
            annual_contribution = insured_salary * bvg_rate
            return_rate = 0.01  # minimum guarantee

        # Project balance using compound growth + contributions
        balance = current_balance
        for yr in range(years_elapsed):
            age_in_sim = (age_at_year - years_elapsed) + yr
            insured_salary = max(0, annual_income - BVG_COORD_DEDUCTION)
            contrib = annual_contribution or insured_salary * _bvg_rate_for_age(
                age_in_sim
            )
            balance = balance * (1 + return_rate) + contrib

        if age_at_year < retirement_age:
            return balance  # return balance as proxy before retirement

        # At/after retirement: convert capital to annual pension using configured conversion rate
        return balance * AHV_CONVERSION_RATE

    def _project_3a(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Dict,
        years_elapsed: int,
    ) -> float:
        """
        Project Pillar 3a balance with compound growth.
        Before retirement: accumulated balance. After: annuitized (balance / 20 years).
        """
        current_balance = record.get("current_balance", 0.0)
        annual_contribution = record.get("annual_contribution", 0.0)
        return_rate = record.get("expected_return_rate", 0.03)
        # Use the UI-level retirement_age consistently, not the record's —
        # the user's slider is the single source of truth for the projection.

        balance = current_balance
        for _ in range(years_elapsed):
            balance = balance * (1 + return_rate) + annual_contribution

        if age_at_year < retirement_age:
            return balance  # return balance as proxy

        # Annuitize with residual return during payout phase
        return _annuity_payout(balance)

    def _project_3b(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Dict,
        years_elapsed: int,
    ) -> float:
        """
        Project Pillar 3b (Lebensversicherung / freie Vorsorge).

        For Kapital-/Gemischt-Lebensversicherungen: current_balance holds the
        guaranteed Ablaufleistung (fixed payout sum). We grow it by the
        expected_return_rate until retirement, then annuitize over 20 years.
        For Risiko-LV: current_balance = 0 (no capital component), returns 0.
        """
        current_balance = record.get("current_balance", 0.0)
        annual_contribution = record.get("annual_contribution", 0.0)
        return_rate = record.get("expected_return_rate", 0.0)

        if current_balance <= 0 and annual_contribution <= 0:
            return 0.0

        balance = current_balance
        for _ in range(years_elapsed):
            balance = balance * (1 + return_rate) + annual_contribution

        if age_at_year < retirement_age:
            return balance  # proxy: projected capital

        # Annuitize with residual return during payout phase
        return _annuity_payout(balance)

    def compare_scenarios(
        self,
        scenarios: List[Dict],
        **base_kwargs,
    ) -> Dict[str, Any]:
        """
        Run multiple scenarios and return median (p50) series for each.

        Args:
            scenarios: List of dicts, each with {"name": str, overrides: ...}
            base_kwargs: Default parameters shared across scenarios.
        """
        results = {}
        for scenario in scenarios:
            # get statt pop: pop mutierte die Liste des Aufrufers, beim zweiten
            # Durchlauf derselben Liste hiess danach alles "Unnamed".
            name = scenario.get("name", "Unnamed")
            overrides = {k: v for k, v in scenario.items() if k != "name"}
            params = {**base_kwargs, **overrides}
            result = self.run(**params)
            results[name] = {
                "years": result["years"],
                "p50": result["p50"],
                "p10": result["p10"],
                "p90": result["p90"],
            }
        return results
