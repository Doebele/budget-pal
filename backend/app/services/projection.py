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


# ── Auszahlphase ──────────────────────────────────────────────

#: Pensionskasse: fruehester Bezug (Vorbezug ab 58), spaetester (Aufschub bei
#: Weiterarbeit). Wer frueher aufhoert, parkt das Guthaben bis 58 verzinst auf
#: einem Freizuegigkeitskonto.
BVG_EARLIEST_AGE: int = 58
BVG_LATEST_AGE: int = 70
#: Aenderung des Umwandlungssatzes je Jahr vor bzw. nach 65 (0.0015 = 0.15
#: Prozentpunkte). ponytail: typischer Wert; die Tabelle der eigenen Kasse
#: steht im Reglement.
BVG_CONVERSION_STEP: float = 0.0015
#: Saeule 3a: Bezug fruehestens fuenf Jahre vor dem Referenzalter, spaetestens
#: fuenf danach (dann nur bei Erwerbstaetigkeit).
PILLAR_3A_EARLIEST_AGE: int = 60
PILLAR_3A_LATEST_AGE: int = 70
#: Pflegeheimkosten ersetzen diesen Anteil der normalen Lebenskosten (Wohnen,
#: Essen, Haushalt); Krankenkasse, Steuern und Persoenliches bleiben.
CARE_REPLACES_SHARE: float = 0.6
#: Ohne Angabe: Lebenskosten im Ruhestand = 80 % der heutigen Ausgaben, diese
#: geschaetzt als Nettolohn (72 % des Bruttolohns nach Sozialabgaben, BVG und
#: Steuern) minus Sparrate. Ueblich sind 70-80 % des bisherigen Konsums.
NET_INCOME_SHARE: float = 0.72
RETIREMENT_SPENDING_SHARE: float = 0.8


def bvg_start_age(retirement_age: int) -> int:
    return min(max(retirement_age, BVG_EARLIEST_AGE), BVG_LATEST_AGE)


def pillar_3a_start_age(retirement_age: int) -> int:
    return min(max(retirement_age, PILLAR_3A_EARLIEST_AGE), PILLAR_3A_LATEST_AGE)


def payout_start_ages(retirement_age: int) -> Dict[str, int]:
    """Ab welchem Alter jede Saeule auszahlt. 3b (freie Vorsorge) ist an kein
    Alter gebunden."""
    return {
        "1": ahv_start_age(retirement_age),
        "2": bvg_start_age(retirement_age),
        "3a": pillar_3a_start_age(retirement_age),
        "3b": retirement_age,
    }


def bvg_conversion_at(rate_at_65: float, start_age: int) -> float:
    """Umwandlungssatz beim tatsaechlichen Bezugsalter. Der Satz auf dem
    Vorsorgeausweis gilt fuer 65; frueher gibt es weniger, spaeter mehr."""
    return max(0.0, rate_at_65 + BVG_CONVERSION_STEP * (start_age - AHV_REGULAR_RETIREMENT_AGE))


def default_retirement_spending(annual_income: float, annual_savings: float) -> float:
    """Jaehrliche Lebenskosten im Ruhestand in heutigen CHF, wenn der Nutzer
    keine angibt."""
    return RETIREMENT_SPENDING_SHARE * max(0.0, annual_income * NET_INCOME_SHARE - annual_savings)


def ahv_nonemployed_contribution(basis):
    """AHV-Beitrag fuer Nichterwerbstaetige pro Jahr (2025/2026), aus Vermoegen
    plus 20-fachem Renteneinkommen. Pflicht bis zum Referenzalter, auch fuer
    Fruehpensionierte. Nimmt Skalar oder NumPy-Array.

    ponytail: Naeherung an die Beitragstabelle — 530 unter 350'000, je weitere
    50'000 +106 bis 1.75 Mio., darueber +159, hoechstens 26'500; ohne
    Verwaltungskostenbeitrag und ohne Befreiung durch einen erwerbstaetigen
    Ehepartner.
    """
    basis = np.asarray(basis, dtype=np.float64)
    low = np.clip(np.floor((np.minimum(basis, 1_750_000) - 300_000) / 50_000), 0, None)
    high = np.clip(np.floor((basis - 1_750_000) / 50_000), 0, None)
    return np.minimum(530 + 106 * low + 159 * high, 26_500)


