#!/usr/bin/env python3
"""
generate_peer_benchmarks.py
============================
Recomputes peer_group_benchmarks from anonymized user transaction data.

Usage:
    python scripts/generate_peer_benchmarks.py [--dry-run] [--min-users 10]

How it works:
  1. Loads all users with date_of_birth set
  2. Groups them into age bands (20-29, 30-39, …) × household_type from wizard scenarios
  3. For each group with at least --min-users members, computes:
       - median / p25 / p75 monthly income
       - average monthly spending per peer category (housing, food, transport, insurance, health, leisure)
       - average savings rate
  4. Upserts results into peer_group_benchmarks (ON CONFLICT UPDATE)

Groups with fewer than --min-users users fall back to the existing static seed rows.

Environment variables (same as app):
    DATABASE_URL   postgresql+asyncpg://... (converted to psycopg2 sync URL internally)
"""

import argparse
import os
import re
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime
from typing import Optional

# ── deps ───────────────────────────────────────────────────────
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)


# ── Category mapping (same as budget_multimodal.py) ────────────
TXN_TO_PEER: dict[str, str] = {
    "groceries": "food",
    "food & drink": "food",
    "lebensmittel": "food",
    "transport": "transport",
    "travel": "transport",
    "housing": "housing",
    "wohnen": "housing",
    "utilities": "housing",
    "nebenkosten": "housing",
    "miete": "housing",
    "insurance": "insurance",
    "versicherungen": "insurance",
    "krankenkasse": "insurance",
    "health": "health",
    "gesundheit": "health",
    "entertainment": "leisure",
    "shopping": "leisure",
    "unterhaltung": "leisure",
    "freizeit": "leisure",
}

AGE_BANDS = [
    (20, 29),
    (30, 39),
    (40, 49),
    (50, 59),
    (60, 69),
    (70, 99),
]

HOUSEHOLD_TYPES = ["single", "couple", "family", "single-parent"]


def _age(dob: datetime) -> Optional[int]:
    if not dob:
        return None
    today = date.today()
    d = dob.date() if hasattr(dob, "date") else dob
    return today.year - d.year - ((today.month, today.day) < (d.month, d.day))


def _age_band(age: int) -> Optional[tuple[int, int]]:
    for start, end in AGE_BANDS:
        if start <= age <= end:
            return (start, end)
    return None


def _dsn_from_url(url: str) -> str:
    """Convert asyncpg URL to psycopg2 DSN."""
    url = re.sub(r"^postgresql\+asyncpg://", "postgresql://", url)
    url = re.sub(r"^postgres\+asyncpg://", "postgresql://", url)
    return url


def _connect() -> psycopg2.extensions.connection:
    raw = os.environ.get(
        "DATABASE_URL",
        "postgresql://budgetpal:budgetpal@localhost:5432/budgetpal",
    )
    dsn = _dsn_from_url(raw)
    # Replace asyncpg host reference for local runs
    if "budget-pal-db" in dsn:
        dsn = dsn.replace("budget-pal-db", "localhost")
    return psycopg2.connect(dsn)


