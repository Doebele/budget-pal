/**
 * Cashflow-Sankey — custom SVG implementation.
 *
 * Renders a 3-column Sankey when sub-items are available:
 *   Left   : Einnahmen (one node spanning full height)
 *   Middle : Supercategories (stacked proportionally)
 *   Right  : Sub-items per supercategory (grouped, proportional)
 *   Flows  : Cubic-bezier bands between columns
 *
 * Falls back to 2-column layout when no sub-items are provided.
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
  /** Sub-items shown in the 3rd column + hover tooltip */
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

// ── Fallback palette ─────────────────────────────────────────────
const FALLBACK_COLORS = [
  "#6366f1", "#f0b429", "#ef4444", "#38bdf8",
  "#84cc16", "#a78bfa", "#fb923c", "#ec4899",
  "#22d3ee", "#34d399", "#94a3b8",
];

function flowColor(link: SankeyLink, idx: number): string {
  if (link.color) return link.color;
  const c = getCategoryColor(link.target);
  if (c && c !== "#94a3b8") return c;
  return FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
}

function fmt(v: number): string {
  if (v >= 1_000_000) return `CHF ${(v / 1_000_000).toFixed(2)} Mio.`;
  if (v >= 1_000)     return `CHF ${(v / 1_000).toFixed(1)}k`;
  return `CHF ${Math.round(v).toLocaleString("de-CH")}`;
}

// ── Geometry constants ────────────────────────────────────────────
const MT = 12;
const MB = 12;
const GAP = 4;        // gap between supercategory nodes
const SUB_GAP = 1;    // gap between sub-items within a group

