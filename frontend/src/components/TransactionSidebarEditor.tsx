import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { transactionsApi, categoriesApi } from "@/lib/api";
import { formatCHF, getFrequencyStyle, PERIODICITY_LABELS } from "@/lib/theme";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { clsx } from "clsx";
import { Check, Dollar, FloppyDisk, Label, NavArrowRight, Refresh, Undo, WarningCircle, Xmark } from "@/lib/icons";

type RecurrenceType = "weekly" | "monthly" | "quarterly" | "halfyearly" | "yearly";

interface Transaction {
  id: number;
  date: string;
  description: string;
  merchant_normalized?: string;
  amount: number;
  currency: string;
  category?: string;
  subcategory?: string;
  is_recurring?: boolean;
  periodicity?: RecurrenceType;
  notes?: string;
  account_name?: string;
}

interface Props {
  transactions: Transaction[];
  periodLabel: string;
  onClose: () => void;
}

const ALL_PERIODICITIES: RecurrenceType[] = ["weekly", "monthly", "quarterly", "halfyearly", "yearly"];

const PERIODICITY_LABELS_FULL: Record<RecurrenceType, string> = {
  weekly:     "Wöchentlich",
  monthly:    "Monatlich",
  quarterly:  "Vierteljährlich",
  halfyearly: "Halbjährlich",
  yearly:     "Jährlich",
};

