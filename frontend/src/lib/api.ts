/**
 * Axios instance with JWT auth interceptor.
 * Automatically attaches Bearer token from localStorage.
 * Redirects to /login on 401.
 */
import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const TOKEN_KEY = "budget_pal_token";

// Obergrenze fuer Requests, hinter denen ein KI-Modell steckt. Muss unter dem
// proxy_read_timeout in frontend/nginx.conf bleiben, sonst bricht nginx zuerst ab.
const AI_IMPORT_TIMEOUT_MS = 890_000;

export const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
  timeout: 30_000,
});

// ── Request interceptor: attach JWT ───────────────────────────

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Response interceptor: handle 401 ─────────────────────────

const PUBLIC_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      // Nicht von den oeffentlichen Seiten weg — sonst ginge beim Reset-Link
      // mit abgelaufener Sitzung das Token im Link verloren
      if (!PUBLIC_PATHS.some((p) => window.location.pathname.startsWith(p))) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

// ── Token helpers ─────────────────────────────────────────────

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── API functions ─────────────────────────────────────────────

// Auth
export const authApi = {
  register: (data: { email: string; password: string; name: string }) =>
    api.post("/auth/register", data),
  login: (data: { email: string; password: string }) =>
    api.post("/auth/login", data),
  getMe: () => api.get("/auth/me"),
  updateMe: (data: Record<string, unknown>) => api.put("/auth/me", data),
  forgotPassword: (email: string) => api.post("/auth/password/forgot", { email }),
  resetPassword: (token: string, new_password: string) =>
    api.post("/auth/password/reset", { token, new_password }),
  /** Liefert ein neues Token — die anderen Sitzungen enden. */
  changePassword: (current_password: string, new_password: string) =>
    api.post<{ access_token: string }>("/auth/password/change", { current_password, new_password }),
};

// Accounts
export const accountsApi = {
  list: () => api.get("/accounts"),
  create: (data: Record<string, unknown>) => api.post("/accounts", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/accounts/${id}`, data),
  delete: (id: number) => api.delete(`/accounts/${id}`),
  /** Shallow paths — avoids proxy issues with `/accounts/{id}/transactions/...`. */
  previewTransactionsForDeletion: (accountId: number) =>
    api.get("/accounts/bulk-delete/preview", { params: { account_id: accountId } }),
  deleteAllTransactions: (accountId: number, hard = false) =>
    api.delete("/accounts/bulk-delete/transactions", {
      params: { account_id: accountId, hard },
    }),
};

// Transactions
export const transactionsApi = {
  list: (params?: Record<string, unknown>) => api.get("/transactions", { params }),
  listPage: (params?: Record<string, unknown>, cursor?: string) =>
    api.get("/transactions", { params: { ...params, cursor, limit: 100 } }),
  /**
   * Alle Transaktionen eines Zeitraums, ueber den Cursor durchgeblaettert.
   *
   * Das Backend deckelt `limit` bei 500. Wer mehr anfordert, bekommt 422 —
   * und wer genau 500 anfordert, bekommt stillschweigend nur die ersten 500,
   * was schlimmer ist: die Kennzahlen daraus waeren zu niedrig, ohne dass es
   * auffaellt.
   */
  listAll: async <T = unknown>(
    params?: Record<string, unknown>,
    maxPages = 20,
  ): Promise<T[]> => {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await api.get("/transactions", {
        params: { ...params, cursor, limit: 500 },
      });
      all.push(...(r.data as T[]));
      cursor = r.headers["x-next-cursor"];
      if (!cursor) break;
    }
    return all;
  },
  listArchived: (params?: Record<string, unknown>) =>
    api.get("/transactions/archived", { params }),
  restore: (id: number) => api.post(`/transactions/${id}/restore`),
  purgeArchived: (id: number) => api.delete(`/transactions/archived/${id}`),
  create: (data: Record<string, unknown>) => api.post("/transactions", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/transactions/${id}`, data),
  delete: (id: number, hard = false) =>
    api.delete(`/transactions/${id}`, { params: { hard } }),
  bulkCategorize: (ids: number[], force = false) =>
    api.post("/transactions/bulk-categorize", { transaction_ids: ids, force_recategorize: force }),
  split: (id: number, splits: Array<{ description: string; amount: number; category?: string | null; notes?: string | null }>) =>
    api.post(`/transactions/${id}/split`, { splits }),
  unsplit: (id: number) => api.delete(`/transactions/${id}/split`),
  getSplits: (id: number) => api.get(`/transactions/${id}/splits`),
  exportCsv: (params?: Record<string, unknown>) =>
    api.get("/transactions/export/csv", { params, responseType: "blob" }),
  stats: (params?: Record<string, unknown>) => api.get("/transactions/stats", { params }),
  monthlySummary: (params?: Record<string, unknown>) =>
    api.get("/transactions/monthly-summary", { params }),
  budgetAnalysis: (params?: Record<string, unknown>) =>
    api.get("/transactions/budget-analysis", { params }),
  monthlyCategoryBreakdown: (params: { start?: string; end?: string; months?: number; periodicities?: string }) =>
    api.get("/transactions/monthly-category-breakdown", { params }),
};

