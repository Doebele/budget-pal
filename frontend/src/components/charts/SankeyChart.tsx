/**
 * Cashflow-Sankey — custom SVG implementation.
 *
 * Renders a 2-column Sankey:
 *   Left  : Einnahmen (one node spanning the full height)
 *   Right : Sparen + expense categories (stacked proportionally)
 *   Flows : filled cubic-bezier bands between the two columns
 *
 * Each SankeyLink may carry an optional `color` (used by Dashboard when it
 * passes supercategory colours) and `subItems` (shown in the hover tooltip).
 */
import { useRef, useState, useEffect, useCallback } from "react";
import { colors } from "@/lib/theme";
import { getCategoryColor } from "@/lib/categories";

// ── Types ────────────────────────────────────────────────────────
export interface SankeyNode {
  id: string;
}

export interface SankeySubItem {
  label: string;
  value: number;
  source?: "txn" | "wizard";
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  /** Optional explicit colour – overrides the SUPER_CATEGORIES lookup */
  color?: string;
  /** Sub-items shown in the hover tooltip */
  subItems?: SankeySubItem[];
}

export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

interface SankeyChartProps {
  data: SankeyData;
  height?: number;
}

// ── Fallback palette (if getCategoryColor returns nothing) ────────
const FALLBACK_COLORS = [
  "#6366f1", "#f0b429", "#ef4444", "#38bdf8",
  "#84cc16", "#a78bfa", "#fb923c", "#ec4899",
  "#22d3ee", "#34d399", "#94a3b8",
];

function flowColor(link: SankeyLink, idx: number): string {
  if (link.color) return link.color;
  const fromSuper = getCategoryColor(link.target);
  // getCategoryColor falls back to #94a3b8 for unknowns – use fallback palette
  // only when the result is the generic slate
  if (fromSuper && fromSuper !== "#94a3b8") return fromSuper;
  return FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
}

// ── Formatting ───────────────────────────────────────────────────
function fmt(v: number): string {
  if (v >= 1_000_000) return `CHF ${(v / 1_000_000).toFixed(2)} Mio.`;
  if (v >= 1_000)     return `CHF ${(v / 1_000).toFixed(1)}k`;
  return `CHF ${Math.round(v).toLocaleString("de-CH")}`;
}

// ── Margins / geometry ───────────────────────────────────────────
const ML = 130;   // left margin  (space for Einnahmen label + value)
const MR = 190;   // right margin (space for right labels + values)
const MT = 12;
const MB = 12;
const NW = 22;    // node width
const GAP = 3;    // px gap between right nodes