def main():
    parser = argparse.ArgumentParser(description="Regenerate peer group benchmarks from user data")
    parser.add_argument("--dry-run", action="store_true", help="Print computed benchmarks without writing to DB")
    parser.add_argument("--min-users", type=int, default=5, help="Minimum users per group before computing (default: 5)")
    args = parser.parse_args()

    conn = _connect()
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    print("Loading users...")
    cur.execute("SELECT id, date_of_birth FROM users WHERE date_of_birth IS NOT NULL")
    users = {row["id"]: row["date_of_birth"] for row in cur.fetchall()}
    print(f"  {len(users)} users with date_of_birth")

    # Load wizard household types (most recent per user)
    print("Loading wizard household types...")
    cur.execute("""
        SELECT DISTINCT ON (s.user_id)
            s.user_id,
            s.parameters_json
        FROM scenarios s
        WHERE s.parameters_json::text LIKE '%wizard_onboarding%'
        ORDER BY s.user_id, s.created_at DESC
    """)
    household_by_user: dict[int, str] = {}
    for row in cur.fetchall():
        params = row["parameters_json"] or {}
        ht = params.get("household_type", "single")
        household_by_user[row["user_id"]] = ht if ht in HOUSEHOLD_TYPES else "single"

    # Load monthly income per user (average over last 12 months, positive transactions)
    print("Loading income data...")
    cur.execute("""
        SELECT
            a.user_id,
            AVG(monthly_inc) AS avg_monthly_income
        FROM (
            SELECT
                a.user_id,
                DATE_TRUNC('month', t.date) AS month,
                SUM(t.amount) FILTER (WHERE t.amount > 0) AS monthly_inc
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE t.is_deleted IS NOT TRUE
              AND t.is_transfer = FALSE
              AND t.date >= NOW() - INTERVAL '12 months'
            GROUP BY a.user_id, DATE_TRUNC('month', t.date)
        ) sub
        JOIN accounts a ON a.user_id = sub.user_id
        GROUP BY a.user_id
    """)
    income_by_user: dict[int, float] = {
        row["user_id"]: float(row["avg_monthly_income"] or 0) for row in cur.fetchall()
    }

    # Load monthly spending per peer category per user
    print("Loading spending by category...")
    cur.execute("""
        SELECT
            a.user_id,
            LOWER(t.category) AS category,
            AVG(monthly_amt) AS avg_monthly_spend
        FROM (
            SELECT
                a.user_id,
                LOWER(t.category) AS category,
                DATE_TRUNC('month', t.date) AS month,
                SUM(ABS(t.amount)) FILTER (WHERE t.amount < 0) AS monthly_amt
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE t.is_deleted IS NOT TRUE
              AND t.is_transfer = FALSE
              AND t.amount < 0
              AND t.date >= NOW() - INTERVAL '12 months'
              AND t.category IS NOT NULL
            GROUP BY a.user_id, LOWER(t.category), DATE_TRUNC('month', t.date)
        ) sub
        JOIN accounts a ON a.user_id = sub.user_id
        GROUP BY a.user_id, LOWER(t.category)
    """)
    # spending[user_id][peer_key] = avg monthly spend
    spending_by_user: dict[int, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in cur.fetchall():
        peer_key = TXN_TO_PEER.get(row["category"])
        if peer_key:
            spending_by_user[row["user_id"]][peer_key] += float(row["avg_monthly_spend"] or 0)

    # Group users by (age_band, household_type)
    groups: dict[tuple, list[int]] = defaultdict(list)
    for uid in users:
        age = _age(users[uid])
        if age is None:
            continue
        band = _age_band(age)
        if band is None:
            continue
        ht = household_by_user.get(uid, "single")
        groups[(band, ht)].append(uid)

    print(f"\nComputed {len(groups)} groups")

    results = []
    for (band, ht), uids in sorted(groups.items()):
        if len(uids) < args.min_users:
            print(f"  SKIP {band[0]}-{band[1]} {ht}: only {len(uids)} users (need {args.min_users})")
            continue

        incomes = [income_by_user.get(uid, 0) for uid in uids if income_by_user.get(uid, 0) > 0]
        if not incomes:
            continue

        median_inc = statistics.median(incomes)
        p25_inc = statistics.quantiles(incomes, n=4)[0] if len(incomes) >= 4 else min(incomes)
        p75_inc = statistics.quantiles(incomes, n=4)[2] if len(incomes) >= 4 else max(incomes)

        peer_spending: dict[str, list[float]] = defaultdict(list)
        for uid in uids:
            for pk, amt in spending_by_user[uid].items():
                if amt > 0:
                    peer_spending[pk].append(amt)

        housing_avg = statistics.mean(peer_spending["housing"]) if peer_spending["housing"] else 0
        food_avg = statistics.mean(peer_spending["food"]) if peer_spending["food"] else 0
        transport_avg = statistics.mean(peer_spending["transport"]) if peer_spending["transport"] else 0
        insurance_avg = statistics.mean(peer_spending["insurance"]) if peer_spending["insurance"] else 0
        health_avg = statistics.mean(peer_spending["health"]) if peer_spending["health"] else 0
        leisure_avg = statistics.mean(peer_spending["leisure"]) if peer_spending["leisure"] else 0

        total_expenses = housing_avg + food_avg + transport_avg + insurance_avg + health_avg + leisure_avg
        savings_rate = round((median_inc - total_expenses) / median_inc * 100, 1) if median_inc > 0 else 0

        row = {
            "age_range_start": band[0],
            "age_range_end": band[1],
            "household_type": ht,
            "median_income_monthly": round(median_inc, 2),
            "p25_income_monthly": round(p25_inc, 2),
            "p75_income_monthly": round(p75_inc, 2),
            "housing_avg": round(housing_avg, 2),
            "food_avg": round(food_avg, 2),
            "transport_avg": round(transport_avg, 2),
            "insurance_avg": round(insurance_avg, 2),
            "health_avg": round(health_avg, 2),
            "leisure_avg": round(leisure_avg, 2),
            "savings_rate_pct": savings_rate,
            "peer_count": len(uids),
        }
        results.append(row)
        print(f"  {band[0]}-{band[1]} {ht}: {len(uids)} users | income Ø {median_inc:,.0f} | savings {savings_rate}%")

    if args.dry_run:
        print(f"\nDRY RUN — {len(results)} rows would be upserted (no DB write)")
        for r in results:
            print(f"  {r['age_range_start']}-{r['age_range_end']} {r['household_type']}: income={r['median_income_monthly']}, housing={r['housing_avg']}")
        cur.close()
        conn.close()
        return

    if not results:
        print("\nNo groups met the minimum user threshold — keeping existing static benchmarks.")
        cur.close()
        conn.close()
        return

    print(f"\nUpserting {len(results)} rows into peer_group_benchmarks...")
    for r in results:
        cur.execute("""
            INSERT INTO peer_group_benchmarks (
                age_range_start, age_range_end, household_type,
                median_income_monthly, p25_income_monthly, p75_income_monthly,
                housing_avg, food_avg, transport_avg, insurance_avg, health_avg, leisure_avg,
                savings_rate_pct, peer_count
            ) VALUES (
                %(age_range_start)s, %(age_range_end)s, %(household_type)s,
                %(median_income_monthly)s, %(p25_income_monthly)s, %(p75_income_monthly)s,
                %(housing_avg)s, %(food_avg)s, %(transport_avg)s, %(insurance_avg)s,
                %(health_avg)s, %(leisure_avg)s,
                %(savings_rate_pct)s, %(peer_count)s
            )
            ON CONFLICT (age_range_start, age_range_end, household_type) DO UPDATE SET
                median_income_monthly = EXCLUDED.median_income_monthly,
                p25_income_monthly    = EXCLUDED.p25_income_monthly,
                p75_income_monthly    = EXCLUDED.p75_income_monthly,
                housing_avg           = EXCLUDED.housing_avg,
                food_avg              = EXCLUDED.food_avg,
                transport_avg         = EXCLUDED.transport_avg,
                insurance_avg         = EXCLUDED.insurance_avg,
                health_avg            = EXCLUDED.health_avg,
                leisure_avg           = EXCLUDED.leisure_avg,
                savings_rate_pct      = EXCLUDED.savings_rate_pct,
                peer_count            = EXCLUDED.peer_count
        """, r)

    conn.commit()
    print("Done. Peer benchmarks updated from live user data.")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