// Imports
export const importsApi = {
  uploadCsv: (formData: FormData) =>
    api.post("/imports/csv", formData, { headers: { "Content-Type": "multipart/form-data" } }),
  // PDF-Import laeuft bei unbekannten Formaten synchron durch das KI-Modell.
  // Ein lokales Modell braucht dafuer Minuten, nicht Sekunden — der globale
  // 30s-Timeout wuerde den Upload abbrechen, waehrend das Backend noch arbeitet.
  uploadPdf: (formData: FormData) =>
    api.post("/imports/pdf", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: AI_IMPORT_TIMEOUT_MS,
    }),
  previewPdf: (formData: FormData) =>
    api.post("/imports/pdf/preview", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: AI_IMPORT_TIMEOUT_MS,
    }),
  // Hintergrund-Variante: antwortet sofort mit einer Import-ID, das Ergebnis
  // wird per Polling abgeholt. Der Upload selbst darf ruhig lange dauern
  // (grosse Datei), die Auswertung laeuft danach ohne offenen Request.
  previewPdfAsync: (formData: FormData) =>
    api.post<ImportJob>("/imports/pdf/preview-async", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 120_000,
    }),
  importJob: (importId: number) => api.get<ImportJob>(`/imports/jobs/${importId}`),
  activeImportJob: () => api.get<ImportJob | null>("/imports/jobs/active"),
  confirmPdf: (payload: Record<string, unknown>) => api.post("/imports/pdf/confirm", payload),
  history: () => api.get("/imports/history"),
  preview: (id: number) => api.get(`/imports/${id}/preview`),
  delete: (id: number, deleteTransactions = true) =>
    api.delete(`/imports/${id}?delete_transactions=${deleteTransactions}`),
  previewUpload: (formData: FormData) =>
    api.post("/imports/preview", formData, { headers: { "Content-Type": "multipart/form-data" } }),
};

// Projections
/** Antwort von /projections/run. Alle Betraege real (heutige CHF), Reihen
 *  mit einem Wert pro Jahr ab heute. */
