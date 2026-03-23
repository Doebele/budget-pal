/**
 * CustomProviderSidebar — Sticky right-side panel for creating and editing
 * custom (user-defined) expense providers.
 *
 * Same fixed-header / scroll-body / fixed-footer pattern as ProviderSidebar.
 */
import { useState } from "react";
import {
  X, Globe, ExternalLink, Calendar, RefreshCw, Trash2, Check,
} from "lucide-react";
import { clsx } from "clsx";
import {
  toMonthlyCHF, getFaviconUrl,
  FREQUENCIES, FREQUENCY_LABELS,
  SUPPORTED_CURRENCIES, CURRENCY_SYMBOLS,
  type Frequency, type SupportedCurrency,
} from "@/services/faviconService";
import type { CustomExpenseEntry, ExpenseCategory } from "./Step5AccordionExpenses";

// ── helpers ────────────────────────────────────────────────────

function fchf(n: number): string {
  if (n === 0) return "Gratis";
  return `CHF ${n % 1 === 0 ? n : n.toFixed(2)}`;
}

// ── props ──────────────────────────────────────────────────────

interface Props {
  initialName?: string;
  initialCategoryId?: string;
  categories: ExpenseCategory[];
  /** null/undefined = new mode; defined = edit mode */
  entry?: CustomExpenseEntry | null;
  onClose: () => void;
  onSave: (entry: CustomExpenseEntry) => void;
  onDelete?: (id: string) => void;
}

// ── component ─────────────────────────────────────────────────

