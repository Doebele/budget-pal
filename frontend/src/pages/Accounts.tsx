import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { accountsApi } from "@/lib/api";
import { formatCHF, formatAmount } from "@/lib/theme";
import { Plus, Edit2, Trash2, Search, Check, AlertTriangle, X, FileX } from "lucide-react";
import { clsx } from "clsx";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import {
  BANKS_WITH_LOGOS,
  getBankCategoryLabel,
  getBankById,
  getBankByName,
  type BankWithLogo,
} from "@/data/banks-with-logos";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Girokonto",
  savings: "Sparkonto",
  investment: "Anlagekonto",
  credit: "Kreditkarte",
  cash: "Bargeld",
};

const CURRENCIES = ["CHF", "EUR", "USD", "SEK", "GBP", "JPY"];

// Bank Logo Component
const BankLogo = ({ bank, size = 24 }: { bank: BankWithLogo; size?: number }) => {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    // Fallback: Use default bank icon
    return (
      <img
        src="/logos/default-bank.svg"
        alt="Bank"
        width={size}
        height={size}
        className="object-contain"
      />
    );
  }

  return (
    <img
      src={bank.logoUrl}
      alt={`${bank.name} logo`}
      width={size}
      height={size}
      className="object-contain"
      onError={() => setHasError(true)}
    />
  );
};

// Default Bank Icon for custom banks not in the index
const DefaultBankIcon = ({ size = 24 }: { size?: number }) => {
  return (
    <img
      src="/logos/default-bank.svg"
      alt="Bank"
      width={size}
      height={size}
      className="object-contain"
    />
  );
};

// Exchange rates: CHF value per 1 unit of foreign currency (mock - in production this would come from an API)
const EXCHANGE_RATES: Record<string, number> = {
  CHF: 1,
  EUR: 0.94,
  USD: 0.88,
  GBP: 1.18,
  SEK: 0.085,
  JPY: 0.006,
};

// Convert to CHF
const convertToCHF = (amount: number, currency: string): number => {
  if (currency === "CHF") return amount;
  const rate = EXCHANGE_RATES[currency] || 1;
  return amount * rate;
};

