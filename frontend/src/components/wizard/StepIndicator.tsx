import { Check } from "@/lib/icons";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";

// ── Step labels ────────────────────────────────────────────────

// i18n-Schluessel — erst beim Rendern uebersetzt
const STEP_LABELS = [
  "pages:wizard.w175",
  "pages:wizard.w176",
  "pages:wizard.w177",
  "pages:wizard.w178",
  "pages:wizard.w179",
  "pages:wizard.w180",
  "pages:wizard.w181",
  "pages:wizard.w182",
];

interface StepIndicatorProps {
  currentStep: number; // 1-based
  totalSteps?: number;
  className?: string;
  /** If provided, step circles become clickable links */
  onStepClick?: (step: number) => void;
}

interface StepBoxProps {
  interactive: boolean;
  isActive: boolean;
  onClick: () => void;
  title?: string;
  className: string;
  children: React.ReactNode;
}

/**
 * Ein anklickbarer Schritt ist ein `<button>`, kein `<div role="button">`.
 * Die Vorgaenger-Fassung war per Tastatur nicht ausloesbar (WCAG 2.1.1) —
 * ein echtes Button-Element bringt Enter, Leertaste und Fokus schon mit.
 */
function StepBox({ interactive, isActive, onClick, title, className, children }: StepBoxProps) {
  const current = isActive ? "step" : undefined;
  if (!interactive) {
    return <div className={className} aria-current={current}>{children}</div>;
  }
  return (
    <button type="button" onClick={onClick} title={title} className={className} aria-current={current}>
      {children}
    </button>
  );
}

export default function StepIndicator({
  currentStep,
  totalSteps = 8,
  className,
  onStepClick,
}: StepIndicatorProps) {
  const { t } = useTranslation();
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
          const interactive = clickable && !isActive;

          return (
            <div key={step} className="flex items-center flex-1 last:flex-none">
              {/* Circle */}
              <StepBox
                interactive={interactive}
                isActive={isActive}
                onClick={() => onStepClick?.(step)}
                title={clickable ? t(STEP_LABELS[i]) : undefined}
                className={clsx(
                  "flex flex-col items-center gap-1.5 rounded-lg",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base",
                  clickable && "group",
                  interactive && "cursor-pointer",
                  isActive && "cursor-default",
                )}
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
                  {t(STEP_LABELS[i])}
                </span>
              </StepBox>

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
            const interactive = clickable && !isActive;
            return (
              <StepBox
                key={step}
                interactive={interactive}
                isActive={isActive}
                onClick={() => onStepClick?.(step)}
                title={clickable ? t(STEP_LABELS[i]) : undefined}
                className={clsx(
                  "rounded-full transition-all duration-300",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  interactive && "cursor-pointer",
                  isActive && "w-4 h-2 bg-accent",
                  isCompleted && "w-2 h-2 bg-accent/60",
                  isCompleted && clickable && "hover:bg-accent",
                  !isActive && !isCompleted && "w-2 h-2 bg-white/15",
                  !isActive && !isCompleted && clickable && "hover:bg-white/30",
                )}
              >
                {/* Der Punkt allein sagt nichts — die Beschriftung traegt ihn. */}
                <span className="sr-only">{t(STEP_LABELS[i])}</span>
              </StepBox>
            );
          })}
        </div>
        <span className="text-text-tertiary text-xs">
          {t("pages:wizard.stepOf", { current: currentStep, total: totalSteps })}
          {" "}—{" "}
          <span className="text-text-secondary">{t(STEP_LABELS[currentStep - 1])}</span>
        </span>
      </div>
    </>
  );
}