export interface ProjectionResult {
  years: number[];
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
  /** AHV: Jahresrente ab Bezug. BVG: Guthaben bis zum Endbezug, danach Jahresrente.
   *  3a/3b: Kapital bis zum Bezug, danach 0. */
  pension_ahv: number[];
  pension_bvg: number[];
  pension_3a: number[];
  pension_3b: number[];
  /** Jaehrliches Renteneinkommen: AHV und BVG-Renten, auch Teilrenten. */
  pension_income: number[];
  /** Pensionskasse getrennt: Guthaben bis zum Endbezug (danach 0) und Rente. */
  capital_bvg: number[];
  income_bvg: number[];
  /** Gleichmaessiger Kapitalverzehr pro Jahr (real), der das freie Vermoegen
   *  bis `drawdown_until_age` aufbraucht; 0 vor der Pensionierung. */
  capital_drawdown: number[];
  drawdown_until_age: number | null;
  retirement_idx: number | null;
  /** Index, ab dem AHV ("1") und Pensionskasse ("2", Endbezug) eine Rente
   *  zahlen. 3a und 3b werden als Kapital bezogen. */
  payout_start_idx: Record<"1" | "2", number>;
  /** Jaehrliche Lebenskosten im Ruhestand (ohne Steuern), die die Rechnung verwendet hat. */
  retirement_spending: number | null;
  /** Einkommens- und Vermoegenssteuer im Ruhestand entlang des Medians, real. */
  retirement_tax: number[];
  /** Alter, ab dem das Vermoegen im Median aufgebraucht ist; null = reicht. */
  depletion_age: number | null;
  /** Anteil der Simulationen mit Vermoegen am Ende des Horizonts (0-1). */
  success_rate: number | null;
  capital_withdrawals: CapitalWithdrawal[];
  capital_tax_total: number;
  capital_tax_single_year: number;
  inflation_adjusted: boolean;
  computed_at: string;
  runs: number;
}

/** Pensionskasse als Rente, als Kapital oder wie geplant — heutige CHF. */
export interface BvgVariant {
  key: "pension" | "capital" | "own";
  bvg_monthly: number;
  capital_net: number;
  p50: number[];
  p10: number[];
  depletion_age: number | null;
  success_rate: number;
  wealth_85: number | null;
  wealth_90: number | null;
  wealth_85_p10: number | null;
  taxes_total: number;
}

export interface BvgComparison {
  years: number[];
  current_age: number | null;
  retirement_age: number | null;
  variants: BvgVariant[];
  /** Ab diesem Alter hinterlaesst die Rente im Median mehr freies Vermoegen. */
  breakeven_age: number | null;
}

export const projectionsApi = {
  run: (params: Record<string, unknown>, scenarioId?: number) =>
    api.post<ProjectionResult>("/projections/run", params, {
      params: scenarioId ? { scenario_id: scenarioId } : {},
    }),
  compareBvg: (params: Record<string, unknown>, scenarioId?: number) =>
    api.post<BvgComparison>("/projections/compare-bvg", params, {
      params: scenarioId ? { scenario_id: scenarioId } : {},
    }),
  listScenarios: () => api.get("/projections/scenarios"),
  createScenario: (data: Record<string, unknown>) => api.post("/projections/scenarios", data),
  updateScenario: (id: number, data: Record<string, unknown>) =>
    api.put(`/projections/scenarios/${id}`, data),
  deleteScenario: (id: number) => api.delete(`/projections/scenarios/${id}`),
};

// Categories
export const categoriesApi = {
  list: () => api.get("/categories"),
  /** Idempotent seed of system categories (Sparen/Einnahmen-Typen etc.). */
  bootstrapPeerSystem: () => api.post<{ inserted: number }>("/categories/bootstrap-peer-system"),
  create: (data: Record<string, unknown>) => api.post("/categories", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/categories/${id}`, data),
  delete: (id: number) => api.delete(`/categories/${id}`),
};

// Budgets
export const budgetsApi = {
  list: (params?: { year?: number }) => api.get("/budgets", { params }),
  create: (data: Record<string, unknown>) => api.post("/budgets", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/budgets/${id}`, data),
};

// Multi-modal budget analysis
export const budgetApi = {
  multiAnalysis: (params?: Record<string, unknown>) =>
    api.get("/budget/multi-analysis", { params }),
};

