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
BVG_CONVERSION_RATE_DEFAULT: float = settings.bvg_conversion_rate_default
BVG_COORD_DEDUCTION: float = settings.bvg_coordination_deduction
PAYOUT_YEARS: int = 20  # 3a/3b annuitization horizon (~age 65→85)
PAYOUT_RESIDUAL_RATE: float = 0.02  # conservative yield during payout phase
#: Ordentliches AHV-Rentenalter (Referenzalter 65).
AHV_REGULAR_RETIREMENT_AGE: int = 65
#: Flexibler Rentenbezug: frueheste und spaeteste Wahl (AHV 21).
AHV_EARLIEST_AGE: int = 63
AHV_LATEST_AGE: int = 70
#: Lebenslange Kuerzung je vorbezogenem Jahr.
#: ponytail: fester Satz; AHV 21 sieht neue versicherungstechnische Saetze
#: vor — dann hier ersetzen.
AHV_EARLY_WITHDRAWAL_REDUCTION: float = 0.068
#: Lebenslanger Zuschlag bei Aufschub, nach Anzahl aufgeschobener Jahre.
AHV_DEFERRAL_SUPPLEMENT: Dict[int, float] = {1: 0.052, 2: 0.108, 3: 0.171, 4: 0.240, 5: 0.315}
#: 12 Monatsrenten plus die 13. AHV-Rente (Volksabstimmung 3.3.2024), die ab
#: 2026 jaehrlich im Dezember ausbezahlt wird.
AHV_PAYMENTS_PER_YEAR: int = 13


def ahv_start_age(retirement_age: int) -> int:
    """Alter, ab dem die AHV fliesst. Wer vor 63 aufhoert zu arbeiten, bekommt
    sie trotzdem erst mit 63; spaeter als 70 laesst sie sich nicht aufschieben."""
    return min(max(retirement_age, AHV_EARLIEST_AGE), AHV_LATEST_AGE)


def ahv_full_monthly(average_income: float) -> float:
    """Monatliche Vollrente (Rentenskala 44) aus dem massgebenden
    durchschnittlichen Jahreseinkommen — die zweistufige Rentenformel der AHV.

    Mit m = Minimalrente: bis 12·m Einkommen gilt m, bis 36·m gilt
    0.74·m + 13/600·E, darueber 1.04·m + 8/600·E, hoechstens 2·m (Maximalrente
    ab 72·m, also 90'720 CHF).
    """
    m = AHV_MIN_PENSION
    e = max(0.0, average_income)
    if e <= 12 * m:
        return m
    if e <= 36 * m:
        return 0.74 * m + 13 / 600 * e
    return min(1.04 * m + 8 / 600 * e, AHV_MAX_PENSION)


def _accumulate(balance: float, contribution: float, rate: float, years: int) -> float:
    """Guthaben nach `years` Jahren mit Zins und jaehrlichem Beitrag."""
    for _ in range(max(0, years)):
        balance = balance * (1 + rate) + contribution
    return balance


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


def _bvg_capital(
    record: Optional[Dict], annual_income: float, start_age: int, saving_years: int
) -> tuple:
    """BVG-Guthaben nach `saving_years` Beitragsjahren ab `start_age`, dazu
    der Umwandlungssatz (eigener laut Vorsorgeausweis oder Vorgabe)."""
    if record:
        balance = record.get("current_balance", 0.0)
        annual_contribution = record.get("annual_contribution", 0.0)
        return_rate = record.get("expected_return_rate", 0.01)
        conversion_rate = record.get("conversion_rate") or BVG_CONVERSION_RATE_DEFAULT
    else:
        balance, annual_contribution, return_rate = 0.0, 0.0, 0.01  # Mindestzins
        conversion_rate = BVG_CONVERSION_RATE_DEFAULT
    insured_salary = max(0, annual_income - BVG_COORD_DEDUCTION)
    for yr in range(saving_years):
        contrib = annual_contribution or insured_salary * _bvg_rate_for_age(start_age + yr)
        balance = balance * (1 + return_rate) + contrib
    return balance, conversion_rate


