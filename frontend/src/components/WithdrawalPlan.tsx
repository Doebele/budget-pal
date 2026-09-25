import { useTranslation } from "react-i18next";
import type { CapitalWithdrawal } from "@/lib/api";
import { formatCHF } from "@/lib/theme";

/**
 * Bezugsplan fuer Kapitalbezuege (Pensionskasse, 3a-Konten): wann welches
 * Kapital, wie viel Steuer, was bleibt — und was die Staffelung gegenueber
 * einem Bezug in einem einzigen Jahr spart. Die Zahlen rechnet das Backend
 * (capital_withdrawals), in heutigen Franken.
 */
export default function WithdrawalPlan({
  withdrawals,
  taxSingleYear,
}: {
  withdrawals: CapitalWithdrawal[];
  taxSingleYear: number;
}) {
  const { t } = useTranslation();
  if (withdrawals.length === 0) return null;

  const gross = withdrawals.reduce((s, w) => s + w.amount, 0);
  const tax = withdrawals.reduce((s, w) => s + w.tax, 0);
  const saving = Math.max(0, taxSingleYear - tax);

  return (
    <div className="space-y-2">
      <p className="text-text-secondary text-xs font-semibold uppercase tracking-wide">
        {t("pages:plan.title")}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary text-left">
              <th className="py-1 pr-3 font-medium">{t("pages:plan.when")}</th>
              <th className="py-1 pr-3 font-medium">{t("pages:plan.what")}</th>
              <th className="py-1 pr-3 font-medium text-right">{t("pages:plan.amount")}</th>
              <th className="py-1 pr-3 font-medium text-right">{t("pages:plan.tax")}</th>
              <th className="py-1 font-medium text-right">{t("pages:plan.net")}</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {withdrawals.map((w, i) => (
              <tr key={`${w.source}-${w.label}-${i}`} className="border-t border-border/30">
                <td className="py-1 pr-3 text-text-secondary">
                  {t("pages:plan.age", { age: w.age, year: w.year })}
                </td>
                <td className="py-1 pr-3 font-sans text-text-primary">
                  {w.source === "bvg" ? t("pages:plan.bvg", { label: w.label }) : t("pages:plan.p3a", { label: w.label })}
                </td>
                <td className="py-1 pr-3 text-right text-text-primary">{formatCHF(w.amount)}</td>
                <td className="py-1 pr-3 text-right text-loss">−{formatCHF(w.tax)}</td>
                <td className="py-1 text-right text-text-primary">{formatCHF(w.amount - w.tax)}</td>
              </tr>
            ))}
            <tr className="border-t border-border/60 font-semibold">
              <td className="py-1 pr-3 font-sans" colSpan={2}>{t("pages:plan.total")}</td>
              <td className="py-1 pr-3 text-right">{formatCHF(gross)}</td>
              <td className="py-1 pr-3 text-right text-loss">−{formatCHF(tax)}</td>
              <td className="py-1 text-right">{formatCHF(gross - tax)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {saving >= 1 && (
        <p className="text-gain text-xs">{t("pages:plan.saving", { amount: formatCHF(saving) })}</p>
      )}
      <p className="text-text-tertiary text-[11px] leading-relaxed">{t("pages:plan.rules")}</p>
    </div>
  );
}