/** Supercategory taxonomy (shared/taxonomy.json + merged Category rows) */
export const taxonomyApi = {
  snapshot: () =>
    api.get<{
      version: number;
      superCategories: Array<{
        id: string;
        label: string;
        color: string;
        emoji: string;
        txnCategories: string[];
        wizardLabels: string[];
        legacyAliases: string[];
      }>;
    }>("/taxonomy"),
  getHiddenLabels: () =>
    api.get<{ hidden: Record<string, string[]> }>("/taxonomy/hidden-labels"),
  hideCanonicalLabel: (sc_id: string, label: string, label_type: "txn" | "wl") =>
    api.post("/taxonomy/hide-canonical-label", { sc_id, label, label_type }),
  unhideCanonicalLabel: (sc_id: string, label: string, label_type: "txn" | "wl") =>
    api.delete("/taxonomy/hide-canonical-label", { data: { sc_id, label, label_type } }),
};

// Pension

/** Schaetzung bei Pensionierung — dieselbe Rechnung wie die Prognose.
 *  Alle Betraege in heutigen CHF, Monatswerte = Jahreswert / 12 (bei der AHV
 *  steckt die 13. Rente anteilig darin). */
/** Ein Kapitalbezug (Pensionskasse, 3a-Konto, Lebensversicherung), heutige
 *  CHF. Die Steuer ist der Anteil an der Steuer des Bezugsjahres — alle
 *  Bezuege eines Jahres werden zusammen besteuert; die 3b ist steuerfrei. */
export interface CapitalWithdrawal {
  source: "bvg" | "3a" | "3b";
  label: string;
  age: number;
  year: number;
  amount: number;
  tax: number;
  /** Nur 3a: Position des Kontos in der Eingabe. */
  account?: number;
  /** Nur BVG: Pensum danach (0-1); > 0 = Teilpensionierung. */
  pensum?: number | null;
}

/** Teilpensionierung oder Endbezug der Pensionskasse, heutige CHF. */
export interface BvgStep {
  age: number;
  pensum: number;
  released: number;
  capital: number;
  pension_monthly: number;
}

/** Teilpensionierung: ab `age` noch `pensum` (0-1), `capital_share` des
 *  frei werdenden Guthabens als Kapital. */
export interface PartialStepInput {
  age: number;
  pensum: number;
  capital_share: number;
}

export interface PensionEstimate {
  retirement_age: number;
  years_to_retirement: number;
  ahv_start_age: number;
  bvg_start_age: number;
  ahv_monthly: number;
  bvg_capital: number;
  bvg_conversion_rate: number;
  bvg_capital_share: number;
  bvg_lump_sum: number;
  bvg_monthly: number;
  bvg_steps: BvgStep[];
  pillar_3a_capital: number;
  /** Lebensversicherung am Ablauf, steuerfrei. */
  pillar_3b_capital: number;
  capital_withdrawals: CapitalWithdrawal[];
  capital_tax: number;
  /** Steuer, wenn alles im selben Jahr bezogen wuerde. */
  capital_tax_single_year: number;
  capital_net: number;
  /** Renten (AHV + BVG) pro Monat; Kapitalbezuege sind nicht darin. */
  total_monthly: number;
}

export interface PensionEstimateInput {
  current_age: number;
  retirement_age: number;
  ahv_contribution_years?: number | null;
  ahv_average_income?: number;
  bvg_balance?: number;
  bvg_annual_contribution?: number;
  bvg_conversion_rate?: number | null;
  /** Anteil der Pensionskasse als Kapital, 0-1. */
  bvg_capital_share?: number;
  bvg_partial_steps?: PartialStepInput[];
  pillar_3a?: {
    balance: number;
    annual_contribution: number;
    return_rate?: number;
    provider?: string;
    /** null = der Planer staffelt */
    withdrawal_age?: number | null;
  }[];
  /** Lebensversicherung: Ablaufleistung und Alter bei Ablauf (null = Erwerbsende). */
  pillar_3b?: { balance: number; provider?: string; withdrawal_age?: number | null }[];
  inflation_rate?: number;
  canton?: string;
  married?: boolean;
}

