-- ────────────────────────────────────────────────────────────
-- Migration 007: Wizard configuration + peer-group benchmarks
-- SQLite-compatible (no JSONB, booleans as INTEGER)
-- ────────────────────────────────────────────────────────────

-- ── Wizard Config ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_wizard_config (
    id                              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                         INTEGER NOT NULL UNIQUE,
    fiscal_year_type                TEXT    DEFAULT 'calendar',

    -- Planned financial targets
    monthly_income_target           REAL    DEFAULT 0.0,
    fixed_monthly_expenses          REAL    DEFAULT 0.0,
    target_savings_percentage       REAL    DEFAULT 15.0,
    retirement_age_target           INTEGER DEFAULT 67,
    current_age                     INTEGER DEFAULT 28,

    -- Category weights as JSON TEXT: {"Wohnen": 0.40, "Essen": 0.15}
    category_weights                TEXT,

    -- Peer-group comparison settings
    peer_group_comparison_enabled   INTEGER DEFAULT 1,   -- 0/1 bool
    peer_group_age_range_start      INTEGER DEFAULT 25,
    peer_group_age_range_end        INTEGER DEFAULT 35,
    use_peer_group_defaults         INTEGER DEFAULT 1,

    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now')),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wizard_user_id
    ON user_wizard_config(user_id);

-- ── Peer-Group Benchmarks ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS peer_group_benchmarks (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    age_range_start         INTEGER NOT NULL,
    age_range_end           INTEGER NOT NULL,
    household_type          TEXT    NOT NULL DEFAULT 'single',

    -- Income benchmarks (CHF/month)
    median_income_monthly   REAL    DEFAULT 0.0,
    p25_income_monthly      REAL    DEFAULT 0.0,
    p75_income_monthly      REAL    DEFAULT 0.0,

    -- Expense category averages (CHF/month)
    housing_avg             REAL    DEFAULT 0.0,
    food_avg                REAL    DEFAULT 0.0,
    transport_avg           REAL    DEFAULT 0.0,
    insurance_avg           REAL    DEFAULT 0.0,
    health_avg              REAL    DEFAULT 0.0,
    leisure_avg             REAL    DEFAULT 0.0,

    savings_rate_pct        REAL    DEFAULT 15.0,
    peer_count              INTEGER DEFAULT 0,

    created_at  DATETIME DEFAULT (datetime('now')),

    UNIQUE (age_range_start, age_range_end, household_type)
);

CREATE INDEX IF NOT EXISTS idx_pgb_age_household
    ON peer_group_benchmarks(age_range_start, age_range_end, household_type);

-- ── Swiss peer-group seed data (approx. BFS 2024, CHF/month) ──
-- Columns: age_start, age_end, household, median_income, p25, p75,
--          housing, food, transport, insurance, health, leisure,
--          savings_rate_pct, peer_count
INSERT OR IGNORE INTO peer_group_benchmarks
    (age_range_start, age_range_end, household_type,
     median_income_monthly, p25_income_monthly, p75_income_monthly,
     housing_avg, food_avg, transport_avg, insurance_avg, health_avg,
     leisure_avg, savings_rate_pct, peer_count)
VALUES
  (20, 29, 'single',        4800, 3800,  6200,  1100, 550, 380, 220, 300, 280,  8.0, 120000),
  (20, 29, 'couple',        9200, 7500, 12000,  2000, 950, 600, 400, 520, 500, 10.0,  60000),
  (30, 39, 'single',        7000, 5500,  9000,  1600, 680, 480, 280, 360, 380, 15.0, 150000),
  (30, 39, 'couple',       12500, 9800, 16000,  2800,1200, 750, 550, 650, 700, 17.0, 110000),
  (30, 39, 'family',       14500,11000, 18500,  3200,1800, 850, 750, 900, 600, 12.0, 130000),
  (30, 39, 'single-parent',  9000, 7000, 11500, 2200,1400, 600, 500, 700, 450, 10.0,  25000),
  (40, 49, 'single',        8200, 6500, 10500,  1850, 730, 520, 320, 400, 430, 20.0, 140000),
  (40, 49, 'couple',       14000,11000, 18000,  3000,1350, 800, 600, 750, 750, 22.0, 100000),
  (40, 49, 'family',       16000,12500, 21000,  3500,2200, 950, 850,1050, 650, 14.0, 120000),
  (40, 49, 'single-parent', 10500, 8500, 13500, 2600,1700, 700, 600, 850, 500, 12.0,  22000),
  (50, 59, 'single',        8800, 7000, 11500,  1950, 760, 500, 360, 450, 400, 25.0, 130000),
  (50, 59, 'couple',       15000,12000, 19500,  3200,1400, 750, 650, 850, 700, 28.0,  95000),
  (60, 69, 'single',        6200, 5000,  8000,  1700, 680, 420, 380, 500, 350, 20.0, 110000),
  (60, 69, 'couple',        9500, 7500, 12500,  2800,1200, 650, 700, 900, 600, 22.0,  85000),
  (70, 99, 'single',        4500, 3500,  6000,  1600, 620, 350, 400, 650, 280, 15.0,  90000),
  (70, 99, 'couple',        7500, 6000, 10000,  2600,1100, 550, 700,1050, 500, 18.0,  65000);
