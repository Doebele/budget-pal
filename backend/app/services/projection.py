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
from app.services.capital_tax import DEFAULT_CANTON, capital_tax
from app.services.retirement_tax import retirement_tax
from app.services.swiss_medians import NEW_PENSIONS_2024, median_wealth, retiree_income_monthly

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
#: Teilpensionierung (Art. 13a BVG, seit 2024): hoechstens drei Bezuege in
#: Kapitalform, auch ueber mehrere Kassen, der erste mindestens 20 % der
#: Altersleistung. Mit dem Endbezug beim Erwerbsende bleiben zwei Teilschritte.
BVG_MAX_PARTIAL_STEPS: int = 2
BVG_MIN_FIRST_STEP: float = 0.2
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


def payout_start_ages(retirement_age: int) -> Dict[str, int]:
    """Ab welchem Alter AHV und Pensionskasse (Endbezug) eine Rente zahlen.
    3a und 3b werden als Kapital bezogen (capital_withdrawals), eine
    Teilpensionierung zahlt ihre Teilrente schon vorher (bvg_steps)."""
    return {"1": ahv_start_age(retirement_age), "2": bvg_start_age(retirement_age)}


def pillar_3a_latest_age(retirement_age: int) -> int:
    """Spaetester 3a-Bezug: das Referenzalter, bei Weiterarbeit bis 70."""
    if retirement_age <= AHV_REGULAR_RETIREMENT_AGE:
        return AHV_REGULAR_RETIREMENT_AGE
    return min(retirement_age, PILLAR_3A_LATEST_AGE)


def plan_3a_ages(
    count: int, retirement_age: int, current_age: int, avoid: Sequence[int] = ()
) -> List[int]:
    """Vorschlag fuer den gestaffelten 3a-Bezug: ein Konto pro Jahr, so spaet wie
    moeglich (das Guthaben waechst bis dahin steuerfrei), nie im Jahr eines
    anderen Kapitalbezugs. Mehr Konten als Jahre teilen sich Jahre."""
    earliest = max(PILLAR_3A_EARLIEST_AGE, current_age)
    latest = max(pillar_3a_latest_age(retirement_age), earliest)
    free = [a for a in range(latest, earliest - 1, -1) if a not in set(avoid)] or [latest]
    return sorted(free[i % len(free)] for i in range(count))


def resolve_3a_ages(
    p3a_records: Sequence[Dict], retirement_age: int, current_age: int,
    other_capital_ages: Sequence[int] = (),
) -> List[int]:
    """Bezugsalter je 3a-Konto: das eigene, sonst aus dem Staffelplan."""
    fixed = [r.get("withdrawal_age") for r in p3a_records]
    taken = {a for a in fixed if a} | set(other_capital_ages)
    auto = iter(plan_3a_ages(sum(1 for a in fixed if not a), retirement_age, current_age, sorted(taken)))
    return [max(a, current_age) if a else next(auto) for a in fixed]


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


def _share(value: Optional[float]) -> float:
    return min(max(value or 0.0, 0.0), 1.0)


def partial_retirement_plan(
    record: Optional[Dict], current_age: int, retirement_age: int
) -> tuple:
    """Teilpensionierungen der Pensionskasse, bereinigt.

    Returns (Pensum heute, kommende Schritte als (Alter, Pensum danach,
    Kapitalanteil)). Ein Schritt gilt ab 58 und vor dem Erwerbsende, mit
    sinkendem Pensum, hoechstens BVG_MAX_PARTIAL_STEPS. Vergangene Schritte
    bestimmen nur das heutige Pensum, ihr Guthaben ist schon bezogen. Liegt ein
    Schritt nach dem Erwerbsende (Fruehpensionierung), nimmt ihn der Endbezug mit.
    """
    pensum = last = 1.0
    upcoming = []
    steps = sorted((record or {}).get("partial_steps") or [], key=lambda s: s.get("age") or 0)
    for step in steps[:BVG_MAX_PARTIAL_STEPS]:
        age, after = int(step.get("age") or 0), float(step.get("pensum") or 0)
        if not (BVG_EARLIEST_AGE <= age < retirement_age and 0.0 < after < last):
            continue
        last = after
        if age < current_age:
            pensum = after
        else:
            upcoming.append((age, after, _share(step.get("capital_share"))))
    return pensum, upcoming


def pensum_at(record: Optional[Dict], current_age: int, retirement_age: int, age: int) -> float:
    """Arbeitspensum (0-1) im Alter `age`: voll bis zur ersten
    Teilpensionierung, 0 ab dem Erwerbsende."""
    if age >= retirement_age:
        return 0.0
    pensum, upcoming = partial_retirement_plan(record, current_age, retirement_age)
    for step_age, after, _ in upcoming:
        if age >= step_age:
            pensum = after
    return pensum