export const pensionApi = {
  /** Aus ungespeicherten Werten (Wizard). */
  estimate: (input: PensionEstimateInput) =>
    api.post<PensionEstimate>("/pension/estimate", input),
  /** Aus den gespeicherten Vorsorgedaten (Finanzplan). */
  estimateStored: () => api.get<PensionEstimate>("/pension/estimate"),
  list: () => api.get("/pension"),
  create: (data: Record<string, unknown>) => api.post("/pension", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/pension/${id}`, data),
  delete: (id: number) => api.delete(`/pension/${id}`),
};

// Assets
export const assetsApi = {
  list: () => api.get("/assets"),
  create: (data: Record<string, unknown>) => api.post("/assets", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/assets/${id}`, data),
  delete: (id: number) => api.delete(`/assets/${id}`),
};

// Forecasting (Predictive Budgeting Engine)
export const forecastingApi = {
  /** Generate a forecast for the given horizon and peer profile */
  generate: (payload: Record<string, unknown>) =>
    api.post("/forecasting/scenario", payload),
  /** Raw historical time-series analysis */
  analysis: (params?: { account_ids?: string; lookback_months?: number }) =>
    api.get("/forecasting/analysis", { params }),
  /** Peer-group CHF defaults */
  peerBaseline: (params: {
    age_group?: string;
    canton?: string;
    household_type?: string;
    employment_status?: string;
    income_level?: string;
  }) => api.get("/forecasting/peer-baseline", { params }),
  /** Saved scenarios */
  listScenarios: () => api.get("/forecasting/scenarios"),
  saveScenario: (data: Record<string, unknown>) =>
    api.post("/forecasting/scenarios", data),
  deleteScenario: (id: number) => api.delete(`/forecasting/scenarios/${id}`),
};

// Recurring Plan (Budgetplan)
export const recurringPlanApi = {
  list: (params?: { year?: number; is_future?: boolean }) =>
    api.get("/recurring-plan", { params }),
  create: (data: Record<string, unknown>) => api.post("/recurring-plan", data),
  update: (id: number, data: Record<string, unknown>) =>
    api.put(`/recurring-plan/${id}`, data),
  delete: (id: number) => api.delete(`/recurring-plan/${id}`),
  suggest: (source: "historical" | "empirical", year: number) =>
    api.get("/recurring-plan/suggest", { params: { source, year } }),
  prefill: (payload: {
    source: "historical" | "empirical";
    year: number;
    target_year: number;
    entries?: Array<{
      description: string;
      amount: number;
      periodicity: string;
      category?: string | null;
      notes?: string | null;
      source: string;
    }>;
  }) => api.post("/recurring-plan/prefill", payload),
  reconciliation: (year: number, month?: number) =>
    api.get("/recurring-plan/reconciliation", { params: { year, month } }),
  /** Alles oder nichts — siehe backend/app/api/recurring_plan.py */
  batch: (payload: {
    create?: Record<string, unknown>[];
    update?: Array<{ id: number } & Record<string, unknown>>;
    delete?: number[];
  }) => api.post("/recurring-plan/batch", payload),
};

/** Plan-Ist-Abgleich — siehe backend/app/api/recurring_plan.py */
export type ReconciliationStatus = "booked" | "deviating" | "open" | "overdue";

export interface ReconciliationEntry {
  plan_id: number;
  description: string;
  month: number;
  periodicity: string;
  expected: number;
  actual: number | null;
  status: ReconciliationStatus;
  matched_transaction_ids: number[];
}

export interface ReconciliationResponse {
  year: number;
  entries: ReconciliationEntry[];
  booked_count: number;
  open_count: number;
  overdue_count: number;
  deviating_count: number;
}

// Onboarding — siehe backend/app/api/onboarding.py
export interface OnboardingStatus {
  has_accounts: boolean;
  has_transactions: boolean;
  transaction_count: number;
  has_wizard: boolean;
  has_plan: boolean;
  is_demo: boolean;
  completeness_pct: number;
}

