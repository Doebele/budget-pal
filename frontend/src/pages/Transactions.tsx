import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { transactionsApi, accountsApi } from "@/lib/api";
import { formatCHF, getFrequencyBadgeStyle, PERIODICITY_LABELS } from "@/lib/theme";
import { resolveSuperCategory, SUPER_CATEGORIES } from "@/lib/categories";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { Search, Upload, ChevronDown, Check, X, LayoutGrid, Building2, Repeat, Wallet, TrendingUp, PieChart, Trash2 } from "lucide-react";
import GranularityNavigator from "@/components/GranularityNavigator";
import { computeDateRange, TimeGranularity } from "@/lib/granularity";
import { Link } from "react-router-dom";
import { clsx } from "clsx";
import { getBankByName } from "@/data/banks-with-logos";
import { TransactionOverviewHeader } from "@/components/transactions/TransactionOverviewHeader";
import {
  RECURRENCE_FILTER_OPTIONS,
  recurrenceFilterToApiParams,
  type RecurrenceFilterValue,
} from "@/lib/recurrenceFilter";

type RecurrenceType = "weekly" | "monthly" | "quarterly" | "halfyearly" | "yearly";

interface Transaction {
  id: number;
  account_name: string;
  date: string;
  description: string;
  merchant_normalized?: string;
  amount: number;
  currency: string;
  category?: string;
  subcategory?: string;
  confidence_score?: number;
  user_verified: boolean;
  notes?: string;
  is_recurring?: boolean;
  periodicity?: RecurrenceType;
}

interface RecurringCostItem {
  description: string;
  category?: string;
  amount: number;
  periodicity: RecurrenceType;
  monthly_equivalent: number;
}

interface BudgetAnalysis {
  total_monthly_income: number;
  fixed_recurring_costs: number;
  variable_costs: number;
  monthly_budget_limit: number;
  variance: number;
  recurring_items: RecurringCostItem[];
  period_start: string;
  period_end: string;
}