def _saving_then_payout(
    record: Dict, age_at_year: int, retirement_age: int, years_elapsed: int, default_rate: float
) -> float:
    """3a/3b: bis zum Rentenalter ansparen, danach PAYOUT_YEARS lang einen
    festen Betrag auszahlen, dann 0.

    Wer heute schon im Rentenalter ist, dem wird das verbleibende Guthaben ab
    jetzt ausbezahlt.
    """
    start_age = age_at_year - years_elapsed
    saving_years = min(years_elapsed, max(0, retirement_age - start_age))
    balance = _accumulate(
        record.get("current_balance", 0.0),
        record.get("annual_contribution", 0.0),
        record.get("expected_return_rate", default_rate),
        saving_years,
    )
    if age_at_year < retirement_age:
        return balance
    payout_year = age_at_year - max(retirement_age, start_age)
    if payout_year >= PAYOUT_YEARS:
        return 0.0
    return _annuity_payout(balance)


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

    def estimate_at_retirement(
        self,
        pension_records: List[Dict],
        current_age: int,
        retirement_age: int,
        annual_income: float,
        inflation_rate: float,
    ) -> Dict[str, Any]:
        """Renten und Kapital bei der Pensionierung, in heutigen CHF.

        Dieselben Funktionen wie die Prognose — Wizard und Finanzplan zeigen
        damit dieselben Zahlen wie das Rentendiagramm. Monatsbetraege sind
        Jahresbetraege / 12; bei der AHV steckt die 13. Rente anteilig darin.
        """
        years_to_retirement = max(0, retirement_age - current_age)
        deflator = (1 + inflation_rate) ** years_to_retirement
        ahv_record = next((r for r in pension_records if r["pillar"] == "1"), None)
        bvg_record = next((r for r in pension_records if r["pillar"] == "2"), None)
        p3a_records = [r for r in pension_records if r["pillar"] == "3a"]
        p3b_records = [r for r in pension_records if r["pillar"] == "3b"]

        start = ahv_start_age(retirement_age)
        ahv_annual = self._project_ahv(
            age_at_year=max(start, current_age), retirement_age=retirement_age,
            record=ahv_record, annual_income=annual_income, current_age=current_age,
        )
        bvg_capital, conversion_rate = _bvg_capital(
            bvg_record, annual_income, current_age, years_to_retirement
        )
        p3a_capital = sum(
            _accumulate(
                r.get("current_balance", 0.0), r.get("annual_contribution", 0.0),
                r.get("expected_return_rate", 0.03), years_to_retirement,
            )
            for r in p3a_records
        )
        p3b_capital = sum(
            _accumulate(
                r.get("current_balance", 0.0), r.get("annual_contribution", 0.0),
                r.get("expected_return_rate", 0.0), years_to_retirement,
            )
            for r in p3b_records
        )
        ahv_monthly = ahv_annual / 12
        bvg_monthly = bvg_capital * conversion_rate / 12 / deflator
        p3a_monthly = _annuity_payout(p3a_capital) / 12 / deflator
        p3b_monthly = _annuity_payout(p3b_capital) / 12 / deflator
        return {
            "retirement_age": retirement_age,
            "years_to_retirement": years_to_retirement,
            "ahv_start_age": start,
            "ahv_monthly": ahv_monthly,
            "bvg_capital": bvg_capital / deflator,
            "bvg_conversion_rate": conversion_rate,
            "bvg_monthly": bvg_monthly,
            "pillar_3a_capital": p3a_capital / deflator,
            "pillar_3a_monthly": p3a_monthly,
            "pillar_3b_capital": p3b_capital / deflator,
            "pillar_3b_monthly": p3b_monthly,
            "total_monthly": ahv_monthly + bvg_monthly + p3a_monthly + p3b_monthly,
        }

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

        Nach dem Rentenalter wird nichts mehr einbezahlt: BVG-Rente und
        3a/3b-Auszahlung stehen ab da nominal fest (und verlieren real an
        Wert), die 3a/3b-Auszahlung endet nach PAYOUT_YEARS.
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
            # Nicht deflationieren: die AHV wird alle zwei Jahre an Loehne und
            # Preise angepasst (Mischindex) und bleibt real etwa gleich. Die
            # Formel rechnet ohnehin mit heutigen Werten.
            pension_ahv_series.append(ahv_annual)

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
        Jaehrliche AHV-Rente in heutigen CHF (inkl. 13. AHV-Rente), 0 vor dem
        Rentenbeginn.

        Der Wizard speichert die Beitragsjahre von heute. Bis zum Rentenbeginn
        kommen die Jahre dazwischen dazu (wer frueher aufhoert, zahlt als
        Nichterwerbstaetiger weiter), hoechstens bis zum Referenzalter und 44.
        Danach steht die Rente fest.
        """
        start_age = ahv_start_age(retirement_age)
        if age_at_year < start_age:
            return 0.0

        # Beitragsjahre werden beim Rentenbeginn festgeschrieben
        contributing_until = min(start_age, AHV_REGULAR_RETIREMENT_AGE)
        added_years = max(0, contributing_until - current_age)

        if record:
            stored_years = record.get("contribution_years")
            if stored_years is None:
                # No explicit value → estimate from age (assume work since 18)
                contribution_years = max(0, contributing_until - 18)
            else:
                contribution_years = stored_years + added_years
            avg_salary = record.get("average_insured_salary") or annual_income
        else:
            contribution_years = max(0, contributing_until - 18)
            avg_salary = annual_income

        contribution_years = min(contribution_years, AHV_FULL_YEARS)

        # Kuerzung um 1/44 je fehlendem Beitragsjahr (Rentenskala).
        pension_monthly = ahv_full_monthly(avg_salary) * (contribution_years / AHV_FULL_YEARS)
        pension_monthly = min(pension_monthly, AHV_MAX_PENSION)

        # Vorbezug kuerzt lebenslang, Aufschub erhoeht lebenslang. Der Zuschlag
        # kommt auf die Rente obendrauf und darf die Maximalrente ueberschreiten.
        if start_age < AHV_REGULAR_RETIREMENT_AGE:
            early_years = AHV_REGULAR_RETIREMENT_AGE - start_age
            pension_monthly *= max(0.0, 1 - AHV_EARLY_WITHDRAWAL_REDUCTION * early_years)
        elif start_age > AHV_REGULAR_RETIREMENT_AGE:
            pension_monthly *= 1 + AHV_DEFERRAL_SUPPLEMENT[start_age - AHV_REGULAR_RETIREMENT_AGE]

        return pension_monthly * AHV_PAYMENTS_PER_YEAR

    def _project_bvg(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Optional[Dict],
        annual_income: float,
        years_elapsed: int,
    ) -> float:
        """
        Project BVG pension balance and eventual annual pension (nominal CHF).
        Before retirement: returns projected capital (not income).
        After retirement: annual pension = capital at retirement x conversion
        rate. Beitraege enden mit dem Rentenalter, die Rente steht danach fest.
        """
        start_age = age_at_year - years_elapsed
        # Nur bis zum Rentenalter wird einbezahlt — danach waechst nichts mehr
        saving_years = min(years_elapsed, max(0, retirement_age - start_age))
        balance, conversion_rate = _bvg_capital(record, annual_income, start_age, saving_years)

        if age_at_year < retirement_age:
            return balance  # return balance as proxy before retirement

        return balance * conversion_rate

    def _project_3a(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Dict,
        years_elapsed: int,
    ) -> float:
        """
        Project Pillar 3a balance with compound growth (nominal CHF).
        Before retirement: accumulated balance. After: fixed annual payout over
        PAYOUT_YEARS, then 0. Einzahlen geht nur bis zum Rentenalter.
        """
        return _saving_then_payout(record, age_at_year, retirement_age, years_elapsed, 0.03)

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
        guaranteed Ablaufleistung (fixed payout sum). Grows by the
        expected_return_rate until retirement, then paid out like 3a.
        For Risiko-LV: current_balance = 0 (no capital component), returns 0.
        """
        if record.get("current_balance", 0.0) <= 0 and record.get("annual_contribution", 0.0) <= 0:
            return 0.0
        return _saving_then_payout(record, age_at_year, retirement_age, years_elapsed, 0.0)

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
