# Budget-Pal — Project Context Document

## Overview

Budget-Pal is a personal financial planning web application designed for Swiss residents and expats. It combines transaction management, bank import, AI-based categorization, Swiss pension system integration, and long-term financial projections with Monte Carlo simulations. The app is self-hosted and multi-user, running on Docker.

---

## Goals

- Replace spreadsheet-based budgeting with a structured, visual application
- Automate transaction import from Swiss and German banks
- Provide accurate long-term financial projections factoring in the Swiss 3-pillar pension system
- Give visibility into cash flow via Sankey diagrams
- Support multiple users (family / household members sharing an instance)
- Run entirely self-hosted (Strato VPS + local NAS)

---

## Tech Stack & Rationale

### Frontend
- **React 18 + TypeScript + Vite** — Fast build, modern DX, type safety
- **Tailwind CSS** — Utility-first, consistent with portfolio-tracker design system
- **shadcn/ui** — Headless accessible components (Radix UI based)
- **@nivo** — Rich data visualization (Sankey, bar, line, heatmap, treemap)
- **recharts** — Monte Carlo fan charts (area stacking with gradients)
- **react-router-dom v6** — SPA routing with protected routes
- **@tanstack/react-query** — Server state management, caching, refetching
- **react-hook-form + zod** — Form validation with schema inference
- **lucide-react** — Consistent icon set

### Backend
- **Python FastAPI** — Async, OpenAPI auto-docs, fast iteration
- **SQLAlchemy 2.0 (async)** — ORM with async session support
- **Alembic** — Database migrations
- **PostgreSQL 15** — Robust JSONB support for scenario parameters, array fields for labels
- **python-jose[cryptography]** — JWT token generation/verification
- **passlib[bcrypt]** — Secure password hashing
- **pdfplumber + easyocr** — PDF bank statement extraction (digital + scanned)
- **sentence-transformers** — Local AI categorization via semantic embeddings
- **rapidfuzz** — Fast fuzzy merchant name matching
- **openai** — Optional fallback for hard-to-categorize transactions
- **pandas + numpy + scipy** — Data manipulation and Monte Carlo simulations
- **numpy-financial** — Financial projection formulas (NPV, PMT, FV)
- **mt940** — Parse MT940 SWIFT format (UBS/PostFinance exports)

### Infrastructure
- **Docker + docker-compose** — All services containerized
- **nginx** — Reverse proxy + static file serving + gzip + security headers
- **PostgreSQL 15 Docker image** — With persistent volume

---

## Feature List

### Core Features
- [x] Multi-user with JWT authentication (register/login/profile)
- [x] Account management (checking, savings, investment accounts)
- [x] Manual transaction entry
- [x] Bank CSV import (UBS, N26, Revolut, comdirect)
- [x] PDF/OCR bank statement import (pdfplumber + easyocr)
- [x] AI transaction categorization (local + OpenAI fallback)
- [x] Category and label management
- [x] Budget planning (monthly/annual per category)
- [x] Dashboard with net worth, income/expense summary
- [x] Sankey cash flow diagram
- [x] Monthly/yearly transaction analytics
- [x] Long-term financial projections (1yr, 5yr, 10yr, to retirement, to age 90)
- [x] Monte Carlo simulation (10,000 runs)
- [x] Swiss AHV/BVG/3a pension projection
- [x] Scenario comparison (what-if analysis)
- [x] Import history and log
- [x] Duplicate detection (import hash)
- [x] Dark theme matching portfolio-tracker

### Planned / Future
- [ ] Recurring transaction detection
- [ ] Email/push budget alerts
- [ ] Tax report export (Steuererklärung helper)
- [ ] EBICS integration (direct bank connection)
- [ ] FinTools integration with portfolio-tracker
- [ ] Mobile PWA
- [ ] Multi-currency net worth dashboard
- [ ] Real estate equity tracking

---

## Swiss Financial Context

### Currency
- Primary currency: CHF (Swiss Franc)
- Multi-currency support for N26/Revolut EUR/USD transactions
- Exchange rate API (optional): exchange-rate.host or ECB

### Swiss 3-Pillar Pension System

#### Pillar 1 — AHV (Alters- und Hinterlassenenversicherung)
- State pension, mandatory for all residents
- Funded by payroll contributions: 8.7% employee + 8.7% employer (shared, but net = ~8.7% of gross)
- Maximum monthly pension (2024): **CHF 2,520** (full 44 contribution years)
- Minimum monthly pension: CHF 1,260
- Qualifying: 1 contribution year = 1/44th of full pension
- Pensionable age: Men 65, Women 65 (from 2025 AHV21 reform)
- Deferred pension bonus: +6.8% per year deferred (up to 5 years)
- Early retirement reduction: -6.8% per year early

#### Pillar 2 — BVG (Berufliche Vorsorge / Pensionskasse)
- Occupational pension, mandatory for employees earning >CHF 22,050/yr
- Coordination deduction: CHF 25,725 (2024)
- Insured salary = gross salary - coordination deduction
- Age-based contribution rates:
  - Age 25–34: 7% (employee + employer, each)
  - Age 35–44: 10%
  - Age 45–54: 15%
  - Age 55–65: 18%
