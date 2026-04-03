/**
 * ForecastCard — compact monthly projection tile.
 *
 * Shows: predicted income, expense, net with confidence badge.
 * Used in the grid view of the Forecast page.
 */
import { TrendingUp, TrendingDown, Minus, Users } from "lucide-react";
import { formatCHF } from "@/lib/theme";

export interface ForecastCardData {
  month: string;          // "2026-05"
  predicted_income: number;
  predicted_expense: number;
  net: number;
  confidence_low: number;
  confidence_high: number;
  peer_calibrated: boolean;
}

interface Props {
  data: ForecastCardData;
  isSelected?: boolean;
  onClick?: () => void;
}

function formatMonthFull(m: string): string {
  const [year, month] = m.split("-");
  const names = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  return `${names[parseInt(month, 10) - 1]} ${year}`;
}

export default function ForecastCard({ data, isSelected, onClick }: Props) {
  const isPositive = data.net >= 0;
  const confidenceRange = data.confidence_high - data.confidence_low;
  const uncertainty = Math.abs(confidenceRange / (data.net || 1)) * 100;

  const netColor = isPositive ? "text-gain" : "text-loss";
  const TrendIcon = isPositive
    ? TrendingUp
    : data.net < -100
    ? TrendingDown
    : Minus;

  return (
    <button
      onClick={onClick}
      className={`
        w-full text-left rounded-xl p-4 border transition-all duration-150
        ${isSelected
          ? "border-accent/60 bg-accent/10 shadow-md shadow-accent/10"
          : "border-border bg-bg-surface hover:border-border/80 hover:bg-bg-surface2"
        }
      `}
    >
      {/* Month header */}
      <div className="flex items-start justify-between mb-3">
        <p className="text-text-secondary text-xs font-medium">{formatMonthFull(data.month)}</p>
        <div className="flex items-center gap-1.5">
          {data.peer_calibrated && (
            <span title="Peer-Gruppe kalibriert">
              <Users className="w-3 h-3 text-violet-400" />
            </span>
          )}
          <TrendIcon className={`w-4 h-4 ${netColor}`} />
        </div>
      </div>

      {/* Net amount — primary */}
      <p className={`text-xl font-display font-bold ${netColor} mb-1`}>
        {isPositive ? "+" : ""}{formatCHF(data.net)}
      </p>

      {/* Confidence range */}
      <p className="text-text-tertiary text-[11px] mb-3">
        90%-Band: {formatCHF(data.confidence_low)} – {formatCHF(data.confidence_high)}
      </p>

      {/* Income / Expense bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-[11px]">
          <span className="text-gain">↑ {formatCHF(data.predicted_income)}</span>
          <span className="text-loss">↓ {formatCHF(data.predicted_expense)}</span>
        </div>

        {/* Visual ratio bar */}
        <div className="flex h-1.5 rounded-full overflow-hidden bg-bg">
          {data.predicted_income + data.predicted_expense > 0 && (
            <>
              <div
                className="bg-gain/70"
                style={{
                  width: `${(data.predicted_income / (data.predicted_income + data.predicted_expense)) * 100}%`,
                }}
              />
              <div className="flex-1 bg-loss/50" />
            </>
          )}
        </div>
      </div>

      {/* Uncertainty level */}
      {uncertainty > 20 && (
        <p className="text-[10px] text-amber-400/80 mt-2 flex items-center gap-1">
          <span>⚠</span> Hohe Unsicherheit ({Math.round(uncertainty)}%)
        </p>
      )}
    </button>
  );
}