def _current_age(date_of_birth: Optional[str]) -> int:
    """Alter als Kalenderjahr-Differenz, wie das Frontend (Tage/365.25 lag je
    nach Geburtsmonat um ein Jahr daneben). Ohne Datum: 40."""
    if date_of_birth:
        try:
            return datetime.now().year - datetime.fromisoformat(date_of_birth).year
        except ValueError:
            pass
    return 40


def pension_income(
    series: Dict[str, Sequence[float]], current_age: int, retirement_age: int
) -> List[float]:
    """Summe der Saeulen, die im jeweiligen Jahr tatsaechlich auszahlen.

    Vor ihrem Bezugsbeginn enthalten die BVG-/3a-/3b-Reihen das Kapital (fuers
    Diagramm) — das ist kein Einkommen und darf nicht mitgezaehlt werden.
    """
    starts = payout_start_ages(retirement_age)
    length = len(series["1"])
    return [
        sum(values[i] for pillar, values in series.items() if current_age + i >= starts[pillar])
        for i in range(length)
    ]


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
    retirement_spending: float = 0.0,
    care_cost_annual: float = CARE_COST_ANNUAL_DEFAULT,
    mortgage_debt: float = 0.0,
    mortgage_rate_pct: float = 0.0,
    amortization_years: int = AMORTIZATION_YEARS_DEFAULT,
    inflation_rate: float = 0.015,
) -> List[float]:
    """Zusatz-Cashflows der Szenarien Pflegekosten und Amortisation.

    Rueckgabe: Liste der Laenge `years`, NOMINALE CHF-Deltas je Jahr, die
    `ProjectionService.run(annual_flows=...)` zum Jahresfluss addiert.
    Mehrere Szenarien addieren sich — `active_scenarios` ist eine Liste.

    Die Fruehpensionierung steht hier nicht mehr: sie ist dieselbe Rechnung mit
    frueherem Rentenalter (Sparen endet, Renten beginnen spaeter und kleiner,
    Entnahmen ab dann). Frueher modellierte sie nur das Fenster bis zum
    geplanten Alter und liess die lebenslang tieferen Renten weg.

    `care_cost_annual` und `retirement_spending` kommen in heutigen CHF und
    werden je Jahr auf nominal hochgerechnet. Hypothekenbetraege bleiben
    nominal: ein Hypothekarvertrag lautet auf einen festen Betrag.

    Reine Funktion, absichtlich ohne DB- oder Modellzugriff.
    """
    flows = [0.0] * max(0, years)
    if years <= 0:
        return flows

    active = set(active_scenarios or [])

    if "care_costs_at_80" in active:
        # Das Pflegeheim ersetzt Wohnen, Essen und Haushalt — nur der Rest ist
        # Mehrkosten.
        extra = max(0.0, care_cost_annual - CARE_REPLACES_SHARE * retirement_spending)
        for yr in range(years):
            if current_age + yr >= CARE_START_AGE:
                flows[yr] -= extra * (1 + inflation_rate) ** yr

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
    record: Optional[Dict], annual_income: float, start_age: int, saving_years: int,
    interest_years: int = 0,
) -> tuple:
    """BVG-Guthaben nach `saving_years` Beitragsjahren ab `start_age` und
    danach `interest_years` Jahren nur mit Zins (Freizuegigkeitskonto zwischen
    Erwerbsende und Bezug), dazu der Umwandlungssatz fuer 65 (eigener laut
    Vorsorgeausweis oder Vorgabe)."""
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
    balance *= (1 + return_rate) ** max(0, interest_years)
    return balance, conversion_rate