- Minimum interest rate on savings: 1.00% (2024, Federal Council sets annually)
- **Conversion rate (Umwandlungssatz): 6.8%** (minimum, often higher in practice)
- Pension = BVG capital at retirement × 6.8%
- Capital withdrawal option: up to 100% as lump sum (WEF Vorbezug for property)

#### Pillar 3a — Private Retirement Savings (Gebundene Vorsorge)
- Voluntary, tax-deductible
- Annual contribution cap (employees with Pillar 2): **CHF 7,056** (2024)
- Annual contribution cap (self-employed without Pillar 2): CHF 35,280 (20% of net income)
- Tax deduction: from cantonal income tax
- Withdrawal conditions: retirement, emigration, self-employment, buying primary residence, disability
- Typical interest rate (bank): 0.5–1.5%
- Typical return (fund/ETF-based 3a): 4–7% p.a.

#### Pillar 3b — Free Savings
- No tax deduction, no restrictions on withdrawal
- Includes regular savings accounts, investments, life insurance
- Tracked as "Assets" in Budget-Pal

---

## Bank CSV Format Details

### UBS (Switzerland)
- **Encoding**: ISO-8859-1 (Latin-1)
- **Delimiter**: Semicolon (`;`)
- **Date format**: `DD.MM.YYYY`
- **Decimal**: Period (`.`)
- **Headers** (line varies — skip lines until "Valuta" or "Buchungsdatum" found):
  - `Valuta;Buchungsdatum;Buchungstext;Belastung;Gutschrift;Saldo`
- Notes: Separate debit (Belastung) and credit (Gutschrift) columns
- Encoding hint: First line may contain account info text

### N26 (Germany / EU)
- **Encoding**: UTF-8 with BOM
- **Delimiter**: Comma (`,`)
- **Date format**: `YYYY-MM-DD`
- **Decimal**: Period (`.`)
- **Headers**: `"Date","Payee","Account number","Transaction type","Payment reference","Amount (EUR)","Amount (Foreign Currency)","Type Foreign Currency","Exchange Rate"`
- Notes: Negative = debit, positive = credit. Foreign currency columns may be empty.

### Revolut
- **Encoding**: UTF-8
- **Delimiter**: Comma (`,`)
- **Date format**: `YYYY-MM-DD HH:MM:SS` (Started Date)
- **Headers**: `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance`
- Notes: Filter `State == "COMPLETED"` only. Fee column separate. Multiple currencies.

### comdirect (Germany)
- **Encoding**: Windows-1252
- **Delimiter**: Semicolon (`;`)
- **Date format**: `DD.MM.YYYY`
- **Decimal**: German format (`1.234,56`)
- **Headers**: `"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR"`
- Notes: Buchungstext is a large concatenated field containing payee + purpose + BIC/IBAN. Needs regex parsing.

### MT940 (UBS / PostFinance SWIFT format)
- Standard SWIFT format, parseable with `mt940` Python library
- Balance line `:60F:` — opening balance
- Transaction lines `:61:` + `:86:` — date, amount, description

---

## Architecture Decisions

### Async-First Backend
- FastAPI with `async def` route handlers
- SQLAlchemy 2.0 async sessions (asyncpg driver)
- Background tasks via FastAPI `BackgroundTasks` for import processing

### Import Pipeline
1. Upload file → detect bank format (by header fingerprint)
2. Parse to normalized `NormalizedTransaction` schema
3. Deduplicate by SHA-256 hash of (account_id + date + amount + description)
4. Run categorization pipeline
5. Store to DB, return preview
6. Log import result to `ImportLog`

### Categorization Pipeline
1. Check manual override cache (exact description match)
2. Rule-based keyword matching (MERCHANT_RULES dict)
3. Fuzzy matching with rapidfuzz (threshold ≥ 85)
4. Sentence-transformer embedding similarity (local model: `all-MiniLM-L6-v2`)
5. OpenAI GPT-4o-mini fallback (if confidence < 0.5 and API key configured)
6. Return: `(category, subcategory, merchant_normalized, confidence_score)`

### Projection Engine
- Monte Carlo: 10,000 runs, parameterized by (mean_return, std_dev, inflation_rate)
- Returns percentile bands: p10, p25, p50, p75, p90
- AHV calculation: based on contribution years and average insured income
- BVG calculation: current capital + projected contributions × age bracket rates
- 3a: compound growth with annual cap
- All projections in real (inflation-adjusted) CHF
- Results cached in `ProjectionCache` with 24h TTL

### Security
- bcrypt password hashing (12 rounds)
- HS256 JWT tokens (30 min access token)
- All endpoints require `Authorization: Bearer <token>`
- CORS limited to known domains in production

---

## Deployment

