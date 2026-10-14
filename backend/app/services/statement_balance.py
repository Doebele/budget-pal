"""Schlusssaldo eines Kontoauszugs lesen und als Kontostand übernehmen.

Jeder Auszug nennt am Ende den Stand des Kontos. Beim Import wird er gelesen
und ersetzt `Account.balance`, aber nur, wenn der Auszug mindestens so neu ist
wie der bisher übernommene (`Account.balance_date`). So zählt immer der jüngste
Auszug, egal in welcher Reihenfolge die Auszüge importiert werden.

Gelesen wird aus dem Text des PDFs (bei Comdirect nach der Texterkennung) oder
aus der Saldo-Spalte einer CSV:
- Comdirect Finanzreport: erstes «Neuer Saldo <Datum> <Betrag>» = Girokonto
  (Tagesgeld, Visa und Depot folgen als eigene Abschnitte)
- UBS: «Schlusssaldo <Betrag>» oder «Aktueller Saldo» im Kopf, Stand am
  «Erstellt am <Datum>» bzw. Periodenende
- N26: erstes «Your new balance / Dein neuer Kontostand», Periodenende
- Revolut: Zeile «Gesamt» der «Zusammenfassung der Bilanz» (vierter Betrag)
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Iterable, List, NamedTuple, Optional

from app.models.models import Account
from app.services.currency_service import convert_with_eur_rates


class StatementBalance(NamedTuple):
    date: date
    amount: float
    currency: Optional[str] = None  # None = Währung des Kontos


_NUM = r"[+-]?\s?\d{1,3}(?:[.'’ ]\d{3})*(?:[.,]\d{2})"
_DATE = r"(\d{2})\.(\d{2})\.(\d{4})"
_CURRENCY_SIGNS = {"€": "EUR", "$": "USD", "£": "GBP", "CHF": "CHF", "EUR": "EUR", "USD": "USD"}


def _amount(text: str) -> float:
    """'+6.159,33' / "6'106.97" / '1’069.68' / '-18.000,00' → float."""
    s = re.sub(r"[\s'’]", "", text)
    if "," in s and (s.rfind(",") > s.rfind(".")):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    return float(s)


def _date(m: re.Match, offset: int = 1) -> date:
    d, mth, y = (int(m.group(offset + i)) for i in range(3))
    return date(y, mth, d)


def _last_date(text: str, pattern: str) -> Optional[date]:
    m = list(re.finditer(pattern, text, re.IGNORECASE))
    return _date(m[-1]) if m else None


def from_text(text: str) -> Optional[StatementBalance]:
    if not text:
        return None

    # Comdirect: erster Abschnitt ist das Girokonto
    m = re.search(rf"Neuer\s*Saldo\s+{_DATE}\s+({_NUM})", text, re.IGNORECASE)
    if m:
        return StatementBalance(_date(m), _amount(m.group(4)))

    # UBS (Kontoauszug und PDF-Export der Kontobewegungen). Exporte ohne
    # Saldo-Spalte nennen nur oben «<Konto> CHF<Betrag> … Aktueller Saldo».
    m = (re.search(rf"Schlusssaldo\s+({_NUM})(?!\s*[€$£])", text)
         or re.search(rf"(?:CHF|EUR|USD)\s?({_NUM})\s*\n[^\n]*Aktueller\s+Saldo", text))
    if m and "UBS" in text:
        when = (_last_date(text, rf"Erstellt\s+am\s+{_DATE}")
                or _last_date(text, rf"\bbis\s+{_DATE}"))
        if when:
            return StatementBalance(when, _amount(m.group(1)))

    # N26: Hauptkonto zuerst, Spaces folgen
    m = re.search(rf"(?:Your new balance|Dein neuer Kontostand|Neuer Kontostand)\s+({_NUM})\s*(€|EUR)?",
                  text, re.IGNORECASE)
    if m:
        period = re.search(rf"{_DATE}\s+(?:until|bis)\s+{_DATE}", text, re.IGNORECASE)
        if period:
            return StatementBalance(_date(period, 4), _amount(m.group(1)), "EUR")

    # Revolut: «Gesamt <Eröffnung> <Ausgang> <Eingang> <Schluss>» je Währung
    m = re.search(rf"^Gesamt\s+(?:{_NUM}\s*[€$£]?\s*(?:CHF|EUR|USD)?\s+){{3}}({_NUM})\s*([€$£]|CHF|EUR|USD)?",
                  text, re.IGNORECASE | re.MULTILINE)
    if m and "Revolut" in text:
        when = (_last_date(text, rf"Generiert\s+am\s+{_DATE}")
                or _last_date(text, rf"Generated\s+on\s+{_DATE}"))
        if when:
            return StatementBalance(when, _amount(m.group(1)), _CURRENCY_SIGNS.get((m.group(2) or "").strip()))
    return None


def from_rows(rows: Iterable[dict]) -> List[StatementBalance]:
    """CSV mit Saldo-Spalte: je Währung der Saldo der jüngsten Buchung. Bei
    mehreren Buchungen am letzten Tag zählt die zuletzt gebuchte; ob die Datei
    auf- oder absteigend sortiert ist, zeigt der Vergleich von erster und
    letzter Zeile."""
    rows = [r for r in rows if r.get("balance") is not None and r.get("date") is not None]
    if not rows:
        return []
    day = lambda r: r["date"].date() if isinstance(r["date"], datetime) else r["date"]  # noqa: E731
    if day(rows[0]) > day(rows[-1]):  # neueste zuerst
        rows = rows[::-1]
    latest: dict = {}
    for r in rows:
        latest[r.get("balance_currency")] = StatementBalance(day(r), float(r["balance"]), r.get("balance_currency"))
    return list(latest.values())


def apply(account: Account, sb: Optional[StatementBalance], rates: dict) -> bool:
    """Übernimmt den Saldo, wenn der Auszug nicht älter ist als der bisher
    übernommene derselben Währung. Je Währung wird ein Stand gehalten
    (`statement_balances`, z. B. die Währungstaschen bei Revolut, die je einen
    eigenen Auszug haben); `balance` ist ihre Summe in der Kontowährung zum
    heutigen Kurs. True, wenn übernommen."""
    if sb is None:
        return False
    target = (account.currency or "CHF").upper()
    key = (sb.currency or target).upper()
    parts = dict(account.statement_balances or {})
    if key in parts and sb.date.isoformat() < parts[key]["date"]:
        return False
    parts[key] = {"date": sb.date.isoformat(), "amount": round(sb.amount, 2)}
    account.statement_balances = parts
    account.balance = round(
        sum(convert_with_eur_rates(rates, p["amount"], cur, target) for cur, p in parts.items()), 2
    )
    account.balance_date = max(date.fromisoformat(p["date"]) for p in parts.values())
    return True
