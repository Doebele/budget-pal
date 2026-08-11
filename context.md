# Budget-Pal — Context Documentation

Laufendes Änderungsprotokoll aller bedeutenden Erweiterungen und Bugfixes.

---

## Neueste Änderungen (August 2026)

### Wizard — Hypothekarzins, Jahresprämien, Gauge-Theming ([PR #9](https://github.com/Doebele/budget-pal/pull/9))

**`backend/app/services/wizard_derive.py`** (neu)
- Zentrale Ableitungen aus den Wizard-Rohdaten, vorher an vier Stellen separat (teils inkonsistent) berechnet:
  - `mortgage_interest_monthly()` / `mortgage_tranches_from_wizard()` — Hypothekarzins aus den Tranchen (Schritt 6), fällt auf die Einzelhypothek zurück wenn keine Tranchen erfasst sind
  - `monthly_amount()` — Jahres- auf Monatsbeträge umrechnen (z.B. jährliche Autoversicherung)
  - `health_insurance_monthly()` — Haushaltsprämie: Summe individueller Personen-Prämien oder direkter Haushaltstotal, je nach Modus
- Genutzt von `wizard.py` (`/wizard/complete`), `recurring_plan.py` (`/recurring-plan/suggestions`) und `budget_multimodal.py` (`/budget/multi-analysis`)

**`backend/app/api/wizard.py`**
- Wohneigentum-Budget berücksichtigt jetzt Nebenkosten und Hypothekarzins zusätzlich zur Amortisation (vorher fehlten beide komplett)
- `WizardCompletePayload`: `health_insurance_mode` ("person" | "total"), `health_insurance_premiums: List[float]` (ersetzt den reinen Pro-Kopf-Betrag), `autoversicherung_period` ("monat" | "jahr")
- Bugfix: Nebenkosten-Budget-Vermerk von `"Nebenkosten (Strom/Heizung)"` auf `"Nebenkosten"` gekürzt — die längere Variante matchte keinen Taxonomy-Schlüssel und landete unter "Sonstiges" statt "Wohnen"

**`frontend/src/pages/Wizard.tsx`**
- Krankenkasse: Umschalter "Pro Person" (Liste mit Hinzufügen/Entfernen individueller Prämien) vs. "Total Haushalt"
- Autoversicherung: Umschalter "pro Monat" / "pro Jahr" mit Live-Umrechnung
- Wohneigentum: Nebenkosten-Feld ergänzt, Hypothekarzins wird live aus den Tranchen berechnet und angezeigt
- Alle Auswahlfelder (Wohnsituation, Krankenkassen-Erfassung, Franchise, Autoversicherung-Periode, Haushalt, Beschäftigungsstatus) auf `Segmented`-Toggle-Komponente umgestellt — gleiche Optik wie die Rail-Umschalter (Sprache/Dichte), nur grösser; Beschäftigungsstatus hat neu Iconoir-Icons (`Suitcase`, `Laptop`, `Shuffle`, `Sofa`)

**`frontend/src/index.css`**
- `.seg-row` / `.seg-btn` — wiederverwendbare Segmented-Toggle-Klassen im Rail-Stil, `flex-wrap` statt Textabschneidung auf schmalen Viewports

**`frontend/src/components/charts/CategoryGaugeChart.tsx`**
- Bugfix: leerer Ring-Track war als dunkler Hex-Wert (`#1a1b23`) hartkodiert und blieb im Lightmode schwarz — folgt jetzt `colors.bgElevated` aus der Theme-Palette

**`frontend/src/components/charts/BudgetStackedBarChart.tsx`**
- `wizardToMonthly()` an dieselbe Hypothekarzins-/Jahresprämien-/Krankenkassen-Logik angeglichen wie die Backend-Ableitungen

---

## Frühere Änderungen (April 2026)

### Taxonomy-System — Komplettüberarbeitung

**`shared/taxonomy.json`**
- Säule 3A von Superkategorie *Steuern* zu *Sparen* verschoben (txnCategories + wizardLabels)
- Einheitliches Label "ÖV-Kosten" für alle öv-/ÖV-Varianten

**`backend/app/api/taxonomy.py`** — neue Endpunkte
- `GET /api/taxonomy` — liefert per-User gefilterte Taxonomy (ausgeblendete Labels entfernt)
- `GET /api/taxonomy/hidden-labels` — gibt ausgeblendete Labels des Users zurück
- `POST /api/taxonomy/hide-canonical-label` — Label ausblenden `{ sc_id, label, label_type }`
- `DELETE /api/taxonomy/hide-canonical-label` — Label wieder einblenden

**`backend/app/models/models.py`**
- Neues Feld `taxonomy_hidden_json: Text` auf `User`-Model (JSON-Blob: ausgeblendete Labels pro Superkategorie)

**`backend/app/main.py`**
- DB-Migration beim Start: `ALTER TABLE users ADD COLUMN IF NOT EXISTS taxonomy_hidden_json TEXT`

**`backend/app/services/peer_group_seed.py`**
- Slug-Migrationen: `einnahmen-saeule-3a` und `steuern-saeule-3a` → `sparen-saeule-3a`
- `abo-oev` Name normalisiert zu "ÖV-Kosten"

