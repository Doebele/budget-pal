import { NavArrowLeft, NavArrowRight } from "@/lib/icons";
import { clsx } from "clsx";
import {
  TimeGranularity,
  computeDateRange,
  navigatePeriod,
  isCurrentPeriod,
  isRollingWindow,
} from "@/lib/granularity";

/** Left-to-right: Max → 2J → YTD → J → H → Q → M */
const TABS: { value: TimeGranularity; label: string; title: string }[] = [
  { value: "max",        label: "Max", title: "Gesamter Zeitraum" },
  { value: "twoyears",   label: "2J",  title: "Letzte 2 Jahre" },
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
  const rolling = isRollingWindow(granularity);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Granularity segmented control — gemeinsames Toggle-Muster */}
      <div className="toggle-group">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            title={tab.title}
            onClick={() => onChange(tab.value, new Date())}
            className={clsx("toggle-btn", granularity === tab.value && "active")}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Period navigation — hidden for rolling-window granularities */}
      <div className="flex items-center gap-1">
        {!rolling && (
          <button
            onClick={() => onChange(granularity, navigatePeriod(granularity, anchor, -1))}
            className="p-1.5 rounded hover:bg-bg-surface2 text-text-tertiary hover:text-text-primary transition-colors"
            title="Vorherige Periode"
          >
            <NavArrowLeft className="w-4 h-4" />
          </button>
        )}

        <span className="text-sm font-medium text-text-primary min-w-[110px] text-center select-none">
          {range.label}
        </span>

        {!rolling && (
          <>
            <button
              onClick={() => onChange(granularity, navigatePeriod(granularity, anchor, 1))}
              className="p-1.5 rounded hover:bg-bg-surface2 text-text-tertiary hover:text-text-primary transition-colors"
              title="Nächste Periode"
            >
              <NavArrowRight className="w-4 h-4" />
            </button>

            <button
              onClick={() => onChange(granularity, new Date())}
              className={clsx("toggle-btn ml-1", current && "active cursor-default")}
            >
              Aktuell
            </button>
          </>
        )}
      </div>
    </div>
  );
}