### Strato VPS (Production)
- Domain: `budgetpal.doebele12.de`
- SSL: Let's Encrypt via certbot/traefik
- Docker Compose on single VPS
- Nginx in container handles static + proxy
- External traefik may front the whole stack
- Ports: Backend :8010, Frontend :8011 (configurable via .env)

### Local NAS (Development / Backup)
- Synology NAS running Docker
- Same docker-compose, different .env
- Access via local IP or Tailscale VPN
- Postgres backups via `make backup` → `/data/backups/`

### CI/CD (Future)
- GitHub Actions → Docker build → SSH deploy to Strato

---

## Visualization Types

| Chart | Library | Usage |
|-------|---------|-------|
| Sankey | @nivo/sankey | Cash flow: income → categories → savings |
| Line + Area | recharts | Monte Carlo fan (percentile bands) |
| Stacked Area | recharts | Pension pillars over time |
| Bar (grouped) | @nivo/bar | Monthly income vs expense |
| Waterfall | recharts | Month-over-month net change |
| Heatmap | @nivo/heatmap | Spending by category × month |
| Treemap | @nivo/treemap | Spending breakdown by category |
| Radial/Donut | recharts | Category distribution |
| Scatter | recharts | Projection scenario comparison |

---

## Color Theme & Design System

Identical to portfolio-tracker. All values in Tailwind extended theme:

```
bg:           #0d0e12   (main background)
surface:      #13141a   (card/panel background)
surface2:     #1a1b23   (elevated surface)
border:       rgba(255,255,255,0.13)
text-primary: #f0f1f5
text-secondary:#b4bfcc
text-tertiary: #8896a8
accent:       #3b82f6   (blue, CTA, links)
accent-light: #60a5fa
gain:         #4ade80   (green, positive amounts)
loss:         #f87171   (red, negative amounts)
warning:      #fbbf24   (amber)
```

Fonts:
- UI / Labels: **Syne** (Google Fonts)
- Numbers / Mono: **JetBrains Mono** (Google Fonts)
- Display / Hero: **DM Serif Display** (Google Fonts)

---

## Database Schema Overview

```
users                    → auth + profile
accounts                 → bank accounts per user
transactions             → all financial transactions
categories               → hierarchical categories (system + user)
labels                   → free-form tags
transaction_labels       → M:N join table
budgets                  → monthly/annual budget targets
pension_data             → pillar 1/2/3a records per user
assets                   → property, stocks, crypto, other
scenarios                → saved projection parameters
projection_cache         → cached MC results (24h TTL)
import_logs              → audit trail for imports
```

---

## API Structure

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/me
PUT    /api/auth/me

GET    /api/accounts
POST   /api/accounts
PUT    /api/accounts/{id}
DELETE /api/accounts/{id}

GET    /api/transactions          ?start=&end=&category=&account=&label=&q=
POST   /api/transactions
PUT    /api/transactions/{id}
DELETE /api/transactions/{id}
POST   /api/transactions/bulk-categorize
GET    /api/transactions/stats
GET    /api/transactions/monthly-summary

POST   /api/imports/csv
POST   /api/imports/pdf
GET    /api/imports/history
GET    /api/imports/{id}/preview

GET    /api/projections/scenarios
POST   /api/projections/scenarios
PUT    /api/projections/scenarios/{id}
DELETE /api/projections/scenarios/{id}
POST   /api/projections/run

GET    /api/categories
POST   /api/categories
PUT    /api/categories/{id}
DELETE /api/categories/{id}

GET    /api/budgets
POST   /api/budgets
PUT    /api/budgets/{id}

GET    /api/pension
POST   /api/pension
PUT    /api/pension/{id}
DELETE /api/pension/{id}

GET    /api/assets
POST   /api/assets
PUT    /api/assets/{id}
DELETE /api/assets/{id}

GET    /api/health
```

---

## Integration with Portfolio-Tracker (FinTools)

Budget-Pal and portfolio-tracker are sibling projects under `~/projects/`, designed to eventually form a unified "FinTools" suite:

- **Shared design system**: Same Tailwind colors, fonts, card styles
- **Shared auth** (future): Single sign-on across both apps
- **Net worth sync** (future): Portfolio-tracker asset values feed into Budget-Pal net worth
- **Navigation link**: Budget-Pal sidebar links to portfolio-tracker URL
- **API cross-reference** (future): Budget-Pal calls portfolio-tracker API for current investment values

---

## Future Roadmap

### v1.0 (MVP)
- Auth + accounts + manual transactions
- CSV import for all 4 banks
- Rule-based categorization
- Dashboard + Sankey
- Basic projections

### v1.5
- PDF OCR import
- AI categorization (sentence-transformers)
- Monte Carlo fan chart
- Swiss pension calculator
- Budget tracking

### v2.0
- Scenario comparison
- OpenAI fallback categorization
- Tax report export (simplified)
- Email alerts
- Portfolio-tracker integration

### v3.0
- EBICS direct bank connection
- Mobile PWA
- Multi-household support
- Advanced tax optimization (3a timing)
