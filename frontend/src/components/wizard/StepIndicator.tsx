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
  /** If provided, step circles become clickable links */
  onStepClick?: (step: number) => void;
}

export default function StepIndicator({
  currentStep,
  totalSteps = 8,
  className,
  onStepClick,
}: StepIndicatorProps) {
  const clickable = Boolean(onStepClick);

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
              <div
                className={clsx(
                  "flex flex-col items-center gap-1.5",
                  clickable && "group",
                  clickable && !isActive && "cursor-pointer",
                  isActive && "cursor-default",
                )}
                onClick={() => clickable && !isActive && onStepClick?.(step)}
                title={clickable ? STEP_LABELS[i] : undefined}
                role={clickable && !isActive ? "button" : undefined}
                tabIndex={clickable && !isActive ? 0 : undefined}
                onKeyDown={(e) => {
                  if (clickable && !isActive && (e.key === "Enter" || e.key === " ")) {
                    onStepClick?.(step);
                  }
                }}
              >
                <div
                  className={clsx(
                    "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all duration-300",
                    isCompleted && "bg-accent border-accent text-white",
                    isCompleted && clickable && "group-hover:bg-accent/75 group-hover:border-accent/75",
                    isActive && "bg-accent/15 border-accent text-accent shadow-[0_0_12px_rgba(59,130,246,0.35)]",
                    isPending && "bg-transparent border-white/15 text-text-tertiary",
                    isPending && clickable && "group-hover:border-white/40 group-hover:text-text-secondary",
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
                    "text-[10px] font-medium whitespace-nowrap transition-colors",
                    isActive && "text-accent",
                    isCompleted && "text-text-secondary",
                    isCompleted && clickable && "group-hover:text-text-primary",
                    isPending && "text-text-tertiary",
                    isPending && clickable && "group-hover:text-text-secondary",
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
                onClick={() => clickable && !isActive && onStepClick?.(step)}
                role={clickable && !isActive ? "button" : undefined}
                tabIndex={clickable && !isActive ? 0 : undefined}
                title={clickable ? STEP_LABELS[i] : undefined}
                className={clsx(
                  "rounded-full transition-all duration-300",
                  clickable && !isActive && "cursor-pointer",
                  isActive && "w-4 h-2 bg-accent",
                  isCompleted && "w-2 h-2 bg-accent/60",
                  isCompleted && clickable && "hover:bg-accent",
                  !isActive && !isCompleted && "w-2 h-2 bg-white/15",
                  !isActive && !isCompleted && clickable && "hover:bg-white/30",
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
