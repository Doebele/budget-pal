/**
 * Cashflow-Sankey — powered by Apache ECharts.
 *
 * Renders a 3-column Sankey when sub-items are available:
 *   Left   : Einnahmen
 *   Middle : Supercategories
 *   Right  : Sub-items per supercategory
 *
 * Falls back to a 2-column layout (Einnahmen → Supercategories) when
 * no sub-items are present.
 *
 * The public SankeyData / SankeyLink / SankeyNode interfaces are kept
 * unchanged so Dashboard.tsx and Budget.tsx require no modifications.
 */
import ReactECharts from "echarts-for-react";
import { useMemo } from "react";
import { colors } from "@/lib/theme";
import { getCategoryColor } from "@/lib/categories";

// ── Public types (unchanged for caller compatibility) ──────────
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

// ── Helpers ────────────────────────────────────────────────────
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

/** Separator used to create unique sub-item node names without affecting the displayed label. */
const SEP = "\x00";

function displayName(raw: string): string {
  return raw.includes(SEP) ? raw.split(SEP)[1] : raw;
}

// ── Component ──────────────────────────────────────────────────
export default function SankeyChart({ data, height = 340 }: SankeyChartProps) {
  const option = useMemo(() => {
    // Filter + sort: only direct links from income node, positive values
    const direct = data.links.filter(
      (l) => (l.source === "Einnahmen" || l.source === "Verfügbar") && l.value > 0,
    );
    if (!direct.length) return null;

    const flows = [...direct].sort((a, b) => {
      if (a.target === "Sparen") return -1;
      if (b.target === "Sparen") return 1;
      return b.value - a.value;
    });

    const totalFlow = flows.reduce((s, f) => s + f.value, 0);
    if (totalFlow === 0) return null;

    const hasSubItems = flows.some((f) => f.subItems && f.subItems.length > 0);

    // ── Build ECharts nodes + links ──────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eNodes: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eLinks: any[] = [];
    const seen = new Set<string>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function addNode(name: string, nodeColor: string, labelOverride?: any) {
      if (seen.has(name)) return;
      seen.add(name);
      eNodes.push({
        name,
        itemStyle: { color: nodeColor, borderColor: nodeColor, borderWidth: 0 },
        ...(labelOverride ? { label: labelOverride } : {}),
      });
    }

    // Income (Einnahmen) node — label on the LEFT
    addNode("Einnahmen", colors.accent, {
      position: "left",
      color: colors.textPrimary,
      fontWeight: "bold",
      fontSize: 12,
      formatter: () => "Einnahmen",
    });

    flows.forEach((f, i) => {
      const c = flowColor(f, i);

      // Supercategory node
      // In 3-level: label on the left (between the two flow bands)
      // In 2-level: label on the right (normal)
      addNode(
        f.target,
        c,
        hasSubItems
          ? { position: "left", color: colors.textTertiary, fontSize: 10, formatter: (p: { name: string }) => displayName(p.name) }
          : { position: "right", color: colors.textSecondary, fontSize: 11, formatter: (p: { name: string }) => displayName(p.name) },
      );

      // Einnahmen → Supercategory link
      eLinks.push({
        source: "Einnahmen",
        target: f.target,
        value: f.value,
        lineStyle: { opacity: 0.45 },
      });

      // Sub-item nodes + links (3-level only)
      if (hasSubItems) {
        (f.subItems ?? []).forEach((sub) => {
          // Unique name: "Wohnen\x00Miete"  — label formatter strips the prefix
          const key = `${f.target}${SEP}${sub.label}`;
          addNode(key, c, {
            position: "right",
            color: colors.textSecondary,
            fontSize: 10,
            formatter: (p: { name: string }) => displayName(p.name),
          });
          eLinks.push({
            source: f.target,
            target: key,
            value: sub.value,
            lineStyle: { opacity: 0.40 },
          });
        });
      }
    });

    // ── ECharts option ────────────────────────────────────────
    return {
      backgroundColor: "transparent",

      tooltip: {
        trigger: "item",
        triggerOn: "mousemove",
        backgroundColor: colors.bgElevated,
        borderColor: colors.border,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: {
          color: colors.textPrimary,
          fontSize: 12,
          fontFamily: "Syne, system-ui, sans-serif",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        formatter: (params: any) => {
          const name: string  = params.name ?? "";
          const label         = displayName(name);
          const nodeColor     = params.color ?? colors.accent;

          if (params.dataType === "node") {
            // Build sub-items list for supercategory tooltip
            const flow = flows.find((f) => f.target === name);
            const subs = flow?.subItems ?? [];
            const subRows = subs
              .map(
                (s) =>
                  `<div style="display:flex;justify-content:space-between;gap:16px;color:${colors.textTertiary}">
                    <span>${s.label}</span>
                    <span style="font-variant-numeric:tabular-nums">${fmt(s.value)}</span>
                   </div>`,
              )
              .join("");

            return `
              <div style="min-width:160px">
                <div style="font-weight:700;color:${nodeColor};margin-bottom:4px;font-size:13px">${fmt(params.value)}</div>
                <div style="color:${colors.textSecondary};font-size:11px;margin-bottom:${subs.length ? 6 : 0}px">${label}</div>
                ${subs.length ? `<div style="border-top:1px solid ${colors.border};padding-top:6px;font-size:11px">${subRows}</div>` : ""}
              </div>`;
          }

          // Edge tooltip
          const srcRaw: string = params.data?.source ?? "";
          const tgtRaw: string = params.data?.target ?? "";
          return `
            <div style="min-width:140px">
              <div style="color:${colors.textTertiary};font-size:11px;margin-bottom:2px">
                ${displayName(srcRaw)} → ${displayName(tgtRaw)}
              </div>
              <div style="font-weight:700;color:${colors.textPrimary};font-size:13px">${fmt(params.value)}</div>
            </div>`;
        },
      },

      series: [
        {
          type: "sankey",
          data: eNodes,
          links: eLinks,
          orient: "horizontal",
          nodeWidth: 10,
          nodeGap: 10,
          // 0 = preserve insertion order (Sparen first) instead of crossing-minimisation
          layoutIterations: 0,
          draggable: false,
          emphasis: {
            focus: "adjacency",
            lineStyle: { opacity: 0.85 },
          },
          // Default label for nodes that don't have a per-node override
          label: {
            show: true,
            position: "right",
            fontSize: 11,
            fontFamily: "Syne, system-ui, sans-serif",
            color: colors.textSecondary,
            formatter: (p: { name: string }) => displayName(p.name),
          },
          lineStyle: {
            color: "gradient",
            curveness: 0.5,
            opacity: 0.45,
          },
          // Space for "Einnahmen" label on the left and sub-item labels on the right
          left: hasSubItems ? "14%" : "10%",
          right: hasSubItems ? "22%" : "18%",
          top: 8,
          bottom: 8,
        },
      ],
    };
  }, [data]);

  if (!option) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-text-tertiary text-sm"
      >
        Keine Daten verfügbar
      </div>
    );
  }

  return (
    <ReactECharts
      option={option}
      style={{ height, width: "100%" }}
      opts={{ renderer: "svg" }}
    />
  );
}
