import { ChevronLeft, ChevronRight } from "lucide-react";
import { clsx } from "clsx";
import {
  TimeGranularity,
  computeDateRange,
  navigatePeriod,
  isCurrentPeriod,
} from "@/lib/granularity";

/** Left-to-right: YTD → Jahr → Halbjahr → Quartal → Monat */
const TABS: { value: TimeGranularity; label: string; title: string }[] = [
  { value: "ytd",        label: "YTD", title: "Jahr bis heute" },
  { value: "yearly",     label: "J",   title: "Jährlich" },
  { value: "halfyearly", label: "H",   title: "Halbjährlich" },
  { value: "quarterly",  label: "Q",   title: "Vierteljährlich" },
  { value: "monthly",    label: "M",   title: "Monatlich" },
];

interface Props {
  granularity: TimeGranularity;
  anchor: Date;
  onChange: (granularity: TimeGranularity, anchor: Date) => void;
}

export default function GranularityNavigator({ granularity, anchor, onChange }: Props) {
  const range = computeDateRange(granularity, anchor);
  const current = isCurrentPeriod(granularity, anchor);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Granularity segmented control */}
      <div className="flex rounded-md border border-border/60 overflow-hidden">
        {TABS.map((tab, i) => (
          <button
            key={tab.value}
            title={tab.title}
            onClick={() => onChange(tab.value, new Date())}
            className={clsx(
              "px-3 py-1.5 text-xs font-medium transition-colors",
              i < TABS.length - 1 && "border-r border-border/40",
              granularity === tab.value
                ? "bg-accent/20 text-accent"
                : "text-text-tertiary hover:bg-bg-surface2 hover:text-text-primary"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Period navigation */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(granularity, navigatePeriod(granularity, anchor, -1))}
          className="p-1.5 rounded hover:bg-bg-surface2 text-text-tertiary hover:text-text-primary transition-colors"
          title="Vorherige Periode"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <span className="text-sm font-medium text-text-primary min-w-[110px] text-center select-none">
          {range.label}
        </span>

        <button
          onClick={() => onChange(granularity, navigatePeriod(granularity, anchor, 1))}
          className="p-1.5 rounded hover:bg-bg-surface2 text-text-tertiary hover:text-text-primary transition-colors"
          title="Nächste Periode"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <button
          onClick={() => onChange(granularity, new Date())}
          className={clsx(
            "px-2.5 py-1.5 rounded text-xs font-medium transition-colors ml-1",
            current
              ? "text-accent bg-accent/10 cursor-default"
              : "text-text-tertiary hover:text-text-primary hover:bg-bg-surface2"
          )}
        >
          Aktuell
        </button>
      </div>
    </div>
  );
}
