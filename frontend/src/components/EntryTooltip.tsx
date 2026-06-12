import { displayLocale } from "@/lib/format";
import { useState, useRef, useCallback, useEffect } from "react";
import { getBankByName, type BankWithLogo } from "@/data/banks-with-logos";
import { clsx } from "clsx";

// ── Types ──────────────────────────────────────────────────────

interface RecurringPlanEntry {
  id: number;
  user_id: number;
  account_id: number | null;
  category_id: number | null;
  description: string;
  amount: number;
  periodicity: string;
  start_date: string;
  end_date: string | null;
  is_future: boolean;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface Account {
  id: number;
  name: string;
  bank: string;
  color?: string | null;
}

interface EntryTooltipProps {
  entry: RecurringPlanEntry;
  account: Account | null;
  children: React.ReactNode;
}

// ── Constants ──────────────────────────────────────────────────

const PERIODICITY_LABELS: Record<string, string> = {
  weekly: "Wöchentlich",
  monthly: "Monatlich",
  quarterly: "Quartalsweise",
  halfyearly: "Halbjährlich",
  yearly: "Jährlich",
};

const DEFAULT_BANK_LOGO = "/logos/default-bank.svg";

// ── BankLogo helper ────────────────────────────────────────────

const BankLogo = ({ bank, size = 20 }: { bank: BankWithLogo; size?: number }) => {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <img
        src={DEFAULT_BANK_LOGO}
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

// ── Main component ─────────────────────────────────────────────

export default function EntryTooltip({ entry, account, children }: EntryTooltipProps) {
  const [show, setShow] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = useCallback(() => {
    setShow(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setShow(false);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const x = e.clientX + 12;
    const y = e.clientY + 12;
    setPosition({ x, y });
  }, []);

  // Hide tooltip on scroll to avoid stale positioning
  useEffect(() => {
    if (!show) return;
    const handleScroll = () => setShow(false);
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [show]);

  const bankLogo = account ? getBankByName(account.bank) : null;
  const formattedStart = entry.start_date
    ? new Date(entry.start_date + "T00:00:00").toLocaleDateString(displayLocale())
    : "—";
  const formattedEnd = entry.end_date
    ? new Date(entry.end_date + "T00:00:00").toLocaleDateString(displayLocale())
    : "—";
  const isOngoing = !entry.end_date;
  const isExpense = entry.amount < 0;

  return (
    <div ref={triggerRef} className="inline-block">
      {/* Trigger wrapper */}
      <div
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="cursor-default"
      >
        {children}
      </div>

      {/* Tooltip */}
      {show && (
        <div
          className="fixed z-[100] pointer-events-none"
          style={{
            left: position.x,
            top: position.y,
          }}
        >
          <div className="bg-bg-surface border border-border rounded-xl shadow-2xl p-4 w-72 animate-fade-in">
            {/* Header: Bank Logo + Name */}
            <div className="flex items-center gap-3 mb-3">
              {account ? (
                <div className="w-10 h-10 rounded-lg bg-bg-surface2 flex items-center justify-center shrink-0">
                  {bankLogo ? (
                    <BankLogo bank={bankLogo} size={20} />
                  ) : (
                    <img
                      src={DEFAULT_BANK_LOGO}
                      alt="Bank"
                      width={20}
                      height={20}
                      className="object-contain"
                    />
                  )}
                </div>
              ) : (
                <div className="w-10 h-10 rounded-lg bg-bg-surface2 flex items-center justify-center shrink-0">
                  <span className="text-text-tertiary text-xs">—</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-text-primary font-semibold text-sm truncate">
                  {entry.description}
                </p>
                <p className="text-text-tertiary text-xs">
                  {account?.name || "Unbekanntes Konto"}
                </p>
              </div>
            </div>

            {/* Details grid */}
            <div className="space-y-2">
              {/* Betrag */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">Betrag</span>
                <span
                  className={clsx(
                    "font-mono font-semibold",
                    isExpense ? "text-loss" : "text-gain"
                  )}
                >
                  {isExpense ? "−" : "+"}
                  CHF{" "}
                  {Math.abs(entry.amount).toLocaleString(displayLocale(), {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>

              {/* Periodizität */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">Periodizität</span>
                <span className="text-text-primary">
                  {PERIODICITY_LABELS[entry.periodicity] || entry.periodicity}
                </span>
              </div>

              {/* Startdatum */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">Startdatum</span>
                <span className="text-text-primary">{formattedStart}</span>
              </div>

              {/* Enddatum */}
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-tertiary">Enddatum</span>
                <span
                  className={clsx(
                    "font-medium",
                    isOngoing ? "text-gain" : "text-text-primary"
                  )}
                >
                  {isOngoing ? "Läuft" : formattedEnd}
                </span>
              </div>

              {/* Notizen (optional) */}
              {entry.notes && (
                <div className="pt-2 mt-2 border-t border-border/50">
                  <p className="text-text-tertiary text-xs mb-1">Notizen</p>
                  <p className="text-text-secondary text-xs whitespace-pre-wrap break-words leading-relaxed">
                    {entry.notes}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
