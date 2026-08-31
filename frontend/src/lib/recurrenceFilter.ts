/** Values for transaction recurrence dropdowns (aligned with API query params). */
export type RecurrenceFilterValue =
  | ""
  | "once"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "halfyearly"
  | "yearly";

// label = i18n-Schluessel, uebersetzt am Ausgabeort
export const RECURRENCE_FILTER_OPTIONS: { value: RecurrenceFilterValue; label: string }[] = [
  { value: "", label: "pages:budgetplan.all" },
  { value: "weekly", label: "periodicity.weekly" },
  { value: "monthly", label: "periodicity.monthly" },
  { value: "quarterly", label: "periodicity.quarterly" },
  { value: "halfyearly", label: "periodicity.halfyearly" },
  { value: "yearly", label: "periodicity.yearly" },
  { value: "once", label: "periodicity.once" },
];

/** Maps UI value to GET /transactions (and /archived) query params. */
export function recurrenceFilterToApiParams(
  v: RecurrenceFilterValue
): { is_recurring?: boolean; periodicity?: string } {
  if (!v) return {};
  if (v === "once") return { is_recurring: false };
  return { periodicity: v };
}
