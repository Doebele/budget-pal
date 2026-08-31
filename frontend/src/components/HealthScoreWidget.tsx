/**
 * HealthScoreWidget — Budget Health Score dashboard card.
 *
 * Layout:
 *   Header  — title + mode toggle (Historisch | Empirisch | Plan)
 *   Left    — large main score ring (grade + score)
 *   Right   — 5 small component rings side by side, each with tooltip
 *   Bottom  — collapsible improvement levers
 */
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/lib/api";
import { clsx } from "clsx";
import { Activity, GraphUp, NavArrowDown, NavArrowUp, Xmark } from "@/lib/icons";
import PortalTooltip from "@/components/ui/PortalTooltip";
import { useTranslation } from "react-i18next";

// ── Colour helpers ────────────────────────────────────────────

const GRADE_COLOR: Record<string, string> = {
  A: "text-gain",
  B: "text-gain/80",
  C: "text-warning",
  D: "txt-warning",
  F: "text-loss",
};

const GRADE_STROKE: Record<string, string> = {
  A: "#4ade80",
  B: "#86efac",
  C: "#fbbf24",
  D: "#fb923c",
  F: "#f87171",
};

function scoreStroke(score: number): string {
  if (score >= 75) return "#4ade80";
  if (score >= 50) return "#fbbf24";
  return "#f87171";
}

// ── Tooltip ───────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      <PortalTooltip
        anchorRef={ref}
        visible={visible}
        placement="top"
        className="w-56 rounded-lg bg-bg-surface border border-border shadow-xl px-3 py-2"
        style={{ fontSize: 11 }}
      >
        <p className="text-text-secondary leading-snug whitespace-pre-line">{text}</p>
      </PortalTooltip>
    </div>
  );
}

// ── Reusable ring ─────────────────────────────────────────────

