import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { budgetsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { clsx } from "clsx";
import { X, Save, AlertCircle, DollarSign } from "lucide-react";

interface WizardBudget {
  id: number;
  notes: string | null;
  amount: number;
}

interface Props {
  periodLabel: string;
  months: number;
  onClose: () => void;
}

export default function WizardBudgetSidebar({ periodLabel, months, onClose }: Props) {
  const queryClient = useQueryClient();

  // ── Fetch wizard budgets ──────────────────────────────────
  const { data: budgetsRaw, isLoading } = useQuery({
    queryKey: ["wizard-budgets-sidebar"],
    queryFn: () => budgetsApi.list().then((r) => r.data),
    staleTime: 30_000,
  });

  // Filter to wizard budgets (those with notes set) — latest batch
  const wizardBudgets: WizardBudget[] = useMemo(() => {
    if (!budgetsRaw || !Array.isArray(budgetsRaw)) return [];
    // Latest created_at
    const withNotes = budgetsRaw.filter((b: WizardBudget & { created_at?: string }) => b.notes);
    if (!withNotes.length) return [];
    const maxTs = withNotes.reduce(
      (max: string, b: WizardBudget & { created_at?: string }) =>
        (b.created_at || "") > max ? b.created_at || "" : max,
      ""
    );
    return withNotes.filter(
      (b: WizardBudget & { created_at?: string }) => b.created_at === maxTs
    );
  }, [budgetsRaw]);

  // ── Draft state: id → monthly amount ─────────────────────
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<number>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());

  // Initialise drafts when budgets load
  useEffect(() => {
    if (!wizardBudgets.length) return;
    setDrafts(
      Object.fromEntries(wizardBudgets.map((b) => [b.id, String(b.amount)]))
    );
  }, [wizardBudgets]);

  function updateDraft(id: number, val: string) {
    setDrafts((prev) => ({ ...prev, [id]: val }));
    setDirtyIds((prev) => new Set(prev).add(id));
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // ── Save mutation ─────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) =>
      budgetsApi.update(id, { amount }),
    onSuccess: (_data, vars) => {
      setDirtyIds((prev) => {
        const next = new Set(prev);
        next.delete(vars.id);
        return next;
      });
      setSavedIds((prev) => new Set(prev).add(vars.id));
      queryClient.invalidateQueries({ queryKey: ["multi-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["budget-capabilities"] });
      queryClient.invalidateQueries({ queryKey: ["wizard-budgets-sidebar"] });
      setTimeout(() => {
        setSavedIds((prev) => {
          const next = new Set(prev);
          next.delete(vars.id);
          return next;
        });
      }, 2000);
    },
  });

  function handleSave(id: number) {
    const raw = drafts[id];
    const amount = parseFloat(raw);
    if (isNaN(amount) || amount < 0) return;
    saveMutation.mutate({ id, amount });
  }

  function handleSaveAll() {
    for (const id of dirtyIds) {
      handleSave(id);
    }
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const monthlyTotal = wizardBudgets.reduce((sum, b) => {
    const val = parseFloat(drafts[b.id] ?? String(b.amount));
    return sum + (isNaN(val) ? 0 : val);
  }, 0);

  const periodTotal = monthlyTotal * months;

  // ── Render ────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-slate-900 border-l border-slate-700 flex flex-col z-50 shadow-2xl">

        {/* ── Sticky Header ─────────────────────────────────── */}
        <div className="shrink-0 px-5 py-4 border-b border-slate-700 bg-slate-800/90 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-text-primary font-semibold text-base">Empirische Budgets bearbeiten</h2>
              <p className="text-text-tertiary text-xs mt-0.5">{periodLabel} · {wizardBudgets.length} Positionen</p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
              title="Schliessen (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Period hint */}
          {months > 1 && (
            <div className="mt-3 px-3 py-2 bg-slate-700/40 rounded-lg text-xs text-text-tertiary">
              Monatlich × {months} Monate = Periodengesamtbetrag
            </div>
          )}
        </div>

        {/* ── Scrollable budget list ─────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="text-text-tertiary text-sm text-center py-10">Wird geladen…</p>
          ) : wizardBudgets.length === 0 ? (
            <p className="text-text-tertiary text-sm text-center py-10">
              Keine Budgets aus empirischen Angaben. Bitte zuerst unter «Empirische Angaben» abschliessen.
            </p>
          ) : (
            <div className="divide-y divide-slate-800">
              {wizardBudgets.map((b) => {
                const isDirty = dirtyIds.has(b.id);
                const isSaved = savedIds.has(b.id);
                const monthlyVal = parseFloat(drafts[b.id] ?? String(b.amount));
                const periodVal = isNaN(monthlyVal) ? 0 : monthlyVal * months;
                return (
                  <div key={b.id} className="px-5 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-text-primary text-sm font-medium">
                        {b.notes}
                      </span>
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

                      {/* Period total (read-only hint) */}
                      {months > 1 && (
                        <div className="shrink-0 text-right">
                          <p className="text-xs text-text-tertiary mb-1">
                            × {months} Monate
                          </p>
                          <p className="text-sm font-mono text-violet-400">
                            {formatCHF(periodVal)}
                          </p>
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
                            : "border-slate-600 bg-slate-700/30 text-slate-600 cursor-not-allowed"
                        )}
                        title="Speichern"
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

        {/* ── Footer: totals + save all ─────────────────────── */}
        {wizardBudgets.length > 0 && (
          <div className="shrink-0 border-t border-slate-700 bg-slate-800 px-5 py-4">
            {/* Totals */}
            <div className="flex items-center justify-between mb-3 text-sm">
              <span className="text-text-tertiary">Gesamtausgaben / Monat</span>
              <span className="font-mono text-text-primary">{formatCHF(monthlyTotal)}</span>
            </div>
            {months > 1 && (
              <div className="flex items-center justify-between mb-3 text-sm">
                <span className="text-text-tertiary">Gesamtausgaben / Periode ({months} Monate)</span>
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
              Alle Änderungen speichern
              {dirtyIds.size > 0 && ` (${dirtyIds.size})`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
