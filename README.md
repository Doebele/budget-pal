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

## ✨ Neueste Updates / Latest Updates

**September 2026 — KI-Anbieter und Einstellungs-Backup**

- 🤖 **18 KI-Anbieter statt 7** — LM Studio und Ollama lokal, dazu Anthropic, OpenAI, Google,
  xAI, Meta, Mistral, DeepSeek, Qwen, Kimi, Z.AI, MiniMax, MiMo, StepFun und OpenRouter;
  dieselbe Liste wie im Schwesterprojekt FinTools
- 🗂️ **Ein Profil je Anbieter** — Endpunkt, Modell und Key bleiben beim Wechsel erhalten
- 🔌 **Verbindungstest** mit Modellliste live vom Anbieter und gemessener Antwortzeit
- 💾 **Einstellungs-Backup** — KI-Anbieter, Sprache und Session-Dauer wandern mit ins
  JSON-Backup; API-Keys nur auf ausdrücklichen Wunsch und mit Passwortbestätigung
- 🔒 **Key-Schutz** — gespeicherte Keys verlassen den Server nie im Klartext, und ein Key
  geht nur an den Endpunkt, mit dem er gespeichert wurde

**August 2026 — Onboarding, Szenarien und Plan-Ist-Abgleich**

- 🚪 **Drei Wege zum ersten Ergebnis** — statt eines achtstufigen Wizards vor dem Dashboard:
  Kontoauszug hochladen (gemessen), Budget selbst einschätzen (geschätzt, Kurzstrecke durch
  denselben Wizard) oder anonyme Beispieldaten laden (erfunden, 424 Buchungen über
  zwölf Monate, jederzeit spurlos entfernbar)
- ✅ **Bestätigungsschleife nach dem Import** — die zehn grössten *Händler* statt Buchungen;
  eine Bestätigung wirkt auf alle Buchungen dieses Händlers und auf jeden künftigen Import
- 📊 **Fortschritt statt Sperre** — das Dashboard zeigt, was schon geht, und benennt je
  Schritt, was der nächste freischaltet
- 🔀 **Szenarien wirken** — Sparplan, Frühpensionierung, Pflegekosten und Amortisation
  fliessen jetzt in die Monte-Carlo-Projektion ein (vorher waren es Schalter ohne Funktion)
- 🧾 **Plan-Ist-Abgleich im Budgetplan** — jede Fälligkeit trägt ihren Status
  (gebucht / abweichend / offen / überfällig), Jahresbilanz mit Vorjahresvergleich und
  kumuliertem Laufsaldo
- 🗂️ **Massenänderungen** — Mehrfachauswahl, Massen-Kategorisierung, Teuerungsaufschlag,
  alles über einen transaktionalen Batch-Endpunkt
- 📈 **Sparquote an der Vergleichsgruppe** — BFS-Werte nach Haushaltsform und
  Einkommensklasse statt einer festen Zielmarke
- ♿ **Barrierefreiheit** — Wizard-Schritte als echte Buttons (Tastatur, Fokusring,
  `aria-current`), Fortschrittsbalken mit `role="progressbar"`, Statusfarben zusätzlich
  durch Form unterscheidbar

**Juni 2026 — Neues Design-System & Mehrsprachigkeit**

- 🎨 **Light & Dark Mode** — vollständig token-basiertes Design-System (CSS-Variablen), umschaltbar pro Nutzer, inkl. theme-bewusster Charts (Recharts, ECharts)
- 🧭 **Rail-Navigation** — einklappbare Desktop-Seitenleiste (52/220px) mit Tooltips, portiert vom Schwesterprojekt application-pal; auf Mobile weiterhin Bottom-Navigation + Drawer
- 🗜️ **Density-Modi** — «Kompakt» (mehr Information) und «Komfort» (mehr Weissraum, sanfter UI-Zoom)
- 🌐 **Sprachwechsel Deutsch/Englisch** — react-i18next mit Persistenz in der Datenbank (`users.ui_language`, erweiterbar für weitere Sprachen); Zahlen- und Datumsformate folgen der Sprache bei Schweizer Konventionen (de-CH/en-CH)
- 🎯 **5 Akzentfarben** — Indigo, Violett, Smaragd, Bernstein, Rosé (live umschaltbar)
- 🖌️ **Iconoir-Icons** — komplette Icon-Migration von lucide-react auf iconoir-react (~106 Icons)
- 🔘 **Einheitliches Toggle-Muster** — alle Segment-Schalter (Zeitraum, Ansichten, Modi) im selben Akzent-Stil
- ⚙️ **Erscheinungsbild-Einstellungen** — Theme, Dichte, Sprache und Akzentfarbe zentral unter Einstellungen, synchron mit der Rail
- 🐳 **Docker-Build-Fix** — `frontend/package.json` enthält jetzt korrekt `round-flag-icons`; `vite.config.ts` referenziert im `manualChunks`-Bundle `iconoir-react` statt des entfernten `lucide-react` — `docker compose build` läuft wieder fehlerfrei durch

