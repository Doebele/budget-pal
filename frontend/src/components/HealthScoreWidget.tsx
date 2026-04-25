/**
 * HealthScoreWidget — compact dashboard card showing the Budget Health Score.
 *
 * Calls GET /budget/health-score and displays:
 *   - Circular score ring (0–100) with grade letter
 *   - Five weighted components as small progress rows
 *   - Top improvement levers (collapsed by default)
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/lib/api";
import { clsx } from "clsx";
import { Activity, ChevronDown, ChevronUp, TrendingUp } from "lucide-react";

const GRADE_COLOR: Record<string, string> = {
  A: "text-gain",
  B: "text-gain/80",
  C: "text-warning",
  D: "text-orange-400",
  F: "text-loss",
};

const SCORE_RING_COLOR: Record<string, string> = {
  A: "#4ade80",
  B: "#86efac",
  C: "#fbbf24",
  D: "#fb923c",
  F: "#f87171",
};

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const dash = Math.min(1, score / 100) * circumference;
  const color = SCORE_RING_COLOR[grade] ?? "#6366f1";

  return (
    <div className="relative w-20 h-20 shrink-0">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 72 72">
        {/* Track */}
        <circle cx="36" cy="36" r={radius} fill="none" stroke="currentColor"
          strokeWidth="6" className="text-bg-surface2" />
        {/* Progress */}
        <circle cx="36" cy="36" r={radius} fill="none"
          stroke={color} strokeWidth="6"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.7s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx("text-xl font-bold font-mono leading-none", GRADE_COLOR[grade] ?? "text-text-primary")}>
          {grade}
        </span>
        <span className="text-[10px] text-text-tertiary font-mono">{Math.round(score)}</span>
      </div>
    </div>
  );
}

function ComponentRow({ name, score, weight, detail }: {
  name: string; score: number; weight: number; detail: string;
}) {
  const pct = Math.round(score);
  const barColor =
    score >= 75 ? "bg-gain" :
    score >= 50 ? "bg-warning" :
    "bg-loss";

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-text-secondary">{name}</span>
        <span className="text-text-tertiary font-mono">{pct}/100</span>
      </div>
      <div className="h-1.5 bg-bg-surface2 rounded-full overflow-hidden">
        <div
          className={clsx("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-text-disabled truncate" title={detail}>{detail}</p>
    </div>
  );
}

export default function HealthScoreWidget() {
  const [showDetails, setShowDetails] = useState(false);
  const [showLevers, setShowLevers] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["budget-health-score"],
    queryFn: () => healthApi.score().then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="card animate-pulse">
        <div className="skeleton h-4 w-32 rounded mb-3" />
        <div className="flex gap-4">
          <div className="skeleton w-20 h-20 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-3 rounded" />)}
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { score, grade, components, top_levers } = data;

  return (
    <div className="card space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 text-text-tertiary text-xs uppercase tracking-widest">
        <Activity className="w-3.5 h-3.5" />
        Budget-Gesundheit
      </div>

      {/* Score ring + top 3 components */}
      <div className="flex gap-4 items-start">
        <ScoreRing score={score} grade={grade} />

        <div className="flex-1 space-y-2 pt-1">
          {components.slice(0, 3).map((c) => (
            <ComponentRow key={c.name} {...c} />
          ))}
        </div>
      </div>

      {/* Expand to see all 5 components */}
      {components.length > 3 && (
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {showDetails
            ? <><ChevronUp className="w-3 h-3" />Weniger</>
            : <><ChevronDown className="w-3 h-3" />Alle {components.length} Komponenten</>}
        </button>
      )}

      {showDetails && (
        <div className="space-y-2 pt-1 border-t border-border/40 animate-fade-in">
          {components.slice(3).map((c) => (
            <ComponentRow key={c.name} {...c} />
          ))}
        </div>
      )}

      {/* Improvement levers */}
      {top_levers.length > 0 && (
        <div className="border-t border-border/40 pt-2">
          <button
            type="button"
            onClick={() => setShowLevers((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors w-full"
          >
            <TrendingUp className="w-3 h-3 text-accent" />
            <span className="flex-1 text-left">Verbesserungspotenzial</span>
            {showLevers ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>

          {showLevers && (
            <div className="mt-2 space-y-1.5 animate-fade-in">
              {top_levers.map((lever, i) => (
                <div key={i} className="bg-accent/5 border border-accent/15 rounded-lg px-2.5 py-1.5">
                  <p className="text-[11px] font-medium text-text-secondary">{lever.title}</p>
                  <p className="text-[10px] text-text-tertiary mt-0.5">{lever.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
