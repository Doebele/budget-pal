# Budget-Pal

**Persönliche Finanzplanung — Schweizer Kontext, KI-Kategorisierung, Monte Carlo Simulationen**

*Personal Finance Planning — Swiss context, AI categorization, Monte Carlo projections*

---

## Überblick / Overview

Budget-Pal ist eine selbst gehostete Webanwendung zur persönlichen Finanzplanung.
Sie kombiniert Transaktionsverwaltung, Bankimport, KI-Kategorisierung, langfristige
Finanzprognosen und das Schweizer 3-Säulen-Rentensystem.

*Budget-Pal is a self-hosted personal finance planning application. It combines transaction management,
bank import, AI categorization, long-term financial projections, and the Swiss 3-pillar pension system.*

---

## Features

### Import
- **CSV-Import**: UBS, N26, Revolut, comdirect (automatische Formaterkennung)
- **PDF-Import**: OCR-Extraktion mit pdfplumber + EasyOCR (inkl. N26 PDF)
- Duplikaterkennung (SHA-256 Hash)
- Import-Historie und Protokoll

### KI-Kategorisierung (5-stufige Pipeline)
1. Manueller Kategorie-Cache (vorherige Entscheidungen)
2. Regelbasiertes Keyword-Matching (50+ Schweizer/Deutsche Händler)
3. Fuzzy-Matching mit RapidFuzz
4. Sentence-Transformer Embedding-Klassifizierung (lokal, `all-MiniLM-L6-v2`)
5. OpenAI GPT-4o-mini Fallback (optional, wenn API-Key gesetzt)

### Kategorie-Taxonomie
- 11 Superkategorien: Wohnen, Essen, Mobilität, Versicherungen, Freizeit, Abos, Shopping, Bildung, Steuern, Sparen, Sonstiges
- Zentrale Definition in `shared/taxonomy.json` (txnCategories, wizardLabels, legacyAliases)
- Per-User Anpassungen: Labels ausblenden, eigene Labels hinzufügen (Settings)
- Kategorienverwaltung: Migrierung von Transaktionen beim Ausblenden eines Labels

### Budgetplanung
- Monatsbudget pro Superkategorie
- **Budgetplan**: Jahresübersicht wiederkehrender Einträge über 12 Monate (Kalender- und Listenansicht)
- Wiederkehrende Einnahmen/Ausgaben (monatlich, quartalsweise, jährlich, ...)

### Prognosen
- **Monte Carlo Simulation** (10.000 Durchläufe), Perzentilbänder (p10, p25, p50, p75, p90)
- **Schweizer Rentenberechnung**:
  - AHV (Säule 1): Beitragsjahre, Durchschnittseinkommen, max. CHF 2'520/Monat
  - BVG/Pensionskasse (Säule 2): Umwandlungssatz 6.8%, Altersklassen
  - Säule 3a: Zinseszins, max. CHF 7'056/Jahr steuerlich abzugsfähig
- Inflationsbereinigung (Standard: 1.5% CHF)
- Szenario-Vergleich (Was-wäre-wenn-Analysen)

### Visualisierungen
- **Sankey-Diagramm**: Cashflow — Einnahmen → Superkategorien → Sparen (real & empirisch)
- **Monte Carlo Fan-Chart**: Recharts AreaChart mit Perzentilbändern
- **Finanzplan**: Gestapeltes Flächendiagramm (Rentenentwicklung 3 Säulen)
- Budget-Statusbalken pro Kategorie
- Monatsübersicht Einnahmen vs. Ausgaben

### Referenzwährung
- Wahl zwischen CHF, EUR, USD in den Einstellungen
- Live-Wechselkursabruf (ECB / fixer.io Fallback)
- Alle Berechnungen und Anzeigen umgerechnet

### Authentifizierung
- Multi-User mit JWT (python-jose, bcrypt)
- Registrierung und Login

---

## Quick Start (Docker)

### Voraussetzungen / Prerequisites
- Docker >= 24.0
- Docker Compose >= 2.0

### Einrichtung / Setup

```bash
# 1. Repository klonen
git clone <repo-url> budget-pal
cd budget-pal

# 2. Environment konfigurieren
cp .env.example .env
# .env mit eigenem Editor bearbeiten — mindestens setzen:
#   POSTGRES_PASSWORD, JWT_SECRET_KEY

# 3. Starten (baut alle Images aus dem Repo-Root)
docker compose up -d --build

# 4. Öffnen
# Frontend: http://localhost:8011
# Backend API-Docs: http://localhost:8010/api/docs
```

### Wichtige Umgebungsvariablen / Key Environment Variables

```env
# Pflichtfelder / Required
POSTGRES_PASSWORD=sicheres_passwort_hier
JWT_SECRET_KEY=64_zeichen_hex_string_hier  # openssl rand -hex 32

# Optional
OPENAI_API_KEY=sk-...        # für KI-Fallback Kategorisierung
MISTRAL_API_KEY=...          # alternatives KI-Modell
BACKEND_PORT=8010            # Standard-Port Backend
FRONTEND_PORT=8011           # Standard-Port Frontend
AUTO_CREATE_SCHEMA=false     # true = DB ohne Alembic beim ersten Start
```

---

## Entwicklung / Development

```bash
# Backend lokal (ohne Docker)
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Frontend lokal
cd frontend
npm install
npm run dev    # Vite Dev-Server auf :5173 mit Proxy zu :8000

# Logs streamen
make logs
make logs-backend
```

---

## Deployment auf Strato (Produktion)

