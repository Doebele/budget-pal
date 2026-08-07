/** Values for transaction recurrence dropdowns (aligned with API query params). */
export type RecurrenceFilterValue =
  | ""
  | "once"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "halfyearly"
  | "yearly";

export const RECURRENCE_FILTER_OPTIONS: { value: RecurrenceFilterValue; label: string }[] = [
  { value: "", label: "Alle" },
  { value: "weekly", label: "Wöchentlich" },
  { value: "monthly", label: "Monatlich" },
  { value: "quarterly", label: "Vierteljährlich" },
  { value: "halfyearly", label: "Halbjährlich" },
  { value: "yearly", label: "Jährlich" },
  { value: "once", label: "Einmalig" },
];

/** Maps UI value to GET /transactions (and /archived) query params. */
export function recurrenceFilterToApiParams(
  v: RecurrenceFilterValue
): { is_recurring?: boolean; periodicity?: string } {
  if (!v) return {};
  if (v === "once") return { is_recurring: false };
  return { periodicity: v };
}