// Format currency amount
const formatCurrency = (amount: number, currency: string): string => {
  return new Intl.NumberFormat("de-CH", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

interface BulkDeletePreview {
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

// MassDeleteConfirmModal Component
const MassDeleteConfirmModal = ({
  isOpen,
  onClose,
  onConfirm,
  accountName,
  preview,
  isLoading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (hardDelete: boolean) => void;
  accountName: string;
  preview: BulkDeletePreview | null;
  isLoading: boolean;
}) => {
  const [confirmed, setConfirmed] = useState(false);
  const [hardDelete, setHardDelete] = useState(false);

  // Reset states when modal opens/closes
  useEffect(() => {
    if (!isOpen) {
      setConfirmed(false);
      setHardDelete(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="relative w-full max-w-lg bg-slate-900 rounded-lg border border-red-500/30 shadow-2xl mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with warning gradient */}
        <div className="bg-gradient-to-r from-red-900/50 to-orange-900/50 p-6 border-b border-red-500/20">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-6 h-6 text-red-500" />
            </div>
            <div>
              <h3 className="text-xl font-semibold text-white">
                ⛔ Alle Transaktionen löschen?
              </h3>
              <p className="text-red-300 text-sm mt-1">
                Diese Aktion ist unwiderruflich! Es werden keine Backups erstellt.
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Account info */}
          <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <p className="text-slate-400 text-sm">Betroffenes Konto:</p>
            <p className="text-white font-medium text-lg">{accountName}</p>
          </div>

          {/* Preview of affected transactions */}
          {preview && (
            <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <p className="text-white font-medium flex items-center gap-2">
                  <FileX className="w-4 h-4 text-red-400" />
                  {preview.transaction_count} Transaktionen werden gelöscht
                </p>
                <span className="text-xs text-slate-400">
                  {preview.date_range.from && preview.date_range.to
                    ? `${format(new Date(preview.date_range.from), "dd.MM.yyyy", { locale: de })} - ${format(new Date(preview.date_range.to), "dd.MM.yyyy", { locale: de })}`
                    : "Keine Datumsangaben"}
                </span>
              </div>

              {preview.sample_transactions.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Vorschau der ersten Einträge:</p>
                  <ul className="space-y-1.5">
                    {preview.sample_transactions.map((txn) => (
                      <li
                        key={txn.id}
                        className="flex items-center justify-between text-sm py-2 px-3 bg-slate-700/50 rounded"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-slate-400 text-xs whitespace-nowrap">
                            {format(new Date(txn.date), "dd.MM.", { locale: de })}
                          </span>
                          <span className="text-slate-300 truncate">{txn.description}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-slate-500">{txn.category || "Allgemein"}</span>
                          <span className={clsx(
                            "font-mono font-medium",
                            txn.amount >= 0 ? "text-gain" : "text-loss"
                          )}>
                            {txn.amount >= 0 ? "+" : ""}{formatAmount(txn.amount)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {preview.transaction_count > 5 && (
                    <p className="text-xs text-slate-500 text-center pt-2">
                      ...und weitere {preview.transaction_count - 5} Einträge
                    </p>
                  )}
                </div>
              )}

              <div className="mt-4 pt-3 border-t border-slate-700 flex justify-between items-center">
                <span className="text-slate-400 text-sm">Gesamtbetrag:</span>
                <span className="font-mono text-lg text-white">
                  {formatAmount(preview.total_amount)}
                </span>
              </div>
            </div>
          )}

          {/* Hard delete option */}
          <div className="bg-red-950/30 border border-red-500/20 rounded-lg p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={hardDelete}
                onChange={(e) => setHardDelete(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-red-500/50 bg-red-950/50 text-red-500 focus:ring-red-500/50"
              />
              <div>
                <p className="text-red-300 font-medium text-sm">⚠️ Dauerhaft löschen (Hard Delete)</p>
                <p className="text-red-400/70 text-xs mt-1">
                  Standardmäßig werden Transaktionen archiviert (Soft Delete). Bei Hard Delete werden
                  die Daten unwiderruflich aus der Datenbank entfernt.
                </p>
              </div>
            </label>
          </div>

          {/* Confirmation checkbox */}
          <label className="flex items-center gap-3 cursor-pointer p-3 bg-slate-800/50 rounded-lg">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="w-4 h-4 rounded border-slate-600 bg-slate-700 text-accent focus:ring-accent/50"
            />
            <span className="text-sm text-slate-300">
              Ich verstehe, dass diese Aktion <span className="text-red-400 font-medium">nicht rückgängig</span> gemacht werden kann.
            </span>
          </label>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 transition-colors font-medium"
              disabled={isLoading}
            >
              Abbrechen
            </button>
            <button
              onClick={() => {
                if (confirmed) {
                  onConfirm(hardDelete);
                }
              }}
              disabled={!confirmed || isLoading}
              className={clsx(
                "flex-1 px-4 py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2",
                confirmed && !isLoading
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : "bg-slate-700 text-slate-500 cursor-not-allowed"
              )}
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Löschen...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  Ja, ich bin sicher – Löschen!
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default function Accounts() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<{ id: number; name: string } | null>(null);

  // Mass delete modal state
  const [showMassDeleteModal, setShowMassDeleteModal] = useState(false);
  const [accountForMassDelete, setAccountForMassDelete] = useState<{ id: number; name: string } | null>(null);
  const [massDeletePreview, setMassDeletePreview] = useState<BulkDeletePreview | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // Non-blocking notification (replaces alert())
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const showNotification = (message: string, type: "success" | "error" = "success") => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const [form, setForm] = useState({
    name: "",
    bank: "",
    currency: "CHF",
    balance: 0,
    account_type: "checking",
  });

  const [bankSearchQuery, setBankSearchQuery] = useState("");
  const [showBankDropdown, setShowBankDropdown] = useState(false);
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: () => {
      if (editingAccountId) {
        return accountsApi.update(editingAccountId, form);
      }
      return accountsApi.create(form);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => accountsApi.delete(id),
    onSuccess: () => {
      // Always reset the edit form — the account no longer exists.
      // Do this before invalidateQueries so the form closes immediately
      // rather than waiting for the refetch to complete.
      resetForm();
      setShowDeleteModal(false);
      setAccountToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
    },
    onError: (error) => {
      console.error("[Accounts] Delete error:", error);
      alert(`Fehler beim Löschen: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`);
    },
  });

  // Mass delete mutation
  const massDeleteMutation = useMutation({
    mutationFn: ({ accountId, hard }: { accountId: number; hard: boolean }) =>
      accountsApi.deleteAllTransactions(accountId, hard).then((r) => r.data),
    onSuccess: (data: { deleted_count: number }) => {
      setShowMassDeleteModal(false);
      setAccountForMassDelete(null);
      setMassDeletePreview(null);

      queryClient.invalidateQueries({ queryKey: ["transactions"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["budget-analysis"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["import-history"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });

      showNotification(`${data.deleted_count ?? 0} Transaktionen erfolgreich gelöscht.`);
    },
    onError: (error) => {
      console.error("[Accounts] Mass delete error:", error);
      setShowMassDeleteModal(false);
      setAccountForMassDelete(null);
      setMassDeletePreview(null);
      showNotification(
        `Fehler beim Löschen: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`,
        "error"
      );
    },
  });

  // Open mass delete modal and load preview
  const handleMassDeleteClick = async (account: { id: number; name: string }) => {
    setAccountForMassDelete(account);
    setShowMassDeleteModal(true);
    setIsLoadingPreview(true);
    try {
      const response = await accountsApi.previewTransactionsForDeletion(account.id);
      setMassDeletePreview(response.data as BulkDeletePreview);
    } catch (error) {
      console.error("[Accounts] Failed to load preview:", error);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // Confirm mass delete
  const handleMassDeleteConfirm = (hardDelete: boolean) => {
    if (accountForMassDelete) {
      massDeleteMutation.mutate({ accountId: accountForMassDelete.id, hard: hardDelete });
    }
  };

  // Close mass delete modal
  const handleMassDeleteClose = () => {
    setShowMassDeleteModal(false);
    setAccountForMassDelete(null);
    setMassDeletePreview(null);
  };

  const resetForm = () => {
    setEditingAccountId(null);
    setShowForm(false);
    setForm({
      name: "",
      bank: "",
      currency: "CHF",
      balance: 0,
      account_type: "checking",
    });
    setBankSearchQuery("");
    setShowBankDropdown(false);
    setSelectedBankId(null);
  };

  const handleEditClick = (account: {
    id: number;
    name: string;
    bank: string;
    currency: string;
    balance: number;
    account_type: string;
  }) => {
    setEditingAccountId(account.id);
    setForm({
      name: account.name,
      bank: account.bank,
      currency: account.currency,
      balance: account.balance,
      account_type: account.account_type,
    });
    // Finde die Bank-ID wenn sie im Index existiert
    const matchedBank = getBankByName(account.bank);
    if (matchedBank) {
      setSelectedBankId(matchedBank.id);
      setBankSearchQuery(matchedBank.name);
    } else {
      setSelectedBankId(null);
      setBankSearchQuery(account.bank);
    }
    setShowForm(true);
  };

  const handleDeleteClick = (account: { id: number; name: string }) => {
    setAccountToDelete(account);
    setShowDeleteModal(true);
  };

  const confirmDelete = () => {
    if (accountToDelete) {
      deleteMutation.mutate(accountToDelete.id);
    }
  };

  const handleSubmit = () => {
    // Validierung: Währung, Kontoname und Kontotyp sind Pflichtfelder
    if (!form.currency || !form.name || !form.account_type) {
      alert("Bitte alle Pflichtfelder ausfüllen: Währung, Kontoname und Kontotyp");
      return;
    }
    createMutation.mutate();
  };

  const totalBalance = (accounts || []).reduce(
    (s: number, a: { balance: number; currency: string }) =>
      s + convertToCHF(a.balance, a.currency),
    0
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Non-blocking notification toast */}
      {notification && (
        <div
          className={clsx(
            "fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all",
            notification.type === "success"
              ? "bg-emerald-900/90 border border-emerald-500/40 text-emerald-200"
              : "bg-red-900/90 border border-red-500/40 text-red-200"
          )}
        >
          <span>{notification.message}</span>
          <button onClick={() => setNotification(null)} className="ml-2 opacity-60 hover:opacity-100">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Konten</h1>
          <p className="text-text-tertiary text-sm mt-0.5">
            Gesamtsaldo:{" "}
            <span className="text-text-primary font-mono font-semibold">
              {formatCHF(totalBalance)}
            </span>
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setBankSearchQuery("");
            setSelectedBankId(null);
            setShowBankDropdown(false);
            setShowForm(true);
          }}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Konto hinzufügen
        </button>
      </div>

      {showForm && (
        <div className="card">
          <h2 className="text-text-primary font-semibold text-sm mb-4">
            {editingAccountId ? "Konto bearbeiten" : "Neues Konto"}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
            {/* Position 1: Währung */}
            <div>
              <label className="label">Währung *</label>
              <select
                className="input"
                value={form.currency}
                onChange={(e) =>
                  setForm((f) => ({ ...f, currency: e.target.value }))
                }
              >
                <option value="">Währung wählen</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            {/* Position 2: Anfangsguthaben */}
            <div>
              <label className="label">Anfangsguthaben</label>
              <input
                type="number"
                step="0.01"
                min="0"
                className="input"
                value={form.balance}
                onChange={(e) =>
                  setForm((f) => ({ ...f, balance: +e.target.value }))
                }
                placeholder="z.B. 5000.00"
              />
            </div>
            {/* Position 3: Kontoname */}
            <div>
              <label className="label">Kontoname *</label>
              <input
                type="text"
                className="input"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="z.B. Sparkonto UBS"
              />
            </div>
            {/* Position 4: Bank - Searchable Dropdown */}
            <div className="relative">
              <label className="label">Bank</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                <input
                  type="text"
                  className="input pl-10 pr-10 w-full"
                  value={bankSearchQuery}
                  onChange={(e) => {
                    setBankSearchQuery(e.target.value);
                    setForm((f) => ({ ...f, bank: e.target.value }));
                    setShowBankDropdown(true);
                    setSelectedBankId(null);
                  }}
                  onFocus={() => setShowBankDropdown(true)}
                  placeholder="Bank suchen..."
                />
                {selectedBankId && (
                  <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                )}
              </div>

              {/* Dropdown with filtered results */}
              {showBankDropdown && (
                <div className="absolute z-20 w-full mt-1 bg-slate-800 border border-slate-700 rounded-md shadow-lg max-h-72 overflow-y-auto">
                  {(() => {
                    const filtered = bankSearchQuery
                      ? BANKS_WITH_LOGOS.filter((b) =>
                          b.name.toLowerCase().includes(bankSearchQuery.toLowerCase())
                        )
                      : BANKS_WITH_LOGOS;

                    if (filtered.length === 0) {
                      return (
                        <div className="px-4 py-3 text-sm text-text-tertiary">
                          Keine Bank gefunden. Eigenen Namen verwenden.
                        </div>
                      );
                    }

                    return (
                      <>
                        {/* Group by category */}
                        {["swiss", "eu", "us"].map((category) => {
                          const typeBanks = filtered.filter((b) => b.category === category);
                          if (typeBanks.length === 0) return null;

                          return (
                            <div key={category}>
                              <div className="px-4 py-1.5 text-xs font-semibold text-text-tertiary bg-slate-700/50 sticky top-0">
                                {getBankCategoryLabel(category)}
                              </div>
                              {typeBanks.map((bank) => (
                                <button
                                  key={bank.id}
                                  type="button"
                                  className={clsx(
                                    "w-full px-3 py-2.5 text-left text-sm hover:bg-slate-700 transition-colors flex items-center gap-3",
                                    selectedBankId === bank.id && "bg-slate-700/80 text-accent"
                                  )}
                                  onClick={() => {
                                    setSelectedBankId(bank.id);
                                    setBankSearchQuery(bank.name);
                                    setForm((f) => ({ ...f, bank: bank.name }));
                                    setShowBankDropdown(false);
                                  }}
                                >
                                  {/* Bank Logo */}
                                  <div className="flex-shrink-0 w-8 h-8 rounded bg-white/10 flex items-center justify-center">
                                    <BankLogo bank={bank} size={20} />
                                  </div>
                                  
                                  {/* Bank Name with highlighting */}
                                  <span className="flex-1 truncate">
                                    {bank.name
                                      .split(new RegExp(`(${bankSearchQuery})`, "gi"))
                                      .map((part, i) =>
                                        bankSearchQuery &&
                                        part.toLowerCase() === bankSearchQuery.toLowerCase() ? (
                                          <span key={i} className="bg-accent/30 text-accent font-semibold">
                                            {part}
                                          </span>
                                        ) : (
                                          <span key={i}>{part}</span>
                                        )
                                      )}
                                  </span>
                                  
                                  {/* Checkmark if selected */}
                                  {selectedBankId === bank.id && (
                                    <Check className="w-4 h-4 text-accent flex-shrink-0" />
                                  )}
                                </button>
                              ))}
                            </div>
                          );
                        })}

                        {/* Custom bank option if no exact match */}
                        {bankSearchQuery &&
                          !BANKS_WITH_LOGOS.some(
                            (b) => b.name.toLowerCase() === bankSearchQuery.toLowerCase()
                          ) && (
                            <button
                              type="button"
                              className="w-full px-3 py-3 text-left text-sm hover:bg-slate-700 transition-colors text-accent border-t border-slate-700 flex items-center gap-3"
                              onClick={() => {
                                setSelectedBankId(null);
                                setForm((f) => ({ ...f, bank: bankSearchQuery }));
                                setShowBankDropdown(false);
                              }}
                            >
                              <div className="flex-shrink-0 w-8 h-8 rounded bg-slate-600 flex items-center justify-center">
                                <DefaultBankIcon size={20} />
                              </div>
                              <span className="font-medium">
                                "{bankSearchQuery}" als eigene Bank
                              </span>
                            </button>
                          )}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* Click outside to close dropdown */}
              {showBankDropdown && (
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowBankDropdown(false)}
                />
              )}
            </div>
            {/* Position 5: Kontotyp */}
            <div>
              <label className="label">Kontotyp *</label>
              <select
                className="input"
                value={form.account_type}
                onChange={(e) =>
                  setForm((f) => ({ ...f, account_type: e.target.value }))
                }
              >
                <option value="">Kontotyp wählen</option>
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              className="btn-primary"
              disabled={!form.currency || !form.name || !form.account_type || createMutation.isPending}
            >
              {createMutation.isPending
                ? "Speichern..."
                : editingAccountId
                ? "Aktualisieren"
                : "Erstellen"}
            </button>
            <button onClick={resetForm} className="btn-secondary">
              Abbrechen
            </button>
            {editingAccountId && (
              <button
                onClick={() => {
                  const account = (accounts || []).find(
                    (a: { id: number }) => a.id === editingAccountId
                  );
                  if (account) {
                    handleDeleteClick({ id: account.id, name: account.name });
                  }
                }}
                className="btn-danger ml-auto flex items-center gap-2"
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="w-4 h-4" />
                {deleteMutation.isPending ? "Löschen..." : "Löschen"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && accountToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowDeleteModal(false)}
          />
          <div className="relative w-full max-w-md bg-slate-800 rounded-lg border border-slate-700 p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-500" />
              </div>
              <h3 className="text-lg font-semibold text-white">
                Konto löschen?
              </h3>
            </div>
            <p className="text-slate-300 mb-2">
              Möchtest du das Konto <strong className="text-white">"{accountToDelete.name}"</strong> wirklich löschen?
            </p>
            <p className="text-sm text-slate-500">
              Diese Aktion kann nicht rückgängig gemacht werden!
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="btn-secondary"
              >
                Abbrechen
              </button>
              <button
                onClick={confirmDelete}
                className="btn-danger"
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Wird gelöscht..." : "Ja, löschen"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(accounts || []).map(
          (account: {
            id: number;
            name: string;
            bank: string;
            balance: number;
            account_type: string;
            currency: string;
          }) => (
            <div
              key={account.id}
              className={clsx(
                "card hover:border-accent/30 transition-colors",
                editingAccountId === account.id && "border-accent ring-1 ring-accent"
              )}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  {/* Bank Logo or Default Icon */}
                  <div className="w-9 h-9 rounded-lg bg-white/10 flex items-center justify-center overflow-hidden">
                    {(() => {
                      const matchedBank = getBankByName(account.bank);
                      if (matchedBank) {
                        return <BankLogo bank={matchedBank} size={20} />;
                      }
                      return <DefaultBankIcon size={20} />;
                    })()}
                  </div>
                  <div>
                    <p className="text-text-primary font-medium text-sm">
                      {account.name}
                    </p>
                    <p className="text-text-tertiary text-xs">
                      {account.bank} ·{" "}
                      {ACCOUNT_TYPE_LABELS[account.account_type] ||
                        account.account_type}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleEditClick(account)}
                    className={clsx(
                      "p-1.5 rounded-md transition-colors",
                      editingAccountId === account.id
                        ? "bg-accent/20 text-accent"
                        : "text-text-tertiary hover:text-text-primary hover:bg-white/5"
                    )}
                    title="Bearbeiten"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleMassDeleteClick(account)}
                    className="p-1.5 rounded-md text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Alle Transaktionen löschen"
                  >
                    <FileX className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {/* Balance Display: Primary (CHF) + Secondary (Original Currency) */}
              <div className="flex flex-col items-end">
                {/* Primary Amount: CHF Converted */}
                <p
                  className={clsx(
                    "text-xl font-mono font-semibold",
                    account.balance >= 0 ? "text-text-primary" : "text-loss"
                  )}
                >
                  {formatCurrency(
                    convertToCHF(account.balance, account.currency),
                    "CHF"
                  )}
                </p>
                {/* Secondary Amount: Original Currency (if not CHF) */}
                {account.currency !== "CHF" && (
                  <p className="text-xs text-text-tertiary mt-0.5">
                    {formatCurrency(account.balance, account.currency)} (≈)
                  </p>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* Mass Delete Confirmation Modal */}
      <MassDeleteConfirmModal
        isOpen={showMassDeleteModal}
        onClose={handleMassDeleteClose}
        onConfirm={handleMassDeleteConfirm}
        accountName={accountForMassDelete?.name || ""}
        preview={massDeletePreview}
        isLoading={isLoadingPreview || massDeleteMutation.isPending}
      />
    </div>
  );
}
