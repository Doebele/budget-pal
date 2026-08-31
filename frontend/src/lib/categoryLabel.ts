/**
 * Übersetzung von Kategorienamen.
 *
 * Kategorien kommen aus zwei Quellen mit unterschiedlichen Schlüsseln:
 *   - die DB liefert Slugs ("einnahmen-gehalt")
 *   - shared/taxonomy.json liefert deutsche Namen ("Gehalt")
 *
 * Beide werden auf denselben normalisierten Schlüssel abgebildet und im
 * Namespace `categories` nachgeschlagen. Findet sich nichts — etwa bei
 * selbst angelegten Kategorien der Nutzer — bleibt der Originaltext stehen.
 */
import i18n from "@/i18n";

/** "Restaurant & Takeaway" → "restaurant-takeaway" (wie die DB-Slugs). */
export function categoryKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Übersetzt einen Kategorienamen oder -Slug; unbekannte bleiben unverändert. */
export function translateCategory(value: string | null | undefined): string {
  if (!value) return "";
  const key = categoryKey(value);
  const hit = i18n.t(`categories:txn.${key}`, { defaultValue: "" });
  return hit || value;
}

/** Übersetzt ein Superkategorie-Label über dessen stabile ID. */
export function translateSuperCategory(id: string, fallback: string): string {
  return i18n.t(`categories:super.${id}`, { defaultValue: fallback });
}