Alle Präferenzen (Theme/Dichte/Akzent lokal, Sprache zusätzlich serverseitig) bleiben über Sessions und Geräte hinweg erhalten.

---

## Begriffe / Terminology

Zwei Begriffe ziehen sich durch die ganze Anwendung und bedeuten **nicht**, was
der Alltagsgebrauch nahelegt:

| Oberfläche | Bedeutung |
|---|---|
| **Empirische Angaben** / *Empirical Data* | **Angenommene und statistische** Werte aus dem 8-stufigen Wizard, vorbelegt mit BFS-Vergleichswerten der Peer-Gruppe. Schätzungen und Planwerte — keine Messwerte. |
| **Reale Angaben** / *Actual Data* | **Gemessene** Werte: Transaktionen aus dem CSV-/PDF-Import echter Kontoauszüge. |

„Empirisch" steht hier also für *modelliert*, „real" für *beobachtet* — genau
umgekehrt zur üblichen Wortbedeutung von „empirisch".

---

## Features

### Oberfläche / UI
- **Rail-Navigation** (Desktop) mit Einklapp-Modus und Hover-Tooltips; Bottom-Nav + Drawer auf Mobile
- **Light/Dark Mode** mit token-basiertem Design-System (`data-theme`, `data-accent`, `data-density`)
- **Density-Modi** Kompakt/Komfort und 5 Akzentfarben
- **Zweisprachig DE/EN** mit DB-Persistenz der Sprachwahl pro Nutzer

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
5. Das in den Einstellungen gewählte KI-Modell (optional, siehe [KI-Anbieter](#ki-anbieter))

### KI-Anbieter

Das KI-Modell wählt jeder Nutzer unter **Einstellungen → KI-Modell**. Es dient der
PDF-Auswertung beim Import, der letzten Stufe der Kategorisierung und den Analysen.
Ohne Anbieter läuft alles weiter — nur die KI-Stufe entfällt.

| Art | Anbieter | Key |
|---|---|---|
| **Lokal** | LM Studio, Ollama | keiner |
| **Cloud** | Anthropic, OpenAI, Google (Gemini), xAI (Grok), Meta, Mistral, DeepSeek, Alibaba (Qwen), Kimi Platform, Kimi Code, Z.AI, BigModel, MiniMax, Xiaomi (MiMo), StepFun, OpenRouter | eigener API-Key |

- Anthropic spricht seine Messages-API, alle anderen die OpenAI-kompatible Schnittstelle.
  Ein neuer Anbieter ist ein Eintrag in `PROVIDER_CATALOG` (`backend/app/services/ai_client.py`).
- **Ein Profil je Anbieter** mit Endpunkt, Modell und Key. Beim Wechsel bleibt jedes erhalten;
  ein Key wird nie auf einen anderen Anbieter übertragen. In der Auswahl markiert ✓ einen
  getesteten Anbieter, 🔑 einen mit hinterlegtem Key.
- **Modellliste live** vom `/models`-Endpunkt des Anbieters, gefiltert auf Chat-Modelle.
- **Verbindung testen** prüft Endpunkt und Key und pingt das gewählte Modell an.
- `localhost` wird im Container automatisch zu `host.docker.internal` — LM Studio und Ollama
  laufen auf dem Host.
- Das **Kontextfenster** wird erkannt (lokal vom Server, Cloud aus dem Katalog) und bestimmt,
  wie viel Text pro Anfrage mitgeht; per Regler übersteuerbar.

**Umgang mit API-Keys**

- Gespeicherte Keys verlassen den Server nie im Klartext — die Oberfläche erfährt nur,
  *dass* einer hinterlegt ist.
- Ein gespeicherter Key geht **nur an den Endpunkt, mit dem er gespeichert wurde.** Wer den
  Endpunkt ändert, gibt den Key neu ein. Sonst könnte ein gestohlenes Session-Token den Key
  an einen fremden Server umlenken.
- Fehlermeldungen eines Anbieters werden nur als dessen `error.message` angezeigt, nie als
  Rohtext — der Endpunkt ist frei wählbar.
- Keys werden pro Nutzer in der Datenbank abgelegt, nicht in der `.env`.

**Nur öffentliche Endpunkte auf dem Server**

Die Registrierung ist offen, und den KI-Endpunkt ruft der Server selbst auf. Mit
`ENVIRONMENT=production` akzeptiert er deshalb nur `https`-Adressen, die auf eine öffentliche
IP zeigen — sonst könnte jeder Nutzer interne Dienste ansprechen (Datenbank, andere
Container, `127.0.0.1`). LM Studio und Ollama gehen dort nicht, dafür einen Cloud-Anbieter
wählen. Lokal (`ENVIRONMENT=development`) sind sie erlaubt, auf einem NAS im Heimnetz mit
`AI_ALLOW_PRIVATE_ENDPOINTS=true`.

### Kategorie-Taxonomie
- 11 Superkategorien: Wohnen, Essen, Mobilität, Versicherungen, Freizeit, Abos, Shopping, Bildung, Steuern, Sparen, Sonstiges
- Zentrale Definition in `shared/taxonomy.json` (txnCategories, wizardLabels, legacyAliases)
- Per-User Anpassungen: Labels ausblenden, eigene Labels hinzufügen (Settings)
- Kategorienverwaltung: Migrierung von Transaktionen beim Ausblenden eines Labels

### Onboarding
Drei Einstiege nach der Registrierung, alle mit demselben Ziel — eine erste
brauchbare Zahl, bevor jemand 50 Felder ausfüllt:

| Weg | Datenlage | Wofür |
|---|---|---|
| **Kontoauszug hochladen** | gemessen | echte Zahlen, braucht die Unterlagen |
| **Budget selbst einschätzen** | geschätzt | vier Schritte durch den Wizard; darf Dinge enthalten, die erst bevorstehen |
| **Beispieldaten ansehen** | erfunden | anonym, sofort, für Demos und zum Kennenlernen |

- Beispieldaten: erfundener Schweizer Haushalt, 424 Buchungen über zwölf Monate,
  fester Startwert (dieselbe Vorführung zeigt zweimal dieselben Zahlen),
  idempotent, über `DELETE /api/onboarding/demo` restlos entfernbar
- Bestätigungsschleife über die zehn grössten Händler — wirkt über
  `merchant_normalized` auf Stufe 0 der Kategorisierung

### Budgetplanung
- Monatsbudget pro Superkategorie
- **Budgetplan**: Jahresübersicht wiederkehrender Einträge über 12 Monate (Kalender- und Listenansicht)
- Wiederkehrende Einnahmen/Ausgaben (wöchentlich, monatlich, quartalsweise, halbjährlich, jährlich)
- **Plan-Ist-Abgleich**: Status je Fälligkeit — gebucht / Betrag weicht ab / offen / überfällig;
  Textabgleich über dieselbe Fuzzy-Logik wie die Duplikaterkennung beim Import
- **Jahresbilanz** mit Vorjahresvergleich und kumuliertem Laufsaldo je Monat
- **Massenänderungen**: Mehrfachauswahl, Kategorisierung, Löschen, prozentualer
  Teuerungsaufschlag — als eine Transaktion (`POST /api/recurring-plan/batch`)

### Prognosen
- **Monte Carlo Simulation** (10.000 Durchläufe), Perzentilbänder (p10, p25, p50, p75, p90)
- **Schweizer Rentenberechnung**:
  - AHV (Säule 1): Beitragsjahre, Durchschnittseinkommen, max. CHF 2'520/Monat
  - BVG/Pensionskasse (Säule 2): Umwandlungssatz 6.8%, Altersklassen
  - Säule 3a: Zinseszins, max. CHF 7'056/Jahr steuerlich abzugsfähig
- Inflationsbereinigung (Standard: 1.5% CHF)
- Szenario-Vergleich (Was-wäre-wenn-Analysen)
- **Wirksame Szenarien**: Sparplan erhöhen, Frühpensionierung (inkl. AHV-Vorbezugskürzung
  von 6.8 %/Jahr), Pflegekosten ab 80, Hypothek amortisieren — beliebig kombinierbar
- **Budget-Gesundheit**: fünf gewichtete Komponenten; die Sparquote wird an der
  BFS-Vergleichsgruppe gemessen (Haushaltsform × Einkommensklasse), nicht an einer
  festen Zielmarke

### Visualisierungen
- **Sankey-Diagramm**: Cashflow — Einnahmen → Superkategorien → Sparen, wahlweise aus realen (importierten) oder empirischen (Wizard-)Daten
- **Monte Carlo Fan-Chart**: Recharts AreaChart mit Perzentilbändern
- **Rentenübersicht** (Prognose): Ansicht *Kapital und Vermögen* – Vorsorgekapital gestapelt bis
  zum Bezug, Privat-/Anlagevermögen (Median) als einblendbare Linie – und Ansicht *Einkommen im
  Ruhestand* – AHV, Pensionskassen-Rente und Entnahme aus dem Vermögen gegen die Ausgaben, dazu
  die Linie *verfügbar*: Renten plus gleichbleibender Kapitalverzehr bis zur Lebenserwartung
- **Finanzplan**: Gestapeltes Flächendiagramm (Rentenentwicklung 3 Säulen)
- Budget-Statusbalken pro Kategorie
- Monatsübersicht Einnahmen vs. Ausgaben

### Referenzwährung
- Wahl zwischen CHF, EUR, USD in den Einstellungen
- Live-Wechselkursabruf (ECB / fixer.io Fallback)
- Alle Berechnungen und Anzeigen umgerechnet

### Datensicherung
Unter **Einstellungen → Datensicherung** als JSON-Datei (Format `budgetpal-backup`, Version 1.1):

- **Daten:** Konten, Transaktionen, Labels, Budgets, Budgetplan, Wizard-Konfiguration,
  Säulen 1–3a und Assets.
- **Einstellungen:** KI-Anbieter mit Endpunkt und Modell, Sprache, Session-Dauer,
  SARON-Referenz.
- **API-Keys** nur mit dem Häkchen *API-Keys einschliessen* **und** dem Passwort des Kontos.
  Die Datei enthält sie dann im Klartext — sicher aufbewahren. Das Passwort ist nötig, weil ein
  angemeldeter Browser allein nicht genügen soll, um alle Keys herunterzuladen.
- **Passkeys** sind nie enthalten — sie sind an Gerät und Domain gebunden.

Beim Wiederherstellen werden bestehende Einträge nicht überschrieben. Einstellungen und Keys
kommen nur mit dem Häkchen *Einstellungen & API-Keys wiederherstellen* zurück, weil das
Sprache, Session-Dauer und aktiven KI-Anbieter ersetzt. Ungültige Werte in der Datei werden
übersprungen und als Warnung gemeldet. Backups der Version 1.0 lassen sich weiter einspielen.

### Authentifizierung
- Multi-User mit JWT (python-jose, bcrypt)
- Registrierung und Login, Passkeys (WebAuthn). Einen Passkey hinzufügen verlangt das aktuelle
  Passwort und löst eine Info-Mail aus; „Passwort vergessen“ entfernt alle Passkeys des Kontos.
  Produktiv sind Domain und Adresse fest gesetzt (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS_RAW`)
- Session-Dauer pro Nutzer einstellbar
- **Passwort ändern** unter *Einstellungen → Sicherheit*; alle anderen Geräte werden dabei
  abgemeldet, die eigene Sitzung bleibt
- **Passwort vergessen** auf der Login-Seite: ein Link per E-Mail, 30 Minuten und nur einmal
  gültig. Die Antwort ist immer gleich, sie verrät nicht, ob es die Adresse gibt. In der
  Datenbank liegt nur der SHA-256 des Links; das Token steht im URL-Fragment und damit in
  keinem Server-Log. Nach jedem Wechsel geht eine Info-Mail an den Kontoinhaber.
- Mails per SMTP (`SMTP_*`), produktiv über ein Strato-Postfach. Ohne SMTP und mit
  `ENVIRONMENT=development` steht der Link im Backend-Log.

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

> **Frische Datenbank:** Beim ersten Start erkennt `backend/start.sh` eine leere DB
> automatisch, legt das vollständige Schema per `create_all()` an und stempelt Alembic
> auf `head`. Bestehende Installationen erhalten Updates regulär über
> `alembic upgrade head` — kein manueller Eingriff nötig.

### Wichtige Umgebungsvariablen / Key Environment Variables

```env
# Pflichtfelder / Required
POSTGRES_PASSWORD=sicheres_passwort_hier
JWT_SECRET_KEY=64_zeichen_hex_string_hier  # openssl rand -hex 32

# Optional
MISTRAL_API_KEY=...          # OCR-Fallback beim PDF-Import (Mistral OCR)
BACKEND_PORT=8010            # Standard-Port Backend
FRONTEND_PORT=8011           # Standard-Port Frontend
AUTO_CREATE_SCHEMA=false     # true = DB ohne Alembic beim ersten Start
ENVIRONMENT=production       # development = lokal, erlaubt LM Studio/Ollama
AI_ALLOW_PRIVATE_ENDPOINTS=false  # true = LM Studio/Ollama im Heimnetz (NAS)
SMTP_HOST=smtp.strato.de     # Mails für "Passwort vergessen"; leer = keine Mails
SMTP_PORT=465                # 465 = SSL, sonst STARTTLS
SMTP_USER=noreply@example.ch
SMTP_PASSWORD=...
SMTP_FROM=noreply@example.ch
APP_BASE_URL=http://localhost:8011  # Basis für Links in Mails (nie aus dem Host-Header)
```

KI-Anbieter und ihre API-Keys gehören **nicht** in die `.env` — jeder Nutzer hinterlegt sie
unter *Einstellungen → KI-Modell*, gespeichert pro Nutzer in der Datenbank.

---

## Entwicklung / Development

### Feature-Branch-Workflow

Direkte Pushes auf `main` sind gesperrt (pre-push hook). Workflow:

```bash
# 1. Neuen Feature-Branch erstellen (von main)
make feature name=mein-feature   # → Branch feat/mein-feature

# 2. Entwickeln ...

# 3. Commit + Push + GitHub PR
make pr msg="feat: kurze Beschreibung"

# Branch mit main synchron halten
make sync
```

### Lokale Entwicklung

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

### Tests

```bash
# Alle Backend-Tests
make test-backend

# Einzelne Test-Suites
docker compose exec budget-pal-backend pytest tests/test_auth.py -v
docker compose exec budget-pal-backend pytest tests/test_transactions.py -v
docker compose exec budget-pal-backend pytest tests/services/ -v
```

Test-Abdeckung: Auth-Flows, Transaktions-CRUD, KI-Kategorisierung (5-stufige Pipeline),
KI-Anbieter und Key-Schutz (`test_ai_client.py`, `test_ai_settings.py`), Datensicherung inkl.
Einstellungen (`test_backup_settings.py`), Monte-Carlo-Projektion.

---

## Deployment auf Strato (Produktion)

**Auto-Publish:** Jeder Push auf `main` (also jeder gemergte Pull Request) wird getestet,
gebaut und auf den Strato-VPS ausgerollt. Pull Requests werden nur getestet.

```text
Push auf main ─▶ backend-tests + frontend-build
               ─▶ build-and-push: Images nach GHCR, Tags latest und 7-stelliger Commit-Hash
                    ghcr.io/doebele/budget-pal/backend, …/frontend
               ─▶ deploy (nur mit DEPLOY_ENABLED=true): per SSH git pull, .env aus Secret,
                    ./deploy.sh <hash>, danach /api/health von aussen
```

`deploy.sh` auf dem Server sichert zuerst die Datenbank (`backups/`), holt die Images,
startet mit `docker-compose.prod.yml` und wartet, bis alle Container healthy sind. Wird die
neue Version nicht healthy, startet es wieder den letzten funktionierenden Stand.

```text
Browser ─HTTPS─▶ nginx auf dem Host (443, Let's Encrypt)
                   └─▶ 127.0.0.1:18081 ─▶ budget-pal-frontend (nginx)
                                            ├─ /api/ ─▶ budget-pal-backend :8000 (kein Host-Port)
                                            └─ /     ─▶ statisches Frontend
                                          budget-pal-db (nur intern)
```

In Produktion hängt nur das Frontend an `127.0.0.1`; von aussen ist nichts ausser 443
erreichbar, auch wenn die Server-Firewall aus ist.

### Einmalige Einrichtung

1. **DNS:** A-Record `budgetpal.doebele12.de` → IP des VPS.
2. **Checkout auf dem Server** (Repo ist öffentlich, kein Token nötig):
   ```bash
   git clone https://github.com/Doebele/budget-pal.git /opt/budgetpal
   ```
3. **Host-nginx** `/etc/nginx/sites-available/budgetpal`, danach verlinken und Zertifikat holen:
   ```nginx
   server {
       listen 80;
       server_name budgetpal.doebele12.de;
       client_max_body_size 50M;
       location / {
           proxy_pass http://127.0.0.1:18081;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
   ```bash
   ln -s /etc/nginx/sites-available/budgetpal /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   certbot --nginx -d budgetpal.doebele12.de --redirect   # HTTPS + Weiterleitung 80 → 443
   ```
4. **Deploy-Key:** eigenes Schlüsselpaar nur für GitHub Actions, öffentlichen Teil auf dem
   Server in `~/.ssh/authorized_keys`:
   ```bash
   ssh-keygen -t ed25519 -N "" -C budgetpal-deploy -f budgetpal_deploy
   ssh-keyscan -t ed25519 <server-ip>     # Ausgabe → Secret STRATO_KNOWN_HOSTS
   ```
5. **GitHub-Secrets** (Settings → Secrets and variables → Actions):

   | Secret | Inhalt |
   |---|---|
   | `STRATO_HOST` | IP oder Hostname des VPS |
   | `STRATO_USER` | SSH-Benutzer |
   | `STRATO_SSH_KEY` | privater Deploy-Key (`budgetpal_deploy`) |
   | `STRATO_KNOWN_HOSTS` | Zeile aus `ssh-keyscan`, schützt vor falschem Server |
   | `STRATO_DEPLOY_PATH` | `/opt/budgetpal` |
   | `STRATO_ENV_FILE` | Inhalt der `.env` für den Server, mindestens `POSTGRES_PASSWORD` und `JWT_SECRET_KEY` (`openssl rand -hex 32`), optional `MISTRAL_API_KEY` und die `SMTP_*`-Zeilen für „Passwort vergessen“. **`POSTGRES_PASSWORD` nach dem ersten Deploy nicht mehr ändern** — es gilt nur beim Anlegen der Datenbank |

   `ENVIRONMENT=production` und `ALLOWED_ORIGINS` setzt `docker-compose.prod.yml` fest.
6. **Images öffentlich machen:** Nach dem ersten Build auf `main` unter GitHub → Profil →
   Packages die Pakete `budget-pal/backend` und `budget-pal/frontend` auf *Public* stellen.
   Dann braucht der Server keinen Token zum Herunterladen.
7. **Einschalten:** Repository-Variable `DEPLOY_ENABLED=true` (Settings → Secrets and
   variables → Actions → Variables). Danach den letzten `main`-Lauf neu starten (siehe unten).
8. **Nächtliches Backup** per Cron auf dem Server:
   ```bash
   (crontab -l; echo "0 3 * * * /opt/budgetpal/scripts/backup-db.sh nightly >/dev/null") | crontab -
   ```

### Befehle

```bash
gh run watch                                   # Deploy verfolgen
gh run rerun $(gh run list --branch main --event push --limit 1 --json databaseId --jq '.[0].databaseId')
                                               # letzten Deploy wiederholen, z. B. nach Änderung an STRATO_ENV_FILE
curl -s https://budgetpal.doebele12.de/api/health
```

Auf dem Server (`cd /opt/budgetpal`):

```bash
docker compose -f docker-compose.prod.yml ps            # Status
docker logs -f --tail=100 budget-pal-backend            # Backend-Logs
IMAGE_TAG=<hash> ./deploy.sh                            # auf älteren Stand zurückrollen
scripts/backup-db.sh                                    # Datenbank-Backup nach backups/
```

Backup einspielen — **löscht alle aktuellen Daten**:

```bash
docker stop budget-pal-backend
docker exec budget-pal-db psql -U budgetpal budgetpal -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c backups/<datei>.sql.gz | docker exec -i budget-pal-db psql -q -U budgetpal budgetpal
IMAGE_TAG=<hash> ./deploy.sh                            # Stand, der zum Backup passt
```

Beim Zurückrollen bleibt die Datenbank, wie sie ist. Hat die neuere Version sie migriert,
startet ein älteres Image unter Umständen nicht mehr; dann das Backup von vor dem Deploy
(`backups/budgetpal_*_pre-deploy_<hash>.sql.gz`) wie oben einspielen.

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

Mit `ENVIRONMENT=production` sind KI-Endpunkte im Heimnetz gesperrt. Für LM Studio oder
Ollama auf dem NAS oder im LAN zusätzlich `AI_ALLOW_PRIVATE_ENDPOINTS=true` setzen.

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
│   │   │   ├── transactions.py # CRUD + stats + bulk-archive
│   │   │   ├── accounts.py     # CRUD + bulk-delete/preview
│   │   │   ├── imports.py      # CSV/PDF import (UBS, N26, Revolut, comdirect)
│   │   │   ├── projections.py  # Monte Carlo scenarios
│   │   │   ├── recurring_plan.py # Budgetplan CRUD
│   │   │   ├── taxonomy.py     # Taxonomy + per-User Label-Hiding
│   │   │   ├── wizard.py       # Empirisches Finanzprofil (Annahmen/Statistik)
│   │   │   ├── currency.py     # Wechselkurse (ECB / Fallback)
│   │   │   └── settings.py     # User-Einstellungen
│   │   └── services/
│   │       ├── categorization.py     # 5-stufige KI-Pipeline
│   │       ├── projection.py         # Monte Carlo + AHV/BVG
│   │       ├── wizard_derive.py      # Wizard-Ableitungen (Hypothekarzins, Jahresbeträge, Krankenkasse)
│   │       ├── peer_group_seed.py    # System-Kategorie Seeding + Migrationen
│   │       └── import_parsers/       # UBS, N26, Revolut, comdirect
│   ├── alembic/
│   │   └── versions/
│   │       ├── 0001_migrate_float_to_numeric_for_monetary_columns.py
│   │       └── 0002_add_user_ui_language.py   # DE/EN-Präferenz pro Nutzer
│   ├── tests/                  # pytest Test-Suite
│   │   ├── conftest.py         # Async DB-Fixtures, Test-Client
│   │   ├── test_auth.py        # Auth-Flows (Register, Login, JWT)
│   │   ├── test_transactions.py
│   │   └── services/
│   │       ├── test_categorization.py  # 5-stufige Pipeline
│   │       ├── test_projection.py      # Monte Carlo + Rentensäulen
│   │       └── test_wizard_derive.py   # Hypothekarzins, Jahres-/Monatsumrechnung, Krankenkasse
│   ├── Dockerfile
│   └── requirements.txt
│
├── frontend/                   # React 18 + TypeScript + Vite
│   ├── src/
│   │   ├── App.tsx             # Routes + UI-Attribute (data-theme/-accent/-density)
│   │   ├── i18n/               # react-i18next Setup + de/en Übersetzungen
│   │   ├── lib/
│   │   │   ├── api.ts          # Axios + JWT interceptor + alle API-Calls
│   │   │   ├── auth.tsx        # Auth Context + Sprach-Sync mit DB
│   │   │   ├── store.ts        # zustand UI-Store (Theme/Dichte/Akzent/Sprache/Rail)
│   │   │   ├── theme.ts        # themePalettes dark/light + Betragsformatierung
│   │   │   ├── format.ts       # locale-bewusste Zahlen-/Datumsformatierung
│   │   │   ├── icons.tsx       # Iconoir-Adapter (size-Prop-kompatibel)
│   │   │   ├── categories.ts   # useTaxonomy(), SuperCategory Typen, Lookups
│   │   │   └── planSchedule.ts # Fälligkeiten eines Budgetplan-Eintrags
│   │   │                       #   (Gegenstück zu services/plan_schedule.py)
│   │   ├── hooks/
│   │   │   └── useThemeColors.ts   # theme-bewusste Chart-Farben
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Rail.tsx           # Desktop-Rail (52/220px, Footer-Toggles)
│   │   │   │   ├── MobileDrawer.tsx   # Hamburger-Navigation < md
│   │   │   │   ├── BottomNav.tsx      # Mobile Bottom-Tabs
│   │   │   │   └── navItems.ts        # Gemeinsame Nav-Konfiguration
│   │   │   ├── EntryTooltip.tsx           # Hover-Tooltip für Budgetplan-Einträge
│   │   │   └── transactions/
│   │   │       └── TransactionOverviewHeader.tsx  # Bulk-Archiv/Delete Modal
│   │   └── pages/
│   │       ├── Dashboard.tsx   # Sankey, Top-Kategorien, Letzte Transaktionen
│   │       ├── Transactions.tsx
│   │       ├── Import.tsx
│   │       ├── Budget.tsx
│   │       ├── Budgetplan.tsx  # Jahresübersicht wiederkehrender Einträge
│   │       ├── Finanzplan.tsx  # Langfristprognose + Rentensäulen
│   │       ├── Projections.tsx # Monte Carlo Fan-Chart
│   │       ├── Forecast.tsx    # Kategorie-Breakdown, Chart-Export
│   │       ├── Wizard.tsx      # Empirisches Finanzprofil (Annahmen/Statistik)
│   │       ├── Accounts.tsx
│   │       └── Settings.tsx    # Einstellungen inkl. Kategorie-Taxonomie
│   ├── nginx.conf
│   ├── Dockerfile
│   └── package.json
│
├── shared/
│   └── taxonomy.json           # Zentrale Superkategorie-Definition
│
├── .githooks/
│   └── pre-push                # Blockiert direkte Pushes auf main
├── docker-compose.yml          # Build-Kontext: Repo-Root für alle Services
├── .env.example
├── Makefile                    # make feature / make pr / make sync + Docker-Befehle
├── context.md                  # Änderungsprotokoll
└── README.md
```

---

## Schweizer Rentenrechner

| Säule | Typ | Werte 2025/2026 | Beitrag |
|-------|-----|-----------------|---------|
| AHV (1) | Staatlich | max. CHF 2'520/Monat × 13 (13. AHV-Rente ab Dez. 2026) | Pflicht, Lohnprozente |
| BVG (2) | Berufsvorsorge | Kapital × Umwandlungssatz (Vorsorgeausweis, sonst 5.3 %) | Pflicht ab CHF 22'680 |
| 3a | Privat gebunden | CHF 7'258/Jahr (ohne PK: 20 % bis CHF 36'288) | Freiwillig, steuerbegünstigt |
| 3b | Privat frei | Unbegrenzt | Freiwillig |

So rechnet die Prognose (`services/projection.py`, eine Rechnung für Wizard, Finanzplan und
Rentendiagramm über `/api/pension/estimate`):

- **AHV:** zweistufige Rentenformel (Rentenskala 44), −1/44 je fehlendem Beitragsjahr. Bezug
  frühestens mit 63 (−6.8 % je Jahr Vorbezug), Aufschub bis 70 (+5.2 % bis +31.5 %). Die Rente
  folgt Löhnen und Preisen und bleibt deshalb in heutigen Franken gleich.
- **Pensionskasse:** Beiträge bis zum Rentenalter, danach feste Rente = Kapital × Umwandlungssatz.
  Die gesetzlichen 6.8 % gelten nur für den obligatorischen Teil; die meisten Kassen rechnen aufs
  ganze Guthaben mit 5.0–5.6 %. Die Rente wird in der Regel nicht der Teuerung angepasst. Sie
  beginnt mit dem Erwerbsende (frühestens 58).
- **Teilpensionierung** (Art. 13a BVG): bis zu zwei Schritte vor dem Erwerbsende, je mit Alter,
  Pensum danach und Kapitalanteil. Jeder Schritt gibt den Teil des Guthabens frei, um den das
  Pensum sinkt; der Rest spart mit dem tieferen Pensum weiter. Höchstens drei Kapitalbezüge
  inklusive Endbezug, der erste Schritt mindestens 20 %. Im Vermögen fehlt der Lohnausfall
  (netto), die Teilrente kommt dazu.
- **3a:** Ansparen bis zum Rentenalter, dann **Kapitalbezug pro Konto** (ein Konto lässt sich nur
  als Ganzes beziehen). Ohne eigenes Bezugsalter staffelt der Planer: ein Konto pro Jahr, so spät
  wie möglich, frühestens mit 60, spätestens mit 65 (bei Weiterarbeit bis 70), nie im Jahr des
  Pensionskassen-Kapitals.
- **3b / Lebensversicherung:** Die Ablaufleistung kommt am Ablauf der Police auf einmal ins freie
  Vermögen (ohne Datum beim Erwerbsende), steuerfrei (rückkaufsfähige Versicherung mit laufender
  Prämie). Als fester Betrag verliert sie bis dahin an realem Wert.
- **Pensionskasse als Kapital:** frei wählbarer Anteil (0–100 %). Der Kapitalteil fliesst im
  Bezugsjahr nach Steuer ins freie Vermögen, der Rest wird Rente.
- **Steuer auf Kapitalbezüge** (`services/capital_tax.py`): Bund exakt (ein Fünftel des Tarifs
  2026, ESTV Form. 58c; die geplante Verschärfung hat das Parlament im März 2026 gestrichen),
  Kanton und Gemeinde für den Kantonshauptort aus dem ESTV-Steuerrechner
  (`services/data/capital_tax_2026.json`, 26 Kantone, alleinstehend/verheiratet, 50'000–2 Mio.).
  Alle Bezüge eines Jahres werden zusammen besteuert. Kanton und Tarif kommen aus dem Wizard.
- **Bezugsbeginn je Säule:** AHV 63–70, Pensionskasse ab 58 (davor verzinst auf dem
  Freizügigkeitskonto; Umwandlungssatz −0.15 Prozentpunkte je Jahr vor 65, + je Jahr danach),
  3a 60–70, 3b am Ablauf der Police.
- **Vermögen nach der Pensionierung:** Die Sparrate endet mit dem Rentenalter. Danach werden die
  Lebenskosten entnommen, abzüglich der Renten, die schon fliessen. Frühpensionierte zahlen bis 65
  AHV-Beiträge als Nichterwerbstätige (aus Vermögen + 20 × Renteneinkommen, 530–26'500 CHF/Jahr).
  Die Anzeige zeigt, bis zu welchem Alter das Vermögen im Median reicht und in wie vielen
  Simulationen es bis zum Ende hält.
- **Lebenskosten im Ruhestand:** eigene Angabe, sonst Ausgaben aus dem Wizard × Lebensstilfaktor
  (0.8), sonst 80 % von (72 % des Bruttolohns − Sparrate).
- **Szenarien:** Frühpensionierung = dieselbe Rechnung mit früherem Rentenalter (lebenslang). Pflege
  ab 80 ersetzt 60 % der normalen Lebenskosten.
- Noch nicht abgebildet: Plafonierung für Ehepaare, Kapitalbezüge des Ehepartners im selben Jahr,
  Befreiung von AHV-Beiträgen durch einen erwerbstätigen Ehepartner, Gemeinden ausserhalb des
  Kantonshauptorts, Kirchensteuer.

---

## Integration mit portfolio-tracker (FinTools)

Budget-Pal, portfolio-tracker und application-pal sind Schwester-Projekte unter `~/projects/`
und bilden gemeinsam die **FinTools**-Suite:

- **Gleiches Design-System**: token-basierte CSS-Variablen (Light/Dark, Akzentfarben,
  Density), Rail-Navigation und Iconoir-Icons — 1:1 von application-pal übernommen
- **Gemeinsame Auth** (geplant): Single Sign-On
- **Nettovermögen-Sync** (geplant): Portfolio-Tracker Werte fließen in Budget-Pal ein

---

## Lizenz / License

Privates Projekt — nicht zur öffentlichen Verbreitung bestimmt.

*Private project — not intended for public distribution.*

---

*Entwickelt von Claus Medvesek · budgetpal.doebele12.de*
