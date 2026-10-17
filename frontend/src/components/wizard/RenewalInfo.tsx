import { useTranslation } from "react-i18next";
import { nextCancellation, nextRenewal } from "@/services/faviconService";

const fmt = (d: Date) => d.toLocaleDateString("de-CH");
const daysUntil = (d: Date) => Math.round((d.getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);

/** Nächste Verlängerung und spätester Kündigungstermin — zum Planen von Kündigungen.
 *  In den letzten 30 Tagen vor dem Kündigungstermin hervorgehoben. */
export default function RenewalInfo({ start, everyMonths, noticeDays = 1, compact = false }: {
  start?: string;
  everyMonths: number;
  noticeDays?: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (!start) return null;
  const renews = nextRenewal(start, everyMonths);
  const cancel = nextCancellation(start, everyMonths, noticeDays);
  if (!renews || !cancel) return null;
  const soon = daysUntil(cancel.deadline) <= 30;
  if (compact) {
    return (
      <span className={soon ? "txt-warning" : "text-text-tertiary"}>
        {t("pages:step5.renewsShort", { date: fmt(renews) })} · {t("pages:step5.cancelShort", { deadline: fmt(cancel.deadline) })}
      </span>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-text-secondary text-sm">
        {t("pages:step5.renews", { date: fmt(renews), count: daysUntil(renews) })}
      </p>
      <p className={soon ? "txt-warning text-sm" : "text-text-secondary text-sm"}>
        {t("pages:step5.cancelBy", { deadline: fmt(cancel.deadline), end: fmt(cancel.end) })}
      </p>
    </div>
  );
}
