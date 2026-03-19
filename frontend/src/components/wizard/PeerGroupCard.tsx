import { useState, useEffect } from "react";
import { Users, TrendingUp, Shield, ChevronRight } from "lucide-react";
import { clsx } from "clsx";
import type { PeerGroupDefaults, PeerGroupProfile } from "@/services/peerGroupAnalyzer";
import { formatCHF } from "@/services/peerGroupAnalyzer";

// ── Types ──────────────────────────────────────────────────────

interface PeerGroupCardProps {
  profile: PeerGroupProfile;
  defaults: PeerGroupDefaults;
  userIncomeMonthly: number;
  onAccept: () => void;
  onAdjust: (key: keyof PeerGroupDefaults, value: number) => void;
}

// ── Category display config ────────────────────────────────────

interface CategoryConfig {
  key: keyof PeerGroupDefaults;
  label: string;
  icon: string;
  color: string;
}

const DISPLAY_CATEGORIES: CategoryConfig[] = [
  { key: "housing",          label: "Wohnen",        icon: "🏠", color: "bg-blue-500/20 text-blue-400" },
  { key: "groceries",        label: "Lebensmittel",  icon: "🛒", color: "bg-green-500/20 text-green-400" },
  { key: "transport",        label: "Transport",     icon: "🚂", color: "bg-yellow-500/20 text-yellow-400" },
  { key: "health_insurance", label: "Krankenkasse",  icon: "🏥", color: "bg-red-500/20 text-red-400" },
  { key: "dining_out",       label: "Freizeit",      icon: "🍽️", color: "bg-purple-500/20 text-purple-400" },
  { key: "savings_rate",     label: "Sparquote",     icon: "💰", color: "bg-emerald-500/20 text-emerald-400" },
];

// ── Animated number ────────────────────────────────────────────

function AnimatedNumber({ value, delay = 0, isSavings = false }: { value: number; delay?: number; isSavings?: boolean }) {
  const [displayed, setDisplayed] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const visTimer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(visTimer);
  }, [delay]);

  useEffect(() => {
    if (!visible) return;
    let start = 0;
    const end = value;
    const duration = 600;
    const startTime = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayed(Math.round(eased * end));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [visible, value]);

  if (isSavings) return <span>{displayed}%</span>;
  return <span>{formatCHF(displayed)}</span>;
}

// ── Bar chart row ──────────────────────────────────────────────

function BarRow({
  label,
  peerValue,
  maxValue,
  delay,
}: {
  label: string;
  peerValue: number;
  maxValue: number;
  delay: number;
}) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setWidth((peerValue / maxValue) * 100), delay + 100);
    return () => clearTimeout(t);
  }, [peerValue, maxValue, delay]);

  return (
    <div className="flex items-center gap-3">
      <span className="text-text-secondary text-xs w-20 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-700 ease-out"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-text-primary text-xs font-mono w-20 text-right">
        {formatCHF(peerValue)}
      </span>
    </div>
  );
}

// ── Income comparison bar ──────────────────────────────────────