```bash
# 1. SSH auf Strato VPS
ssh user@strato-vps-ip

# 2. Repository klonen
git clone <repo-url> /opt/budget-pal
cd /opt/budget-pal

# 3. .env konfigurieren
cp .env.example .env
nano .env
# ENVIRONMENT=production
# ALLOWED_ORIGINS=https://budgetpal.doebele12.de
# STRATO_DOMAIN=budgetpal.doebele12.de
# starke Passwörter für POSTGRES_PASSWORD und JWT_SECRET_KEY

# 4. Starten
docker compose up -d --build

# 5. Updates
git pull
docker compose build
docker compose up -d
```

### Nginx Reverse Proxy Beispiel (Host-Ebene)

```nginx
server {
    listen 443 ssl;
    server_name budgetpal.doebele12.de;

    ssl_certificate /etc/letsencrypt/live/budgetpal.doebele12.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/budgetpal.doebele12.de/privkey.pem;

    location / {
        proxy_pass http://localhost:8011;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen 80;
    server_name budgetpal.doebele12.de;
    return 301 https://$host$request_uri;
}
```

---

## Lokales NAS Deployment (Synology / QNAP)

```bash
# Per SSH auf NAS verbinden
ssh admin@nas-ip

# Repository klonen
git clone <repo-url> /volume1/docker/budget-pal
cd /volume1/docker/budget-pal

# .env anpassen
cp .env.example .env
# FRONTEND_PORT=8011
# BACKEND_PORT=8010

# Starten
docker compose up -d --build

# Zugriff: http://nas-ip:8011
```

---

## Architektur / Architecture

```
budget-pal/
├── backend/                    # Python FastAPI
│   ├── app/
│   │   ├── main.py             # FastAPI App Entry Point + startup migrations
│   │   ├── core/
│   │   │   ├── config.py       # Pydantic Settings
│   │   │   ├── database.py     # SQLAlchemy async engine
│   │   │   ├── security.py     # JWT + bcrypt
│   │   │   └── taxonomy.py     # Taxonomy-Lookups, WIZARD_TO_TXN Mapping
│   │   ├── models/
│   │   │   └── models.py       # ORM Models (User, Transaction, RecurringPlan, ...)
│   │   ├── api/
│   │   │   ├── auth.py         # POST /auth/register, /login, /me
│   │   │   ├── transactions.py # CRUD + stats
│   │   │   ├── imports.py      # CSV/PDF import
│   │   │   ├── projections.py  # Monte Carlo scenarios
│   │   │   ├── recurring_plan.py # Budgetplan CRUD
│   │   │   ├── taxonomy.py     # Taxonomy + per-User Label-Hiding
│   │   │   ├── wizard.py       # Empirisches Finanzprofil
│   │   │   ├── currency.py     # Wechselkurse
│   │   │   └── settings.py     # User-Einstellungen
│   │   └── services/
│   │       ├── categorization.py     # 5-stage AI pipeline
│   │       ├── projection.py         # Monte Carlo + AHV/BVG
│   │       ├── peer_group_seed.py    # System-Kategorie Seeding + Migrationen
│   │       └── import_parsers/       # UBS, N26, Revolut, comdirect
│   ├── Dockerfile
│   └── requirements.txt
│
├── frontend/                   # React 18 + TypeScript + Vite
│   ├── src/
│   │   ├── App.tsx             # Routes
│   │   ├── lib/
│   │   │   ├── api.ts          # Axios + JWT interceptor + alle API-Calls
│   │   │   ├── auth.tsx        # Auth Context
│   │   │   └── categories.ts   # useTaxonomy(), SuperCategory Typen, Lookups
│   │   └── pages/
│   │       ├── Dashboard.tsx   # Sankey, Top-Kategorien, Letzte Transaktionen
│   │       ├── Transactions.tsx
│   │       ├── Import.tsx
│   │       ├── Budget.tsx
│   │       ├── Budgetplan.tsx  # Jahresübersicht wiederkehrender Einträge
│   │       ├── Finanzplan.tsx  # Langfristprognose + Rentensäulen
│   │       ├── Projections.tsx # Monte Carlo Fan-Chart
│   │       ├── Forecast.tsx
│   │       ├── Wizard.tsx      # Empirisches Finanzprofil
│   │       ├── Accounts.tsx
│   │       └── Settings.tsx    # Einstellungen inkl. Kategorie-Taxonomie
│   ├── nginx.conf
│   ├── Dockerfile
│   └── package.json
│
├── shared/
│   └── taxonomy.json           # Zentrale Superkategorie-Definition
│
├── docker-compose.yml          # Build-Kontext: Repo-Root für alle Services
├── .env.example
├── Makefile
├── context.md                  # Änderungsprotokoll
└── README.md
```

---

## Schweizer Rentenrechner

| Säule | Typ | Max. 2024 | Beitrag |
|-------|-----|-----------|---------|
| AHV (1) | Staatlich | CHF 2'520/Monat | Pflicht, Lohnprozente |
| BVG (2) | Berufsvorsorge | Kapital × 6.8% | Pflicht ab CHF 22'050 |
| 3a | Privat gebunden | CHF 7'056/Jahr | Freiwillig, steuerfrei |
| 3b | Privat frei | Unbegrenzt | Freiwillig |

---

## Integration mit portfolio-tracker (FinTools)

Budget-Pal und portfolio-tracker sind Schwester-Projekte unter `~/projects/` und bilden
gemeinsam die **FinTools**-Suite:

- **Gleiches Design-System**: identische Tailwind-Farben, Schriften, Card-Styles
- **Gemeinsame Auth** (geplant): Single Sign-On
- **Nettovermögen-Sync** (geplant): Portfolio-Tracker Werte fließen in Budget-Pal ein

---

## Lizenz / License

Privates Projekt — nicht zur öffentlichen Verbreitung bestimmt.

*Private project — not intended for public distribution.*

---

*Entwickelt von Claus Medvesek · budgetpal.doebele12.de*
