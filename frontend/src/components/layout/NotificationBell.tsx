/**
 * NotificationBell — anomaly findings bell in the top bar.
 *
 * Shows a badge count for warnings/alerts.
 * Clicking opens a slide-down panel listing all findings.
 */
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { notificationsApi } from "@/lib/api";
import { Bell, BellNotification, Cash, CreditCard, Dollar, GraphDown, InfoCircle, Refresh, WarningCircle, WarningTriangle, Xmark } from "@/lib/icons";
import { clsx } from "clsx";

interface Finding {
  type: string;
  severity: "info" | "warning" | "alert";
  title: string;
  body: string;
  transaction_id?: number | null;
  amount?: number | null;
  currency?: string | null;
}

const SEVERITY_META = {
  alert:   { color: "text-loss",    bg: "bg-loss/10 border-loss/20",    icon: WarningCircle,  label: "Alarm"    },
  warning: { color: "text-warning", bg: "bg-warning/10 border-warning/20", icon: WarningTriangle, label: "Warnung" },
  info:    { color: "text-accent",  bg: "bg-accent/10 border-accent/20",  icon: InfoCircle,         label: "InfoCircle"    },
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  unusually_large:  GraphDown,
  new_subscription: Refresh,
  price_change:     CreditCard,
  missing_salary:   Dollar,
  large_cash:       Cash,
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Lightweight count poll (every 5 min)
  const { data: countData } = useQuery({
    queryKey: ["notifications-count"],
    queryFn: () => notificationsApi.count().then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Full findings — only fetch when panel is open
  const { data: findings = [], isLoading } = useQuery<Finding[]>({
    queryKey: ["notifications"],
    queryFn: () => notificationsApi.list().then((r) => r.data),
    enabled: open,
    staleTime: 2 * 60_000,
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const total = countData?.total ?? 0;
  const hasAlert = (countData?.alerts ?? 0) > 0;
  const hasWarning = (countData?.warnings ?? 0) > 0;
  const badgeColor = hasAlert ? "bg-loss" : hasWarning ? "bg-warning" : "bg-accent";

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "relative flex items-center justify-center w-8 h-8 rounded-lg transition-colors",
          open ? "bg-bg-surface2 text-text-primary" : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2"
        )}
        title="Benachrichtigungen"
      >
        {total > 0 ? (
          <BellNotification className="w-4 h-4" />
        ) : (
          <Bell className="w-4 h-4" />
        )}
        {total > 0 && (
          <span
            className={clsx(
              "absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white px-1",
              badgeColor,
            )}
          >
            {total > 9 ? "9+" : total}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-bg-surface border border-border rounded-xl shadow-2xl z-50 overflow-hidden animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-text-primary text-sm font-semibold flex items-center gap-2">
              <BellNotification className="w-3.5 h-3.5 text-accent" />
              Benachrichtigungen
            </span>
            <button onClick={() => setOpen(false)} className="text-text-tertiary hover:text-text-primary transition-colors">
              <Xmark className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Content */}
          <div className="max-h-96 overflow-y-auto">
            {isLoading && (
              <div className="px-4 py-8 text-center text-text-tertiary text-xs animate-pulse">
                Analysiere Transaktionen…
              </div>
            )}
            {!isLoading && findings.length === 0 && (
              <div className="px-4 py-8 text-center">
                <Bell className="w-6 h-6 text-text-tertiary mx-auto mb-2" />
                <p className="text-text-tertiary text-xs">Keine Anomalien erkannt.</p>
                <p className="text-text-tertiary text-[10px] mt-0.5">Alles sieht normal aus 🎉</p>
              </div>
            )}
            {!isLoading && findings.map((f, i) => {
              const meta = SEVERITY_META[f.severity] ?? SEVERITY_META.info;
              const TypeIcon = TYPE_ICONS[f.type] ?? InfoCircle;
              return (
                <div
                  key={i}
                  className={clsx(
                    "flex gap-3 px-4 py-3 border-b border-border/50 last:border-0",
                    "hover:bg-bg-surface2 transition-colors"
                  )}
                >
                  <div className={clsx("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 border", meta.bg)}>
                    <TypeIcon className={clsx("w-3.5 h-3.5", meta.color)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-text-primary text-xs font-medium leading-tight">{f.title}</p>
                      <span className={clsx("text-[9px] font-semibold uppercase tracking-wide shrink-0", meta.color)}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="text-text-tertiary text-[11px] mt-0.5 leading-snug">{f.body}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {findings.length > 0 && (
            <div className="px-4 py-2.5 border-t border-border bg-bg-surface2/50">
              <p className="text-[10px] text-text-tertiary">
                Basierend auf deinen letzten 90 Tagen · Aktualisiert alle 5 Min.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
