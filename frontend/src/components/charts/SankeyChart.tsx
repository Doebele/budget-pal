/**
 * Cashflow-Sankey mit @nivo/sankey (MIT).
 */
import { useMemo } from "react";
import { ResponsiveSankey } from "@nivo/sankey";
import { nivoTheme, colors } from "@/lib/theme";

interface SankeyNode {
  id: string;
}

interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

interface SankeyChartProps {
  data: SankeyData;
  height?: number;
}

const NODE_COLORS = [
  colors.accent,
  colors.gain,
  colors.warning,
  colors.purple,
  colors.teal,
  colors.loss,
  "#38bdf8",
  "#fb923c",
  "#f472b6",
];

function formatChf(v: number): string {
  if (Math.abs(v) >= 1000) return `CHF ${(v / 1000).toFixed(1)}k`;
  return `CHF ${Math.round(v).toLocaleString("de-CH")}`;
}

export default function SankeyChart({ data, height = 300 }: SankeyChartProps) {
  const validLinks = useMemo(
    () => data.links.filter((l) => l.value > 0),
    [data.links]
  );

  const chartData = useMemo(
    () => ({ nodes: data.nodes, links: validLinks }),
    [data.nodes, validLinks]
  );

  const nodeColorMap = useMemo(() => {
    const m: Record<string, string> = {};
    data.nodes.forEach((node, i) => {
      m[node.id] = NODE_COLORS[i % NODE_COLORS.length];
    });
    return m;
  }, [data.nodes]);

  if (!data.nodes.length || !validLinks.length) {
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
    <div style={{ height }} className="w-full min-h-[200px]">
      <ResponsiveSankey
        data={chartData}
        margin={{ top: 8, right: 120, bottom: 8, left: 120 }}
        align="justify"
        colors={(node: { id: string }) => nodeColorMap[node.id] || colors.accent}
        nodeOpacity={0.9}
        nodeHoverOpacity={1}
        nodeThickness={18}
        nodeSpacing={24}
        nodeBorderWidth={0}
        nodeBorderRadius={3}
        linkOpacity={0.25}
        linkHoverOpacity={0.5}
        linkContract={2}
        enableLinkGradient
        labelPosition="outside"
        labelOrientation="horizontal"
        labelPadding={16}
        labelTextColor={colors.textSecondary}
        valueFormat={(v) => formatChf(Number(v))}
        theme={{
          ...nivoTheme,
          labels: {
            text: {
              fill: colors.textSecondary,
              fontSize: 11,
              fontFamily: "Syne, system-ui, sans-serif",
            },
          },
        }}
        nodeTooltip={({ node }) => (
          <div
            style={{
              background: colors.bgElevated,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: "8px 12px",
              color: colors.textPrimary,
              fontSize: 12,
            }}
          >
            <strong>{node.id}</strong>
            <br />
            {formatChf(node.value)}
          </div>
        )}
        linkTooltip={({ link }) => (
          <div
            style={{
              background: colors.bgElevated,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              padding: "8px 12px",
              color: colors.textPrimary,
              fontSize: 12,
            }}
          >
            <strong>
              {link.source.id} → {link.target.id}
            </strong>
            <br />
            {formatChf(link.value)}
          </div>
        )}
      />
    </div>
  );
}