export interface ReviewGroup {
  merchant: string;
  category: string | null;
  count: number;
  total: number;
  sample_description: string;
}

export const onboardingApi = {
  status: () => api.get<OnboardingStatus>("/onboarding/status"),
  loadDemo: () => api.post("/onboarding/demo"),
  removeDemo: () => api.delete("/onboarding/demo"),
  review: () => api.get<ReviewGroup[]>("/onboarding/review"),
  confirmReview: (entries: Array<{ merchant: string; category: string }>) =>
    api.post("/onboarding/review", entries),
};

// Settings (category mappings)
export const settingsApi = {
  getCategoryMappings: () => api.get("/settings/category-mappings"),
  putCategoryMappings: (mappings: Array<{ wizard_label: string; transaction_category: string }>) =>
    api.put("/settings/category-mappings", { mappings }),
  resetCategoryMappings: () => api.delete("/settings/category-mappings"),
};

// PDF-Import als Hintergrundjob — siehe backend/app/api/imports.py
export type ImportJobStatus = "pending" | "processing" | "completed" | "failed" | "partial";

export interface ImportJob {
  import_id: number;
  status: ImportJobStatus;
  filename: string;
  // Ziel-Konto des Jobs — zum Wiederherstellen der Auswahl
  account_id: number | null;
  chunks_done: number;
  chunks_total: number;
  error_message: string | null;
  // Erst bei status === "completed" gefüllt; Form entspricht der Vorschau
  result: Record<string, unknown> | null;
}

export const isImportJobRunning = (job?: ImportJob | null): boolean =>
  job?.status === "pending" || job?.status === "processing";

