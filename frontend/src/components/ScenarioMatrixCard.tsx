import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import type { RetirementScenarios, ScenarioHint } from "@/lib/api";
import { formatCHF } from "@/lib/theme";

/**
 * Szenarienmatrix (Rentenalter x Pensionskasse als Rente/halb/Kapital) mit
 * Nettoeinkommen pro Monat und Erfolgsquote, dazu Hinweise aus den eigenen
 * Zahlen. Rechnung: POST /projections/retirement-scenarios.
 */
export default function ScenarioMatrixCard({ data }: { data: RetirementScenarios }) {
  const { t } = useTranslation();
  const cell = (age: number, share: number) =>
    data.cells.find((c) => c.age === age && c.capital_share === share);
  const shareLabel = (s: number) => t(`pages:scenarios.share${Math.round(s * 100)}`);
  const best = Math.max(...data.cells.map((c) => c.net_start));

  const hintText = (h: ScenarioHint) => {
    const values = Object.fromEntries(
      Object.entries(h).map(([k, v]) => [k, k === "amount" && typeof v === "number" ? formatCHF(v) : v]),
    );
    const key = h.key === "lowSuccess" && h.age == null ? "lowSuccessNoAge" : h.key;
    return t(`pages:scenarios.hint_${key}`, values);
  };

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-text-primary font-semibold text-sm">{t("pages:scenarios.title")}</h2>
        <p className="text-text-tertiary text-xs mt-0.5">{t("pages:scenarios.subtitle")}</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-tertiary text-left">
              <th className="py-1 pr-3 font-medium">{t("pages:scenarios.age")}</th>
              {data.shares.map((s) => (
                <th key={s} className="py-1 pr-3 font-medium text-right">{shareLabel(s)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.ages.map((age) => (
              <tr key={age} className="border-t border-border/30">
                <td className="py-2 pr-3 font-semibold text-text-primary">{age}</td>
                {data.shares.map((s) => {
                  const c = cell(age, s);
                  if (!c) return <td key={s} />;
                  const yours = age === data.planned_age && s === data.own_share;
                  return (
                    <td key={s} className={clsx("py-2 pr-3 text-right align-top rounded", yours && "bg-accent/10")}>
                      <p className={clsx("font-mono font-semibold", c.net_start === best ? "text-gain" : "text-text-primary")}>
                        {formatCHF(c.net_start)}
                      </p>
                      {c.net_75 != null && (
                        <p className="text-text-tertiary text-[10px]">{t("pages:scenarios.at75", { amount: formatCHF(c.net_75) })}</p>
                      )}
                      <p className={clsx("text-[10px]", c.success_rate >= 0.8 ? "text-text-tertiary" : "text-loss")}>
                        {t("pages:scenarios.success", { pct: Math.round(c.success_rate * 100) })}
                      </p>
                      {yours && <p className="text-accent text-[10px]">{t("pages:scenarios.yours")}</p>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.hints.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-text-secondary text-xs font-semibold uppercase tracking-wide">{t("pages:scenarios.hintsTitle")}</p>
          <ul className="list-disc pl-5 space-y-1 text-xs text-text-secondary">
            {data.hints.map((h, i) => <li key={`${h.key}-${i}`}>{hintText(h)}</li>)}
          </ul>
        </div>
      )}
      <p className="text-text-tertiary text-[11px]">{t("pages:scenarios.disclaimer")}</p>
    </div>
  );
}