def pillar_3b_age(record: Dict, current_age: int, retirement_age: int) -> int:
    """Auszahlung der freien Vorsorge (3b): am Ablauf der Police
    (`withdrawal_age`), sonst beim Erwerbsende."""
    return max(record.get("withdrawal_age") or retirement_age, current_age)


#: Kapitalbezuege, die besteuert werden. Die 3b (Lebensversicherung mit
#: laufender Praemie) ist bei Auszahlung einkommenssteuerfrei.
TAXED_SOURCES = ("bvg", "3a")


def level_withdrawal(balance: float, rate: float, years: int) -> float:
    """Gleicher Betrag pro Jahr, der `balance` in `years` Jahren aufbraucht,
    wenn der Rest mit `rate` weiter rentiert."""
    years = max(1, years)
    if abs(rate) < 1e-9:
        return balance / years
    return balance * rate / (1 - (1 + rate) ** -years)


def single_year_tax(withdrawals: Sequence[Dict], canton: str, married: bool) -> float:
    """Zum Vergleich: alle steuerbaren Bezuege im selben Jahr — was die
    Staffelung spart."""
    taxed = sum(w["amount"] for w in withdrawals if w["source"] in TAXED_SOURCES)
    return capital_tax(taxed, canton, married) if taxed > 0 else 0.0


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


def bvg_steps(
    record: Optional[Dict], annual_income: float, current_age: int, retirement_age: int,
) -> tuple:
    """Pensionskasse Jahr fuer Jahr bis zum Endbezug, nominal.

    Eine Teilpensionierung gibt den Teil des Guthabens frei, um den das Pensum
    sinkt (100 % auf 60 %: 40 %); der Rest spart mit dem tieferen Pensum
    weiter. Beim Erwerbsende (fruehestens 58, bis dahin verzinst auf
    Freizuegigkeit) wird der Rest frei. Vom frei gewordenen Guthaben geht der
    Kapitalanteil als Kapital weg, der Rest wird Rente mit dem Umwandlungssatz
    des Bezugsalters (Satz auf dem Vorsorgeausweis gilt fuer 65).

    Returns (Schritte, Guthaben): Schritte als Dicts mit age, pensum (danach),
    released, capital, pension (Jahresrente ab age); Guthaben[i] = Stand im
    Alter current_age + i vor einem Schritt, bis vor den Endbezug.
    """
    record = record or {}
    balance = record.get("current_balance", 0.0)
    contribution = record.get("annual_contribution", 0.0)
    rate = record.get("expected_return_rate", 0.01)
    rate_65 = record.get("conversion_rate") or BVG_CONVERSION_RATE_DEFAULT
    insured_salary = max(0, annual_income - BVG_COORD_DEDUCTION)
    pensum, upcoming = partial_retirement_plan(record, current_age, retirement_age)
    # ponytail: wer heute schon ueber dem Bezugsalter ist, bezieht jetzt
    final_age = max(bvg_start_age(retirement_age), current_age)
    plan = upcoming + [(final_age, 0.0, _share(record.get("capital_share")))]
    steps: List[Dict[str, float]] = []
    balances: List[float] = []
    age = current_age
    for step_age, after, share in plan:
        while age < step_age:
            balances.append(balance)
            # Beitraege nur bei Erwerbstaetigkeit, im Verhaeltnis zum Pensum
            base = contribution or insured_salary * _bvg_rate_for_age(age)
            balance = balance * (1 + rate) + (base * pensum if age < retirement_age else 0.0)
            age += 1
        released = balance * (pensum - after) / pensum if pensum > 0 else balance
        balance -= released
        pensum = after
        steps.append({
            "age": step_age, "pensum": after, "released": released,
            "capital": released * share,
            "pension": released * (1 - share) * bvg_conversion_at(rate_65, step_age),
        })
    return steps, balances