export default function Transactions() {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [recurrenceFilter, setRecurrenceFilter] = useState<RecurrenceFilterValue>("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editCategory, setEditCategory] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const [granularity, setGranularity] = useState<TimeGranularity>("ytd");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState("all");
  const [showBudgetAnalysis, setShowBudgetAnalysis] = useState(false);

  const [showAccountDropdown, setShowAccountDropdown] = useState(false);

  // All selectable categories, grouped by supercategory
  const ALL_CAT_GROUPS = SUPER_CATEGORIES
    .filter((sc) => sc.txnCategories.length > 0)
    .map((sc) => ({ sc, cats: sc.txnCategories }));

  function titleCase(s: string) {
    return s.replace(/(?:^|\s|-)\S/g, (c) => c.toUpperCase());
  }

  // Fetch accounts for filter
  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  type AccountRow = { id: number | string; name: string; bank: string };

  const selectedAccount = useMemo(() => {
    if (viewMode === "all" || !accounts?.length) return null;
    return (accounts as AccountRow[]).find((a) => String(a.id) === String(viewMode)) ?? null;
  }, [viewMode, accounts]);

  /** Avoid preview/delete with a stale id after the account disappeared from the list (e.g. deactivated). */
  useEffect(() => {
    if (viewMode === "all" || accounts === undefined) return;
    const exists = (accounts as AccountRow[]).some((a) => String(a.id) === String(viewMode));
    if (!exists) setViewMode("all");
  }, [viewMode, accounts]);

  const range = useMemo(() => computeDateRange(granularity, anchor), [granularity, anchor]);
  const periodStart = format(range.from, "yyyy-MM-dd");
  const periodEnd   = format(range.to,   "yyyy-MM-dd");

  const { data: transactions, isLoading } = useQuery({
    queryKey: [
      "transactions",
      search,
      categoryFilter,
      recurrenceFilter,
      granularity,
      anchor.toISOString(),
      viewMode,
    ],
    queryFn: () =>
      transactionsApi
        .list({
          q: search || undefined,
          category: categoryFilter || undefined,
          ...recurrenceFilterToApiParams(recurrenceFilter),
          account_id: viewMode === "all" ? undefined : Number(viewMode),
          start: periodStart,
          end: periodEnd,
          limit: 500,
        })
        .then((r) => r.data),
  });

  // Budget analysis query
  const { data: budgetAnalysis } = useQuery({
    queryKey: ["budget-analysis", granularity, anchor.toISOString(), viewMode],
    queryFn: () =>
      transactionsApi
        .budgetAnalysis({
          account_id: viewMode === "all" ? undefined : Number(viewMode),
          start: periodStart,
          end: periodEnd,
        })
        .then((r) => r.data as BudgetAnalysis),
    enabled: showBudgetAnalysis,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      transactionsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => transactionsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      setConfirmingDeleteId(null);
    },
  });

  const handleCategoryEdit = (txn: Transaction) => {
    setEditingId(txn.id);
    setEditCategory(txn.category || "");
  };

  const handleCategorySave = (id: number) => {
    updateMutation.mutate({ id, data: { category: editCategory, user_verified: true } });
  };

  const handleRecurringChange = (txn: Transaction, value: string) => {
    if (value === "") {
      updateMutation.mutate({ id: txn.id, data: { is_recurring: false, periodicity: null } });
    } else {
      updateMutation.mutate({ id: txn.id, data: { is_recurring: true, periodicity: value } });
    }
  };

  const categories = Array.from(
    new Set(
      (transactions || [])
        .map((t: Transaction) => t.category)
        .filter((c): c is string => Boolean(c))
    )
  ).sort();

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Reale Angaben</h1>
          <p className="text-text-tertiary text-sm mt-0.5">
            {range.label} · {transactions?.length || 0} Einträge
          </p>
        </div>
        <Link to="/import" className="btn-primary flex items-center gap-2">
          <Upload className="w-4 h-4" />
          Import
        </Link>
      </div>

      {/* TransactionFilterBar - Account Selection */}
      <div className="sticky top-0 z-20 bg-slate-900 border-b border-slate-700 rounded-lg mb-4">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            {viewMode === "all" ? (
              <LayoutGrid className="w-5 h-5 text-accent" />
            ) : (
              <Building2 className="w-5 h-5 text-accent" />
            )}
            <div>
              <h2 className="text-white text-lg font-medium">
                {viewMode === "all"
                  ? "Alle Konten"
                  : selectedAccount?.name || "Konto"}
              </h2>
              <p className="text-slate-400 text-xs">
                {viewMode === "all"
                  ? `${accounts?.length || 0} Konten aggregiert`
                  : "Einzelkonto-Ansicht"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap justify-end">
            {selectedAccount && (
              <TransactionOverviewHeader
                accountId={Number(selectedAccount.id)}
                accountName={selectedAccount.name}
              />
            )}
            <button
              onClick={() => setShowBudgetAnalysis(!showBudgetAnalysis)}
              className={clsx(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors",
                showBudgetAnalysis
                  ? "bg-accent/20 text-accent border border-accent/30"
                  : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2 border border-transparent"
              )}
            >
              <PieChart className="w-4 h-4" />
              <span className="hidden sm:inline">Budget-Analyse</span>
            </button>
            <span className="text-text-tertiary text-sm hidden sm:inline">Übersicht:</span>

            {/* Custom Account Dropdown with Logos */}
            <div className="relative">
              <button
                onClick={() => setShowAccountDropdown(!showAccountDropdown)}
                className="flex items-center gap-2 bg-slate-800 text-white px-3 py-2 pr-8 rounded-md border border-slate-600 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent cursor-pointer min-w-[180px] hover:bg-slate-700 transition-colors"
              >
                {viewMode === "all" ? (
                  <>
                    <LayoutGrid className="w-4 h-4 text-accent" />
                    <span>Alle Konten</span>
                  </>
                ) : (
                  (() => {
                    const acc = accounts?.find(
                      (a: AccountRow) => String(a.id) === String(viewMode)
                    );
                    if (!acc) return <span>Konto</span>;
                    const bank = getBankByName(acc.bank);
                    return (
                      <>
                        {bank ? (
                          <img
                            src={bank.logoUrl}
                            alt={bank.name}
                            className="w-5 h-5 object-contain rounded"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <Building2 className="w-4 h-4 text-slate-400" />
                        )}
                        <span className="truncate">{acc.name}</span>
                      </>
                    );
                  })()
                )}
              </button>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />

              {/* Dropdown Menu */}
              {showAccountDropdown && (
                <>
                  {/* Backdrop to close */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowAccountDropdown(false)}
                  />
                  <div className="absolute top-full right-0 mt-1 w-64 bg-slate-800 border border-slate-700 rounded-md shadow-xl z-20 py-1 max-h-72 overflow-y-auto">
                    {/* All Accounts Option */}
                    <button
                      onClick={() => {
                        setViewMode("all");
                        setShowAccountDropdown(false);
                      }}
                      className={clsx(
                        "w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-700 transition-colors",
                        viewMode === "all" && "bg-slate-700/80"
                      )}
                    >
                      <div className="w-6 h-6 rounded bg-accent/20 flex items-center justify-center flex-shrink-0">
                        <LayoutGrid className="w-3.5 h-3.5 text-accent" />
                      </div>
                      <span className="text-white">Alle Konten</span>
                      {viewMode === "all" && (
                        <Check className="w-4 h-4 text-accent ml-auto" />
                      )}
                    </button>

                    <div className="border-t border-slate-700 my-1" />

                    {/* Account Options */}
                    {(accounts || []).map((acc: AccountRow) => {
                      const bank = getBankByName(acc.bank);
                      return (
                        <button
                          key={acc.id}
                          onClick={() => {
                            setViewMode(String(acc.id));
                            setShowAccountDropdown(false);
                          }}
                          className={clsx(
                            "w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-700 transition-colors",
                            String(viewMode) === String(acc.id) && "bg-slate-700/80"
                          )}
                        >
                          <div className="w-6 h-6 rounded bg-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                            {bank ? (
                              <img
                                src={bank.logoUrl}
                                alt={bank.name}
                                className="w-5 h-5 object-contain"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                  const parent = (e.target as HTMLImageElement).parentElement;
                                  if (parent) parent.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-slate-400"><path d="M2 10h20M6 10V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4"/><path d="M12 14v7"/><path d="M4 10v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10"/></svg>';
                                }}
                              />
                            ) : (
                              <Building2 className="w-3.5 h-3.5 text-slate-400" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-white truncate">{acc.name}</p>
                            <p className="text-slate-500 text-xs truncate">{acc.bank}</p>
                          </div>
                          {String(viewMode) === String(acc.id) && (
                            <Check className="w-4 h-4 text-accent flex-shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Budget Analysis Panel */}
      {showBudgetAnalysis && budgetAnalysis && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 space-y-4 animate-fade-in">
          <div className="flex items-center gap-2 text-accent mb-2">
            <Wallet className="w-5 h-5" />
            <h3 className="font-medium">Budget-Analyse: {range.label}</h3>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-slate-900 rounded-lg p-3">
              <p className="text-slate-400 text-xs mb-1">Monatliches Einkommen</p>
              <p className="text-gain font-mono text-lg">+{formatCHF(budgetAnalysis.total_monthly_income)}</p>
            </div>
            <div className="bg-slate-900 rounded-lg p-3">
              <p className="text-slate-400 text-xs mb-1">Fixe Kosten</p>
              <p className="text-loss font-mono text-lg">-{formatCHF(budgetAnalysis.fixed_recurring_costs)}</p>
            </div>
            <div className="bg-slate-900 rounded-lg p-3">
              <p className="text-slate-400 text-xs mb-1">Variable Kosten</p>
              <p className="text-loss font-mono text-lg">-{formatCHF(budgetAnalysis.variable_costs)}</p>
            </div>
            <div className={clsx(
              "rounded-lg p-3",
              budgetAnalysis.variance >= 0 ? "bg-gain/10" : "bg-loss/10"
            )}>
              <p className="text-slate-400 text-xs mb-1">Verbleibend</p>
              <p className={clsx(
                "font-mono text-lg",
                budgetAnalysis.variance >= 0 ? "text-gain" : "text-loss"
              )}>
                {budgetAnalysis.variance >= 0 ? "+" : ""}{formatCHF(budgetAnalysis.variance)}
              </p>
            </div>
          </div>

          {/* Recurring Items List */}
          {budgetAnalysis.recurring_items.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm text-slate-300 mb-2 flex items-center gap-2">
                <Repeat className="w-4 h-4 text-accent" />
                Wiederkehrende Zahlungen
              </h4>
              <div className="bg-slate-900 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-800 text-slate-400 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2">Beschreibung</th>
                      <th className="text-left px-3 py-2">Periode</th>
                      <th className="text-right px-3 py-2">Betrag</th>
                      <th className="text-right px-3 py-2">Monatl. Äquiv.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {budgetAnalysis.recurring_items.map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/50">
                        <td className="px-3 py-2 text-slate-300">{item.description}</td>
                        <td className="px-3 py-2">
                          <span className={clsx("inline-flex items-center px-2 py-0.5 rounded text-xs", getFrequencyBadgeStyle(item.periodicity))}>
                            {PERIODICITY_LABELS[item.periodicity] ?? item.periodicity}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-400">
                          {formatCHF(item.amount)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-loss">
                          {formatCHF(item.monthly_equivalent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Progress Bar */}
          <div className="mt-4">
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Budget-Auslastung</span>
              <span>
                {budgetAnalysis.monthly_budget_limit > 0
                  ? `${Math.round((budgetAnalysis.fixed_recurring_costs + budgetAnalysis.variable_costs) / budgetAnalysis.monthly_budget_limit * 100)}%`
                  : "0%"}
              </span>
            </div>
            <div className="h-2 bg-slate-700 rounded-full overflow-hidden flex">
              <div
                className="h-full bg-loss transition-all"
                style={{
                  width: `${Math.min(100, (budgetAnalysis.fixed_recurring_costs / (budgetAnalysis.fixed_recurring_costs + budgetAnalysis.variable_costs || 1)) * 100)}%`,
                  opacity: 0.7
                }}
                title="Fixe Kosten"
              />
              <div
                className="h-full bg-loss-light transition-all"
                style={{
                  width: `${Math.min(100, (budgetAnalysis.variable_costs / (budgetAnalysis.fixed_recurring_costs + budgetAnalysis.variable_costs || 1)) * 100)}%`,
                  opacity: 0.7
                }}
                title="Variable Kosten"
              />
            </div>
            <div className="flex gap-4 mt-2 text-xs">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-loss opacity-70" />
                <span className="text-slate-400">Fix</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-loss-light opacity-70" />
                <span className="text-slate-400">Variable</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        {/* Period Navigator */}
        <GranularityNavigator
          granularity={granularity}
          anchor={anchor}
          onChange={(g, a) => { setGranularity(g); setAnchor(a); }}
        />

        <div className="w-px h-8 bg-border/50 mx-1" />

        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            type="text"
            placeholder="Suchen..."
            className="input pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input w-auto"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">Alle Kategorien</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        <select
          className="input w-auto min-w-[12rem]"
          value={recurrenceFilter}
          onChange={(e) =>
            setRecurrenceFilter(e.target.value as RecurrenceFilterValue)
          }
          aria-label="Nach Wiederkehrend / Rhythmus filtern"
        >
          {RECURRENCE_FILTER_OPTIONS.map(({ value, label }) => (
            <option key={value || "all"} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-auto max-h-[calc(100vh-320px)]">
          <table className="w-full">
            <thead className="sticky top-0 z-10 bg-slate-900">
              <tr className="border-b border-border/50">
                {["Datum", "Beschreibung", "Konto", "Kategorie", "Wiederkehrend", "Betrag", ""].map((h) => (
                  <th key={h} className="text-left text-text-tertiary text-xs uppercase tracking-wide px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from<undefined>({ length: 8 }).map((_el, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {Array.from<undefined>({ length: 7 }).map((_c, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="skeleton h-4 w-24 rounded" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading &&
                (transactions || []).map((txn: Transaction) => (
                  <tr key={txn.id} className="group border-b border-border/30 hover:bg-bg-surface2/50 transition-colors">
                    <td className="px-4 py-3 text-text-tertiary text-xs font-mono whitespace-nowrap">
                      {format(new Date(txn.date), "dd.MM.yyyy")}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-text-primary text-sm truncate">
                        {txn.merchant_normalized || txn.description}
                      </p>
                      {txn.merchant_normalized && txn.description !== txn.merchant_normalized && (
                        <p className="text-text-tertiary text-xs truncate">{txn.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary text-xs whitespace-nowrap">
                      {txn.account_name}
                    </td>
                    <td className="px-4 py-3">
                      {editingId === txn.id ? (
                        <div className="flex items-center gap-1.5">
                          <select
                            autoFocus
                            value={editCategory}
                            onChange={(e) => {
                              const val = e.target.value;
                              setEditCategory(val);
                              updateMutation.mutate({ id: txn.id, data: { category: val, user_verified: true } });
                              setEditingId(null);
                            }}
                            onBlur={() => setEditingId(null)}
                            onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                            className="input py-0.5 pr-6 text-xs rounded text-text-primary bg-bg-surface2 border border-border"
                          >
                            {/* Keep current value selectable even if not in canonical list */}
                            {editCategory && !ALL_CAT_GROUPS.some((g) =>
                              g.cats.includes(editCategory.toLowerCase())
                            ) && (
                              <option value={editCategory}>{titleCase(editCategory)}</option>
                            )}
                            {ALL_CAT_GROUPS.map(({ sc, cats }) => (
                              <optgroup key={sc.id} label={`${sc.emoji}  ${sc.label}`}>
                                {cats.map((cat) => (
                                  <option key={cat} value={cat}>{titleCase(cat)}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <button onClick={() => setEditingId(null)} className="text-text-tertiary hover:text-loss">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleCategoryEdit(txn)}
                          className="flex items-center gap-1.5 group"
                        >
                          {(() => {
                            const sc = resolveSuperCategory(txn.category || "");
                            return (
                              <span
                                className="badge text-xs flex items-center gap-1"
                                style={{
                                  backgroundColor: sc.color + "22",
                                  color: sc.color,
                                  border: `1px solid ${sc.color}44`,
                                }}
                              >
                                <sc.icon className="w-3 h-3 shrink-0" />
                                {txn.category || "Unkategorisiert"}
                              </span>
                            );
                          })()}
                          {!txn.user_verified && txn.confidence_score !== undefined && (
                            <span className="text-warning text-xs opacity-70">
                              {Math.round((txn.confidence_score || 0) * 100)}%
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className={clsx(
                        "inline-flex items-center gap-1.5 rounded text-xs transition-colors",
                        txn.is_recurring
                          ? getFrequencyBadgeStyle(txn.periodicity)
                          : "text-slate-500"
                      )}>
                        <Repeat className="w-3 h-3 shrink-0" />
                        <select
                          value={txn.is_recurring ? (txn.periodicity ?? "monthly") : ""}
                          onChange={(e) => handleRecurringChange(txn, e.target.value)}
                          className="bg-transparent border-none outline-none cursor-pointer text-xs appearance-none"
                        >
                          <option value="">—</option>
                          <option value="weekly">Wöchentlich</option>
                          <option value="monthly">Monatlich</option>
                          <option value="quarterly">Vierteljährlich</option>
                          <option value="halfyearly">Halbjährlich</option>
                          <option value="yearly">Jährlich</option>
                        </select>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={clsx("text-sm font-mono", txn.amount >= 0 ? "text-gain" : "text-loss")}>
                        {txn.amount >= 0 ? "+" : ""}{formatCHF(txn.amount)}
                      </span>
                    </td>
                    <td className="px-2 py-3 w-16">
                      {confirmingDeleteId === txn.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => deleteMutation.mutate(txn.id)}
                            disabled={deleteMutation.isPending}
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-loss/20 text-loss border border-loss/30 hover:bg-loss/40 transition-colors whitespace-nowrap"
                          >
                            Löschen
                          </button>
                          <button
                            onClick={() => setConfirmingDeleteId(null)}
                            className="text-text-tertiary hover:text-text-secondary transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmingDeleteId(txn.id)}
                          className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-loss transition-all"
                          title="Eintrag löschen"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              {!isLoading && (!transactions || transactions.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-text-tertiary text-sm">
                    Keine Transaktionen für {range.label} gefunden.{" "}
                    <Link to="/import" className="text-accent hover:text-accent-light">
                      CSV importieren
                    </Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