export default function CustomProviderSidebar({
  initialName = "",
  initialCategoryId,
  categories,
  entry,
  onClose,
  onSave,
  onDelete,
}: Props) {
  const isEditing = entry != null;

  // Local form state — seeded from entry when editing
  const [name, setName] = useState(isEditing ? entry!.name : initialName);
  const [website, setWebsite] = useState(isEditing ? (entry!.website ?? "") : "");
  const [categoryId, setCategoryId] = useState(
    isEditing ? entry!.categoryId : (initialCategoryId ?? categories[0]?.id ?? "")
  );
  const [amount, setAmount] = useState(
    isEditing
      ? String(entry!.individualAmount ?? entry!.price ?? "")
      : ""
  );
  const [currency, setCurrency] = useState<SupportedCurrency>(
    isEditing ? (entry!.currency ?? "CHF") : "CHF"
  );
  const [frequency, setFrequency] = useState<Frequency>(
    isEditing ? (entry!.frequency ?? "monthly") : "monthly"
  );
  const [firstPaymentDate, setFirstPaymentDate] = useState(
    isEditing ? (entry!.firstPaymentDate ?? "") : ""
  );
  const [note, setNote] = useState(isEditing ? (entry!.note ?? "") : "");

  // Favicon preview
  const faviconUrl = website.trim() ? getFaviconUrl(website.trim(), 32) : "";
  const [faviconFailed, setFaviconFailed] = useState(false);

  // Recompute when website changes
  const showFavicon = faviconUrl && !faviconFailed;

  // Effective monthly CHF
  const parsedAmount = parseFloat(amount);
  const effectiveMonthly =
    !isNaN(parsedAmount) && parsedAmount > 0
      ? toMonthlyCHF(parsedAmount, frequency, currency)
      : null;

  const canSave = name.trim().length > 0 && effectiveMonthly != null && effectiveMonthly > 0;

  function handleSave() {
    if (!canSave) return;
    const id = isEditing ? entry!.id : `custom-${Date.now()}`;
    const saved: CustomExpenseEntry = {
      id,
      categoryId,
      name: name.trim(),
      website: website.trim() || undefined,
      individualAmount: parsedAmount,
      frequency,
      currency,
      firstPaymentDate: firstPaymentDate || undefined,
      note: note.trim() || undefined,
      price: effectiveMonthly!, // effective monthly CHF stored on save
    };
    onSave(saved);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-surface border border-border/50 rounded-lg overflow-hidden shadow-2xl">

      {/* ── Fixed Header ──────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-bg-surface2 flex-shrink-0">
        {/* Favicon or globe */}
        <div className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded bg-bg-surface2">
          {showFavicon ? (
            <img
              src={faviconUrl}
              alt={name || "Eigener Anbieter"}
              width={24}
              height={24}
              className="rounded object-contain"
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            <Globe className="w-4 h-4 text-text-tertiary" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-text-primary font-semibold text-sm truncate">
            {name.trim() || "Eigener Anbieter"}
          </div>
          <div className="text-text-tertiary text-[11px]">
            {isEditing ? "Bearbeiten" : "Neu erstellen"}
          </div>
        </div>

        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* ── Scrollable Body ───────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide p-4 space-y-4 min-h-0">

        {/* Name */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            Name
          </p>
          <input
            type="text"
            className="input text-sm w-full"
            placeholder="z.B. Zeitungsabo, Vereinsmitgliedschaft…"
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Website */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            Website <span className="normal-case font-normal">(optional)</span>
          </p>
          <div className="relative flex items-center gap-2">
            <input
              type="url"
              className="input text-sm w-full pr-8"
              placeholder="https://example.com"
              value={website}
              onChange={e => {
                setWebsite(e.target.value);
                setFaviconFailed(false);
              }}
            />
            {website.trim() && (
              <a
                href={website.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute right-2.5 text-text-tertiary hover:text-accent transition-colors"
                tabIndex={-1}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Kategorie */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            Kategorie
          </p>
          <select
            className="input text-sm w-full cursor-pointer"
            value={categoryId}
            onChange={e => setCategoryId(e.target.value)}
          >
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.label}</option>
            ))}
          </select>
        </div>

        {/* Betrag */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            Betrag
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              className="input text-sm flex-1"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              min={0}
              step={0.01}
            />
            <select
              className="input text-sm w-24 cursor-pointer"
              value={currency}
              onChange={e => setCurrency(e.target.value as SupportedCurrency)}
            >
              {SUPPORTED_CURRENCIES.map(c => (
                <option key={c} value={c}>{CURRENCY_SYMBOLS[c]} {c}</option>
              ))}
            </select>
          </div>
          {currency !== "CHF" && parsedAmount > 0 && (
            <p className="text-text-tertiary text-[10px] mt-1 flex items-center gap-1">
              <RefreshCw className="w-2.5 h-2.5" />
              Indikativer Kurs · Angaben ohne Gewähr
            </p>
          )}
        </div>

        {/* Zahlungsrhythmus */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            Zahlungsrhythmus
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {FREQUENCIES.map(freq => (
              <button
                key={freq}
                type="button"
                onClick={() => setFrequency(freq)}
                className={clsx(
                  "rounded-lg border px-2 py-2 text-[11px] font-medium transition-all text-left",
                  frequency === freq
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border/50 text-text-secondary hover:border-border"
                )}
              >
                {FREQUENCY_LABELS[freq]}
              </button>
            ))}
          </div>
        </div>

        {/* Erste Zahlung */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            <Calendar className="w-3 h-3 inline mr-1 mb-0.5" />
            Erste Zahlung <span className="normal-case font-normal">(optional)</span>
          </p>
          <input
            type="date"
            className="input text-sm w-full"
            value={firstPaymentDate}
            onChange={e => setFirstPaymentDate(e.target.value)}
            max="2030-12-31"
          />
        </div>

        {/* Notiz */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-1.5">
            Notiz <span className="normal-case font-normal">(optional)</span>
          </p>
          <input
            type="text"
            className="input text-sm w-full"
            placeholder="z.B. Jahresabo, geteilter Account…"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        {/* Delete (edit mode only) */}
        {isEditing && onDelete && (
          <div className="pt-2 border-t border-border/50">
            <button
              type="button"
              onClick={() => onDelete(entry!.id)}
              className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-loss/30 bg-loss/8 text-loss hover:bg-loss/15 px-3 py-2 text-xs font-medium transition-all"
            >
              <Trash2 className="w-3 h-3" />
              Anbieter löschen
            </button>
          </div>
        )}
      </div>

      {/* ── Fixed Footer ──────────────────────────────────── */}
      <footer className="flex-shrink-0 border-t border-border/50 bg-bg-surface2 px-4 py-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-text-tertiary text-[10px] uppercase tracking-wide font-semibold">
              Monatlicher Betrag
            </p>
            {frequency !== "monthly" && (
              <p className="text-text-tertiary text-[10px]">{FREQUENCY_LABELS[frequency]}</p>
            )}
          </div>
          <div className="text-right">
            <span className="font-mono font-bold text-gain text-base">
              {effectiveMonthly != null && effectiveMonthly > 0
                ? fchf(effectiveMonthly)
                : "—"}
            </span>
            {effectiveMonthly != null && effectiveMonthly > 0 && (
              <span className="text-text-tertiary text-xs font-normal">/Mo</span>
            )}
          </div>
        </div>

        <button
          type="button"
          disabled={!canSave}
          onClick={handleSave}
          className={clsx(
            "w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-sm font-semibold transition-all",
            canSave
              ? "btn-primary"
              : "bg-bg-surface2 text-text-tertiary border border-border/50 cursor-not-allowed opacity-50"
          )}
        >
          <Check className="w-4 h-4" />
          {isEditing ? "Änderungen speichern" : "Anbieter hinzufügen"}
        </button>
      </footer>
    </div>
  );
}
