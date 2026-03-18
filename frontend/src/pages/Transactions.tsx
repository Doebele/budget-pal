import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { transactionsApi } from "@/lib/api";
import { formatCHF, categoryColors } from "@/lib/theme";
import { format } from "date-fns";
import { Search, Filter, Upload, ChevronDown, Check, X } from "lucide-react";
import { Link } from "react-router-dom";
import { clsx } from "clsx";

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
}

export default function Transactions() {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editCategory, setEditCategory] = useState("");
  const queryClient = useQueryClient();

  const { data: transactions, isLoading } = useQuery({
    queryKey: ["transactions", search, categoryFilter],
    queryFn: () =>
      transactionsApi
        .list({ q: search || undefined, category: categoryFilter || undefined, limit: 200 })
        .then((r) => r.data),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      transactionsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      setEditingId(null);
    },
  });

  const handleCategoryEdit = (txn: Transaction) => {
    setEditingId(txn.id);
    setEditCategory(txn.category || "");
  };

  const handleCategorySave = (id: number) => {
    updateMutation.mutate({ id, data: { category: editCategory, user_verified: true } });
  };

  const categories = Array.from(
    new Set((transactions || []).map((t: Transaction) => t.category).filter(Boolean))
  ).sort();

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Transaktionen</h1>
          <p className="text-text-tertiary text-sm mt-0.5">
            {transactions?.length || 0} Einträge
          </p>
        </div>
        <Link to="/import" className="btn-primary flex items-center gap-2">
          <Upload className="w-4 h-4" />
          Import
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
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
      </div>

      {/* Table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/50">
                {["Datum", "Beschreibung", "Konto", "Kategorie", "Betrag"].map((h) => (
                  <th key={h} className="text-left text-text-tertiary text-xs uppercase tracking-wide px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/30">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="skeleton h-4 w-24 rounded" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading &&
                (transactions || []).map((txn: Transaction) => (
                  <tr key={txn.id} className="border-b border-border/30 hover:bg-bg-surface2/50 transition-colors">
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
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            className="input py-1 text-xs w-32"
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value)}
                            autoFocus
                          />
                          <button
                            onClick={() => handleCategorySave(txn.id)}
                            className="text-gain hover:text-gain-light"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button onClick={() => setEditingId(null)} className="text-loss hover:text-loss-light">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleCategoryEdit(txn)}
                          className="flex items-center gap-1.5 group"
                        >
                          <span
                            className="badge text-xs"
                            style={{
                              backgroundColor: `${categoryColors[txn.category || ""] || "#64748b"}22`,
                              color: categoryColors[txn.category || ""] || "#94a3b8",
                              border: `1px solid ${categoryColors[txn.category || ""] || "#64748b"}44`,
                            }}
                          >
                            {txn.category || "Unkategorisiert"}
                          </span>
                          {!txn.user_verified && txn.confidence_score !== undefined && (
                            <span className="text-warning text-xs opacity-70">
                              {Math.round((txn.confidence_score || 0) * 100)}%
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={clsx("text-sm font-mono", txn.amount >= 0 ? "text-gain" : "text-loss")}>
                        {txn.amount >= 0 ? "+" : ""}{formatCHF(txn.amount)}
                      </span>
                    </td>
                  </tr>
                ))}
              {!isLoading && (!transactions || transactions.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-text-tertiary text-sm">
                    Keine Transaktionen gefunden.{" "}
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
