import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

import { onboardingApi, type OnboardingStatus } from "@/lib/api";
import { Check, NavArrowRight } from "@/lib/icons";
import ProgressBar from "@/components/ui/ProgressBar";

/**
 * Fortschritt statt Sperre.
 *
 * Der Wizard stand bisher vor dem Dashboard: erst 50 Felder, dann Zahlen.
 * Jetzt zeigt das Dashboard, was schon geht, und benennt je Schritt, was der
 * naechste freischaltet — sichtbarer Nutzen statt einer Huerde.
 *
 * Ist alles beisammen, verschwindet die Leiste ganz.
 */
export default function OnboardingProgress() {
  const { t } = useTranslation();

  const { data } = useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => onboardingApi.status().then((r) => r.data as OnboardingStatus),
    staleTime: 60_000,
  });

  if (!data || data.completeness_pct >= 100) return null;

  const steps = [
    { done: data.has_transactions, label: t("pages:onboarding.stepData"),   unlocks: t("pages:onboarding.unlocksData"),   to: "/onboarding" },
    { done: data.has_wizard,       label: t("pages:onboarding.stepProfile"), unlocks: t("pages:onboarding.unlocksProfile"), to: "/wizard" },
    { done: data.has_plan,         label: t("pages:onboarding.stepPlan"),    unlocks: t("pages:onboarding.unlocksPlan"),    to: "/budgetplan" },
  ];
  const next = steps.find((s) => !s.done);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-text-secondary text-xs font-medium uppercase tracking-wide">
          {t("pages:onboarding.progressTitle")}
        </p>
        <span className="text-text-tertiary text-xs tabular-nums">
          {data.completeness_pct}%
        </span>
      </div>

      <ProgressBar
        value={data.completeness_pct}
        label={t("pages:onboarding.progressTitle")}
        className="mb-3"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {steps.map((step) => (
          <span
            key={step.label}
            className={clsx(
              "flex items-center gap-1.5 text-xs",
              step.done ? "text-gain" : "text-text-tertiary",
            )}
          >
            {step.done ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <span className="w-3.5 h-3.5 rounded-full border border-current opacity-50" />
            )}
            {step.label}
          </span>
        ))}
      </div>

      {next && (
        <Link
          to={next.to}
          className="mt-3 inline-flex items-center gap-1 text-accent text-xs hover:underline"
        >
          {next.unlocks}
          <NavArrowRight className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  );
}
