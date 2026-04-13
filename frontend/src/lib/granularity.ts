import {
  startOfMonth, endOfMonth, addMonths,
  startOfQuarter, endOfQuarter, addQuarters, getQuarter,
  startOfYear, endOfYear, addYears,
  isSameMonth, isSameQuarter, isSameYear,
  format,
} from "date-fns";
import { de } from "date-fns/locale";

export type TimeGranularity = "monthly" | "quarterly" | "halfyearly" | "yearly" | "ytd" | "twoyears" | "max";

export interface DateRange {
  from: Date;
  to: Date;
  label: string;
}

export function computeDateRange(granularity: TimeGranularity, anchor: Date): DateRange {
  const today = new Date();

  switch (granularity) {
    case "monthly":
      return {
        from: startOfMonth(anchor),
        to: endOfMonth(anchor),
        label: format(anchor, "MMM yyyy", { locale: de }),
      };

    case "quarterly": {
      const q = getQuarter(anchor);
      return {
        from: startOfQuarter(anchor),
        to: endOfQuarter(anchor),
        label: `Q${q} ${anchor.getFullYear()}`,
      };
    }

    case "halfyearly": {
      const year = anchor.getFullYear();
      const isH1 = anchor.getMonth() < 6;
      return {
        from: new Date(year, isH1 ? 0 : 6, 1),
        to: new Date(year, isH1 ? 5 : 11, isH1 ? 30 : 31, 23, 59, 59, 999),
        label: `H${isH1 ? 1 : 2} ${year}`,
      };
    }

    case "yearly":
      return {
        from: startOfYear(anchor),
        to: endOfYear(anchor),
        label: `${anchor.getFullYear()}`,
      };

    case "ytd": {
      const year = anchor.getFullYear();
      const isCurrentYear = year === today.getFullYear();
      return {
        from: startOfYear(anchor),
        to: isCurrentYear ? today : endOfYear(anchor),
        label: `YTD ${year}`,
      };
    }

    case "twoyears":
      return {
        from: startOfMonth(addYears(today, -2)),
        to: today,
        label: "2 Jahre",
      };

    case "max":
      return {
        from: new Date(2000, 0, 1),
        to: today,
        label: "Maximum",
      };
  }
}

export function navigatePeriod(granularity: TimeGranularity, anchor: Date, direction: 1 | -1): Date {
  switch (granularity) {
    case "monthly":    return addMonths(anchor, direction);
    case "quarterly":  return addQuarters(anchor, direction);
    case "halfyearly": return addMonths(anchor, 6 * direction);
    case "yearly":
    case "ytd":        return addYears(anchor, direction);
    case "twoyears":
    case "max":        return anchor; // rolling windows — navigation not applicable
  }
}

export function isCurrentPeriod(granularity: TimeGranularity, anchor: Date): boolean {
  const today = new Date();
  switch (granularity) {
    case "monthly":    return isSameMonth(anchor, today);
    case "quarterly":  return isSameQuarter(anchor, today);
    case "halfyearly": {
      const anchorH = anchor.getMonth() < 6 ? 0 : 1;
      const todayH  = today.getMonth() < 6 ? 0 : 1;
      return anchor.getFullYear() === today.getFullYear() && anchorH === todayH;
    }
    case "yearly":
    case "ytd":       return isSameYear(anchor, today);
    case "twoyears":
    case "max":       return true; // always current (rolling windows)
  }
}

/** True for granularities that are fixed rolling windows — navigation arrows are hidden. */
export function isRollingWindow(granularity: TimeGranularity): boolean {
  return granularity === "twoyears" || granularity === "max";
}
