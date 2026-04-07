"""
Swiss BFS-style peer group defaults — Python port of frontend/src/services/peerGroupAnalyzer.ts
(BFS Haushaltsbudgeterhebung HABE, regional multipliers). Amounts in CHF/month.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, TypedDict

AgeGroup = Literal["25-34", "35-44", "45-54", "55-64", "65+"]
HouseholdType = Literal["single", "couple", "family", "single-parent"]
EmploymentStatus = Literal["employed", "self-employed", "mixed", "retired"]
IncomeLevel = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class PeerGroupProfile:
    age_group: AgeGroup
    canton: str
    household_type: HouseholdType
    employment_status: EmploymentStatus
    income_level: IncomeLevel


# Canton multipliers (Zürich = 1.0 base)
CANTON_MULTIPLIERS: Dict[str, float] = {
    "ZH": 1.00,
    "BS": 1.05,
    "GE": 1.08,
    "VD": 1.02,
    "BE": 0.95,
    "AG": 0.90,
    "SG": 0.88,
    "LU": 0.92,
    "ZG": 1.15,
    "TI": 0.88,
    "VS": 0.85,
    "GR": 0.87,
    "FR": 0.90,
    "SO": 0.89,
    "BL": 0.93,
    "SH": 0.92,
    "AR": 0.87,
    "AI": 0.86,
    "GL": 0.88,
    "TG": 0.89,
    "NE": 0.93,
    "JU": 0.88,
    "UR": 0.86,
    "SZ": 0.98,
    "OW": 0.87,
    "NW": 0.89,
}

HEALTH_INSURANCE_BY_AGE: Dict[AgeGroup, int] = {
    "25-34": 380,
    "35-44": 420,
    "45-54": 460,
    "55-64": 510,
    "65+": 560,
}

HOUSEHOLD_MULTIPLIERS: Dict[HouseholdType, float] = {
    "single": 1.0,
    "couple": 1.7,
    "family": 2.2,
    "single-parent": 1.5,
}

INCOME_MEDIANS: Dict[HouseholdType, Dict[IncomeLevel, int]] = {
    "single": {"low": 3_800, "medium": 6_200, "high": 11_000},
    "couple": {"low": 6_200, "medium": 10_500, "high": 18_500},
    "family": {"low": 7_400, "medium": 12_500, "high": 22_000},
    "single-parent": {"low": 4_200, "medium": 6_800, "high": 11_500},
}

SAMPLE_SIZES: Dict[HouseholdType, str] = {
    "single": "~58.000 Haushalte (BFS HABE 2021)",
    "couple": "~72.000 Haushalte (BFS HABE 2021)",
    "family": "~94.000 Haushalte (BFS HABE 2021)",
    "single-parent": "~18.000 Haushalte (BFS HABE 2021)",
}

CANTON_NAMES: Dict[str, str] = {
    "ZH": "Zürich",
    "BE": "Bern",
    "LU": "Luzern",
    "UR": "Uri",
    "SZ": "Schwyz",
    "OW": "Obwalden",
    "NW": "Nidwalden",
    "GL": "Glarus",
    "ZG": "Zug",
    "FR": "Freiburg",
    "SO": "Solothurn",
    "BS": "Basel-Stadt",
    "BL": "Basel-Land",
    "SH": "Schaffhausen",
    "AR": "Appenzell AR",
    "AI": "Appenzell AI",
    "SG": "St. Gallen",
    "GR": "Graubünden",
    "AG": "Aargau",
    "TG": "Thurgau",
    "TI": "Tessin",
    "VD": "Waadt",
    "VS": "Wallis",
    "NE": "Neuenburg",
    "GE": "Genf",
    "JU": "Jura",
}

SAVINGS_RATES: Dict[IncomeLevel, int] = {"low": 8, "medium": 16, "high": 26}

EDUCATION_BY_EMPLOYMENT: Dict[EmploymentStatus, int] = {
    "employed": 80,
    "self-employed": 200,
    "mixed": 150,
    "retired": 40,
}


def round50(n: float) -> float:
    return round(n / 50) * 50


def round10(n: float) -> float:
    return round(n / 10) * 10


class SubscriptionItem(TypedDict, total=False):
    name: str
    price: float
    category: str
    defaultChecked: bool


COMMON_SUBSCRIPTIONS: List[SubscriptionItem] = [
    {"name": "Netflix", "price": 18, "category": "streaming", "defaultChecked": True},
    {"name": "Spotify", "price": 13, "category": "music", "defaultChecked": True},
    {"name": "Disney+", "price": 12, "category": "streaming", "defaultChecked": False},
    {"name": "NZZ Digital", "price": 39, "category": "news", "defaultChecked": False},
    {"name": "Blick+", "price": 13, "category": "news", "defaultChecked": False},
    {"name": "SRF Play (optional)", "price": 0, "category": "streaming", "defaultChecked": False},
    {"name": "iCloud 200GB", "price": 3, "category": "cloud", "defaultChecked": False},
    {"name": "Google One", "price": 3, "category": "cloud", "defaultChecked": False},
    {"name": "Microsoft 365", "price": 12, "category": "software", "defaultChecked": False},
    {"name": "Migros Cumulus Extra", "price": 8, "category": "loyalty", "defaultChecked": False},
    {"name": "ADSL/Fiber (Swisscom)", "price": 59, "category": "internet", "defaultChecked": True},
    {"name": "Mobile Abo (Sunrise)", "price": 39, "category": "mobile", "defaultChecked": True},
    {"name": "SBB Halbtax", "price": 19, "category": "transport", "defaultChecked": False},
    {"name": "SBB GA 2. Kl.", "price": 345, "category": "transport", "defaultChecked": False},
    {"name": "Fitnesscenter", "price": 80, "category": "fitness", "defaultChecked": False},
    {"name": "Adobe Creative Cloud", "price": 56, "category": "software", "defaultChecked": False},
    {"name": "LinkedIn Premium", "price": 45, "category": "professional", "defaultChecked": False},
    {"name": "Dropbox Plus", "price": 12, "category": "cloud", "defaultChecked": False},
    {"name": "Amazon Prime", "price": 9, "category": "shopping", "defaultChecked": False},
    {"name": "YouTube Premium", "price": 14, "category": "streaming", "defaultChecked": False},
]


def swiss_cantons_list() -> List[Dict[str, str]]:
    return [
        {"code": code, "name": name}
        for code, name in sorted(CANTON_NAMES.items(), key=lambda x: x[1].casefold())
    ]


def get_peer_group_defaults(profile: PeerGroupProfile) -> Dict[str, Any]:
    cm = CANTON_MULTIPLIERS.get(profile.canton, 0.93)
    hm = HOUSEHOLD_MULTIPLIERS[profile.household_type]
    age_health_base = HEALTH_INSURANCE_BY_AGE[profile.age_group]
    income_median = INCOME_MEDIANS[profile.household_type][profile.income_level]
    savings_rate = SAVINGS_RATES[profile.income_level]

    housing_base: Dict[HouseholdType, int] = {
        "single": 1_450,
        "couple": 1_850,
        "family": 2_200,
        "single-parent": 1_650,
    }
    groceries_base: Dict[HouseholdType, int] = {
        "single": 480,
        "couple": 780,
        "family": 1_050,
        "single-parent": 680,
    }
    transport_base: Dict[HouseholdType, int] = {
        "single": 580,
        "couple": 700,
        "family": 800,
        "single-parent": 620,
    }

    housing = round50(housing_base[profile.household_type] * cm)
    groceries = round10(groceries_base[profile.household_type] * cm)
    transport = round10(transport_base[profile.household_type] * cm)

    if profile.household_type == "single":
        persons_in_household = 1.0
    elif profile.household_type == "couple":
        persons_in_household = 2.0
    elif profile.household_type == "family":
        persons_in_household = 2.8
    else:
        persons_in_household = 1.5

    kk = round10(age_health_base * cm * persons_in_household)
    other_insurance = round10(120 * cm * (hm**0.5))
    communication = round10(
        (110 * cm) if profile.household_type == "single" else (160 * cm)
    )

    dining_out_base: Dict[AgeGroup, int] = {
        "25-34": 320,
        "35-44": 290,
        "45-54": 270,
        "55-64": 240,
        "65+": 200,
    }
    if profile.income_level == "high":
        income_dining_multiplier = 1.4
    elif profile.income_level == "medium":
        income_dining_multiplier = 1.0
    else:
        income_dining_multiplier = 0.7
    dining_out = round10(
        dining_out_base[profile.age_group]
        * cm
        * income_dining_multiplier
        * ((hm / 1.5) ** 0.5)
    )

    if profile.income_level == "high":
        entertainment_base = 280
    elif profile.income_level == "medium":
        entertainment_base = 200
    else:
        entertainment_base = 140
    entertainment = round10(entertainment_base * cm * (hm**0.5))

    if profile.income_level == "high":
        clothing_base = 250
    elif profile.income_level == "medium":
        clothing_base = 170
    else:
        clothing_base = 110
    clothing = round10(clothing_base * (hm**0.5))

    travel_base: Dict[IncomeLevel, int] = {"low": 150, "medium": 280, "high": 480}
    travel = round50(travel_base[profile.income_level] * (hm**0.5))

    education = round10(EDUCATION_BY_EMPLOYMENT[profile.employment_status] * cm)

    subscriptions_base = 100 if profile.household_type == "single" else 130
    subscriptions = round10(subscriptions_base)

    # Direct taxes (Kanton, Gemeinde, Bund) — estimated from income median + effective rate
    # Rates based on BFS Steuerstatistik averages for Swiss households
    tax_rates: Dict[IncomeLevel, float] = {"low": 0.08, "medium": 0.14, "high": 0.22}
    direct_taxes = round50(income_median * 1.25 * tax_rates[profile.income_level] * cm * (hm ** 0.4))

    pillar3a_annual_max = 35_280 if profile.employment_status == "self-employed" else 7_056
    if profile.income_level == "high":
        pillar3a_usage_rate = 0.95
    elif profile.income_level == "medium":
        pillar3a_usage_rate = 0.70
    else:
        pillar3a_usage_rate = 0.35
    pillar_3a_monthly = round((pillar3a_annual_max * pillar3a_usage_rate) / 12)

    canton_name = CANTON_NAMES.get(profile.canton, profile.canton)
    hh_label: Dict[HouseholdType, str] = {
        "single": "Single-Haushalt",
        "couple": "Paar-Haushalt",
        "family": "Familienhaushalt",
        "single-parent": "Alleinerziehend",
    }
    peer_label = f"{canton_name}er {hh_label[profile.household_type]}, {profile.age_group}"

    confidence_by_age: Dict[AgeGroup, str] = {
        "25-34": "Gute Datenlage (n > 8.000 in diesem Segment)",
        "35-44": "Sehr gute Datenlage (n > 12.000 in diesem Segment)",
        "45-54": "Sehr gute Datenlage (n > 14.000 in diesem Segment)",
        "55-64": "Gute Datenlage (n > 9.000 in diesem Segment)",
        "65+": "Moderate Datenlage (Stichprobe kleiner, Renten dominieren)",
    }

    return {
        "housing": housing,
        "groceries": groceries,
        "transport": transport,
        "health_insurance": kk,
        "other_insurance": other_insurance,
        "communication": communication,
        "dining_out": dining_out,
        "entertainment": entertainment,
        "clothing": clothing,
        "travel": travel,
        "education": education,
        "subscriptions": subscriptions,
        "direct_taxes": direct_taxes,
        "savings_rate": savings_rate,
        "pillar_3a_monthly": pillar_3a_monthly,
        "peerLabel": peer_label,
        "sampleSize": SAMPLE_SIZES[profile.household_type],
        "incomeMedian": income_median,
        "confidenceNote": confidence_by_age[profile.age_group],
    }
