import { clsx } from "clsx";
import { BookOpen, FlaskConical, GitMerge } from "lucide-react";
import type { BudgetAnalysisMode } from "@/types/budgetAnalysis";

interface ModeOption {
  value: BudgetAnalysisMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const MODES: ModeOption[] = [
  {
    value: "past",
    label: "Historisch",
    description: "Wiederkehrende & einmalige Transaktionen",
    icon: <BookOpen className="w-4 h-4" />,
  },
  {
    value: "wizard",
    label: "Empirisch",
    description: "Basierend auf Setup-Wizard-Eingaben",
    icon: <FlaskConical className="w-4 h-4" />,
  },
  {
    value: "combined",
    label: "Kombiniert",
    description: "Historisch + Empirisch, keine Duplikate",
    icon: <GitMerge className="w-4 h-4" />,
  },
];

interface Props {
  mode: BudgetAnalysisMode;
  onChange: (mode: BudgetAnalysisMode) => void;
  wizardAvailable?: boolean;
}

export default function BudgetAnalysisModes({
  mode,
  onChange,
  wizardAvailable = false,
}: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {MODES.map((opt) => {
        const unavailable =
          (opt.value === "wizard" || opt.value === "combined") && !wizardAvailable;
        const active = mode === opt.value;

        return (
          <button
            key={opt.value}
            onClick={() => !unavailable && onChange(opt.value)}
            title={unavailable ? "Wizard-Daten fehlen — Onboarding zuerst abschliessen" : opt.description}
            className={clsx(
              "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all",
              active
                ? "border-accent bg-accent/15 text-accent"
                : unavailable
                  ? "border-slate-700/50 bg-slate-800/30 text-slate-600 cursor-not-allowed"
                  : "border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500 hover:text-text-primary"
            )}
          >
            <span className={clsx(active ? "text-accent" : unavailable ? "text-slate-600" : "text-slate-400")}>
              {opt.icon}
            </span>
            <span className="font-medium">{opt.label}</span>
            {unavailable && (
              <span className="text-xs text-slate-600 ml-1">—</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