def _saving_then_payout(
    record: Dict, age_at_year: int, retirement_age: int, years_elapsed: int,
    default_rate: float, payout_start: int,
) -> float:
    """3a/3b: bis zum Rentenalter ansparen, bis `payout_start` nur verzinsen,
    danach PAYOUT_YEARS lang einen festen Betrag auszahlen, dann 0.

    Wer heute schon ueber dem Bezugsbeginn ist, dem wird das verbleibende
    Guthaben ab jetzt ausbezahlt.
    """
    start_age = age_at_year - years_elapsed
    saving_years = min(years_elapsed, max(0, retirement_age - start_age))
    interest_years = min(years_elapsed, max(0, payout_start - start_age)) - saving_years
    rate = record.get("expected_return_rate", default_rate)
    balance = _accumulate(
        record.get("current_balance", 0.0), record.get("annual_contribution", 0.0), rate, saving_years,
    )
    balance *= (1 + rate) ** max(0, interest_years)
    if age_at_year < payout_start:
        return balance
    payout_year = age_at_year - max(payout_start, start_age)
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
        retirement_spending: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Run Monte Carlo simulation and pension projections.

        Jahresfluss aufs freie Vermoegen (`current_net_worth`, ohne die Saeulen):
          - bis zum Rentenalter: Sparrate (waechst mit der Teuerung)
          - ab dem Rentenalter: tatsaechlich fliessende Renten minus
            Lebenskosten (`retirement_spending`, heutige CHF; ohne Angabe
            `default_retirement_spending`), bis 65 zusaetzlich die AHV-Beitraege
            als Nichterwerbstaetige
          - dazu die Szenario-Cashflows (`annual_flows`, nominal)
        Das Vermoegen faellt nie unter 0.

        Returns dict with years, p10..p90, pension_* series, pension_income,
        retirement_idx, payout_start_idx, retirement_spending, depletion_age,
        success_rate, inflation_adjusted.
        """
        # ── Pension Projections ───────────────────────────────
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
        current_age = _current_age(date_of_birth)
        income_real = pension_income(
            {"1": pension_ahv, "2": pension_bvg, "3a": pension_3a, "3b": pension_3b},
            current_age,
            retirement_age,
        )
        if retirement_spending is None:
            retirement_spending = default_retirement_spending(annual_income, annual_savings)

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

        portfolio = np.full(runs, current_net_worth, dtype=np.float64)
        all_values = np.zeros((runs, years + 1), dtype=np.float64)
        all_values[:, 0] = portfolio

        for yr in range(years):
            inflation_factor = (1 + inflation_rate) ** yr
            age = current_age + yr
            if age < retirement_age:
                flow = annual_savings * inflation_factor
            else:
                # Renten und Lebenskosten kommen real herein, gerechnet wird nominal
                flow = (income_real[yr] - retirement_spending) * inflation_factor
                if age < AHV_REGULAR_RETIREMENT_AGE:
                    # Fruehpensionierte zahlen bis 65 AHV-Beitraege — je Lauf
                    # verschieden, weil sie am Vermoegen haengen
                    basis = portfolio / inflation_factor + 20 * income_real[yr]
                    flow = flow - ahv_nonemployed_contribution(basis) * inflation_factor
            if annual_flows is not None and yr < len(annual_flows):
                # Szenario-Cashflows sind bereits nominal
                flow = flow + annual_flows[yr]
            # Ohne Deckel "waechst" ein negatives Vermoegen mit der Rendite
            # weiter — bei Entnahmen ist das Unsinn.
            portfolio = np.maximum(portfolio * (1 + annual_returns[:, yr]) + flow, 0.0)
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

        # Bis wann reicht das Vermoegen? Median-Pfad nach der Pensionierung.
        depletion_age = next(
            (current_age + i for i in range(retirement_idx, years + 1) if p50[i] <= 0),
            None,
        )
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
            "pension_income": income_real,
            "retirement_idx": retirement_idx,
            "payout_start_idx": {
                pillar: max(0, start - current_age)
                for pillar, start in payout_start_ages(retirement_age).items()
            },
            "retirement_spending": retirement_spending,
            "depletion_age": depletion_age,
            # Anteil der Laeufe, in denen bis zum Ende des Horizonts Vermoegen bleibt
            "success_rate": float(np.mean(all_values[:, -1] > 0)),
            "inflation_adjusted": True,
        }

    def estimate_at_retirement(
        self,
        pension_records: List[Dict],
        current_age: int,
        retirement_age: int,
        annual_income: float,
        inflation_rate: float,
    ) -> Dict[str, Any]:
        """Renten und Kapital bei Bezugsbeginn, in heutigen CHF.

        Liest dieselben Reihen wie das Rentendiagramm (`_project_pensions`) —
        Wizard und Finanzplan zeigen damit dieselben Zahlen. Jede Saeule wird
        bei ihrem eigenen Bezugsbeginn gelesen (AHV ab 63, BVG ab 58, 3a ab 60).
        Monatsbetraege sind Jahresbetraege / 12; bei der AHV steckt die 13.
        Rente anteilig darin.
        """
        starts = payout_start_ages(retirement_age)
        horizon = max(max(starts.values()) - current_age, 0) + 1
        dob = f"{datetime.now().year - current_age}-01-01"
        ahv, bvg, p3a, p3b, _ = self._project_pensions(
            pension_records, horizon, annual_income, dob, retirement_age, inflation_rate
        )

        def at(series, pillar):
            return series[max(0, starts[pillar] - current_age)]

        # Kapital bei Bezugsbeginn aus der Auszahlung zurueckgerechnet — die
        # ist eine feste Funktion davon (Rente bzw. Annuitaet).
        per_chf = _annuity_payout(1.0)

        bvg_record = next((r for r in pension_records if r["pillar"] == "2"), None)
        rate_at_65 = (bvg_record or {}).get("conversion_rate") or BVG_CONVERSION_RATE_DEFAULT
        conversion_rate = bvg_conversion_at(rate_at_65, starts["2"])
        ahv_monthly = at(ahv, "1") / 12
        bvg_monthly = at(bvg, "2") / 12
        p3a_monthly = at(p3a, "3a") / 12
        p3b_monthly = at(p3b, "3b") / 12
        return {
            "retirement_age": retirement_age,
            "years_to_retirement": max(0, retirement_age - current_age),
            "ahv_start_age": starts["1"],
            "bvg_start_age": starts["2"],
            "pillar_3a_start_age": starts["3a"],
            "ahv_monthly": ahv_monthly,
            "bvg_capital": bvg_monthly * 12 / conversion_rate if conversion_rate else 0.0,
            "bvg_conversion_rate": conversion_rate,
            "bvg_monthly": bvg_monthly,
            "pillar_3a_capital": p3a_monthly * 12 / per_chf,
            "pillar_3a_monthly": p3a_monthly,
            "pillar_3b_capital": p3b_monthly * 12 / per_chf,
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

        current_age = _current_age(date_of_birth)

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
        payout_start = bvg_start_age(retirement_age)
        # Beitraege nur bis zum Rentenalter, danach bis zum Bezug nur Zins
        saving_years = min(years_elapsed, max(0, retirement_age - start_age))
        interest_years = min(years_elapsed, max(0, payout_start - start_age)) - saving_years
        balance, conversion_rate = _bvg_capital(
            record, annual_income, start_age, saving_years, interest_years
        )

        if age_at_year < payout_start:
            return balance  # Kapital, solange noch nichts ausbezahlt wird

        return balance * bvg_conversion_at(conversion_rate, payout_start)

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
        return _saving_then_payout(
            record, age_at_year, retirement_age, years_elapsed, 0.03,
            pillar_3a_start_age(retirement_age),
        )

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
        return _saving_then_payout(
            record, age_at_year, retirement_age, years_elapsed, 0.0, retirement_age
        )

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
