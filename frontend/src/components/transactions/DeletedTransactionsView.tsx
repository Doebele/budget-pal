import { format } from "date-fns";
import { de } from "date-fns/locale";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { formatCHF, PERIODICITY_LABELS } from "@/lib/theme";
import { clsx } from "clsx";

export interface DeletedTransactionRow {
  id: number;
  amount: number;
  date: string;
  description: string;
  category?: string | null;
  deletedAt: string | null;
  accountId: number;
  accountName: string;
  is_recurring?: boolean;
  periodicity?: string | null;
}

interface DeletedTransactionsViewProps {
  transactions: DeletedTransactionRow[];
  onRestore: (id: number) => void;
  onDeletePermanently: (id: number) => void;
  busyId?: number | null;
}

export function DeletedTransactionsView({
  transactions,
  onRestore,
  onDeletePermanently,
  busyId = null,
}: DeletedTransactionsViewProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center border border-slate-700">
          <Archive className="w-5 h-5 text-slate-400" />
        </div>
        <div>
          <h2 className="text-text-primary font-semibold text-xl">Gelöschte Transaktionen (Archiv)</h2>
          <p className="text-text-tertiary text-sm">
            Weich gelöschte Buchungen wiederherstellen oder endgültig entfernen.
          </p>
        </div>
      </div>

      <div className="card p-0 overflow-hidden border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-surface2 text-text-tertiary text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Datum</th>
                <th className="text-left px-4 py-3 font-medium">Konto</th>
                <th className="text-left px-4 py-3 font-medium">Beschreibung</th>
                <th className="text-left px-4 py-3 font-medium">Kategorie</th>
                <th className="text-left px-4 py-3 font-medium">Rhythmus</th>
                <th className="text-right px-4 py-3 font-medium">Betrag</th>
                <th className="text-left px-4 py-3 font-medium">Gelöscht am</th>
                <th className="text-right px-4 py-3 font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {transactions.map((txn) => (
                <tr key={txn.id} className="hover:bg-bg-surface2/40 transition-colors">
                  <td className="px-4 py-3 text-text-primary font-mono text-xs whitespace-nowrap">
                    {format(new Date(txn.date), "dd.MM.yyyy", { locale: de })}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary text-xs max-w-[140px] truncate" title={txn.accountName}>
                    {txn.accountName}
                  </td>
                  <td className="px-4 py-3 text-text-primary max-w-xs truncate" title={txn.description}>
                    {txn.description}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary text-xs">
                    {txn.category || "—"}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary text-xs whitespace-nowrap">
                    {txn.is_recurring && txn.periodicity
                      ? (PERIODICITY_LABELS[txn.periodicity] ?? txn.periodicity)
                      : txn.is_recurring
                        ? "Wiederkehrend"
                        : "Einmalig"}
                  </td>
                  <td
                    className={clsx(
                      "px-4 py-3 text-right font-mono whitespace-nowrap",
                      txn.amount >= 0 ? "text-gain" : "text-loss"
                    )}
                  >
                    {txn.amount >= 0 ? "+" : ""}
                    {formatCHF(txn.amount)}
                  </td>
                  <td className="px-4 py-3 text-text-tertiary text-xs font-mono whitespace-nowrap">
                    {txn.deletedAt
                      ? format(new Date(txn.deletedAt), "dd.MM.yyyy HH:mm", { locale: de })
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={busyId === txn.id}
                        onClick={() => onRestore(txn.id)}
                        className="inline-flex items-center gap-1.5 bg-emerald-600/90 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-md px-3 py-1.5 font-medium text-xs transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Wiederherstellen
                      </button>
                      <button
                        type="button"
                        disabled={busyId === txn.id}
                        onClick={() => onDeletePermanently(txn.id)}
                        className="inline-flex items-center gap-1.5 bg-red-600/90 hover:bg-red-600 disabled:opacity-50 text-white rounded-md px-3 py-1.5 font-medium text-xs transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Endgültig löschen
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {transactions.length === 0 && (
        <p className="text-text-tertiary text-center py-12 text-sm">
          Keine gelöschten Transaktionen vorhanden.
        </p>
      )}
    </div>
  );
}
