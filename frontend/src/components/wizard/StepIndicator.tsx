import { Check } from "lucide-react";
import { clsx } from "clsx";

// ── Step labels ────────────────────────────────────────────────

const STEP_LABELS = [
  "Profil",
  "Einkommen",
  "Peer-Gruppe",
  "Wohnen",
  "Alltag",
  "Vermögen",
  "Vorsorge",
  "Ziele",
];

interface StepIndicatorProps {
  currentStep: number; // 1-based
  totalSteps?: number;
  className?: string;
}

export default function StepIndicator({
  currentStep,
  totalSteps = 8,
  className,
}: StepIndicatorProps) {
  return (
    <>
      {/* ── Desktop: full step circles ─────────────────────── */}
      <div className={clsx("hidden md:flex items-center w-full", className)}>
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1;
          const isCompleted = step < currentStep;
          const isActive = step === currentStep;
          const isPending = step > currentStep;

          return (
            <div key={step} className="flex items-center flex-1 last:flex-none">
              {/* Circle */}
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={clsx(
                    "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all duration-300",
                    isCompleted && "bg-accent border-accent text-white",
                    isActive && "bg-accent/15 border-accent text-accent shadow-[0_0_12px_rgba(59,130,246,0.35)]",
                    isPending && "bg-transparent border-white/15 text-text-tertiary"
                  )}
                >
                  {isCompleted ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <span>{step}</span>
                  )}
                </div>
                <span
                  className={clsx(
                    "text-[10px] font-medium whitespace-nowrap",
                    isActive && "text-accent",
                    isCompleted && "text-text-secondary",
                    isPending && "text-text-tertiary"
                  )}
                >
                  {STEP_LABELS[i]}
                </span>
              </div>

              {/* Connector line (not after last) */}
              {step < totalSteps && (
                <div
                  className={clsx(
                    "flex-1 h-[2px] mx-2 rounded-full transition-all duration-500",
                    isCompleted ? "bg-accent" : "bg-white/10"
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ── Mobile: compact current / total ───────────────────── */}
      <div className={clsx("flex md:hidden items-center gap-3", className)}>
        {/* Mini dots */}
        <div className="flex items-center gap-1.5">
          {Array.from({ length: totalSteps }, (_, i) => {
            const step = i + 1;
            const isCompleted = step < currentStep;
            const isActive = step === currentStep;
            return (
              <div
                key={step}
                className={clsx(
                  "rounded-full transition-all duration-300",
                  isActive && "w-4 h-2 bg-accent",
                  isCompleted && "w-2 h-2 bg-accent/60",
                  !isActive && !isCompleted && "w-2 h-2 bg-white/15"
                )}
              />
            );
          })}
        </div>
        <span className="text-text-tertiary text-xs">
          Schritt{" "}
          <span className="text-text-primary font-semibold">{currentStep}</span>{" "}
          von <span className="text-text-primary font-semibold">{totalSteps}</span>
          {" "}—{" "}
          <span className="text-text-secondary">{STEP_LABELS[currentStep - 1]}</span>
        </span>
      </div>
    </>
  );
}
