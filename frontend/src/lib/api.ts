/**
 * Axios instance with JWT auth interceptor.
 * Automatically attaches Bearer token from localStorage.
 * Redirects to /login on 401.
 */
import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const TOKEN_KEY = "budget_pal_token";

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

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      // Only redirect if not already on auth pages
      if (!window.location.pathname.startsWith("/login") && !window.location.pathname.startsWith("/register")) {
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
  uploadPdf: (formData: FormData) =>
    api.post("/imports/pdf", formData, { headers: { "Content-Type": "multipart/form-data" } }),
  previewPdf: (formData: FormData) =>
    api.post("/imports/pdf/preview", formData, { headers: { "Content-Type": "multipart/form-data" } }),
  confirmPdf: (payload: Record<string, unknown>) => api.post("/imports/pdf/confirm", payload),
  history: () => api.get("/imports/history"),
  preview: (id: number) => api.get(`/imports/${id}/preview`),
  delete: (id: number, deleteTransactions = true) =>
    api.delete(`/imports/${id}?delete_transactions=${deleteTransactions}`),
  previewUpload: (formData: FormData) =>
    api.post("/imports/preview", formData, { headers: { "Content-Type": "multipart/form-data" } }),
};

// Projections
export const projectionsApi = {
  run: (params: Record<string, unknown>, scenarioId?: number) =>
    api.post("/projections/run", params, { params: scenarioId ? { scenario_id: scenarioId } : {} }),
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
export const pensionApi = {
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
};

// Settings (category mappings)
export const settingsApi = {
  getCategoryMappings: () => api.get("/settings/category-mappings"),
  putCategoryMappings: (mappings: Array<{ wizard_label: string; transaction_category: string }>) =>
    api.put("/settings/category-mappings", { mappings }),
  resetCategoryMappings: () => api.delete("/settings/category-mappings"),
};

// Wizard state (raw data blob from wizard onboarding)
export const wizardApi = {
  getState: () => api.get<Record<string, unknown>>("/wizard/state"),
  getPeerConfig: () => api.get<Record<string, number | undefined>>("/wizard/peer-config"),
};

// Budget Health Score
export const healthApi = {
  score: (params?: { start?: string; end?: string }) =>
    api.get<{
      score: number;
      grade: string;
      components: Array<{ name: string; score: number; weight: number; detail: string }>;
      top_levers: Array<{ title: string; body: string; potential: number }>;
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

  /** Restore from a parsed backup JSON object. Returns BackupImportResult. */
  import: (payload: {
    backup: Record<string, unknown>;
    overwrite_profile?: boolean;
    import_transactions?: boolean;
    import_recurring_plan?: boolean;
    import_wizard_config?: boolean;
    import_pension_assets?: boolean;
  }) => api.post("/backup/import", payload),
};

export default api;