function IncomeComparison({
  userIncome,
  peerMedian,
}: {
  userIncome: number;
  peerMedian: number;
}) {
  const [userWidth, setUserWidth] = useState(0);
  const [peerWidth, setPeerWidth] = useState(0);
  const max = Math.max(userIncome, peerMedian) * 1.15;

  useEffect(() => {
    const t = setTimeout(() => {
      setUserWidth((userIncome / max) * 100);
      setPeerWidth((peerMedian / max) * 100);
    }, 300);
    return () => clearTimeout(t);
  }, [userIncome, peerMedian, max]);

  const delta = userIncome - peerMedian;
  const deltaPercent = ((delta / peerMedian) * 100).toFixed(0);
  const above = delta >= 0;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <span className="text-text-tertiary text-xs w-24 shrink-0">Dein Einkommen</span>
        <div className="flex-1 h-2.5 bg-white/8 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-700 ease-out"
            style={{ width: `${userWidth}%` }}
          />
        </div>
        <span className="text-accent text-xs font-mono w-24 text-right font-semibold">
          {formatCHF(userIncome)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-text-tertiary text-xs w-24 shrink-0">Peer-Median</span>
        <div className="flex-1 h-2.5 bg-white/8 rounded-full overflow-hidden">
          <div
            className="h-full bg-white/30 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${peerWidth}%` }}
          />
        </div>
        <span className="text-text-secondary text-xs font-mono w-24 text-right">
          {formatCHF(peerMedian)}
        </span>
      </div>
      {userIncome > 0 && (
        <p className={clsx("text-xs", above ? "text-gain" : "text-loss")}>
          {above ? "+" : ""}{deltaPercent}% {above ? "über" : "unter"} dem Peer-Median
        </p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────

export default function PeerGroupCard({
  profile,
  defaults,
  userIncomeMonthly,
  onAccept,
  onAdjust,
}: PeerGroupCardProps) {
  const [editingKey, setEditingKey] = useState<keyof PeerGroupDefaults | null>(null);
  const [editValue, setEditValue] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(t);
  }, []);

  const maxExpense = Math.max(
    defaults.housing,
    defaults.groceries,
    defaults.transport,
    defaults.health_insurance,
    defaults.dining_out,
    500
  );

  function handleEditSave(key: keyof PeerGroupDefaults) {
    const parsed = parseFloat(editValue);
    if (!isNaN(parsed) && parsed >= 0) {
      onAdjust(key, parsed);
    }
    setEditingKey(null);
  }

  function startEdit(key: keyof PeerGroupDefaults) {
    const val = defaults[key];
    setEditValue(String(val));
    setEditingKey(key);
  }

  // Confidence badge color
  const confidenceColor =
    defaults.confidenceNote.startsWith("Sehr")
      ? "bg-gain/15 text-gain"
      : "bg-warning/15 text-warning";

  return (
    <div
      className={clsx(
        "space-y-5 transition-all duration-500",
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      )}
    >
      {/* ── Header card ─────────────────────────────────── */}
      <div className="card border-accent/20 bg-accent/5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-accent/20 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h3 className="text-text-primary font-semibold text-sm leading-tight">
                {defaults.peerLabel}
              </h3>
              <p className="text-text-tertiary text-xs mt-0.5">{defaults.sampleSize}</p>
            </div>
          </div>
          <span className={clsx("badge shrink-0", confidenceColor)}>
            <Shield className="w-3 h-3" />
            BFS 2021
          </span>
        </div>

        <p className="text-text-tertiary text-xs mt-3 leading-relaxed">
          {defaults.confidenceNote}
        </p>
      </div>

      {/* ── Income comparison ────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-accent" />
          <h4 className="text-text-primary text-sm font-medium">Einkommensvergleich</h4>
        </div>
        <IncomeComparison
          userIncome={userIncomeMonthly}
          peerMedian={defaults.incomeMedian}
        />
      </div>

      {/* ── Expense breakdown ────────────────────────────── */}
      <div className="card">
        <h4 className="text-text-primary text-sm font-medium mb-4">Typische Ausgaben deiner Peer-Gruppe</h4>
        <div className="space-y-2.5">
          {DISPLAY_CATEGORIES.filter(c => c.key !== "savings_rate").map((cat, i) => (
            <BarRow
              key={cat.key}
              label={cat.label}
              peerValue={defaults[cat.key] as number}
              maxValue={maxExpense}
              delay={i * 80}
            />
          ))}
        </div>
      </div>

      {/* ── Editable defaults ────────────────────────────── */}
      <div className="card">
        <h4 className="text-text-primary text-sm font-medium mb-1">Vorgeschlagene Budgetwerte</h4>
        <p className="text-text-tertiary text-xs mb-4">
          Basierend auf BFS-Daten für dein Profil. Klicke auf einen Wert, um ihn anzupassen.
        </p>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {DISPLAY_CATEGORIES.map((cat, i) => {
            const rawValue = defaults[cat.key];
            const isSavings = cat.key === "savings_rate";
            const isEditing = editingKey === cat.key;

            return (
              <div
                key={cat.key}
                className={clsx(
                  "rounded-xl p-3 border transition-all duration-300",
                  "opacity-0 animate-[fadeSlideUp_0.4s_ease-out_forwards]",
                  "border-white/8 bg-white/3 hover:border-white/15 hover:bg-white/5 cursor-pointer"
                )}
                style={{ animationDelay: `${i * 60 + 200}ms` }}
                onClick={() => !isEditing && startEdit(cat.key)}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-base leading-none">{cat.icon}</span>
                  <span className="text-text-tertiary text-[10px] font-medium uppercase tracking-wide">
                    {cat.label}
                  </span>
                </div>

                {isEditing ? (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="number"
                      className="input py-1 px-2 text-xs w-full"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleEditSave(cat.key);
                        if (e.key === "Escape") setEditingKey(null);
                      }}
                      autoFocus
                    />
                    <button
                      className="text-accent text-xs px-1.5 py-1 rounded hover:bg-accent/10 shrink-0"
                      onClick={() => handleEditSave(cat.key)}
                    >
                      OK
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <p className="text-text-primary font-mono font-semibold text-sm">
                      <AnimatedNumber value={rawValue as number} delay={i * 60 + 200} isSavings={isSavings} />
                    </p>
                    <ChevronRight className="w-3 h-3 text-text-tertiary opacity-50" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── CTA ──────────────────────────────────────────── */}
      <button
        className="btn-primary w-full py-3 text-base font-semibold"
        onClick={onAccept}
      >
        Diese Defaults übernehmen
      </button>

      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>
    </div>
  );
}
