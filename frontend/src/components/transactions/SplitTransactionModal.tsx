/**
 * SplitTransactionModal
 *
 * Allows splitting a transaction into 2+ labelled child entries.
 * The sum of splits must equal the parent amount.
 */
import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { transactionsApi } from "@/lib/api";
import { formatAmount } from "@/lib/theme";
import { Plus, Trash2, X, Scissors, AlertCircle, Check } from "lucide-react";
import { clsx } from "clsx";

interface SplitEntry {
  id: string;
  description: string;
  amount: string; // string for controlled input
  category: string;
  notes: string;
}

interface Transaction {
  id: number;
  description: string;
  merchant_normalized?: string;
  amount: number;
  currency: string;
  account_currency: string;
  category?: string;
}

interface Props {
  transaction: Transaction;
  onClose: () => void;
}

let _idCounter = 0;
function newId() {
  return `split-${++_idCounter}`;
}

export default function SplitTransactionModal({ transaction, onClose }: Props) {
  const qc = useQueryClient();
  const displayName = transaction.merchant_normalized || transaction.description;
  const ccy = transaction.currency || transaction.account_currency || "CHF";

  const [entries, setEntries] = useState<SplitEntry[]>([
    { id: newId(), description: displayName, amount: "", category: transaction.category ?? "", notes: "" },
    { id: newId(), description: "", amount: "", category: transaction.category ?? "", notes: "" },
  ]);

  const total = entries.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const diff = parseFloat((transaction.amount - total).toFixed(10));
  const isBalanced = Math.abs(diff) < 0.005;

  const addEntry = useCallback(() => {
    setEntries((prev) => [
      ...prev,
      { id: newId(), description: "", amount: "", category: transaction.category ?? "", notes: "" },
    ]);
  }, [transaction.category]);

  const removeEntry = useCallback((id: string) => {
    setEntries((prev) => (prev.length > 2 ? prev.filter((e) => e.id !== id) : prev));
  }, []);

  const updateEntry = useCallback((id: string, field: keyof SplitEntry, value: string) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)));
  }, []);

  /** Distribute the remaining amount into the last empty entry */
  const fillRemaining = useCallback(() => {
    let idx = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].amount === "") { idx = i; break; }
    }
    if (idx === -1) return;
    const otherSum = entries.reduce((s, e, i) => s + (i === idx ? 0 : (parseFloat(e.amount) || 0)), 0);
    const remaining = parseFloat((transaction.amount - otherSum).toFixed(2));
    updateEntry(entries[idx].id, "amount", String(remaining));
  }, [entries, transaction.amount, updateEntry]);

  const splitMutation = useMutation({
    mutationFn: () =>
      transactionsApi.split(
        transaction.id,
        entries.map((e) => ({
          description: e.description || displayName,
          amount: parseFloat(e.amount),
          category: e.category || undefined,
          notes: e.notes || undefined,
        }))
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-bg-surface border border-border rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Scissors className="w-4 h-4 text-accent" />
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Transaktion aufteilen</h2>
              <p className="text-xs text-text-tertiary truncate max-w-xs">{displayName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Parent amount chip */}
        <div className="px-5 pt-3 pb-1">
          <div className="flex items-center justify-between text-xs text-text-tertiary">
            <span>Gesamtbetrag</span>
            <span className={clsx("font-mono font-medium", transaction.amount >= 0 ? "text-gain" : "text-loss")}>
              {transaction.amount >= 0 ? "+" : ""}
              {formatAmount(transaction.amount, ccy)}
            </span>
          </div>
        </div>

        {/* Split entries */}
        <div className="flex-1 overflow-y-auto px-5 py-2 space-y-2">
          {entries.map((entry, idx) => (
            <div key={entry.id} className="bg-bg-surface2 border border-border/60 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-widest text-text-tertiary font-medium">
                  Teil {idx + 1}
                </span>
                {entries.length > 2 && (
                  <button
                    onClick={() => removeEntry(entry.id)}
                    className="text-text-tertiary hover:text-loss transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="Beschreibung"
                  className="input text-sm col-span-2"
                  value={entry.description}
                  onChange={(e) => updateEntry(entry.id, "description", e.target.value)}
                />
                <input
                  type="number"
                  step="0.01"
                  placeholder={`Betrag (${ccy})`}
                  className="input text-sm font-mono"
                  value={entry.amount}
                  onChange={(e) => updateEntry(entry.id, "amount", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Kategorie"
                  className="input text-sm"
                  value={entry.category}
                  onChange={(e) => updateEntry(entry.id, "category", e.target.value)}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Balance indicator */}
        <div className="px-5 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text-tertiary">Aufgeteilt</span>
            <span className="font-mono font-medium text-text-secondary">
              {formatAmount(total, ccy)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs mt-0.5">
            <span className="text-text-tertiary">Differenz</span>
            <span
              className={clsx(
                "font-mono font-medium",
                isBalanced ? "text-gain" : "text-loss"
              )}
            >
              {isBalanced ? (
                <span className="flex items-center gap-1">
                  <Check className="w-3 h-3" /> ausgeglichen
                </span>
              ) : (
                <button
                  className="underline decoration-dotted hover:text-text-primary"
                  onClick={fillRemaining}
                  title="Differenz automatisch verteilen"
                >
                  {diff >= 0 ? "+" : ""}
                  {formatAmount(diff, ccy)} auffüllen
                </button>
              )}
            </span>
          </div>
        </div>

        {splitMutation.isError && (
          <div className="mx-5 mb-2 flex items-center gap-2 text-xs text-loss bg-loss/10 border border-loss/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {(splitMutation.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Fehler beim Aufteilen."}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={addEntry}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors px-2 py-1.5 rounded-lg hover:bg-bg-surface2"
          >
            <Plus className="w-3.5 h-3.5" />
            Teil hinzufügen
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary rounded-lg hover:bg-bg-surface2 transition-colors"
            >
              Abbrechen
            </button>
            <button
              onClick={() => splitMutation.mutate()}
              disabled={!isBalanced || splitMutation.isPending || entries.some((e) => !e.description.trim())}
              className="btn-primary px-4 py-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {splitMutation.isPending ? "Aufteilen…" : "Aufteilen"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