def _pillar_3a_balance(record: Dict, current_age: int, retirement_age: int, at_age: int) -> float:
    """3a-Guthaben (nominal) im Alter `at_age`: Beitraege bis zum Rentenalter,
    danach nur Zins."""
    years = max(0, at_age - current_age)
    saving = min(years, max(0, retirement_age - current_age))
    rate = record.get("expected_return_rate", 0.03)
    balance = _accumulate(record.get("current_balance", 0.0), record.get("annual_contribution", 0.0), rate, saving)
    return balance * (1 + rate) ** (years - saving)


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
        canton: str = DEFAULT_CANTON,
        married: bool = False,
        drawdown_until_age: int = 90,
        seed: Optional[int] = None,
        tax_in_retirement: bool = True,
    ) -> Dict[str, Any]:
        """
        Run Monte Carlo simulation and pension projections.

        Jahresfluss aufs freie Vermoegen (`current_net_worth`, ohne die Saeulen):
          - bis zum Rentenalter: Sparrate (waechst mit der Teuerung); nach
            einer Teilpensionierung abzueglich des Lohnausfalls, zuzueglich der
            Teilrente
          - ab dem Rentenalter: tatsaechlich fliessende Renten minus
            Lebenskosten (`retirement_spending`, heutige CHF, ohne Steuern; ohne
            Angabe `default_retirement_spending`) minus Einkommens- und
            Vermoegenssteuer (`tax_in_retirement`, je Lauf, weil sie am
            Vermoegen haengt), bis 65 zusaetzlich die AHV-Beitraege als
            Nichterwerbstaetige
          - Kapitalbezuege (Pensionskasse, 3a nach Steuer, 3b steuerfrei) im
            Bezugsjahr (`canton`, `married` fuer die Steuer)
          - dazu die Szenario-Cashflows (`annual_flows`, nominal)
        Das Vermoegen faellt nie unter 0.

        Returns dict with years, p10..p90, pension_* series, pension_income,
        retirement_idx, payout_start_idx, retirement_spending, depletion_age,
        success_rate, inflation_adjusted.
        """
        # ── Pension Projections ───────────────────────────────
        pension_ahv, pension_bvg, pension_3a, pension_3b, retirement_idx, bvg_income = (
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
        # Was tatsaechlich fliesst: AHV ab Bezug, Pensionskasse ab jedem Schritt
        income_real = [a + b for a, b in zip(pension_ahv, bvg_income)]
        bvg_record = next((r for r in pension_records or [] if r["pillar"] == "2"), None)
        final_bvg_age = max(bvg_start_age(retirement_age), current_age)
        pensum = [pensum_at(bvg_record, current_age, retirement_age, current_age + yr) for yr in range(years)]
        if retirement_spending is None:
            retirement_spending = default_retirement_spending(annual_income, annual_savings)

        # Kapitalbezuege: netto nach Steuer ins freie Vermoegen, real je Jahr
        withdrawals = self.capital_withdrawals(
            pension_records or [], current_age, retirement_age, annual_income,
            inflation_rate, canton, married,
        )
        capital_inflow_real = [0.0] * (years + 1)
        for w in withdrawals:
            idx = w["age"] - current_age
            if 0 <= idx < years:
                capital_inflow_real[idx] += w["amount"] - w["tax"]

        # ── Monte Carlo ────────────────────────────────────────
        # Gleicher `seed` = gleiche Maerkte: so lassen sich Varianten (Rente
        # oder Kapital) Lauf fuer Lauf vergleichen
        rng = np.random.default_rng(seed)

        # Random annual returns: log-normal distribution
        # ln(1+r) ~ Normal(mu, sigma)
        log_mean = np.log(1 + mean_return) - 0.5 * volatility**2
        annual_log_returns = rng.normal(
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
                # Nach einer Teilpensionierung fehlt der Lohnausfall beim
                # Sparen, die Teilrente kommt dazu (ohne Teilpensionierung 0)
                lost = (1 - pensum[yr]) * annual_income * NET_INCOME_SHARE
                flow = (annual_savings - lost + income_real[yr]) * inflation_factor
            else:
                # Renten und Lebenskosten kommen real herein, gerechnet wird nominal
                flow = (income_real[yr] - retirement_spending) * inflation_factor
                if age < AHV_REGULAR_RETIREMENT_AGE:
                    # Fruehpensionierte zahlen bis 65 AHV-Beitraege — je Lauf
                    # verschieden, weil sie am Vermoegen haengen
                    basis = portfolio / inflation_factor + 20 * income_real[yr]
                    flow = flow - ahv_nonemployed_contribution(basis) * inflation_factor
                if tax_in_retirement:
                    tax = retirement_tax(income_real[yr], portfolio / inflation_factor, canton, married)
                    flow = flow - tax * inflation_factor
            flow = flow + capital_inflow_real[yr] * inflation_factor
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

        # Verfuegbar aus dem Vermoegen: ein gleichbleibender realer Betrag ab
        # der Pensionierung, der das freie Vermoegen (Median bei Pensionierung)
        # samt spaeteren Kapitalbezuegen bis `drawdown_until_age` aufbraucht,
        # bei realer Median-Rendite. Zum Vergleich mit Renten und Ausgaben —
        # die Simulation selbst entnimmt nur, was fehlt.
        growth = float(np.exp(log_mean)) / (1 + inflation_rate) - 1
        later_capital = sum(
            capital_inflow_real[i] / (1 + growth) ** (i - retirement_idx + 1)
            for i in range(retirement_idx, years)
        )
        # bis und mit dem Jahr, in dem man drawdown_until_age wird
        drawdown = level_withdrawal(
            p50[retirement_idx] + later_capital, growth, drawdown_until_age - retirement_age + 1
        )
        capital_drawdown = [
            drawdown if i >= retirement_idx and current_age + i <= drawdown_until_age else 0.0
            for i in range(years + 1)
        ]

        # Steuern im Ruhestand entlang des Median-Pfads, fuer die Anzeige
        tax_median = [
            float(retirement_tax(income_real[i], p50[i], canton, married))
            if tax_in_retirement and i >= retirement_idx else 0.0
            for i in range(years + 1)
        ]

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
            # Fuers Diagramm getrennt: Kapital in der Kasse bis zum Endbezug,
            # und was sie als Rente zahlt (auch Teilrenten)
            "capital_bvg": [
                value if current_age + i < final_bvg_age else 0.0
                for i, value in enumerate(pension_bvg)
            ],
            "income_bvg": bvg_income,
            "capital_drawdown": capital_drawdown,
            "drawdown_until_age": drawdown_until_age,
            "retirement_idx": retirement_idx,
            "payout_start_idx": {
                pillar: max(0, start - current_age)
                for pillar, start in payout_start_ages(retirement_age).items()
            },
            "retirement_spending": retirement_spending,
            "retirement_tax": tax_median,
            # Vergleich: Median des freien Vermoegens im selben Alter (None = keiner)
            "peer_wealth": [median_wealth(current_age + i, married) for i in range(years + 1)],
            "peer_pensions": NEW_PENSIONS_2024,
            "capital_withdrawals": withdrawals,
            "capital_tax_total": sum(w["tax"] for w in withdrawals),
            "capital_tax_single_year": single_year_tax(withdrawals, canton, married),
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
        canton: str = DEFAULT_CANTON,
        married: bool = False,
    ) -> Dict[str, Any]:
        """Renten bei Bezugsbeginn und Kapitalbezuege, in heutigen CHF.

        Liest dieselben Reihen wie das Rentendiagramm (`_project_pensions`) und
        denselben Bezugsplan (`capital_withdrawals`) — Wizard und Finanzplan
        zeigen damit dieselben Zahlen. Monatsbetraege sind Jahresbetraege / 12;
        bei der AHV steckt die 13. Rente anteilig darin.
        """
        starts = payout_start_ages(retirement_age)
        horizon = max(max(starts.values()) - current_age, 0) + 1
        dob = f"{datetime.now().year - current_age}-01-01"
        ahv, bvg, *_ = self._project_pensions(
            pension_records, horizon, annual_income, dob, retirement_age, inflation_rate
        )

        def at(series, pillar):
            return series[max(0, starts[pillar] - current_age)]

        def real(amount, age):
            return amount / (1 + inflation_rate) ** (age - current_age)

        withdrawals = self.capital_withdrawals(
            pension_records, current_age, retirement_age, annual_income,
            inflation_rate, canton, married,
        )
        bvg_record = next((r for r in pension_records if r["pillar"] == "2"), None)
        steps, _ = bvg_steps(bvg_record, annual_income, current_age, retirement_age)
        rate_at_65 = (bvg_record or {}).get("conversion_rate") or BVG_CONVERSION_RATE_DEFAULT
        ahv_monthly = at(ahv, "1") / 12
        bvg_monthly = at(bvg, "2") / 12
        capital_gross = sum(w["amount"] for w in withdrawals)
        capital_tax_total = sum(w["tax"] for w in withdrawals)

        def gross(source):
            return sum(w["amount"] for w in withdrawals if w["source"] == source)

        return {
            "retirement_age": retirement_age,
            "years_to_retirement": max(0, retirement_age - current_age),
            "ahv_start_age": starts["1"],
            "bvg_start_age": starts["2"],
            "ahv_monthly": ahv_monthly,
            "bvg_capital": sum(real(s["released"], s["age"]) for s in steps),
            "bvg_conversion_rate": bvg_conversion_at(rate_at_65, starts["2"]),
            "bvg_capital_share": _share((bvg_record or {}).get("capital_share")),
            "bvg_lump_sum": gross("bvg"),
            "bvg_monthly": bvg_monthly,
            # Teilpensionierung und Endbezug: was frei wird, davon Kapital, und die Rente
            "bvg_steps": [
                {"age": s["age"], "pensum": s["pensum"], "released": real(s["released"], s["age"]),
                 "capital": real(s["capital"], s["age"]),
                 "pension_monthly": real(s["pension"], s["age"]) / 12}
                for s in steps
            ],
            "pillar_3a_capital": gross("3a"),
            "pillar_3b_capital": gross("3b"),
            "capital_withdrawals": withdrawals,
            "capital_tax": capital_tax_total,
            "capital_tax_single_year": single_year_tax(withdrawals, canton, married),
            "capital_net": capital_gross - capital_tax_total,
            "total_monthly": ahv_monthly + bvg_monthly,
        }

    def capital_withdrawals(
        self,
        pension_records: List[Dict],
        current_age: int,
        retirement_age: int,
        annual_income: float,
        inflation_rate: float,
        canton: str = DEFAULT_CANTON,
        married: bool = False,
    ) -> List[Dict[str, Any]]:
        """Kapitalbezuege mit Alter, Betrag und Steuer, in heutigen CHF.

        - Pensionskasse: Kapitalanteil jeder Teilpensionierung und des Endbezugs
        - Saeule 3a: jedes Konto einzeln, im eigenen oder im gestaffelten Alter
        - Saeule 3b / Lebensversicherung: am Ablauf der Police, steuerfrei
          (rueckkaufsfaehige Versicherung mit laufender Praemie)
        Alle steuerbaren Bezuege desselben Jahres werden fuer die Steuer
        zusammengezaehlt, die Steuer dann anteilig verteilt.
        """
        def real(amount, age):
            return amount / (1 + inflation_rate) ** (age - current_age)

        events: List[Dict[str, Any]] = []
        bvg = next((r for r in pension_records if r["pillar"] == "2"), None)
        steps, _ = bvg_steps(bvg, annual_income, current_age, retirement_age)
        for s in steps:
            if s["capital"] > 0:
                events.append({
                    "source": "bvg", "label": (bvg or {}).get("provider") or "Pensionskasse",
                    "age": s["age"], "pensum": s["pensum"],  # > 0: Teilpensionierung
                    "amount": real(s["capital"], s["age"]),
                })
        bvg_capital_ages = [e["age"] for e in events]

        p3a = [r for r in pension_records if r["pillar"] == "3a"]
        ages = resolve_3a_ages(p3a, retirement_age, current_age, bvg_capital_ages)
        for account, (record, age) in enumerate(zip(p3a, ages)):
            events.append({
                "source": "3a", "label": record.get("provider") or "Säule 3a", "age": age,
                "account": account,  # Position unter den 3a-Konten, fuer die Oberflaeche
                "amount": real(_pillar_3a_balance(record, current_age, retirement_age, age), age),
            })

        for record in (r for r in pension_records if r["pillar"] == "3b"):
            age = pillar_3b_age(record, current_age, retirement_age)
            amount = _pillar_3a_balance(record, current_age, retirement_age, age)
            if amount > 0:
                events.append({
                    "source": "3b", "label": record.get("provider") or "Säule 3b", "age": age,
                    "amount": real(amount, age), "tax": 0.0,
                })

        per_age: Dict[int, float] = {}
        for e in events:
            if e["source"] in TAXED_SOURCES:
                per_age[e["age"]] = per_age.get(e["age"], 0.0) + e["amount"]
        tax_per_age = {age: capital_tax(total, canton, married) for age, total in per_age.items()}
        this_year = datetime.now().year
        for e in events:
            if e["source"] in TAXED_SOURCES:
                e["tax"] = tax_per_age[e["age"]] * e["amount"] / per_age[e["age"]] if per_age[e["age"]] else 0.0
            e["year"] = this_year + e["age"] - current_age
        return sorted(events, key=lambda e: (e["age"], e["source"]))

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

        Returns (ahv, bvg, 3a, 3b, retirement_idx, bvg_income), Listen der
        Laenge years+1 in heutigen CHF:
          - ahv: Jahresrente, 0 vor dem Bezug
          - bvg: Guthaben bis zum Endbezug, danach die ganze Jahresrente (fuers
            Diagramm); bvg_income: was tatsaechlich fliesst, auch Teilrenten
          - 3a, 3b: Guthaben bis zum Bezug als Kapital, danach 0

        Nach dem Rentenalter wird nichts mehr einbezahlt: die BVG-Rente steht
        ab da nominal fest (und verliert real an Wert).
        """
        current_age = _current_age(date_of_birth)

        years_to_retirement = max(0, retirement_age - current_age)
        # Index in the series where age first reaches retirement_age.
        retirement_idx = min(years_to_retirement, years)

        # Extract pension records by pillar
        ahv_record = next((r for r in pension_records if r["pillar"] == "1"), None)
        bvg_record = next((r for r in pension_records if r["pillar"] == "2"), None)
        steps, bvg_balances = bvg_steps(bvg_record, annual_income, current_age, retirement_age)
        final_age = steps[-1]["age"]
        # Bezugsalter je 3a-Konto festlegen (eigenes oder gestaffelt) und je
        # 3b-Police, damit Reihe und Kapitalbezug dasselbe Alter verwenden
        bvg_capital_ages = [s["age"] for s in steps if s["capital"] > 0]
        p3a_records = [r for r in pension_records if r["pillar"] == "3a"]
        p3a_records = [
            {**r, "withdrawal_age": age}
            for r, age in zip(
                p3a_records,
                resolve_3a_ages(p3a_records, retirement_age, current_age, bvg_capital_ages),
            )
        ]
        p3b_records = [
            {**r, "withdrawal_age": pillar_3b_age(r, current_age, retirement_age)}
            for r in pension_records if r["pillar"] == "3b"
        ]

        pension_ahv_series = []
        pension_bvg_series = []
        pension_3a_series = []
        pension_3b_series = []
        bvg_income = []

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
            # Renten stehen nominal fest, ab ihrem Schritt
            pension = sum(s["pension"] for s in steps if s["age"] <= age_at_year)
            bvg_income.append(pension / inflation_deflator)
            bvg_value = bvg_balances[yr] if age_at_year < final_age else pension
            pension_bvg_series.append(bvg_value / inflation_deflator)

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
            # Wie 3a: Kapital bis zur Auszahlung, dann ins freie Vermoegen
            p3b_total = sum(
                self._project_3a(
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
            bvg_income,
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

    def _project_3a(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Dict,
        years_elapsed: int,
    ) -> float:
        """
        Guthaben eines 3a-Kontos oder einer 3b-Police (nominal) bis zum Bezug,
        danach 0: es wird als Kapital bezogen (Steuer und Zufluss ins
        Vermoegen: capital_withdrawals). Einzahlen geht nur bis zum Rentenalter.
        """
        withdrawal_age = record.get("withdrawal_age") or pillar_3a_latest_age(retirement_age)
        if age_at_year >= withdrawal_age:
            return 0.0
        return _pillar_3a_balance(record, age_at_year - years_elapsed, retirement_age, age_at_year)

    def income_plan(
        self,
        fund_return: float = 0.04,
        payout_until_age: Optional[int] = 90,
        indexed: bool = True,
        include_wealth: bool = True,
        until_age: int = 95,
        **run_kwargs,
    ) -> Dict[str, Any]:
        """Monatliches Einkommen ab dem Rentenalter, in heutigen CHF.

        Renten (AHV, Pensionskasse) wie in run(). Alle Kapitalbezuege (BVG-
        Kapital, 3a, Lebensversicherung, netto) und — mit `include_wealth` — das
        freie Vermoegen bei Pensionierung (Median) gehen in einen Fonds mit der
        erwarteten Rendite `fund_return` (nominal). Der Fonds zahlt einen festen
        Betrag bis `payout_until_age` (dann ist er leer); `indexed` = der Betrag
        steigt mit der Teuerung, sonst bleibt er in Franken gleich und verliert
        real an Wert. `payout_until_age=None`: nur der Ertrag, das Kapital
        bleibt. Deterministisch mit der erwarteten Rendite — die Streuung zeigt
        die Vermoegensprognose. Steuern: retirement_tax auf Renten plus
        Fondsertrag und Vermoegen; die Entnahme selbst ist Kapitalverzehr und
        steuerfrei.
        """
        r = run_kwargs.pop("_run_result", None) or self.run(**run_kwargs)
        inflation = run_kwargs.get("inflation_rate", 0.015)
        canton = run_kwargs.get("canton", DEFAULT_CANTON)
        married = run_kwargs.get("married", False)
        current_age = _current_age(run_kwargs.get("date_of_birth"))
        start = r["retirement_idx"]
        retirement_age = current_age + start
        real_rate = (1 + fund_return) / (1 + inflation) - 1

        inflow = {w["age"]: 0.0 for w in r["capital_withdrawals"]}
        for w in r["capital_withdrawals"]:
            inflow[w["age"]] += w["amount"] - w["tax"]
        # Was vor der Pensionierung bezogen wurde, steckt schon im Vermoegen
        early = sum(v for age, v in inflow.items() if age < retirement_age)
        opening = (r["p50"][start] if include_wealth else early)
        later = {age: v for age, v in inflow.items() if age >= retirement_age}

        # Fester Betrag aus Anfangsbestand und spaeteren Zufluessen (Barwert)
        pv = opening + sum(v / (1 + real_rate) ** (age - retirement_age) for age, v in later.items())
        if payout_until_age is None:
            payout0 = pv * real_rate
        elif indexed:
            payout0 = level_withdrawal(pv, real_rate, payout_until_age - retirement_age + 1)
        else:
            # nominal fest: mit dem nominalen Zins rechnen, real schrumpft er
            payout0 = level_withdrawal(pv, fund_return, payout_until_age - retirement_age + 1)

        rows, balance = [], opening
        for age in range(retirement_age, until_age + 1):
            i = age - current_age
            balance += later.get(age, 0.0)
            t = age - retirement_age
            if payout_until_age is not None and age > payout_until_age:
                payout = 0.0
            else:
                payout = payout0 if indexed or payout_until_age is None else payout0 / (1 + inflation) ** t
            payout = min(payout, max(balance, 0.0))
            ahv = r["pension_ahv"][i] if i < len(r["pension_ahv"]) else r["pension_ahv"][-1]
            bvg = r["income_bvg"][i] if i < len(r["income_bvg"]) else r["income_bvg"][-1]
            tax = float(retirement_tax(ahv + bvg, balance, canton, married))
            rows.append({
                "age": age, "year": r["years"][0] + i,
                "ahv": ahv / 12, "bvg": bvg / 12, "fund": payout / 12, "tax": tax / 12,
                "net": (ahv + bvg + payout - tax) / 12,
                "fund_balance": balance,
            })
            balance = (balance - payout) * (1 + real_rate)
        return {
            "retirement_age": retirement_age,
            "fund_start": opening,
            "fund_inflows": [{"age": a, "amount": v} for a, v in sorted(later.items())],
            "spending_monthly": (r["retirement_spending"] or 0.0) / 12,
            # Vergleich: Median-Einkommen der Pensionierten (verfuegbar, ohne Kapitalverzehr)
            "peer_income_monthly": retiree_income_monthly(married),
            "rows": rows,
        }

    def retirement_scenarios(
        self,
        pension_records: List[Dict],
        ages: Sequence[int] = (60, 62, 63, 65),
        shares: Sequence[float] = (0.0, 0.5, 1.0),
        life_expectancy: int = 90,
        **run_kwargs,
    ) -> Dict[str, Any]:
        """Szenarienmatrix: Rentenalter x Anteil der Pensionskasse als Kapital.

        Je Zelle das Nettoeinkommen pro Monat (Einkommensplan mit Fonds bis zur
        Lebenserwartung, 4 %) bei Pensionierung, mit 75 und 85, dazu aus der
        Simulation Erfolgsquote, Vermoegen mit 85 und wie lange es reicht.
        Gleiche Maerkte fuer alle Zellen. Dazu regelbasierte Hinweise aus den
        eigenen Zahlen (`hints`: Schluessel + Werte fuer die Uebersetzung).
        """
        run_kwargs["seed"] = run_kwargs.get("seed") or int(np.random.default_rng().integers(2**31))
        planned = run_kwargs.pop("retirement_age", 65)
        bvg = next((r for r in pension_records if r["pillar"] == "2"), None)
        current_age = _current_age(run_kwargs.get("date_of_birth"))
        ages = sorted({a for a in ages if a > current_age} | ({planned} if planned > current_age else set()))

        def records_with(share: float) -> List[Dict]:
            if bvg is None:
                return pension_records
            steps = [{**s, "capital_share": share} for s in bvg.get("partial_steps") or []]
            return [{**r, "capital_share": share, "partial_steps": steps} if r is bvg else r
                    for r in pension_records]

        def at_age(series, age):
            i = age - current_age
            return series[i] if 0 <= i < len(series) else None

        cells, runs = [], {}
        for age in ages:
            for share in (shares if bvg else (0.0,)):
                records = records_with(share)
                r = self.run(pension_records=records, retirement_age=age, **run_kwargs)
                plan = self.income_plan(
                    fund_return=0.04, payout_until_age=life_expectancy, _run_result=r,
                    pension_records=records, retirement_age=age, **run_kwargs,
                )
                net = {row["age"]: row["net"] for row in plan["rows"]}
                runs[(age, share)] = r
                cells.append({
                    "age": age, "capital_share": share,
                    "net_start": net.get(age, 0.0), "net_75": net.get(max(age, 75)),
                    "net_85": net.get(max(age, 85)),
                    "success_rate": r["success_rate"], "depletion_age": r["depletion_age"],
                    "wealth_85": at_age(r["p50"], 85),
                    "capital_tax": r["capital_tax_total"],
                })

        # ── Hinweise ─────────────────────────────────────────
        hints: List[Dict[str, Any]] = []
        own_share = _share((bvg or {}).get("capital_share"))
        own = min(shares, key=lambda s: abs(s - own_share)) if bvg else 0.0
        cell = {(c["age"], c["capital_share"]): c for c in cells}
        base = cell.get((planned, own))
        if base:
            # Was ein Jahr frueher kostet (netto, mit 75, wenn alle Renten fliessen)
            earlier = [a for a in ages if a < planned]
            if earlier and base["net_75"] is not None:
                a = max(earlier)
                other = cell[(a, own)]
                diff = (base["net_75"] - (other["net_75"] or 0)) / (planned - a)
                hints.append({"key": "earlyCost", "age": a, "planned": planned, "amount": round(diff)})
            # AHV-Luecke bis 63
            if planned < AHV_EARLIEST_AGE:
                hints.append({"key": "ahvBridge", "age": planned, "years": AHV_EARLIEST_AGE - planned})
            # Rente oder Kapital: wann holt die Rente das Kapital ein?
            if bvg and (planned, 0.0) in runs and (planned, 1.0) in runs:
                pension, capital = runs[(planned, 0.0)]["p50"], runs[(planned, 1.0)]["p50"]
                first = runs[(planned, 0.0)]["payout_start_idx"]["2"] + 1
                breakeven = next((current_age + i for i in range(first, len(pension))
                                  if pension[i] >= capital[i] and pension[i] > 0), None)
                hints.append({
                    "key": "pensionWins" if breakeven and breakeven <= life_expectancy else "capitalWins",
                    "age": breakeven, "life": life_expectancy,
                })
            # Erfolgsquote: lohnt sich spaeter?
            if base["success_rate"] < 0.8:
                better = next((a for a in ages if a > planned and cell[(a, own)]["success_rate"] >= 0.8), None)
                hints.append({"key": "lowSuccess", "pct": round(base["success_rate"] * 100), "age": better})
        r = runs.get((planned, own))
        if r:
            ws = r["capital_withdrawals"]
            years = [w["age"] for w in ws if w["source"] in TAXED_SOURCES]
            if len(years) != len(set(years)):
                hints.append({"key": "sameYear"})
            saving = r["capital_tax_single_year"] - r["capital_tax_total"]
            if saving > 500:
                hints.append({"key": "staggerSaving", "amount": round(saving)})
            lv = [w for w in ws if w["source"] == "3b"]
            if lv:
                hints.append({"key": "lifeInsurance", "age": lv[0]["age"], "amount": round(lv[0]["amount"])})
            if own_share > 0:
                hints.append({"key": "buyInLock"})
        return {"ages": ages, "shares": list(shares) if bvg else [0.0], "planned_age": planned,
                "own_share": own, "cells": cells, "hints": hints}

    def compare_bvg_options(self, pension_records: List[Dict], **run_kwargs) -> Dict[str, Any]:
        """Pensionskasse ganz als Rente, ganz als Kapital (nach Steuer ins freie
        Vermoegen, dort weiter angelegt) und — wenn es davon abweicht — wie
        geplant. Dieselben Maerkte fuer alle Varianten (gleicher seed), sonst
        alles gleich; die Steuern im Ruhestand sind abgezogen.

        Returns years, current_age, retirement_age, variants (je Median- und
        10-%-Pfad des freien Vermoegens, BVG-Rente, Kapital netto, Steuern,
        Vermoegen mit 85/90, wie lange es reicht) und breakeven_age: ab wann
        die Rente im Median mehr freies Vermoegen uebrig laesst als das Kapital.
        """
        bvg = next((r for r in pension_records if r["pillar"] == "2"), None)
        if bvg is None:
            return {"variants": [], "breakeven_age": None}
        run_kwargs["seed"] = run_kwargs.get("seed") or int(np.random.default_rng().integers(2**31))

        def with_share(share: float) -> List[Dict]:
            steps = [{**s, "capital_share": share} for s in bvg.get("partial_steps") or []]
            return [
                {**r, "capital_share": share, "partial_steps": steps} if r is bvg else r
                for r in pension_records
            ]

        shares = {_share(bvg.get("capital_share"))} | {
            _share(s.get("capital_share")) for s in bvg.get("partial_steps") or []
        }
        variants = [("pension", with_share(0.0)), ("capital", with_share(1.0))]
        if shares not in ({0.0}, {1.0}):
            variants.append(("own", pension_records))

        current_age = _current_age(run_kwargs.get("date_of_birth"))

        def at_age(series, age):
            i = age - current_age
            return series[i] if 0 <= i < len(series) else None

        out, medians = [], {}
        for key, records in variants:
            r = self.run(pension_records=records, **run_kwargs)
            start = min(r["payout_start_idx"]["2"], len(r["income_bvg"]) - 1)
            bvg_capital = [w for w in r["capital_withdrawals"] if w["source"] == "bvg"]
            medians[key] = r["p50"]
            out.append({
                "key": key,
                "bvg_monthly": r["income_bvg"][start] / 12,
                "capital_net": sum(w["amount"] - w["tax"] for w in bvg_capital),
                "p50": r["p50"],
                "p10": r["p10"],
                "depletion_age": r["depletion_age"],
                "success_rate": r["success_rate"],
                "wealth_85": at_age(r["p50"], 85),
                "wealth_90": at_age(r["p50"], 90),
                "wealth_85_p10": at_age(r["p10"], 85),
                "taxes_total": r["capital_tax_total"] + sum(r["retirement_tax"]),
            })
        retirement_idx = r["retirement_idx"]
        # Ab dem Jahr nach dem Endbezug (dann ist das Kapital im Vermoegen)
        first = r["payout_start_idx"]["2"] + 1
        pension, capital = medians["pension"], medians["capital"]
        breakeven_age = next(
            (current_age + i for i in range(first, len(pension))
             if pension[i] >= capital[i] and pension[i] > 0),
            None,
        )
        return {
            "years": r["years"],
            "current_age": current_age,
            "retirement_age": current_age + retirement_idx,
            "variants": out,
            "breakeven_age": breakeven_age,
        }

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