export default function TransactionSidebarEditor({ transactions, periodLabel, onClose }: Props) {
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);

  // ── State ─────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Edit draft for the selected transaction
  const [draft, setDraft] = useState<Partial<Transaction>>({});
  const [dirty, setDirty] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);

  // Optimistic local overrides keyed by transaction id (applied until query refetches)
  const [localUpdates, setLocalUpdates] = useState<Record<number, Partial<Transaction>>>({});

  // ── Categories ────────────────────────────────────────────
  const { data: categoriesRaw } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  // Deduplicated API categories merged with any txn-only categories (e.g. "Taxes", "Finance")
  const categories: string[] = useMemo(() => {
    const apiNames: string[] = (categoriesRaw || []).map((c: { name: string }) => c.name);
    const txnNames: string[] = transactions
      .map((t) => t.category)
      .filter((c): c is string => !!c);
    const merged = Array.from(new Set([...apiNames, ...txnNames]));
    return merged.sort((a, b) => a.localeCompare(b, "de"));
  }, [categoriesRaw, transactions]);

  // Merge server transactions with local optimistic updates
  const mergedTransactions = useMemo(
    () => transactions.map((t) => localUpdates[t.id] ? { ...t, ...localUpdates[t.id] } : t),
    [transactions, localUpdates]
  );

  // ── Derived: distinct category list from transactions ─────
  const txnCategories = Array.from(
    new Set(mergedTransactions.map((t) => t.category).filter(Boolean))
  ).sort() as string[];

  // ── Filtered transaction list ─────────────────────────────
  const filtered = mergedTransactions.filter((t) => {
    const matchSearch =
      !search ||
      t.description.toLowerCase().includes(search.toLowerCase()) ||
      (t.merchant_normalized || "").toLowerCase().includes(search.toLowerCase());
    const matchCat =
      categoryFilter === "all" || t.category === categoryFilter;
    return matchSearch && matchCat;
  });

  // ── Select a transaction ──────────────────────────────────
  const selected = mergedTransactions.find((t) => t.id === selectedId) ?? null;

  function selectTxn(txn: Transaction) {
    if (dirty) {
      if (!confirm("Ungespeicherte Änderungen verwerfen?")) return;
    }
    setSelectedId(txn.id);
    setDraft({
      category: txn.category ?? "",
      is_recurring: txn.is_recurring ?? false,
      periodicity: txn.periodicity ?? "monthly",
      amount: txn.amount,
      notes: txn.notes ?? "",
    });
    setDirty(false);
    setSavedId(null);
  }

  function updateDraft(patch: Partial<Transaction>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  // ── Save mutation ─────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: (payload: { id: number; data: Record<string, unknown> }) =>
      transactionsApi.update(payload.id, payload.data),
    onSuccess: (data, vars) => {
      // Update the local transaction in the list so the sidebar row reflects the save immediately
      setLocalUpdates((prev) => ({ ...prev, [vars.id]: data.data }));
      queryClient.invalidateQueries({ queryKey: ["historical-transactions-budget"] });
      queryClient.invalidateQueries({ queryKey: ["transaction-stats-budget"] });
      queryClient.invalidateQueries({ queryKey: ["peer-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["budget-capabilities"] });
      setDirty(false);
      setSavedId(vars.id);
      setTimeout(() => setSavedId(null), 2000);
    },
  });

  function handleSave() {
    if (!selectedId || !dirty) return;
    const payload: Record<string, unknown> = {
      category: draft.category || null,
      is_recurring: draft.is_recurring ?? false,
      periodicity: draft.is_recurring ? (draft.periodicity ?? "monthly") : null,
      notes: draft.notes ?? null,
      user_verified: true,
    };
    // Only include amount if changed
    if (draft.amount !== selected?.amount) {
      payload.amount = draft.amount;
    }
    saveMutation.mutate({ id: selectedId, data: payload });
  }

  function handleDiscard() {
    if (!selected) return;
    setDraft({
      category: selected.category ?? "",
      is_recurring: selected.is_recurring ?? false,
      periodicity: selected.periodicity ?? "monthly",
      amount: selected.amount,
      notes: selected.notes ?? "",
    });
    setDirty(false);
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
              <h2 className="text-text-primary font-semibold text-base">Transaktionen bearbeiten</h2>
              <p className="text-text-tertiary text-xs mt-0.5">{periodLabel} · {mergedTransactions.length} Transaktionen</p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
              title="Schliessen (Esc)"
            >
              <Xmark className="w-5 h-5" />
            </button>
          </div>

          {/* Search + category filter */}
          <div className="flex gap-2 mt-3">
            <input
              type="text"
              placeholder="Suchen…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-slate-400"
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="bg-slate-700/60 border border-slate-600 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-slate-400 max-w-[140px]"
            >
              <option value="all">Alle Kat.</option>
              {txnCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Scrollable transaction list ────────────────────── */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-text-tertiary text-sm text-center py-10">Keine Transaktionen gefunden</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {filtered.map((txn) => {
                const isSelected = selectedId === txn.id;
                const isSaved = savedId === txn.id;
                return (
                  <button
                    key={txn.id}
                    onClick={() => selectTxn(txn)}
                    className={clsx(
                      "w-full text-left px-4 py-3 transition-colors flex items-start gap-3",
                      isSelected
                        ? "bg-accent/10 border-l-2 border-accent"
                        : "border-l-2 border-transparent hover:bg-slate-800/60"
                    )}
                  >
                    {/* Amount badge */}
                    <span className={clsx(
                      "text-xs font-mono mt-0.5 shrink-0 w-20 text-right",
                      txn.amount < 0 ? "text-loss" : "text-gain"
                    )}>
                      {formatCHF(txn.amount)}
                    </span>

                    {/* Description + meta */}
                    <div className="flex-1 min-w-0">
                      <p className="text-text-primary text-sm truncate">
                        {txn.merchant_normalized || txn.description}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-text-tertiary text-xs">
                          {format(new Date(txn.date), "dd.MM.yy", { locale: de })}
                        </span>
                        {txn.category && (
                          <span className="text-xs text-text-tertiary bg-slate-800 px-1.5 py-0.5 rounded">
                            {txn.category}
                          </span>
                        )}
                        {txn.is_recurring && txn.periodicity && (
                          <span className={clsx(
                            "text-xs px-1.5 py-0.5 rounded border",
                            getFrequencyStyle(txn.periodicity)
                          )}>
                            {PERIODICITY_LABELS[txn.periodicity] ?? txn.periodicity}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* State indicator */}
                    <div className="shrink-0 mt-1">
                      {isSaved ? (
                        <Check className="w-4 h-4 text-gain" />
                      ) : isSelected ? (
                        <NavArrowRight className="w-4 h-4 text-accent" />
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Detail editor (shown when a transaction is selected) ── */}
        {selected && (
          <div className="shrink-0 border-t border-slate-700 bg-slate-800 max-h-[55vh] overflow-y-auto">

            {/* Editor header */}
            <div className="px-5 py-3 border-b border-slate-700/60 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-text-primary text-base font-medium whitespace-normal break-words">
                  {selected.merchant_normalized || selected.description}
                </p>
                <p className="text-text-tertiary text-xs mt-0.5">
                  {format(new Date(selected.date), "dd. MMMM yyyy", { locale: de })}
                  {selected.account_name && ` · ${selected.account_name}`}
                </p>
              </div>
              {dirty && (
                <span className="text-xs text-warning bg-warning/10 px-2 py-0.5 rounded-full border border-warning/30 shrink-0 ml-3">
                  Ungespeichert
                </span>
              )}
            </div>

            <div className="px-5 py-4 space-y-4">

              {/* Category */}
              <div>
                <label className="flex items-center gap-1.5 text-xs text-text-tertiary uppercase tracking-wide mb-1.5">
                  <Label className="w-3.5 h-3.5" /> Kategorie
                </label>
                <select
                  value={draft.category ?? ""}
                  onChange={(e) => updateDraft({ category: e.target.value })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-accent"
                >
                  <option value="">— Keine Kategorie —</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* Recurring + Frequency */}
              <div>
                <label className="flex items-center gap-1.5 text-xs text-text-tertiary uppercase tracking-wide mb-2">
                  <Refresh className="w-3.5 h-3.5" /> Wiederkehrend
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {/* Toggle buttons */}
                  <button
                    type="button"
                    onClick={() => updateDraft({ is_recurring: false })}
                    className={clsx(
                      "px-3 py-1.5 rounded-lg text-sm border transition-all",
                      !draft.is_recurring
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-slate-600 bg-slate-700/50 text-text-tertiary hover:border-slate-500"
                    )}
                  >
                    Einmalig
                  </button>
                  <button
                    type="button"
                    onClick={() => updateDraft({ is_recurring: true })}
                    className={clsx(
                      "px-3 py-1.5 rounded-lg text-sm border transition-all",
                      draft.is_recurring
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-slate-600 bg-slate-700/50 text-text-tertiary hover:border-slate-500"
                    )}
                  >
                    Wiederkehrend
                  </button>
                </div>

                {draft.is_recurring && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {ALL_PERIODICITIES.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => updateDraft({ periodicity: p })}
                        className={clsx(
                          "px-2.5 py-1 rounded-md text-xs border transition-all",
                          draft.periodicity === p
                            ? getFrequencyStyle(p)
                            : "border-slate-600 bg-slate-700/40 text-text-tertiary hover:border-slate-500"
                        )}
                      >
                        {PERIODICITY_LABELS_FULL[p]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Amount */}
              <div>
                <label className="flex items-center gap-1.5 text-xs text-text-tertiary uppercase tracking-wide mb-1.5">
                  <Dollar className="w-3.5 h-3.5" /> Betrag (CHF)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={draft.amount ?? ""}
                  onChange={(e) => updateDraft({ amount: parseFloat(e.target.value) || 0 })}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-accent"
                />
                {draft.amount !== selected.amount && (
                  <p className="text-xs text-text-tertiary mt-1">
                    Original: <span className="font-mono">{formatCHF(selected.amount)}</span>
                  </p>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs text-text-tertiary uppercase tracking-wide mb-1.5 block">
                  Notiz (optional)
                </label>
                <textarea
                  rows={2}
                  value={draft.notes ?? ""}
                  onChange={(e) => updateDraft({ notes: e.target.value })}
                  placeholder="Interne Notiz…"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 resize-none focus:outline-none focus:border-accent"
                />
              </div>

              {/* Error */}
              {saveMutation.isError && (
                <div className="flex items-center gap-2 text-loss text-xs bg-loss/10 border border-loss/30 rounded-lg px-3 py-2">
                  <WarningCircle className="w-4 h-4 shrink-0" />
                  Fehler beim Speichern. Bitte erneut versuchen.
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="px-5 pb-5 flex gap-3">
              <button
                type="button"
                onClick={handleDiscard}
                disabled={!dirty}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-600 text-text-secondary text-sm hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                <Undo className="w-3.5 h-3.5" />
                Verwerfen
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || saveMutation.isPending}
                className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
              >
                {saveMutation.isPending ? (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <FloppyDisk className="w-3.5 h-3.5" />
                )}
                Änderungen speichern
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
