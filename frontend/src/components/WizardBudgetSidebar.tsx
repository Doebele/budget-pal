import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { budgetsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { clsx } from "clsx";
import { X, Save, AlertCircle, DollarSign, ChevronDown } from "lucide-react";
import {
  SUPER_CATEGORIES,
  resolveSuperCategory,
  type SuperCategory,
} from "@/lib/categories";

interface WizardBudget {
  id: number;
  notes: string | null;
  amount: number;
  year: number;
  period: string;
  month?: number | null;
  created_at?: string;
}

interface Props {
  periodLabel: string;
  months: number;
  /** When set, initially filter to this supercategory id */
  initialScId?: string;
  onClose: () => void;
}

// ── Supercategories that have wizard labels ────────────────────
const SC_WITH_WIZARD = SUPER_CATEGORIES.filter((sc) => sc.wizardLabels.length > 0 || sc.id === "sonstiges");

export default function WizardBudgetSidebar({ periodLabel, months, initialScId, onClose }: Props) {
  const queryClient = useQueryClient();

  // ── Selected supercategory filter ("" = show all) ─────────────
  const [activeSc, setActiveSc] = useState<string>(initialScId ?? "");

  // ── Fetch all budgets ─────────────────────────────────────────
  const { data: budgetsRaw, isLoading } = useQuery({
    queryKey: ["wizard-budgets-sidebar"],
    queryFn: () => budgetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });

  // ── Filter to latest wizard batch ─────────────────────────────
  const latestBatch: WizardBudget[] = useMemo(() => {
    if (!budgetsRaw || !Array.isArray(budgetsRaw)) return [];
    const withNotes = (budgetsRaw as WizardBudget[]).filter((b) => b.notes && b.notes.trim() !== "");
    if (!withNotes.length) return [];

    // Strategy 1: use created_at timestamps when available
    const hasTimestamps = withNotes.some((b) => !!b.created_at);
    if (hasTimestamps) {
      const maxTs = withNotes.reduce(
        (max, b) => ((b.created_at || "") > max ? b.created_at || "" : max),
        ""
      );
      const batch = withNotes.filter((b) => b.created_at === maxTs);
      if (batch.length > 0) return batch;
    }

    // Strategy 2 (fallback): deduplicate by notes label — keep entry with highest id
    // This handles the case where created_at is null (backend not yet reloaded)
    const byNote = new Map<string, WizardBudget>();
    for (const b of withNotes) {
      const key = (b.notes ?? "").toLowerCase().trim();
      const existing = byNote.get(key);
      if (!existing || b.id > existing.id) {
        byNote.set(key, b);
      }
    }
    return [...byNote.values()];
  }, [budgetsRaw]);

  // ── Filter by active supercategory ────────────────────────────
  const visibleBudgets = useMemo(() => {
    if (!activeSc) return latestBatch;
    const sc = SUPER_CATEGORIES.find((s) => s.id === activeSc);
    if (!sc) return latestBatch;
    return latestBatch.filter((b) => {
      const resolved = resolveSuperCategory(b.notes ?? "", true);
      return resolved.id === sc.id;
    });
  }, [latestBatch, activeSc]);

  // ── Draft state: id → monthly amount string ───────────────────
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<number>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!latestBatch.length) return;
    setDrafts(Object.fromEntries(latestBatch.map((b) => [b.id, String(b.amount)])));
  }, [latestBatch]);

  function updateDraft(id: number, val: string) {
    setDrafts((prev) => ({ ...prev, [id]: val }));
    setDirtyIds((prev) => new Set(prev).add(id));
    setSavedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }

  // ── Save mutation ─────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: ({ id, amount, year, period }: { id: number; amount: number; year: number; period: string }) =>
      // Send year + period alongside amount so the call works with both the
      // old BudgetCreate endpoint (which required year) and the new BudgetUpdate one.
      budgetsApi.update(id, { amount, year, period }),
    onSuccess: (_data, vars) => {
      setDirtyIds((prev) => { const n = new Set(prev); n.delete(vars.id); return n; });
      setSavedIds((prev) => new Set(prev).add(vars.id));
      queryClient.invalidateQueries({ queryKey: ["wizard-budgets-sidebar"] });
      queryClient.invalidateQueries({ queryKey: ["wizard-budgets-budget"] });
      queryClient.invalidateQueries({ queryKey: ["wizard-budgets-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["budget-capabilities"] });
      setTimeout(() => {
        setSavedIds((prev) => { const n = new Set(prev); n.delete(vars.id); return n; });
      }, 2000);
    },
  });

  function handleSave(id: number) {
    const raw = drafts[id];
    const amount = parseFloat(raw);
    if (isNaN(amount) || amount < 0) return;
    const budget = latestBatch.find((b) => b.id === id);
    if (!budget) return;
    saveMutation.mutate({ id, amount, year: budget.year, period: budget.period });
  }

  function handleSaveAll() {
    for (const id of dirtyIds) handleSave(id);
  }

  // Close on Escape
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  // ── Totals (based on visible items only) ─────────────────────
  const monthlyTotal = visibleBudgets.reduce((sum, b) => {
    const v = parseFloat(drafts[b.id] ?? String(b.amount));
    return sum + (isNaN(v) ? 0 : v);
  }, 0);
  const periodTotal = monthlyTotal * months;

  // ── Supercategory options for the dropdown ────────────────────
  // Only show SCs that have at least one entry in the current batch
  const availableScs: SuperCategory[] = useMemo(() => {
    const scIds = new Set(
      latestBatch.map((b) => resolveSuperCategory(b.notes ?? "", true).id)
    );
    return SUPER_CATEGORIES.filter((sc) => scIds.has(sc.id) && sc.id !== "sparen");
  }, [latestBatch]);

  const activeSCObj = SUPER_CATEGORIES.find((s) => s.id === activeSc);

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-slate-900 border-l border-slate-700 flex flex-col z-50 shadow-2xl">

        {/* ── Sticky Header ──────────────────────────────────── */}
        <div className="shrink-0 px-5 py-4 border-b border-slate-700 bg-slate-800/90 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-text-primary font-semibold text-base">Empirische Budgets bearbeiten</h2>
              <p className="text-text-tertiary text-xs mt-0.5">
                {periodLabel} · {visibleBudgets.length} von {latestBatch.length} Positionen
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Category filter dropdown */}
          <div className="mt-3 relative">
            <div className="flex items-center gap-1.5">
              {activeSCObj && (
                <span
                  className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                  style={{ backgroundColor: activeSCObj.color + "22" }}
                >
                  <activeSCObj.icon className="w-4 h-4" style={{ color: activeSCObj.color }} />
                </span>
              )}
              <select
                value={activeSc}
                onChange={(e) => setActiveSc(e.target.value)}
                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent appearance-none cursor-pointer pr-8"
              >
                <option value="">Alle Kategorien ({latestBatch.length})</option>
                {availableScs.map((sc) => {
                  const count = latestBatch.filter((b) =>
                    resolveSuperCategory(b.notes ?? "", true).id === sc.id
                  ).length;
                  return (
                    <option key={sc.id} value={sc.id}>
                      {sc.emoji} {sc.label} ({count})
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {months > 1 && (
            <div className="mt-2 px-3 py-2 bg-slate-700/40 rounded-lg text-xs text-text-tertiary">
              Monatlich × {months} Monate = Periodengesamtbetrag
            </div>
          )}
        </div>

        {/* ── Scrollable budget list ─────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="text-text-tertiary text-sm text-center py-10">Wird geladen…</p>
          ) : visibleBudgets.length === 0 ? (
            <p className="text-text-tertiary text-sm text-center py-10 px-5">
              {latestBatch.length === 0
                ? "Keine Budgets aus empirischen Angaben. Bitte zuerst den Setup-Wizard abschliessen."
                : "Keine Einträge für diese Kategorie."}
            </p>
          ) : (
            <div className="divide-y divide-slate-800">
              {visibleBudgets.map((b) => {
                const isDirty = dirtyIds.has(b.id);
                const isSaved = savedIds.has(b.id);
                const monthlyVal = parseFloat(drafts[b.id] ?? String(b.amount));
                const periodVal = isNaN(monthlyVal) ? 0 : monthlyVal * months;
                const sc = resolveSuperCategory(b.notes ?? "", true);

                return (
                  <div key={b.id} className="px-5 py-3">
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: sc.color + "22" }}
                        >
                          <sc.icon className="w-3.5 h-3.5" style={{ color: sc.color }} />
                        </span>
                        <span className="text-text-primary text-sm font-medium truncate">
                          {b.notes}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isSaved && (
                          <span className="text-xs text-gain bg-gain/10 px-2 py-0.5 rounded-full border border-gain/30">
                            Gespeichert
                          </span>
                        )}
                        {isDirty && !isSaved && (
                          <span className="text-xs text-warning bg-warning/10 px-2 py-0.5 rounded-full border border-warning/30">
                            Geändert
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {/* Monthly amount input */}
                      <div className="flex-1">
                        <label className="flex items-center gap-1 text-xs text-text-tertiary mb-1">
                          <DollarSign className="w-3 h-3" /> Monatlich (CHF)
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={drafts[b.id] ?? b.amount}
                          onChange={(e) => updateDraft(b.id, e.target.value)}
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-accent"
                        />
                      </div>

                      {/* Period total hint */}
                      {months > 1 && (
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-text-tertiary mb-1">× {months} Monate</p>
                          <p className="text-sm font-mono text-violet-400">{formatCHF(periodVal)}</p>
                        </div>
                      )}

                      {/* Save button */}
                      <button
                        type="button"
                        onClick={() => handleSave(b.id)}
                        disabled={!isDirty || saveMutation.isPending}
                        className={clsx(
                          "shrink-0 p-2 rounded-lg border transition-all",
                          isDirty
                            ? "border-accent bg-accent/15 text-accent hover:bg-accent/25"
                            : "border-slate-600 bg-slate-700/30 text-slate-600 cursor-not-allowed",
                        )}
                      >
                        <Save className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────── */}
        {visibleBudgets.length > 0 && (
          <div className="shrink-0 border-t border-slate-700 bg-slate-800 px-5 py-4">
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="text-text-tertiary">
                {activeSc ? "Kategorie-Summe / Monat" : "Gesamtausgaben / Monat"}
              </span>
              <span className="font-mono text-text-primary">{formatCHF(monthlyTotal)}</span>
            </div>
            {months > 1 && (
              <div className="flex items-center justify-between mb-3 text-sm">
                <span className="text-text-tertiary">
                  {activeSc ? "Kategorie-Summe" : "Gesamtausgaben"} / Periode ({months} Monate)
                </span>
                <span className="font-mono text-violet-400">{formatCHF(periodTotal)}</span>
              </div>
            )}

            {saveMutation.isError && (
              <div className="flex items-center gap-2 text-loss text-xs bg-loss/10 border border-loss/30 rounded-lg px-3 py-2 mb-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Fehler beim Speichern. Bitte erneut versuchen.
              </div>
            )}

            <button
              type="button"
              onClick={handleSaveAll}
              disabled={dirtyIds.size === 0 || saveMutation.isPending}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              {saveMutation.isPending ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Alle Änderungen speichern{dirtyIds.size > 0 && ` (${dirtyIds.size})`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
