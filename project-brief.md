# Projektübergabe — budget-pal

---

## 1. Projekt auf einen Blick

**Projektname:** budget-pal

**Kurzbeschreibung:** Persönliche Finanzplanung-App für die Schweiz — Transaktionsverwaltung mit KI-Kategorisierung, Budgetplanung, Monte-Carlo-Projektionen und Schweizer Rentenrechner (AHV/BVG/3a).

**Projektart:** Web-App

**Primäres Ziel:** Nutzer:innen einen vollständigen Überblick über Finanzen, Budget und Altersvorsorge geben, mit automatisierter Kategorisierung importierter Bankauszüge.

**Aktueller Status:** Alles gemerged (PR #4–#7). `main` ist sauber, CI grün, 248 Tests.

**Wichtigste Priorität in dieser Übergabe:** Keine offene Arbeit. Vor dem ersten Start `make build` (beide Images). Nächste Richtung kommt vom Nutzer.

---

## 2. Zielbild

Eine token-basierte Design-Sprache (Light/Dark/Density, 5 Akzentfarben, DE/EN) konsistent über die gesamte App, mit einklappbarer Rail-Navigation (portiert vom Schwesterprojekt `application-pal`) und Iconoir-Icons statt Lucide. Backend liefert Schweiz-spezifische Finanzlogik (AHV/BVG/3a, Monte-Carlo-Projektionen mit 10'000 Läufen) über eine FastAPI-API, Frontend konsumiert sie über TanStack Query.

---

## 3. Was bereits entschieden ist

### Produkt / Inhalt
- Zielgruppe: Privatpersonen in der Schweiz, die Finanzen + Altersvorsorge planen
- Angebot: Transaktions-Import (CSV/PDF von UBS/N26/Revolut/comdirect), Budgetplanung, Prognosen, Pensionsrechner
- Kernbotschaft: ganzheitliche, automatisierte Finanzplanung statt Excel-Tabellen

### Design
- Stilrichtung: dunkles, token-basiertes Design-System (`fintools`-Stil), übernommen von `application-pal`
- Referenzen: Schwesterprojekt `fintools-new` (Toggle-Switch-Styling), `application-pal` (Rail-Nav, Tokens)
- Icons: ausschließlich `iconoir-react` (Adapter in `frontend/src/lib/icons.tsx`), Lucide vollständig entfernt
- Toggle-Pattern: `.toggle-group`/`.toggle-btn` — Track + aktives Surface-Pill, keine Akzent-Tönung

### Technik
- Stack: Python 3.11 / FastAPI (async) / SQLAlchemy 2.0 async / Alembic / PostgreSQL 15 (Backend), React 18 / TypeScript / Vite / TailwindCSS (Frontend)
- Styling-Ansatz: CSS-Variablen + Tailwind `theme.extend.colors`, geschaltet über `data-theme`/`data-accent`/`data-density`
- Deployment-Ziel: Docker Compose (3 Services: db, backend, frontend), auch Strato/NAS-Deployment dokumentiert
- State: zustand (UI-Präferenzen, persistiert), TanStack Query (Server-State)

---

## 4. Source of Truth

- `README.md`: Features, Setup, Architektur-Überblick, Updates-Changelog
- `CLAUDE.md`: verbindliche Befehle, Architektur-Details, Konventionen (Soft-Delete, Async-Sessions, PortableJSON etc.)
- `shared/taxonomy.json`: zentrale Supercategory-Definition, von Backend und Frontend geteilt

**Regel:** Bei Widersprüchen zwischen Chat und diesen Dateien gelten die Dateien als führend.

---

## 5. Projektstruktur

```txt
budget-pal/
  backend/
    app/
      core/        # config, database, security, taxonomy, json_type
      models/       # alle ORM-Modelle (models.py)
      api/          # ein Router pro Domäne (auth, transactions, accounts, imports, ...)
      services/     # categorization.py (5-stufige KI-Pipeline), projection.py (Monte Carlo + AHV/BVG/3a)
    alembic/versions/
    tests/
  frontend/
    src/
      lib/          # api.ts, auth.tsx, icons.tsx, theme.ts, store.ts
      pages/        # ein File pro Route
      components/   # transactions/, charts/, wizard/, layout/ (Rail, MobileDrawer, BottomNav)
      hooks/
  shared/taxonomy.json
  docker-compose.yml
```

**Wichtige Dateien:**
- `backend/app/services/categorization.py` — Zweck: manual cache → keyword → fuzzy → embedding → OpenAI Fallback-Pipeline
- `frontend/src/lib/store.ts` — Zweck: zustand-Store für Theme/Accent/Density/Sprache (Key `budget-pal-ui-v1`)
- `backend/start.sh` — Zweck: unterscheidet frische DB (create_all + stamp head) von bestehender DB (alembic upgrade head)

---

## 6. Aktueller Stand

### Was funktioniert bereits?
- Vollständiger Docker-Stack (db/backend/frontend) läuft stabil, verifiziert auf Port 8011 (Frontend) / 8010 (Backend, `/api/health`)
- Design-System (Light/Dark, Density, 5 Akzentfarben, DE/EN) durchgängig appliziert, inkl. Light-Mode-Konsistenz-Fixes in 14 Dateien
- Rail-Navigation, Iconoir-Icon-Migration, fintools-Toggle-Styling — alle gemerged (PR #1, #2)
- Docker-Build-Fehler (round-flag-icons im falschen package.json, lucide-react-Restreferenz in vite.config.ts) behoben und gemerged (PR #3)

- **Backend-Testsuite ist grün: 137 passed in 32s** (verifiziert am 2026-08-06 mit `make test-backend`)

### Was ist nur teilweise gut?
- Die Testsuite-Reparatur + Bugfixes liegen noch **unkommittiert** im Arbeitsverzeichnis (siehe unten) — noch kein Branch, kein PR
- `backend/` hat **keinen Bind-Mount** im Compose-Setup: Codeänderungen wirken erst nach `make build` bzw. Rebuild des Backend-Images, nicht durch bloßen Restart

### Was funktioniert noch nicht?
- Keine bekannten offenen Bugs

### Uncommittete Änderungen — Herkunft geklärt

Die in der vorherigen Übergabe als „unzusammenhängend, Herkunft ungeklärt" markierten Änderungen (287 Insertions / 698 Deletions) sind **eine zusammenhängende Arbeitseinheit: Reparatur der Backend-Testsuite plus die dabei gefundenen echten Bugs.** Diff vollständig gelesen und verifiziert — nichts davon ist Fremdcode oder Zufall.

**Echte Produktions-Bugfixes (4):**

| Datei | Fix |
|---|---|
| `app/api/auth.py` | E-Mail-Vergleich bei Register/Login auf `func.lower()` umgestellt — vorher case-sensitiv, `Max@x.ch` und `max@x.ch` waren zwei Konten. Zusätzlich: leerer `birthdate`-String löschte das Geburtsdatum nie, weil der `elif`-Zweig hinter `is not None` unerreichbar war |
| `app/api/transactions.py` | `split_count` löste auf nicht-geladener Relationship einen Lazy-Load aus → `MissingGreenlet` in Async-Sessions. Neuer Guard `_split_count()` via `sa_inspect(txn).unloaded`, plus `selectinload(split_children)` in beiden Gettern und `db.refresh(txn, ["split_children"])` nach `update`/`restore` |
| `app/services/categorization.py` | RapidFuzz-Fuzzy-Stage ohne `processor` — Pipeline übergibt Beschreibungen in Großschrift, Merchant-Namen sind mixed-case, Matching lief faktisch ins Leere. Jetzt `processor=utils.default_process` |
| `Makefile` / `backend/Dockerfile` | `make test-backend` schrieb über den App-Lifespan (Migrationen/Seeds) in die echte Postgres-Dev-DB. Jetzt `-e DATABASE_URL=sqlite+aiosqlite:///:memory:`. Dockerfile kopiert zusätzlich `tests/` + `pytest.ini` ins Image, sonst gibt es im Container nichts zu testen |

**Test-Infrastruktur (`tests/conftest.py`):**
- `test_engine` von `scope="session"` auf Function-Scope: committende API-Routen leakten Zeilen (z. B. unique E-Mails) in spätere Tests
- `poolclass=StaticPool` ergänzt — ohne das bekommt jeder Pool-Checkout seine eigene leere `:memory:`-DB
- Manuelles `event_loop`-Fixture und das Savepoint-/Rollback-Konstrukt entfernt (überflüssig bzw. inkompatibel mit Function-Scope)

**Angepasste Tests (Tests waren falsch, nicht der Code):**
- `test_taxonomy_wizard_defaults.py`: „Säule 3A" liegt in `shared/taxonomy.json` unter `sparen`, nicht `steuern` — Assertion war veraltet (gegen die Datei geprüft)
- `test_projection.py`: AHV-Tests reichen jetzt das inzwischen erforderliche `current_age` durch; der 3a-Auszahlungstest rechnet gegen die echte Annuitätenformel mit `PAYOUT_RESIDUAL_RATE`/`PAYOUT_YEARS` statt gegen naives `balance/20`
- `test_transactions.py`: an das tatsächliche API-Verhalten angeglichen — DELETE liefert `204` (nicht das Objekt), Liste ist ein Array (kein `{items:…}`-Wrapper), Bulk-Categorize ignoriert unbekannte IDs mit `200 / updated: 0`
- `test_categorization.py`: von 643 auf 201 Zeilen zusammengestrichen — die alten Tests mockten eine API, die es so nie gab (`get_keyword_rules`, `_match_keywords`). Neu gegen die reale 5-Stufen-Pipeline geschrieben; Embedding- und OpenAI-Stufe durchgängig gemockt, damit Tests keine Modelle laden und keine externen Calls machen

> **Annahme (markiert):** Diese Arbeit stammt aus einer nicht dokumentierten Session. Die Zuordnung oben ist aus dem Diff rekonstruiert, nicht aus einem Session-Log — inhaltlich aber verifiziert (Suite grün, Taxonomie- und Projection-Konstanten gegengeprüft).

---

## 7. Nächste Aufgabe für den Agenten

**Konkrete Aufgabe jetzt:** Keine. `main` ist grün (248 Tests, CI beide Jobs). Nächste Richtung kommt vom Nutzer.

**Offen geblieben:**
- Es wurde nur **ein** Revolut-Layout mit Buchungen getestet. Andere unbekannte Formate — insbesondere gescannte PDFs, die durch OCR müssen — sind ungeprüft.
- **Die gesamte neue Import-UI ist nie visuell im Browser gesehen worden** (Fortschrittsbalken, Job-Indikator, Modell-/Tokenanzeige, Leerzustand). Alles ist typgeprüft, im Bundle und durch Backend-Tests abgedeckt, aber ein Upload braucht eine angemeldete Sitzung. Der erste echte Import ist der Test.
- Ein lokales 35B-Reasoning-Modell braucht ~5 Minuten pro Auszug. Ein kleineres Instruct-Modell ist um ein Vielfaches schneller; für Revolut ist der vorhandene **CSV**-Parser ohnehin der bessere Weg für regelmäßige Importe.

**Falls die Arbeit hier fortgesetzt wird, naheliegende Kandidaten:**
- Die restlichen im Prompt genannten KI-Features bauen: Ausgabemuster erkennen und Sparvorschläge. Die Infrastruktur steht (`ai_client` + `user_history`), es fehlen nur die Features selbst.
- `currency_service` schickt SQLite-DDL an Postgres (`syntax error at or near "AUTOINCREMENT"`), Wechselkurse werden still nie persistiert. Läuft als separater Task.
- `frontend`: `npm run lint` ist projektweit kaputt, ESLint findet keine Config.

**Nicht tun:**
- Keine unnötigen Umbauten.
- Keine Änderung an bereits akzeptierten Designentscheidungen (Toggle-Pattern, Icon-Library, Farb-Tokens).
- Keine neuen Abhängigkeiten ohne Begründung.
- Die vier Produktions-Bugfixes **nicht** zurückrollen, um Tests „grün zu machen" — der Code war falsch, nicht die Tests.
- Kein direkter Push auf `main` (Pre-Push-Hook blockiert das).

---

## 8. Arbeitsregeln

### Inhaltlich
- Bestehende Entscheidungen respektieren (Design-Tokens, Rail-Nav, iconoir-react als einzige Icon-Library).
- Erst verstehen, dann umbauen.
- Kleine, nachvollziehbare Änderungen bevorzugen — pro Fix ein klar abgegrenzter Commit/PR.
- Bei Unklarheit konservativ vorgehen, insbesondere bei unzusammenhängenden lokalen Änderungen.

### Für Code
- Bestehenden Stil der Codebase respektieren (siehe `CLAUDE.md`).
- **Async-Sessions ohne Auto-Commit — schreibende Router MÜSSEN `await db.commit()` aufrufen. `flush()` allein genügt nicht:** `get_db()` committet nicht, und beim Schließen der Session wird eine offene Transaktion zurückgerollt. Der Endpunkt antwortet dann fröhlich mit 200 und dem neuen Wert (das ORM-Objekt im Speicher stimmt ja), gespeichert wird nichts. Genau so gingen sieben Endpunkte still verloren, bis es 2026-08-08 auffiel.
- **Die `client`-Fixture kann fehlende Commits nicht sehen** — sie hängt Request und Nachprüfung an dieselbe Session, in der ein `flush()` sichtbar ist. Wer Persistenz prüfen will, braucht pro Request eine eigene Session und muss danach aus einer frischen lesen; Vorlage: `tests/test_write_persistence.py`. Eine Prüfung mit geteilter Session ist wertlos und meldet fälschlich Erfolg.
- Soft-Delete-Pattern bei Transaktionen beachten (`is_deleted`/`deleted_at`).
- `PortableJSON` statt rohem `JSON`/`JSONB` für neue JSON-Spalten.

### Für Webprojekte
- Mobile (Bottom-Nav/Drawer) und Desktop (Rail) beide prüfen.
- Bestehende Toggle-/Icon-Patterns wiederverwenden, nicht neu erfinden.

---

## 9. Design- und Qualitätskriterien

### UX / UI
- Konsistentes Toggle-Pattern (`.toggle-group`/`.toggle-btn`) für alle Segment-Schalter
- Light- und Dark-Mode gleichwertig getestet
- Klare Hierarchie in Rail-Navigation

### Frontend
- Responsiv (Rail Desktop, Bottom-Nav/Drawer Mobile)
- Theme-bewusste Charts (Recharts/ECharts via `useThemeColors`)
- Keine hartkodierten Tailwind-Farbklassen (slate/white) — nur Design-Tokens

### Codequalität
- Kleine Diff-Größe pro PR
- Keine toten Pfade (z. B. ungenutzte Icon-Imports nach Migration)
- Kommentare nur dort, wo wirklich nötig

---

## 10. Offene Fragen

**Aktuell keine offenen Fragen.** Alle Punkte der letzten beiden Übergaben sind abgearbeitet:

| Frage | Ergebnis |
|---|---|
| Herkunft der uncommitteten `backend/`-Änderungen | Geklärt — Testsuite-Reparatur + 4 Bugfixes, siehe Abschnitt 6 |
| Zustand der Testsuite | Grün, 137 passed |
| Commit-Aufteilung | Entschieden: ein Sammel-PR (Begründung in Abschnitt 7) |
| Frontend-Auswirkung `split_count` | Keine — nur als Badge in `Transactions.tsx:701` (`?? ""`), Fix ist reine Verbesserung |
| Unique-Index auf `lower(email)` | Nicht nötig — Dev-DB hat 3 User, 0 Duplikate (geprüft). Laufzeit-Fix genügt |
| `elif`-Muster anderswo | Kommt in `backend/app/api/` sonst nirgends vor (gegrept) |

---

## 11. Übergabe an anderes Modell / anderes Tool

**Bisher verwendet in:** Claude Code

**Aktueller Branch:** `main` (PR #4 und #5 gemerged; `feat/ai-model-selection` und `fix/backend-test-suite` können gelöscht werden)

**PDF-Import läuft als Hintergrundjob** (`POST /imports/pdf/preview-async` → `GET /imports/jobs/{id}`). Der Job-Zustand liegt in `ImportLog` (`status`, `preview_json`, `error_message`) — **nicht im Speicher**, weil das Backend mit `--workers 2` läuft und eine Statusabfrage einen anderen Worker treffen kann als den rechnenden. Der Hintergrundlauf öffnet eine eigene DB-Session; die des Requests ist geschlossen, sobald die Antwort raus ist. Für weitere lang laufende Operationen ist das die Vorlage.

**Neu und wichtig für alle künftigen KI-Features:** `backend/app/services/ai_client.py` ist die einzige Stelle, die mit einem LLM spricht. Provider und Modell wählt der Nutzer unter Einstellungen, gespeichert in `users.ai_config_json`. Neue KI-Features rufen `ai_client.complete(cfg, system, user)` auf — nicht direkt gegen einen Anbieter programmieren. `user_history.load_category_hints(db, user_id)` liefert die bisherigen Kategorien und Händler-Zuordnungen des Nutzers als Prompt-Kontext.

**Fallstricke, die Zeit gekostet haben und wiederkommen werden:**
- Lokale Modelle (LM Studio, Ollama) sind aus dem Container nur über `host.docker.internal` erreichbar, nicht über `localhost` — `ai_client.resolve_host_url()` erledigt das.
- LM Studio lehnt `response_format: {"type": "json_object"}` mit 400 ab (verlangt `json_schema` oder `text`), und Reasoning-Modelle liefern ihre Ausgabe in `reasoning_content` statt `content`. Beides ist in `ai_client` behandelt.
- **Timeouts hängen an drei Stellen zusammen** und müssen gemeinsam passen: `frontend/src/lib/api.ts` (`AI_IMPORT_TIMEOUT_MS`, 890 s) < `frontend/nginx.conf` (`proxy_read_timeout`, 900 s), und `ai_client.COMPLETION_TIMEOUT` (600 s) pro Einzelaufruf. Gemessen: **170 s pro 8000-Zeichen-Abschnitt** mit einem lokalen 35B-Reasoning-Modell.
- **`max_tokens` großzügig lassen.** Reasoning-Modelle verbrauchen das Budget beim Denken und liefern sonst ein leeres `content`-Feld. Gemessen nötig: **6536 Completion-Tokens** für einen Abschnitt mit ~26 Buchungen; gesetzt sind 12000 (`pdf_ai_extract.MAX_TOKENS_PER_CHUNK`) bzw. 1500 im Kategorisierungs-Fallback. `max_tokens` ist eine Obergrenze — abgerechnet wird nur Erzeugtes, ein hoher Wert kostet nichts.
- **Fehler immer mit Exception-Typ loggen.** `httpx.ReadTimeout` hat eine leere Meldung; ein nacktes „fehlgeschlagen: " ist nicht diagnostizierbar.

**Gemessene Genauigkeit** (echter Revolut-EUR-Auszug, 4 Seiten, 52 Buchungen, `ornith-35b`): 52 von 52 korrekt inkl. Vorzeichen, nichts fehlend, nichts erfunden, 15'148 Tokens, ~6 Minuten. Bemerkenswert, weil die Spalten „Geldausgang"/„Geldeingang" beim Textextrahieren verschmelzen — das Modell leitet die Richtung aus dem Kontext ab.

**Was das letzte Tool zuletzt gemacht hat:** PR #4 gemerged (Testsuite-Reparatur + 4 Produktionsbugs), PR #5 gebaut und gemerged (KI-Modellauswahl, KI-Import unbekannter PDFs, Kategorien aus der Historie, tolerante Duplikaterkennung). Dabei die seit PR #1 rote CI repariert.

**Was in PR #5 liegt** (Auswahl):
```
backend/app/services/ai_client.py          neu — einziger LLM-Zugang, 7 Provider
backend/app/services/pdf_ai_extract.py     neu — Buchungen aus unbekannten PDFs
backend/app/services/user_history.py       neu — Kategorie-Hinweise aus der Historie
backend/app/services/pdf_duplicate_detection.py  Stufe 3 (Textähnlichkeit) + SQLite-Fix
backend/app/api/settings.py                GET/PUT /api/settings/ai (+ /models)
backend/app/api/imports.py                 PDF-Dispatch entdoppelt + KI-Fallback
backend/alembic/versions/0003_*.py         users.ai_config_json
frontend/src/pages/Settings.tsx            Sektion "KI-Modell"
frontend/src/lib/                          7 Dateien, die nie im Repo waren
backend/pytest.ini                         war ebenfalls nie im Repo
.github/workflows/ci.yml                   fehlende Test-Env ergänzt
```

**Was als Nächstes erwartet wird:** Nichts Offenes. `make build` vor dem ersten Start (baut beide Images), dann neue Richtung vom Nutzer.

**Worauf besonders geachtet werden soll:**
- **`.gitignore` ist zu breit — schon zweimal fehlten dadurch echte Quelldateien im Repo.** `lib/` (ohne führenden Slash) traf auch `frontend/src/lib/`, wodurch `auth.tsx`, `store.ts`, `icons.tsx` u. a. nie committet wurden; `pytest.ini` fehlte ebenso. Beides ist behoben, aber bei neuen Ignore-Regeln bitte verankern (`/lib/`) und danach `git ls-files --others --ignored --exclude-standard` prüfen. Lokal fällt so etwas nie auf — nur in der CI oder bei einem frischen Clone.
- **Weder `backend/` noch `frontend/` haben einen Bind-Mount.** Das Frontend serviert ein statisches Build-Artefakt aus dem Image; Quelländerungen sind auf Port 8011 erst nach `make build` sichtbar. Wer gegen den Vite-Dev-Server (Port 5173, `make`-frei) verifiziert, prüft die Docker-Version **nicht** mit — genau so blieb die KI-Sektion in Docker zunächst unsichtbar, obwohl sie im Dev-Server lief. Für UI-Verifikation entweder `make build` vorher, oder bewusst dazusagen, dass nur der Dev-Server geprüft wurde.
- **Kein Bind-Mount für `backend/`:** Nach Codeänderungen muss das Backend-Image neu gebaut werden (`make build` / `make dev`), ein `make restart-backend` reicht nicht. Das aktuell laufende Image enthält den Stand des Arbeitsverzeichnisses (verifiziert) — deshalb ist der grüne Testlauf aussagekräftig.
- **Tests immer über `make test-backend` starten**, nie via nacktem `pytest` im Container: ohne das `DATABASE_URL`-Override schreibt der App-Lifespan in die echte Postgres-Dev-DB.
- Branch-Workflow: direkte Pushes auf `main` sind per Pre-Push-Hook blockiert — `make feature name=…` / `make pr msg="…"` bzw. Feature-Branch + `gh pr create` verwenden.
- `project-brief.md` ist untracked und bewusst nicht committet — vor `git add -A` (z. B. via `make pr`) prüfen, ob sie mitwandern soll.

---

## 12. Copy-Paste-Kurzbriefing

```md
Du übernimmst ein bestehendes Projekt: budget-pal.

Ziel des Projekts:
Persönliche Finanzplanung-App für die Schweiz (FastAPI + React/TS), mit KI-Kategorisierung von Banktransaktionen, Budgetplanung, Monte-Carlo-Projektionen und Schweizer Rentenrechner (AHV/BVG/3a).

Aktuelle Aufgabe:
PR #5 (Branch feat/ai-model-selection → main) wartet auf Merge. Inhalt: KI-Modellauswahl in den Einstellungen (7 Provider, serverseitig pro User in users.ai_config_json) und deren Nutzung im Import — unbekannte PDFs werden per KI ausgewertet, Kategorien aus der bestätigten Historie des Nutzers gelernt, Duplikate auch bei abweichendem Buchungstext erkannt. Testsuite grün: 224 passed.
Nach dem Merge: `make build` (backend/ hat keinen Bind-Mount). Danach keine bekannte offene Arbeit.

Für alle künftigen KI-Features:
backend/app/services/ai_client.py ist die einzige Stelle, die mit einem LLM spricht — complete(cfg, system, user) nutzen, nicht direkt gegen einen Anbieter programmieren. Die Nutzerauswahl kommt aus ai_client.from_user(user), der Kategorie-Kontext aus user_history.load_category_hints(db, user_id).

Wichtige Dateien / Source of Truth:
- README.md
- CLAUDE.md
- shared/taxonomy.json
- project-brief.md (Abschnitt 6 = vollständige Einordnung der Änderungen)

Bereits entschieden:
- Design-System: Light/Dark/Density/5 Akzentfarben/DE-EN, token-basiert
- Icons: ausschließlich iconoir-react
- Toggle-Pattern: .toggle-group/.toggle-btn (fintools-Stil)
- Branch-Workflow: kein direkter Push auf main, Feature-Branch + PR

Bitte beachten:
- Bestehende Struktur respektieren, nur gezielt ändern.
- Tests immer via `make test-backend` (setzt DATABASE_URL auf SQLite in-memory) — nacktes pytest im Container schreibt in die echte Dev-DB.
- backend/ hat keinen Bind-Mount: nach Codeänderungen `make build`, nicht nur restart.
- Responsive (Rail/Mobile-Nav) und Theme-Konsistenz mitdenken.
```
