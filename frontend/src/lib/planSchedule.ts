/**
 * Fälligkeiten eines Budgetplan-Eintrags.
 *
 * Gegenstück zu `backend/app/services/plan_schedule.py`. Die Frage „in welchen
 * Monaten fällt dieser Eintrag an, und wie oft je Monat" stand vorher doppelt
 * im Frontend — in `Budgetplan.tsx` und in `Forecast.tsx` — und beide Kopien
 * behandelten `weekly` wie `monthly`, zählten einen wöchentlichen Eintrag also
 * einfach statt 4,33-fach.
 */

export interface PlanSchedule {
  periodicity: string;
  start_date: string;
  end_date: string | null;
}

/** Wie oft ein Eintrag je Monat anfällt, in dem er überhaupt anfällt. */
const OCCURRENCES_PER_MONTH: Record<string, number> = { weekly: 52 / 12 };

/** Monatsabstand zwischen zwei Fälligkeiten. */
const MONTH_STEP: Record<string, number> = {
  weekly: 1,
  monthly: 1,
  quarterly: 3,
  halfyearly: 6,
  yearly: 12,
};

export function occurrencesPerMonth(periodicity: string): number {
  return OCCURRENCES_PER_MONTH[periodicity] ?? 1;
}

/** Betrag einer Fälligkeit auf den Monatswert gerechnet. */
export function monthlyAmount(amount: number, periodicity: string): number {
  return amount * occurrencesPerMonth(periodicity);
}

/**
 * Monate (1–12) des Jahres, in denen der Eintrag anfällt.
 *
 * Ankermonat ist der Startmonat: ein quartalsweiser Eintrag ab März fällt im
 * März, Juni, September und Dezember an, nicht im Januar.
 */
export function applicableMonths(entry: PlanSchedule, year: number): number[] {
  const sd = new Date(entry.start_date + "T00:00:00");
  const ed = entry.end_date ? new Date(entry.end_date + "T00:00:00") : null;

  const startM =
    sd.getFullYear() < year ? 1 : sd.getFullYear() === year ? sd.getMonth() + 1 : null;
  if (startM === null) return [];

  const endM = ed
    ? ed.getFullYear() > year
      ? 12
      : ed.getFullYear() === year
        ? ed.getMonth() + 1
        : null
    : 12;
  if (endM === null) return [];

  const step = MONTH_STEP[entry.periodicity] ?? 1;
  const anchor = sd.getMonth() + 1;
  const months: number[] = [];
  for (let m = startM; m <= endM; m++) {
    if (((m - anchor) % step + step) % step === 0) months.push(m);
  }
  return months;
}