// ── Component ────────────────────────────────────────────────────
export default function SankeyChart({ data, height = 340 }: SankeyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgWidth, setSvgWidth] = useState(700);
  // hovered: null | "Einnahmen" | "<scLabel>" | "<scLabel>::<subLabel>"
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

  // ── Derive and sort flows ───────────────────────────────────────
  const flows = (() => {
    const direct = data.links.filter(
      (l) => (l.source === "Einnahmen" || l.source === "Verfügbar") && l.value > 0,
    );
    if (!direct.length) return [];
    return [...direct].sort((a, b) => {
      if (a.target === "Sparen") return -1;
      if (b.target === "Sparen") return 1;
      return b.value - a.value;
    });
  })();

  const totalFlow = flows.reduce((s, f) => s + f.value, 0);
  const hasSubItems = flows.some((f) => f.subItems && f.subItems.length > 0);

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

  // ── Layout: choose 3-level vs 2-level constants ─────────────────
  const ML   = hasSubItems ? 82  : 130;
  const MR   = hasSubItems ? 162 : 190;
  const NW_L = hasSubItems ? 12  : 22;   // left (Einnahmen) node width
  const NW_M = hasSubItems ? 10  : 22;   // middle (supercategory) node width
  const NW_R = 8;                         // right (sub-item) node width

  const innerH = height - MT - MB;
  const innerW = svgWidth - ML - MR;

  // Column x positions (left edge of each node column)
  const COL_L = 0;
  const COL_M = hasSubItems ? Math.round(innerW * 0.40) : innerW;  // for 2-level, COL_M = right edge
  const COL_R = Math.round(innerW * 0.72);

  // ── Middle column layout (supercategories) ──────────────────────
  const totalGaps = GAP * (flows.length - 1);
  const availH    = innerH - totalGaps;

  let midYCursor = 0;
  const midNodes = flows.map((f, i) => {
    const h = Math.max(4, (f.value / totalFlow) * availH);
    const node = { ...f, y: midYCursor, h, color: flowColor(f, i) };
    midYCursor += h + GAP;
    return node;
  });

  // Scale left node vertically (full innerH maps to stacked mid nodes)
  const leftScale = innerH / Math.max(midYCursor - GAP, 1);
  let leftYCursor = 0;
  const midWithLeft = midNodes.map((n) => {
    const leftH = n.h * leftScale;
    const out = { ...n, leftY: leftYCursor, leftH };
    leftYCursor += leftH;
    return out;
  });

  // ── Right column layout (sub-items, grouped by supercategory) ───
  interface RightNode {
    label: string;
    value: number;
    y: number;          // absolute y in chart coordinates
    h: number;
    midSliceY: number;  // y on right edge of parent mid-node
    midSliceH: number;  // height of slice on right edge of parent mid-node
    color: string;
  }

  const rightGroups: { midNode: (typeof midWithLeft)[0]; nodes: RightNode[] }[] = [];
  if (hasSubItems) {
    let rightYCursor = 0;
    for (const mNode of midWithLeft) {
      const subs = mNode.subItems ?? [];
      if (subs.length === 0) {
        rightGroups.push({ midNode: mNode, nodes: [] });
        rightYCursor += mNode.h + GAP;
        continue;
      }
      const subTotal = subs.reduce((s, sub) => s + sub.value, 0);
      const innerGapsTotal = SUB_GAP * Math.max(0, subs.length - 1);
      const availSubH = Math.max(0, mNode.h - innerGapsTotal);
      const subNodes: RightNode[] = [];
      let midSliceY = mNode.y;

      for (let j = 0; j < subs.length; j++) {
        const sub = subs[j];
        const frac = subTotal > 0 ? sub.value / subTotal : 1 / subs.length;
        const subH = Math.max(2, frac * availSubH);
        subNodes.push({
          label: sub.label,
          value: sub.value,
          y: rightYCursor,
          h: subH,
          midSliceY,
          midSliceH: subH,
          color: mNode.color,
        });
        rightYCursor += subH + (j < subs.length - 1 ? SUB_GAP : 0);
        midSliceY += subH + (j < subs.length - 1 ? SUB_GAP : 0);
      }
      rightYCursor += GAP;  // group gap
      rightGroups.push({ midNode: mNode, nodes: subNodes });
    }
  }

  // ── Hover helpers ───────────────────────────────────────────────
  const hoveredSc  = hovered?.split("::")[0] ?? null;
  const hoveredSub = hovered?.includes("::") ? hovered.split("::")[1] : null;

  function lmOpacity(target: string) {
    if (!hovered) return 0.6;
    return hoveredSc === target ? 0.8 : 0.25;
  }
  function mrOpacity(midLabel: string, subLabel: string) {
    if (!hovered) return 0.55;
    if (hoveredSc === midLabel && (!hoveredSub || hoveredSub === subLabel)) return 0.75;
    return 0.2;
  }

  const handleEnterLM = useCallback((id: string, e: React.MouseEvent) => {
    setHovered(id);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setTooltip({ id, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);
  const handleEnterMR = useCallback((midId: string, subLabel: string, e: React.MouseEvent) => {
    const id = `${midId}::${subLabel}`;
    setHovered(id);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setTooltip({ id, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);
  const handleLeave = useCallback(() => { setHovered(null); setTooltip(null); }, []);

  // ── Band path helpers ────────────────────────────────────────────
  function bandPath(x1: number, x2: number, ly0: number, ly1: number, ry0: number, ry1: number) {
    const cx = (x1 + x2) / 2;
    return [
      `M ${x1} ${ly0}`,
      `C ${cx} ${ly0}, ${cx} ${ry0}, ${x2} ${ry0}`,
      `L ${x2} ${ry1}`,
      `C ${cx} ${ry1}, ${cx} ${ly1}, ${x1} ${ly1}`,
      "Z",
    ].join(" ");
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} style={{ height, width: "100%", position: "relative" }}>
      <svg width={svgWidth} height={height} style={{ display: "block" }}>
        <defs>
          {/* Gradients for left→middle bands */}
          {midWithLeft.map((n) => (
            <linearGradient
              key={`grad-lm-${n.target}`}
              id={`grad-lm-${n.target.replace(/[\s&+]/g, "_")}`}
              x1="0%" y1="0%" x2="100%" y2="0%"
            >
              <stop offset="0%"   stopColor={n.color} stopOpacity={0.55} />
              <stop offset="100%" stopColor={n.color} stopOpacity={hasSubItems ? 0.30 : 0.22} />
            </linearGradient>
          ))}
          {/* Gradients for middle→right bands */}
          {hasSubItems && rightGroups.flatMap((grp) =>
            grp.nodes.map((sub) => (
              <linearGradient
                key={`grad-mr-${grp.midNode.target}-${sub.label}`}
                id={`grad-mr-${(grp.midNode.target + sub.label).replace(/[\s&+/]/g, "_")}`}
                x1="0%" y1="0%" x2="100%" y2="0%"
              >
                <stop offset="0%"   stopColor={sub.color} stopOpacity={0.40} />
                <stop offset="100%" stopColor={sub.color} stopOpacity={0.20} />
              </linearGradient>
            ))
          )}
        </defs>

        <g transform={`translate(${ML},${MT})`}>

          {/* ── Left→Middle bands ── */}
          {midWithLeft.map((n) => {
            const x1 = COL_L + NW_L;
            const x2 = COL_M;
            return (
              <path
                key={`band-lm-${n.target}`}
                d={bandPath(x1, x2, n.leftY, n.leftY + n.leftH, n.y, n.y + n.h)}
                fill={`url(#grad-lm-${n.target.replace(/[\s&+]/g, "_")})`}
                opacity={lmOpacity(n.target)}
                style={{ cursor: "default", transition: "opacity 0.15s" }}
                onMouseEnter={(e) => handleEnterLM(n.target, e)}
                onMouseLeave={handleLeave}
              />
            );
          })}

          {/* ── Middle→Right bands ── */}
          {hasSubItems && rightGroups.flatMap((grp) =>
            grp.nodes.map((sub) => {
              const x1 = COL_M + NW_M;
              const x2 = COL_R;
              return (
                <path
                  key={`band-mr-${grp.midNode.target}-${sub.label}`}
                  d={bandPath(x1, x2, sub.midSliceY, sub.midSliceY + sub.midSliceH, sub.y, sub.y + sub.h)}
                  fill={`url(#grad-mr-${(grp.midNode.target + sub.label).replace(/[\s&+/]/g, "_")})`}
                  opacity={mrOpacity(grp.midNode.target, sub.label)}
                  style={{ cursor: "default", transition: "opacity 0.15s" }}
                  onMouseEnter={(e) => handleEnterMR(grp.midNode.target, sub.label, e)}
                  onMouseLeave={handleLeave}
                />
              );
            })
          )}

          {/* ── Left node: Einnahmen ── */}
          <rect
            x={COL_L} y={0} width={NW_L} height={innerH}
            fill={colors.accent} rx={3} opacity={hovered === "Einnahmen" ? 1 : 0.9}
            style={{ cursor: "default", transition: "opacity 0.15s" }}
            onMouseEnter={(e) => handleEnterLM("Einnahmen", e)}
            onMouseLeave={handleLeave}
          />
          <text
            x={COL_L - 8} y={innerH / 2 - (hovered === "Einnahmen" ? 9 : 0)}
            textAnchor="end" dominantBaseline="middle"
            fill={colors.textPrimary} fontSize={12} fontWeight={600}
          >
            Einnahmen
          </text>
          {hovered === "Einnahmen" && (
            <text
              x={COL_L - 8} y={innerH / 2 + 11}
              textAnchor="end" dominantBaseline="middle"
              fill={colors.accent} fontSize={13} fontWeight={700}
            >
              {fmt(totalFlow)}
            </text>
          )}

          {/* ── Middle nodes (supercategories) ── */}
          {midWithLeft.map((n) => {
            const isHov = hoveredSc === n.target;
            const cy = n.y + n.h / 2;
            const x = COL_M;
            const showInlineLabel = !hasSubItems;  // 2-level: labels to the right of this node

            return (
              <g
                key={`mid-${n.target}`}
                onMouseEnter={(e) => handleEnterLM(n.target, e)}
                onMouseLeave={handleLeave}
                style={{ cursor: "default" }}
              >
                <rect
                  x={x} y={n.y} width={NW_M} height={Math.max(n.h, 4)}
                  fill={n.color} rx={3}
                  opacity={isHov ? 1 : 0.88}
                  style={{ transition: "opacity 0.15s" }}
                />

                {/* Label + amount for 2-level (same as original right column) */}
                {showInlineLabel && (
                  <>
                    <text
                      x={x + NW_M + 10} y={isHov ? cy - 9 : cy}
                      dominantBaseline="middle"
                      fill={isHov ? colors.textPrimary : colors.textSecondary}
                      fontSize={isHov ? 12 : 11}
                      fontWeight={isHov || n.target === "Sparen" ? 600 : 400}
                      style={{ transition: "font-size 0.1s" }}
                    >
                      {n.target}
                    </text>
                    {isHov && (
                      <text
                        x={x + NW_M + 10} y={cy + 9}
                        dominantBaseline="middle"
                        fill={n.color} fontSize={13} fontWeight={700}
                      >
                        {fmt(n.value)}
                      </text>
                    )}
                  </>
                )}

                {/* For 3-level: short label to the LEFT of the mid node */}
                {hasSubItems && n.h >= 16 && (
                  <text
                    x={x - 6} y={cy}
                    textAnchor="end" dominantBaseline="middle"
                    fill={isHov ? colors.textPrimary : colors.textTertiary}
                    fontSize={isHov ? 11 : 10}
                    fontWeight={isHov ? 600 : 400}
                    style={{ pointerEvents: "none", transition: "font-size 0.1s" }}
                  >
                    {n.target.length > 14 ? n.target.slice(0, 13) + "…" : n.target}
                  </text>
                )}
              </g>
            );
          })}

          {/* ── Right nodes (sub-items) ── */}
          {hasSubItems && rightGroups.flatMap((grp) =>
            grp.nodes.map((sub) => {
              const key = `${grp.midNode.target}::${sub.label}`;
              const isHov = hoveredSc === grp.midNode.target &&
                (!hoveredSub || hoveredSub === sub.label);
              const cy = sub.y + sub.h / 2;

              return (
                <g
                  key={`right-${key}`}
                  onMouseEnter={(e) => handleEnterMR(grp.midNode.target, sub.label, e)}
                  onMouseLeave={handleLeave}
                  style={{ cursor: "default" }}
                >
                  <rect
                    x={COL_R} y={sub.y} width={NW_R} height={Math.max(sub.h, 2)}
                    fill={sub.color} rx={2}
                    opacity={isHov ? 1 : 0.75}
                    style={{ transition: "opacity 0.15s" }}
                  />
                  {sub.h >= 10 && (
                    <text
                      x={COL_R + NW_R + 7} y={cy}
                      dominantBaseline="middle"
                      fill={isHov ? colors.textPrimary : colors.textSecondary}
                      fontSize={10}
                      fontWeight={isHov ? 600 : 400}
                      style={{ pointerEvents: "none" }}
                    >
                      {sub.label.length > 22 ? sub.label.slice(0, 21) + "…" : sub.label}
                    </text>
                  )}
                  {isHov && (
                    <text
                      x={COL_R + NW_R + 7} y={cy + 11}
                      dominantBaseline="middle"
                      fill={sub.color} fontSize={10} fontWeight={700}
                      style={{ pointerEvents: "none" }}
                    >
                      {fmt(sub.value)}
                    </text>
                  )}
                </g>
              );
            })
          )}
        </g>
      </svg>

      {/* ── HTML tooltip overlay ── */}
      {tooltip && (() => {
        const isSubHover = tooltip.id.includes("::");
        const [midLabel, subLabel] = tooltip.id.split("::");

        if (isSubHover) {
          // Sub-item tooltip
          const grp = rightGroups.find((g) => g.midNode.target === midLabel);
          const sub = grp?.nodes.find((n) => n.label === subLabel);
          if (!sub) return null;
          const tipW = 200;
          const rawX = tooltip.x + 16;
          const clampedX = Math.min(rawX, (svgWidth || 700) - tipW - 8);
          return (
            <div
              style={{ position: "absolute", left: clampedX, top: Math.max(8, tooltip.y - 16), width: tipW, pointerEvents: "none", zIndex: 20 }}
              className="bg-bg-elevated border border-border rounded-xl px-3 py-2 shadow-2xl text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-secondary truncate">{sub.label}</span>
                <span className="font-mono font-bold shrink-0" style={{ color: sub.color }}>{fmt(sub.value)}</span>
              </div>
            </div>
          );
        }

        if (tooltip.id === "Einnahmen") {
          const tipW = 180;
          const rawX = tooltip.x + ML + NW_L + 10;
          const clampedX = Math.min(rawX, (svgWidth || 700) - tipW - 8);
          return (
            <div
              style={{ position: "absolute", left: clampedX, top: Math.max(8, tooltip.y - 16), width: tipW, pointerEvents: "none", zIndex: 20 }}
              className="bg-bg-elevated border border-border rounded-xl px-3 py-2 shadow-2xl text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="text-text-primary font-semibold">Einnahmen</span>
                <span className="font-mono font-bold text-sm" style={{ color: colors.accent }}>{fmt(totalFlow)}</span>
              </div>
            </div>
          );
        }

        // Supercategory tooltip
        const flow = midWithLeft.find((n) => n.target === tooltip.id);
        if (!flow) return null;
        const tipW = 230;
        const rawX = hasSubItems ? tooltip.x + 12 : tooltip.x + ML + NW_M + 18;
        const clampedX = Math.min(rawX, (svgWidth || 700) - tipW - 8);
        const clampedY = Math.max(8, tooltip.y - 20);
        return (
          <div
            style={{ position: "absolute", left: clampedX, top: clampedY, width: tipW, pointerEvents: "none", zIndex: 20 }}
            className="bg-bg-elevated border border-border rounded-xl px-3 py-2.5 shadow-2xl text-xs"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-text-primary">{flow.target}</span>
              <span className="font-mono font-bold text-sm" style={{ color: flow.color }}>{fmt(flow.value)}</span>
            </div>
            {flow.subItems && flow.subItems.length > 0 && (
              <div className="border-t border-border/40 pt-1.5 space-y-1">
                {flow.subItems.map((sub) => (
                  <div key={sub.label} className="flex items-center justify-between gap-2">
                    <span className="text-text-tertiary truncate">{sub.label}</span>
                    <span className="font-mono text-text-secondary shrink-0">{fmt(sub.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
