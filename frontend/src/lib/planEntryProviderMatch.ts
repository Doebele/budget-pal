/**
 * Match recurring plan `description` text to a wizard provider id for ProviderBrandIcon.
 * Best-effort substring match (longest needle wins).
 */
import { EXPENSE_CATEGORIES } from "@/components/wizard/Step5AccordionExpenses";

const NEEDLE_ROWS: { id: string; needles: string[] }[] = (() => {
  const out: { id: string; needles: string[] }[] = [];
  for (const cat of EXPENSE_CATEGORIES) {
    for (const p of cat.providers) {
      const needles = new Set<string>();
      needles.add(p.name.toLowerCase());
      needles.add(p.id.replace(/-/g, " "));
      out.push({
        id: p.id,
        needles: [...needles].filter((n) => n.length >= 3),
      });
    }
  }
  return out;
})();

export function matchPlanEntryProviderId(description: string): string | null {
  const d = description.trim().toLowerCase();
  if (d.length < 3) return null;
  let best: { id: string; len: number } | null = null;
  for (const { id, needles } of NEEDLE_ROWS) {
    for (const n of needles) {
      if (d.includes(n) && (!best || n.length > best.len)) {
        best = { id, len: n.length };
      }
    }
  }
  return best?.id ?? null;
}
