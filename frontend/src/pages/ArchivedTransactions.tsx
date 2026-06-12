import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { transactionsApi, accountsApi } from "@/lib/api";
import { DeletedTransactionsView, type DeletedTransactionRow } from "@/components/transactions/DeletedTransactionsView";
import { WarningTriangle, Xmark } from "@/lib/icons";
import {
  RECURRENCE_FILTER_OPTIONS,
  recurrenceFilterToApiParams,
  type RecurrenceFilterValue,
} from "@/lib/recurrenceFilter";

interface ArchivedApiRow {
  id: number;
  account_id: number;
  account_name: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  category?: string | null;
  deleted_at: string | null;
  is_recurring?: boolean;
  periodicity?: string | null;
}

export default function ArchivedTransactions() {
  const queryClient = useQueryClient();
  const [accountFilter, setAccountFilter] = useState<string>("");
  const [recurrenceFilter, setRecurrenceFilter] = useState<RecurrenceFilterValue>("");
  const [purgeId, setPurgeId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const { data: raw, isLoading } = useQuery({
    queryKey: ["transactions-archived", accountFilter, recurrenceFilter],
    queryFn: () =>
      transactionsApi
        .listArchived({
          account_id: accountFilter ? Number(accountFilter) : undefined,
          ...recurrenceFilterToApiParams(recurrenceFilter),
        })
        .then((r) => r.data as ArchivedApiRow[]),
  });

  const rows: DeletedTransactionRow[] = useMemo(
    () =>
      (raw || []).map((t) => ({
        id: t.id,
        accountId: t.account_id,
        accountName: t.account_name,
        date: t.date,
        description: t.description,
        amount: t.amount,
        category: t.category,
        deletedAt: t.deleted_at,
        is_recurring: t.is_recurring,
        periodicity: t.periodicity,
      })),
    [raw]
  );

  const restoreMutation = useMutation({
    mutationFn: (id: number) => transactionsApi.restore(id),
    onMutate: (id) => setBusyId(id),
    onSettled: () => setBusyId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions-archived"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  const purgeMutation = useMutation({
    mutationFn: (id: number) => transactionsApi.purgeArchived(id),
    onMutate: (id) => setBusyId(id),
    onSettled: () => {
      setBusyId(null);
      setPurgeId(null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions-archived"] });
    },
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Archiv</h1>
          <p className="text-text-tertiary text-sm mt-0.5">Wiederherstellung weich gelöschter Transaktionen</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-4 sm:items-end">
          <div className="flex flex-col gap-1">
            <label className="label text-xs text-text-tertiary">Konto filtern</label>
            <select
              className="input w-full sm:w-64"
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
            >
              <option value="">Alle Konten</option>
              {(accounts || []).map((a: { id: number; name: string }) => (
                <option key={a.id} value={String(a.id)}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="label text-xs text-text-tertiary">Wiederkehrend</label>
            <select
              className="input w-full sm:w-64"
              value={recurrenceFilter}
              onChange={(e) =>
                setRecurrenceFilter(e.target.value as RecurrenceFilterValue)
              }
              aria-label="Archiv nach Rhythmus filtern"
            >
              {RECURRENCE_FILTER_OPTIONS.map(({ value, label }) => (
                <option key={value || "all"} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="card flex items-center gap-3 p-6">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-text-secondary text-sm">Archiv wird geladen…</span>
        </div>
      )}

      {!isLoading && (
        <DeletedTransactionsView
          transactions={rows}
          busyId={busyId}
          onRestore={(id) => restoreMutation.mutate(id)}
          onDeletePermanently={(id) => setPurgeId(id)}
        />
      )}

      {purgeId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="relative w-full max-w-md bg-bg-card border border-border rounded-xl p-6 shadow-xl mx-4">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center shrink-0">
                <WarningTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-text-primary font-semibold">Endgültig löschen?</h3>
                <p className="text-text-tertiary text-sm mt-1">
                  Diese Transaktion wird unwiderruflich aus der Datenbank entfernt. Diese Aktion kann nicht
                  rückgängig gemacht werden.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPurgeId(null)}
                className="p-1 text-text-tertiary hover:text-text-primary ml-auto"
                aria-label="Schließen"
              >
                <Xmark className="w-5 h-5" />
              </button>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setPurgeId(null)}>
                Abbrechen
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={purgeMutation.isPending}
                onClick={() => purgeId !== null && purgeMutation.mutate(purgeId)}
              >
                {purgeMutation.isPending ? "Wird gelöscht…" : "Endgültig löschen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
