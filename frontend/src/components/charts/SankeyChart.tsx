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
import { compareSubLabelsByTaxonomy, useTaxonomy } from "@/lib/categories";

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
  /** Taxonomy supercategory id — used when `flowOrder` is `superCategory` */
  superCategoryId?: string;
}

export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export type SankeyFlowOrder = "value" | "superCategory";

interface SankeyChartProps {
  data: SankeyData;
  height?: number;
  /** Middle column: by flow size (default) or by taxonomy supercategory order */
  flowOrder?: SankeyFlowOrder;
  /** Supercategory ids in display order (e.g. `superCategories.map((s) => s.id)`) */
  superCategoryOrder?: string[];
}

// ── Helpers ────────────────────────────────────────────────────
const FALLBACK_COLORS = [
  "#6366f1", "#f0b429", "#ef4444", "#38bdf8",
  "#84cc16", "#a78bfa", "#fb923c", "#ec4899",
  "#22d3ee", "#34d399", "#94a3b8",
];

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
export default function SankeyChart({
  data,
  height = 340,
  flowOrder = "value",
  superCategoryOrder = [],
}: SankeyChartProps) {
  const { getCategoryColor, superCategories } = useTaxonomy();
  const option = useMemo(() => {
    const scById = new Map(superCategories.map((s) => [s.id, s] as const));
    function flowColor(link: SankeyLink, idx: number): string {
      if (link.color) return link.color;
      const c = getCategoryColor(link.target);
      if (c && c !== "#94a3b8") return c;
      return FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
    }

    // Filter + sort: only direct links from income node, positive values
    const direct = data.links.filter(
      (l) => (l.source === "Einnahmen" || l.source === "Verfügbar") && l.value > 0,
    );
    if (!direct.length) return null;

    const orderIndex = new Map(superCategoryOrder.map((id, i) => [id, i]));

    const flows = [...direct].sort((a, b) => {
      // Nur bei «Nach Betrag»: Rest-Cashflow «Sparen» nach unten (weniger Kreuzungen).
      if (flowOrder !== "superCategory") {
        if (a.target === "Sparen") return 1;
        if (b.target === "Sparen") return -1;
      }
      if (flowOrder === "superCategory" && superCategoryOrder.length > 0) {
        const ia = orderIndex.get(a.superCategoryId ?? "") ?? 999;
        const ib = orderIndex.get(b.superCategoryId ?? "") ?? 999;
        if (ia !== ib) return ia - ib;
        return b.value - a.value;
      }
      return b.value - a.value;
    });

    const totalFlow = flows.reduce((s, f) => s + f.value, 0);
    if (totalFlow === 0) return null;

    const hasSubItems = flows.some((f) => f.subItems && f.subItems.length > 0);

    type PreparedSub = { label: string; value: number };
    const prepared = flows.map((f, i) => {
      const c = flowColor(f, i);
      const positive = (f.subItems ?? []).filter((s) => s.value > 0);
      let list: PreparedSub[] =
        positive.length > 0
          ? positive.map((s) => ({ label: s.label, value: s.value }))
          : [{ label: "Gesamtbetrag", value: f.value }];
      if (flowOrder === "superCategory" && positive.length > 0) {
        const sc = f.superCategoryId ? scById.get(f.superCategoryId) : undefined;
        list = [...list].sort((x, y) =>
          compareSubLabelsByTaxonomy(x.label, y.label, sc),
        );
      }
      return { flow: f, color: c, idx: i, subList: list };
    });

    // ── Build ECharts nodes + links ──────────────────────────
    // Schichten: links Einnahmen → alle Superknoten → alle Unterknoten (in derselben
    // Super-Reihenfolge). So bleibt die rechte Spalte an die mittlere gekoppelt und
    // layoutIterations:0 übernimmt diese Reihenfolge ohne Neuordnung.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eNodes: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eLinks: any[] = [];

    eNodes.push({
      name: "Einnahmen",
      itemStyle: { color: colors.accent, borderColor: colors.accent, borderWidth: 0 },
      label: {
        position: "left",
        color: colors.textPrimary,
        fontWeight: "bold",
        fontSize: 12,
        formatter: () => "Einnahmen",
      },
    });

    if (!hasSubItems) {
      prepared.forEach((p) => {
        const f = p.flow;
        eNodes.push({
          name: f.target,
          itemStyle: { color: p.color, borderColor: p.color, borderWidth: 0 },
          label: {
            position: "right",
            color: colors.textSecondary,
            fontSize: 11,
            formatter: (x: { name: string }) => displayName(x.name),
          },
        });
        eLinks.push({
          source: "Einnahmen",
          target: f.target,
          value: f.value,
          lineStyle: { opacity: 0.45 },
        });
      });
    } else {
      prepared.forEach((p) => {
        const f = p.flow;
        eNodes.push({
          name: f.target,
          itemStyle: { color: p.color, borderColor: p.color, borderWidth: 0 },
          label: {
            position: "left",
            color: colors.textTertiary,
            fontSize: 10,
            formatter: (x: { name: string }) => displayName(x.name),
          },
        });
      });

      prepared.forEach((p) => {
        const f = p.flow;
        p.subList.forEach((sub) => {
          const v = sub.value > 0 ? sub.value : f.value;
          if (v <= 0) return;
          const key = `${f.target}${SEP}${sub.label}`;
          eNodes.push({
            name: key,
            itemStyle: { color: p.color, borderColor: p.color, borderWidth: 0 },
            label: {
              position: "right",
              color: colors.textSecondary,
              fontSize: 10,
              formatter: (x: { name: string }) => displayName(x.name),
            },
          });
        });
      });

      prepared.forEach((p) => {
        const f = p.flow;
        eLinks.push({
          source: "Einnahmen",
          target: f.target,
          value: f.value,
          lineStyle: { opacity: 0.45 },
        });
      });

      prepared.forEach((p) => {
        const f = p.flow;
        p.subList.forEach((sub) => {
          const v = sub.value > 0 ? sub.value : f.value;
          if (v <= 0) return;
          const key = `${f.target}${SEP}${sub.label}`;
          eLinks.push({
            source: f.target,
            target: key,
            value: v,
            lineStyle: { opacity: 0.40 },
          });
        });
      });
    }

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
            let subs = flow?.subItems ?? [];
            if (flowOrder === "superCategory" && subs.length > 1) {
              const flowSc = flow?.superCategoryId
                ? scById.get(flow.superCategoryId)
                : undefined;
              subs = [...subs].sort((x, y) =>
                compareSubLabelsByTaxonomy(x.label, y.label, flowSc),
              );
            }
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
          nodeGap: 14,
          // Bei Taxonomie-Ansicht: 0 — sonst mischen die Layout-Iterationen die
          // Super-/Kategorie-Reihenfolge und erzeugen unnötige Kreuzungen.
          layoutIterations: flowOrder === "superCategory" ? 0 : 6,
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
  }, [data, flowOrder, getCategoryColor, superCategoryOrder, superCategories]);

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
