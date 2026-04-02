import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { accountsApi } from "@/lib/api";

function formatPreviewError(err: unknown): string {
  if (err instanceof AxiosError && err.response?.data != null) {
    const data = err.response.data as { detail?: unknown };
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      const msg = data.detail.map((x) => (typeof x === "object" && x && "msg" in x ? String((x as { msg: string }).msg) : String(x))).join("; ");
      if (msg) return msg;
    }
  }
  if (err instanceof Error) return err.message;
  return "Vorschau konnte nicht geladen werden.";
}

export interface BulkDeletePreview {
  transaction_count: number;
  total_amount: number;
  date_range: { from: string | null; to: string | null };
  sample_transactions: Array<{
    id: number;
    date: string;
    description: string;
    amount: number;
    category?: string;
  }>;
}

export interface BulkDeleteResult {
  deleted_count: number;
  hard_delete: boolean;
  account_id: number;
}

export type UseBulkDeleteOptions = {
  /** Called after a successful archive / hard-delete (e.g. close modal). */
  onCompleted?: () => void;
};

/**
 * Modal state + preview/delete mutations for bulk archive / hard-delete on an account.
 * Action buttons are enabled only after a successful preview with transaction_count > 0;
 * hard delete additionally requires confirmHard.
 */
export function useBulkDelete(
  accountId: number,
  modalOpen: boolean,
  options?: UseBulkDeleteOptions
) {
  const queryClient = useQueryClient();
  const [confirmHard, setConfirmHard] = useState(false);
  const onCompletedRef = useRef(options?.onCompleted);
  useEffect(() => {
    onCompletedRef.current = options?.onCompleted;
  }, [options?.onCompleted]);

  const accountIdValid = Number.isFinite(accountId) && accountId > 0;

  const {
    data: preview,
    isSuccess: previewSuccess,
    isError: previewError,
    error: previewErrorObj,
    isFetching: previewFetching,
    refetch: refetchPreview,
  } = useQuery({
    queryKey: ["account-tx-preview", accountId],
    queryFn: () =>
      accountsApi.previewTransactionsForDeletion(accountId).then((r) => r.data as BulkDeletePreview),
    enabled: modalOpen && accountIdValid,
  });

  const archiveMutation = useMutation({
    mutationFn: (hard: boolean) =>
      accountsApi.deleteAllTransactions(accountId, hard).then((r) => r.data as BulkDeleteResult),
    onSuccess: (data) => {
      setConfirmHard(false);
      onCompletedRef.current?.();
      queryClient.invalidateQueries({ queryKey: ["transactions"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["budget-analysis"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["account-tx-preview", accountId] });
      alert(
        data.hard_delete
          ? `${data.deleted_count} Transaktionen endgültig entfernt.`
          : `${data.deleted_count} Transaktionen archiviert (nicht mehr in der Hauptansicht).`
      );
    },
    onError: (err) => {
      alert(`Fehler: ${err instanceof Error ? err.message : "Unbekannt"}`);
    },
  });

  const transactionCount = useMemo(() => {
    const raw = preview?.transaction_count;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }, [preview?.transaction_count]);

  const mutating = archiveMutation.isPending;

  /** True once we have a successful preview with at least one non-deleted transaction. */
  const actionsEnabled = previewSuccess && transactionCount > 0 && !mutating;

  const canArchive = actionsEnabled;
  const canHardDelete = actionsEnabled && confirmHard;

  const resetConfirmHard = useCallback(() => setConfirmHard(false), []);

  /** Shown until the first preview payload is available (includes retry after error). */
  const showPreviewSpinner =
    modalOpen && accountIdValid && previewFetching && preview === undefined;

  return {
    preview: previewSuccess ? preview : undefined,
    previewSuccess,
    previewError,
    previewErrorMessage: formatPreviewError(previewErrorObj),
    refetchPreview,
    showPreviewSpinner,
    transactionCount,
    confirmHard,
    setConfirmHard,
    resetConfirmHard,
    archiveMutation,
    mutating,
    canArchive,
    canHardDelete,
    accountIdValid,
  };
}