**`backend/app/services/categorization.py`**
- EN→DE Mapping erweitert: `dividend`, `dividends`, `interest`, `refund`, `bonus`

**`backend/app/core/taxonomy.py`**
- `DEFAULT_WIZARD_TO_TXN` ergänzt: `säule 3a einzahlung`, `pillar 3a`, `3. säule` → "Säule 3A"

**`frontend/src/pages/Settings.tsx`**
- Neue Sektion "Kategorie Taxonomie" mit erweiterbaren Superkategorie-Panels
- Txn-Labels und Wizard-Labels einzeln ausblend-/löschbar (mit Migrations-Dialog)
- Ausgeblendete Labels in eigener Sektion sichtbar + wiederherstellbar
- Neue Labels hinzufügbar über Inline-Input

**`frontend/src/lib/api.ts`** — `taxonomyApi` erweitert
- `getHiddenLabels()`, `hideCanonicalLabel()`, `unhideCanonicalLabel()`

---

### Docker Build — Kritischer Fix

**`backend/Dockerfile`**
- Build-Kontext auf Repo-Root umgestellt (`context: .`)
- COPY-Pfade korrigiert: `backend/app/`, `backend/alembic/`, `shared/taxonomy.json`
- `shared/` in `mkdir` und `chown` aufgenommen damit `taxonomy.json` erreichbar ist

**`docker-compose.yml`**
- Backend Build-Kontext: `context: ./backend` → `context: .`, `dockerfile: backend/Dockerfile`

---

### Dashboard-Crash — Bugfix

**`frontend/src/lib/categories.ts`**
- `useTaxonomySuperCategories`: gibt nie leeres Array zurück — `BUNDLED_SUPER_CATEGORIES` als Fallback wenn API `[]` liefert
- `resolveSuperCategoryFromList`: gibt nie `undefined` zurück — BUNDLED-Fallback wenn Liste leer

**`frontend/src/pages/Dashboard.tsx`**
- Null-Guard für `resolveSuperCategory` im Transaktions-Mapping

**`frontend/src/pages/Finanzplan.tsx`**
- Null-Guard in `categoryGroups` useMemo verhindert Crash bei leerem Taxonomy-Snapshot

---

## Ältere Änderungen

### Referenzwährung (CHF / EUR / USD)

- Einstellungen: Dropdown zur Wahl der Anzeigewährung
- `backend/app/api/currency.py` — Wechselkursabruf (ECB / fixer.io Fallback)
- Alle Berechnungen und Anzeigen in Transaktionen, Dashboard, Prognose berücksichtigen Referenzwährung

### Budgetplan & Wiederkehrende Ausgaben

- **`backend/app/api/recurring_plan.py`** — vollständige CRUD-API für wiederkehrende Einträge
- **`frontend/src/pages/Budgetplan.tsx`** — Jahresübersicht über 12 Monate, Kalender- und Listenansicht
- Sparen-Kategorien korrekt als Einnahmen gewertet

### N26 PDF-Import

- **`backend/app/services/import_parsers/`** — neuer N26 PDF-Parser
- OCR-Pipeline: pdfplumber + EasyOCR

### Sankey-Diagramm

- Cashflow-Visualisierung: Einnahmen → Superkategorien → Sparen
- Reale Transaktionsdaten und empirische Wizard-Daten als Quellen wählbar

### Shared Taxonomy (`shared/taxonomy.json`)

- Zentrale Superkategorie-Definition für Backend und Frontend
- 11 Superkategorien: wohnen, essen, mobilitaet, versicherungen, freizeit, abos, shopping, bildung, steuern, sparen, sonstiges
- Felder: `id`, `label`, `emoji`, `color`, `txnCategories`, `wizardLabels`, `legacyAliases`

### Finanzplan (Monte Carlo)

- **`frontend/src/pages/Finanzplan.tsx`** — langfristige Finanzprognose
- Wizard-Budget-Einträge als Ausgangsbasis
- Säulen 1–3 Rentenprojektionen, Inflationsbereinigung

### Wizard (Empirisches Profil — Annahmen und Statistik)

- Schweizer Finanzprofil erfassen: Wohnen, Transport, Versicherungen, Abos, Sparen
- Daten fließen in Budgetplan und Prognosen ein

### Accounts (Konten)

- Soft-Delete-Implementierung (`is_deleted`, `deleted_at` Flags)
- Wizard überspringt synthetische Konten

---

## Architektur-Entscheidungen

| Bereich | Entscheidung |
|---------|-------------|
| Taxonomy | Zentrale JSON-Datei (`shared/taxonomy.json`), per-User Anpassungen via DB-Feld |
| Auth | JWT + bcrypt, kein OAuth |
| DB-Migrationen | Alembic für Schema-Versionen + startup `ALTER TABLE IF NOT EXISTS` für kleine Ergänzungen |
| State | React Query (Server), Context (Auth), kein Redux |
| KI-Kategorisierung | 5-stufige Pipeline: manueller Cache → Keywords → Fuzzy → Embeddings → GPT-4o-mini |
| Docker | Mono-Repo-Build: ein `docker-compose.yml` mit `context: .` für alle Services |