// ── Component ────────────────────────────────────────────────────
export default function SankeyChart({ data, height = 300 }: SankeyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth] = useState(700);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setSvgWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    setSvgWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ── Derive flows ────────────────────────────────────────────────
  const flows = (() => {
    const direct = data.links.filter(
      (l) => (l.source === "Einnahmen" || l.source === "Verfügbar") && l.value > 0
    );
    if (!direct.length) return [];
    return [...direct].sort((a, b) => {
      if (a.target === "Sparen") return -1;
      if (b.target === "Sparen") return 1;
      return b.value - a.value;
    });
  })();

  const totalIncome = (() => {
    // When all links come from "Einnahmen", the first link's source total = income
    // But we sum flows to be safe
    return flows.reduce((s, f) => s + f.value, 0);
  })();

  const totalFlow = flows.reduce((s, f) => s + f.value, 0);

  // ── Empty state ─────────────────────────────────────────────────
  if (!flows.length || totalFlow === 0) {
    return (
      <div
        ref={containerRef}
        style={{ height }}
        className="flex items-center justify-center text-text-tertiary text-sm"
      >
        Keine Daten verfügbar
      </div>
    );
  }

  // ── Layout ──────────────────────────────────────────────────────
  const innerH = height - MT - MB;
  const innerW = svgWidth - ML - MR;

  const totalGaps = GAP * (flows.length - 1);
  const availH = innerH - totalGaps;

  let rightY = 0;
  const nodes = flows.map((f, i) => {
    const h = Math.max(4, (f.value / totalFlow) * availH);
    const node = { ...f, y: rightY, h, color: flowColor(f, i) };
    rightY += h + GAP;
    return node;
  });

  const leftScale = innerH / (rightY - GAP || 1);
  let leftY = 0;
  const flowsWithLeft = nodes.map((n) => {
    const leftH = n.h * leftScale;
    const out = { ...n, leftY, leftH };
    leftY += leftH;
    return out;
  });

  const leftX  = 0;
  const rightX = innerW;
  const midX   = innerW / 2;

  // ── Bezier band path ─────────────────────────────────────────────
  const bandPath = (n: typeof flowsWithLeft[0]) => {
    const x1 = leftX + NW;
    const x2 = rightX;
    const ly0 = n.leftY;
    const ly1 = n.leftY + n.leftH;
    const ry0 = n.y;
    const ry1 = n.y + n.h;
    return [
      `M ${x1} ${ly0}`,
      `C ${midX} ${ly0}, ${midX} ${ry0}, ${x2} ${ry0}`,
      `L ${x2} ${ry1}`,
      `C ${midX} ${ry1}, ${midX} ${ly1}, ${x1} ${ly1}`,
      "Z",
    ].join(" ");
  };

  // ── Mouse handlers ────────────────────────────────────────────────
  const handleEnter = useCallback(
    (id: string, e: React.MouseEvent) => {
      setHovered(id);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) setTooltip({ id, x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    []
  );
  const handleLeave = useCallback(() => {
    setHovered(null);
    setTooltip(null);
  }, []);

  return (
    <div ref={containerRef} style={{ height, width: "100%", position: "relative" }}>
      <svg width={svgWidth} height={height} style={{ display: "block" }}>
        <defs>
          {flowsWithLeft.map((n) => (
            <linearGradient
              key={`grad-${n.target}`}
              id={`grad-${n.target.replace(/[\s&]/g, "_")}`}
              x1="0%" y1="0%" x2="100%" y2="0%"
            >
              <stop offset="0%"   stopColor={n.color} stopOpacity={0.55} />
              <stop offset="100%" stopColor={n.color} stopOpacity={0.25} />
            </linearGradient>
          ))}
        </defs>

        <g transform={`translate(${ML},${MT})`}>
          {/* ── Bezier flow bands ── */}
          {flowsWithLeft.map((n) => {
            const isHov = hovered === n.target;
            return (
              <path
                key={`band-${n.target}`}
                d={bandPath(n)}
                fill={`url(#grad-${n.target.replace(/[\s&]/g, "_")})`}
                opacity={isHov ? 0.85 : 0.6}
                style={{ cursor: "default", transition: "opacity 0.15s" }}
                onMouseEnter={(e) => handleEnter(n.target, e)}
                onMouseLeave={handleLeave}
              />
            );
          })}

          {/* ── Left node: Einnahmen ── */}
          <rect
            x={leftX} y={0} width={NW} height={innerH}
            fill={colors.accent} rx={3} opacity={0.9}
            style={{ cursor: "default" }}
            onMouseEnter={(e) => handleEnter("Einnahmen", e)}
            onMouseLeave={handleLeave}
          />
          {/* Left labels */}
          <text
            x={leftX - 10} y={innerH / 2 - (hovered === "Einnahmen" ? 9 : 0)}
            textAnchor="end" dominantBaseline="middle"
            fill={colors.textPrimary} fontSize={12} fontWeight={600}
          >
            Einnahmen
          </text>
          {hovered === "Einnahmen" && (
            <text
              x={leftX - 10} y={innerH / 2 + 11}
              textAnchor="end" dominantBaseline="middle"
              fill={colors.accent} fontSize={13} fontWeight={700}
            >
              {fmt(totalIncome)}
            </text>
          )}

          {/* ── Right nodes ── */}
          {flowsWithLeft.map((n) => {
            const isHov = hovered === n.target;
            const cy = n.y + n.h / 2;
            return (
              <g
                key={`node-${n.target}`}
                onMouseEnter={(e) => handleEnter(n.target, e)}
                onMouseLeave={handleLeave}
                style={{ cursor: "default" }}
              >
                <rect
                  x={rightX} y={n.y} width={NW} height={Math.max(n.h, 4)}
                  fill={n.color} rx={3}
                  opacity={isHov ? 1 : 0.88}
                  style={{ transition: "opacity 0.15s" }}
                />
                {/* Label */}
                <text
                  x={rightX + NW + 10} y={isHov ? cy - 9 : cy}
                  dominantBaseline="middle"
                  fill={isHov ? colors.textPrimary : colors.textSecondary}
                  fontSize={isHov ? 12 : 11}
                  fontWeight={isHov || n.target === "Sparen" ? 600 : 400}
                  style={{ transition: "font-size 0.1s" }}
                >
                  {n.target}
                </text>
                {/* Amount — only on hover */}
                {isHov && (
                  <text
                    x={rightX + NW + 10} y={cy + 9}
                    dominantBaseline="middle"
                    fill={n.color} fontSize={13} fontWeight={700}
                  >
                    {fmt(n.value)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* ── HTML tooltip overlay (subcategories) ── */}
      {tooltip && (() => {
        const flow = flowsWithLeft.find((n) => n.target === tooltip.id);
        if (!flow || !flow.subItems?.length) return null;

        // Clamp so tooltip stays within container
        const tipW = 220;
        const rawX = tooltip.x + ML + NW + 18;
        const clampedX = Math.min(rawX, (svgWidth || 700) - tipW - 8);
        const clampedY = Math.max(8, tooltip.y - 20);

        return (
          <div
            style={{
              position: "absolute",
              left: clampedX,
              top: clampedY,
              width: tipW,
              pointerEvents: "none",
              zIndex: 20,
            }}
            className="bg-bg-elevated border border-border rounded-xl px-3 py-2.5 shadow-2xl text-xs"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-text-primary">{flow.target}</span>
              <span className="font-mono font-bold text-sm" style={{ color: flow.color }}>
                {fmt(flow.value)}
              </span>
            </div>
            <div className="border-t border-border/40 pt-1.5 space-y-1">
              {flow.subItems.map((sub) => (
                <div key={sub.label} className="flex items-center justify-between gap-2">
                  <span className="text-text-tertiary truncate">{sub.label}</span>
                  <span className="font-mono text-text-secondary shrink-0">
                    {fmt(sub.value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