function Ring({
  score,
  size,
  strokeWidth,
  color,
  label,
  sublabel,
  labelClass,
}: {
  score: number;
  size: number;
  strokeWidth: number;
  color: string;
  label: string;
  sublabel?: string;
  labelClass?: string;
}) {
  const r = (size - strokeWidth * 2) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const dash = Math.min(1, score / 100) * circumference;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        className="w-full h-full -rotate-90"
        viewBox={`0 0 ${size} ${size}`}
      >
        {/* Track */}
        <circle
          cx={cx} cy={cx} r={r}
          fill="none" stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-bg-surface2"
        />
        {/* Progress */}
        <circle
          cx={cx} cy={cx} r={r}
          fill="none" stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.7s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={clsx("font-bold font-mono leading-none", labelClass)}>
          {label}
        </span>
        {sublabel && (
          <span className="text-text-tertiary font-mono leading-none mt-0.5" style={{ fontSize: size < 60 ? 8 : 10 }}>
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Component tooltips ────────────────────────────────────────

// Schluessel des Backends -> Tooltip-Text (i18n)
const COMPONENT_TOOLTIPS: Record<string, string> = {
  savingsRate: "pages:health.tipSavingsRate",
  budgetAdherence: "pages:health.tipBudgetAdherence",
  cashflow: "pages:health.tipCashflow",
  retirementProvision: "pages:health.tipRetirementProvision",
  expenseDiversity: "pages:health.tipExpenseDiversity",
};

// ── Mode definitions ──────────────────────────────────────────

type ScoreMode = "historical" | "empirical" | "plan";

const MODES: { id: ScoreMode; label: string; tooltip: string }[] = [
  {
    id: "historical",
    label: "pages:health.modeHistorical",
    tooltip: "pages:health.tipModeHistorical",
  },
  {
    id: "empirical",
    label: "pages:health.modeEmpirical",
    tooltip: "pages:health.tipModeEmpirical",
  },
  {
    id: "plan",
    label: "pages:health.modePlan",
    tooltip: "pages:health.tipModePlan",
  },
];

// ── Main export ───────────────────────────────────────────────

export default function HealthScoreWidget() {
  const { t } = useTranslation();
  const [showLevers, setShowLevers] = useState(false);
  const [mode, setMode] = useState<ScoreMode>("historical");

  const { data, isLoading } = useQuery({
    queryKey: ["budget-health-score", mode],
    queryFn: () => healthApi.score({ mode }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="card animate-pulse">
        <div className="flex items-center justify-between mb-4">
          <div className="skeleton h-3 w-32 rounded" />
          <div className="flex gap-1">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="skeleton h-6 w-20 rounded-full" />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="skeleton rounded-full shrink-0" style={{ width: 96, height: 96 }} />
          <div className="flex gap-4 flex-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
                <div className="skeleton rounded-full" style={{ width: 52, height: 52 }} />
                <div className="skeleton h-2.5 w-12 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { score, grade, components, top_levers } = data;

  return (
    <div className="card space-y-4">
      {/* Header: title + mode toggle */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-text-tertiary text-xs uppercase tracking-widest flex-1">
          <Activity className="w-3.5 h-3.5" />
          {t("pages:ui.budget_gesundheit")}
        </div>

        {/* Mode toggle pills */}
        <div className="toggle-group">
          {MODES.map((m) => (
            <Tooltip key={m.id} text={t(m.tooltip)}>
              <button
                type="button"
                onClick={() => setMode(m.id)}
                className={clsx("toggle-btn", mode === m.id && "active")}
              >
                {t(m.label)}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      {/* Score ring + 5 component rings */}
      <div className="flex items-center gap-5">

        {/* Main score — larger ring */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <Ring
            score={score}
            size={96}
            strokeWidth={7}
            color={GRADE_STROKE[grade] ?? "#6366f1"}
            label={grade}
            sublabel={String(Math.round(score))}
            labelClass={clsx("text-2xl", GRADE_COLOR[grade] ?? "text-text-primary")}
          />
          <span className="text-[10px] text-text-tertiary">{t("pages:health.total")}</span>
        </div>

        {/* Divider */}
        <div className="w-px self-stretch bg-border/40 shrink-0" />

        {/* 5 component rings */}
        <div className="flex items-end gap-3 flex-1 justify-around">
          {components.map((c) => {
            const cName = c.name_key ? t(`pages:health.${c.name_key}`) : c.name;
            const cDetail = c.detail_key
              ? t(`pages:health.${c.detail_key}`, c.detail_params ?? {})
              : c.detail;
            const tip = COMPONENT_TOOLTIPS[c.name_key ?? ""];
            const tooltipText = tip
              ? `${t(tip)}\n\n${t("pages:health.currently")}: ${cDetail}`
              : cDetail;
            return (
              <Tooltip key={c.name} text={tooltipText}>
                <div className="flex flex-col items-center gap-1.5 min-w-0 cursor-default">
                  <Ring
                    score={c.score}
                    size={64}
                    strokeWidth={5}
                    color={scoreStroke(c.score)}
                    label={String(Math.round(c.score))}
                    labelClass="text-base"
                  />
                  <span
                    className="text-xs text-text-tertiary text-center leading-tight max-w-[72px]"
                  >
                    {cName}
                  </span>
                  <span className="text-[10px] text-text-disabled text-center leading-tight max-w-[72px] truncate" title={cDetail}>
                    {cDetail}
                  </span>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* Improvement levers */}
      {top_levers.length > 0 && (
        <div className="border-t border-border/40 pt-2">
          <button
            type="button"
            onClick={() => setShowLevers((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors w-full"
          >
            <GraphUp className="w-3 h-3 text-accent" />
            <span className="flex-1 text-left">{t("pages:ui.verbesserungspotenzial")}</span>
            {showLevers ? <NavArrowUp className="w-3 h-3" /> : <NavArrowDown className="w-3 h-3" />}
          </button>

          {showLevers && (
            <div className="mt-2 space-y-1.5 animate-fade-in">
              {top_levers.map((lever, i) => (
                <div key={i} className="bg-accent/5 border border-accent/15 rounded-lg px-2.5 py-1.5">
                  <p className="text-[11px] font-medium text-text-secondary">{lever.title_key ? t(`pages:health.${lever.title_key}`) : lever.title}</p>
                  <p className="text-[10px] text-text-tertiary mt-0.5">{lever.body_key ? t(`pages:health.${lever.body_key}`, lever.body_params ?? {}) : lever.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
