/**
 * Shared deduplication logic for wizard budget entries.
 *
 * Both Dashboard (Sankey) and Budget (bars) need to show exactly the
 * entries from the latest wizard run. The same two-strategy approach
 * that WizardBudgetSidebar uses must be applied consistently here.
 */

export interface WizardBudgetEntry {
  id: number;
  notes: string | null;
  amount: number;
  created_at?: string | null;
  [key: string]: unknown;
}

/**
 * Given all wizard budget entries (with notes), returns only those
 * belonging to the single most-recent wizard run.
 *
 * Strategy 1 – created_at available:
 *   Filter to entries with the maximum timestamp (= latest run).
 *
 * Strategy 2 – fallback when created_at is null everywhere:
 *   Deduplicate by notes label (case-insensitive), keeping the entry
 *   with the highest id (= last inserted per label).
 */
export function deduplicateWizardBatch<T extends WizardBudgetEntry>(entries: T[]): T[] {
  if (entries.length === 0) return [];

  // Strategy 1: created_at-based batch filter
  const hasTimestamps = entries.some((b) => !!b.created_at);
  if (hasTimestamps) {
    const maxTs = entries.reduce(
      (max, b) => ((b.created_at || "") > max ? b.created_at || "" : max),
      "",
    );
    const batch = entries.filter((b) => b.created_at === maxTs);
    if (batch.length > 0) return batch;
  }

  // Strategy 2: deduplicate by notes label, keep highest id
  const byNote = new Map<string, T>();
  for (const b of entries) {
    const key = (b.notes ?? "").toLowerCase().trim();
    const existing = byNote.get(key);
    if (!existing || b.id > existing.id) {
      byNote.set(key, b);
    }
  }
  return [...byNote.values()];
}