// Passkeys (WebAuthn) — siehe backend/app/api/webauthn.py
export interface PasskeyCredential {
  id: number;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export const SESSION_TIMEOUTS = ["15m", "1h", "6h", "24h", "7d", "30d"] as const;
export type SessionTimeout = (typeof SESSION_TIMEOUTS)[number];

export const passkeysApi = {
  // Die Options-Endpunkte liefern JSON als String, so wie die WebAuthn-Spec
  // es erwartet — er geht unveraendert an den Browser weiter.
  /** Verlangt das aktuelle Passwort — ein Passkey ist ein zweiter Schluessel zum Konto. */
  registerOptions: (password: string) =>
    api.post<string>("/auth/webauthn/register/options", { password }),
  registerVerify: (credential: unknown, deviceName?: string) =>
    api.post<PasskeyCredential>("/auth/webauthn/register/verify", {
      credential,
      device_name: deviceName || null,
    }),
  loginOptions: () => api.post<string>("/auth/webauthn/login/options"),
  loginVerify: (credential: unknown) =>
    api.post<{ access_token: string; user_id: number; name: string; email: string }>(
      "/auth/webauthn/login/verify",
      { credential },
    ),
  list: () => api.get<PasskeyCredential[]>("/auth/webauthn/credentials"),
  remove: (id: number) => api.delete(`/auth/webauthn/credentials/${id}`),
};

// KI-Anbieter / Modellauswahl — siehe backend/app/services/ai_client.py
// Anbieterliste und Profil-Modell wie im Schwesterprojekt fintools.
export type AiProvider = string; // "none" oder eine ID aus /settings/ai/providers

export interface AiProviderInfo {
  id: string;
  label: string;
  url: string;
  // Leer = lokaler Anbieter ohne Key
  key_url: string;
  placeholder: string;
  // i18n-Schlüssel eines Warnhinweises unter dem Key-Feld
  note: string;
  local: boolean;
}

export interface AiProfile {
  endpoint: string;
  model: string;
  // API-Keys kommen nie zurück — nur ob einer hinterlegt ist
  has_key: boolean;
  // Der letzte Verbindungstest mit genau diesen Werten war erfolgreich
  ok: boolean;
}

export interface AiSettings {
  provider: AiProvider;
  profiles: Record<string, AiProfile>;
  // Textmenge pro KI-Anfrage. 0 = automatisch aus dem Kontextfenster ableiten.
  context_chars_override: number;
  // Erkanntes Kontextfenster des Modells (Tokens), null wenn unbekannt
  detected_context_tokens: number | null;
  // Was tatsächlich verwendet wird — erkannt oder übersteuert
  effective_context_chars: number;
}

export interface AiProfileUpdate {
  endpoint?: string;
  model?: string;
  // Weglassen = unverändert, "" = löschen
  key?: string;
  ok?: boolean;
}

export interface AiSettingsUpdate {
  provider?: AiProvider;
  profiles?: Record<string, AiProfileUpdate>;
  context_chars_override?: number;
}

export interface AiTestResult {
  ok: boolean;
  models: string[] | null;
  model: string;
  reply: string;
  latency_ms: number;
  error: string;
}

export const aiApi = {
  get: () => api.get<AiSettings>("/settings/ai"),
  update: (data: AiSettingsUpdate) => api.put<AiSettings>("/settings/ai", data),
  providers: () => api.get<AiProviderInfo[]>("/settings/ai/providers"),
  models: (provider: AiProvider, endpoint?: string) =>
    api.get<string[]>("/settings/ai/models", { params: { provider, endpoint } }),
  // Ohne `key` prüft der Server mit dem gespeicherten — der Browser kennt ihn nicht.
  // Ein Modell, das erst geladen werden muss, braucht länger als die üblichen 30 s.
  test: (data: { provider: AiProvider; endpoint?: string; model?: string; key?: string }) =>
    api.post<AiTestResult>("/settings/ai/test", data, { timeout: 120_000 }),
};

// Wizard state (raw data blob from wizard onboarding)
export const wizardApi = {
  getState: () => api.get<Record<string, unknown>>("/wizard/state"),
  getPeerConfig: () => api.get<Record<string, number | undefined>>("/wizard/peer-config"),
};

// Budget Health Score
export const healthApi = {
  score: (params?: { start?: string; end?: string; mode?: string }) =>
    api.get<{
      score: number;
      grade: string;
      components: Array<{
        name: string; score: number; weight: number; detail: string;
        // i18n-Schluessel des Backends; name/detail bleiben deutscher Rueckfall
        name_key?: string | null;
        detail_key?: string | null;
        detail_params?: Record<string, string | number> | null;
      }>;
      top_levers: Array<{
        title: string; body: string; potential: number;
        title_key?: string | null;
        body_key?: string | null;
        body_params?: Record<string, string | number> | null;
      }>;
    }>("/budget/health-score", { params }),
};

// Notifications / Anomalies
export const notificationsApi = {
  list: (params?: { lookback_days?: number; recent_days?: number }) =>
    api.get("/notifications", { params }),
  count: () => api.get<{ total: number; alerts: number; warnings: number }>("/notifications/count"),
};

// Goals
export const goalsApi = {
  list: () => api.get("/goals"),
  create: (data: Record<string, unknown>) => api.post("/goals", data),
  update: (id: number, data: Record<string, unknown>) => api.put(`/goals/${id}`, data),
  delete: (id: number) => api.delete(`/goals/${id}`),
};

// Backup / Export / Import
export const backupApi = {
  /** Download a full JSON backup for the current user. Returns raw blob response. */
  export: () => api.get("/backup/export", { responseType: "blob" }),

  /** Dasselbe inkl. API-Keys im Klartext. Nur mit Passwort — im Body, nie in der URL. */
  exportWithSecrets: (password: string) =>
    api.post("/backup/export-secrets", { password }, { responseType: "blob" }),

  /** Restore from a parsed backup JSON object. Returns BackupImportResult. */
  import: (payload: {
    backup: Record<string, unknown>;
    overwrite_profile?: boolean;
    import_transactions?: boolean;
    import_recurring_plan?: boolean;
    import_wizard_config?: boolean;
    import_pension_assets?: boolean;
    import_settings?: boolean;
  }) => api.post("/backup/import", payload),
};

export default api;
