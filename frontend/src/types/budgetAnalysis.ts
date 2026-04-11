/** Modes selectable in the Budget UI (peer is toggled separately). */
export type BudgetAnalysisMode = "past" | "wizard" | "combined";

/** API may return `peer` for dedicated peer breakdown queries. */
export type MultiAnalysisApiMode = BudgetAnalysisMode | "peer";

export interface CategoryBreakdown {
  category: string;
  peer_key?: string | null;
  planned?: number | null;
  actual?: number | null;
  peer_benchmark?: number | null;
  blended?: number | null;
  delta_vs_peer?: number | null;
}

export interface PeerGroupInfo {
  age_range: string;
  household_type: string;
  median_income: number;
  p25_income: number;
  p75_income: number;
  savings_rate_pct: number;
  peer_count: number;
}

export interface SavingsOpportunity {
  category: string;
  peer_key: string;
  peer_label: string;
  actual: number;
  peer_benchmark: number;
  excess: number;
  excess_pct: number;
  monthly_saving: number;
  action: string;
}

export interface MultiAnalysisResult {
  mode: MultiAnalysisApiMode;
  period_start: string | null;
  period_end: string | null;
  income: number;
  total_expenses: number;
  savings_rate: number;
  categories: CategoryBreakdown[];
  peer_info: PeerGroupInfo | null;
  wizard_available: boolean;
  peer_data_available: boolean;
  data_sources: string[];
  opportunities: SavingsOpportunity[];
  reference_currency?: string;
}
