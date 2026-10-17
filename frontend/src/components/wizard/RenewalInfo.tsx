import { useTranslation } from "react-i18next";
import { nextRenewal } from "@/services/faviconService";

/** «Nächste Verlängerung: 15.12.2026 (in 59 Tagen)» — zum Planen von Kündigungen */
export default function RenewalInfo({ start, everyMonths, compact = false }: {
  start?: string;
  everyMonths: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (!start) return null;
  const due = nextRenewal(start, everyMonths);
  if (!due) return null;
  const days = Math.round((due.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  const date = due.toLocaleDateString("de-CH");
  const soon = days <= 30;
  if (compact) {
    return (
      <span className={soon ? "txt-warning" : "text-text-tertiary"}>
        {t("pages:step5.renewsShort", { date })}
      </span>
    );
  }
  return (
    <p className={soon ? "txt-warning text-sm" : "text-text-secondary text-sm"}>
      {t("pages:step5.renews", { date, count: days })}
    </p>
  );
}
