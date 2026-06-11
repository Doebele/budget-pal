/**
 * Supercategory taxonomy — Daten aus `shared/taxonomy.json`, nach Login angereichert per
 * GET /api/taxonomy (merge eigener Category-Zeilen: icon = Super-ID bzw. wl:Super-ID).
 *
 * Verwendung:
 *   • `useTaxonomy()` in React-Komponenten (Farben, resolve*, groupBySuper, …)
 *   • `useTaxonomySuperCategories()` wenn nur die Liste nötig ist
 */
import type { IconComponent } from "@/lib/icons";
import { Bank, Cart, Component, GraduationCap, Home, Movie, PiggyBank, ShieldCheck, ShoppingBag, SmartphoneDevice, Train } from "@/lib/icons";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { taxonomyApi } from "@/lib/api";

import taxonomyJson from "../../../shared/taxonomy.json";

// ── Lucide icons by supercategory id (not in JSON) ─────────────

const SUPER_ICONS: Record<string, IconComponent> = {
  wohnen: Home,
  essen: Cart,
  mobilitaet: Train,
  versicherungen: ShieldCheck,
  freizeit: Movie,
  abos: SmartphoneDevice,
  shopping: ShoppingBag,
  bildung: GraduationCap,
  steuern: Bank,
  sparen: PiggyBank,
  sonstiges: Component,
};

export interface SuperCategory {
  id: string;
  label: string;
  icon: IconComponent;
  emoji: string;
  color: string;
  txnCategories: string[];
  legacyAliases?: string[];
  wizardLabels: string[];
}

interface TaxonomyJsonRow {
  id: string;
  label: string;
  emoji: string;
  color: string;
  txnCategories: string[];
  wizardLabels: string[];
  legacyAliases?: string[];
}

export function buildSuperCategoriesFromRows(rows: TaxonomyJsonRow[]): SuperCategory[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    icon: SUPER_ICONS[row.id] ?? Component,
    emoji: row.emoji,
    color: row.color,
    txnCategories: [...row.txnCategories],
    wizardLabels: [...row.wizardLabels],
    legacyAliases: row.legacyAliases ? [...row.legacyAliases] : undefined,
  }));
}

/** Bundled snapshot (vor Login / Fallback) — entspricht shared/taxonomy.json */
export const BUNDLED_SUPER_CATEGORIES: SuperCategory[] = buildSuperCategoriesFromRows(
  taxonomyJson.superCategories as TaxonomyJsonRow[],
);

async function fetchTaxonomySuperCategories(): Promise<SuperCategory[]> {
  const { data } = await taxonomyApi.snapshot();
  const rows = data.superCategories as TaxonomyJsonRow[];
  return buildSuperCategoriesFromRows(rows);
}

/** React Query: eine Anfrage, alle Subscriber aktualisieren sich. */
export function useTaxonomySuperCategories(): SuperCategory[] {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: ["taxonomy"],
    queryFn: fetchTaxonomySuperCategories,
    enabled: isAuthenticated,
    placeholderData: BUNDLED_SUPER_CATEGORIES,
    staleTime: 60_000,
  });
  // Never return an empty list — fall back to bundled snapshot if API
  // returned nothing (e.g. during startup when taxonomy.json was unavailable).
  return (data && data.length > 0) ? data : BUNDLED_SUPER_CATEGORIES;
}

export function useTaxonomy() {
  const list = useTaxonomySuperCategories();
  return useMemo(
    () => ({
      superCategories: list,
      resolveSuperCategory: (name: string, isWizard = false) =>
        resolveSuperCategoryFromList(list, name, isWizard),
      resolveSuperCategoryForRow: (cat: { name: string; icon?: string | null }) =>
        resolveSuperCategoryForRowFromList(list, cat),
      superCategoryGroupLabel: (cat: { name: string; icon?: string | null }) =>
        resolveSuperCategoryForRowFromList(list, cat).label,
      getCategoryColor: (name: string) => resolveSuperCategoryFromList(list, name, false).color,
      groupBySuper: (items: Array<{ category: string; total: number }>, isWizard = false) =>
        groupBySuperFromList(list, items, isWizard),
      categoryIsIncomeOriented: (cat: { name: string; icon?: string | null }) =>
        categoryIsIncomeOrientedFromList(list, cat),
      categoryIsExpenseOriented: (cat: { name: string; icon?: string | null }) =>
        categoryIsExpenseOrientedFromList(list, cat),
    }),
    [list],
  );
}

// ── Pure lookups (list = useTaxonomySuperCategories() oder BUNDLED) ──

/**
 * Unterkategorien-Sortierung (Sankey, «Nach Superkategorie»):
 * Reihenfolge wie in der Taxonomie — zuerst alle `txnCategories`, dann `wizardLabels`,
 * jeweils ohne Duplikate (case-insensitive).
 */
export function buildSubCategoryOrderKeys(sc: SuperCategory): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of sc.txnCategories) {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const w of sc.wizardLabels) {
    const k = w.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function isSyntheticSubLabel(label: string): boolean {
  const low = label.trim().toLowerCase();
  if (low === "gesamtbetrag") return true;
  if (low.startsWith("überschuss")) return true;
  return false;
}

/** Bekannte Taxonomie-Labels zuerst, dann übrige A–Z, synthetische Einträge zuletzt. */
export function compareSubLabelsByTaxonomy(
  labelA: string,
  labelB: string,
  sc: SuperCategory | undefined,
): number {
  const pa = isSyntheticSubLabel(labelA);
  const pb = isSyntheticSubLabel(labelB);
  if (pa !== pb) return pa ? 1 : -1;

  if (!sc) {
    return labelA.localeCompare(labelB, "de", { sensitivity: "base" });
  }

  const keys = buildSubCategoryOrderKeys(sc);
  const la = labelA.trim().toLowerCase();
  const lb = labelB.trim().toLowerCase();
  const ia = keys.findIndex((k) => k === la);
  const ib = keys.findIndex((k) => k === lb);

  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;

  return labelA.localeCompare(labelB, "de", { sensitivity: "base" });
}

export function getSuperCategoryByLabel(list: SuperCategory[], label: string): SuperCategory | undefined {
  const lower = label.toLowerCase();
  return list.find((sc) => sc.label.toLowerCase() === lower);
}

export function getSuperCategoryFromList(list: SuperCategory[], txnCategory: string): SuperCategory | undefined {
  const lower = txnCategory.toLowerCase();
  return list.find(
    (sc) =>
      sc.txnCategories.some((t) => t.toLowerCase() === lower) ||
      (sc.legacyAliases ?? []).some((a) => a.toLowerCase() === lower),
  );
}

export function getSuperCategoryByWizardLabelFromList(
  list: SuperCategory[],
  label: string,
): SuperCategory | undefined {
  const lower = label.toLowerCase();
  return list.find((sc) => sc.wizardLabels.includes(lower));
}

export function resolveSuperCategoryFromList(
  list: SuperCategory[],
  name: string,
  isWizard = false,
): SuperCategory {
  const lower = name.toLowerCase();

  const byLabel = list.find((sc) => sc.label.toLowerCase() === lower);
  if (byLabel) return byLabel;

  const byId = list.find((sc) => sc.id === lower);
  if (byId) return byId;

  if (isWizard) {
    const byWizard = getSuperCategoryByWizardLabelFromList(list, name);
    if (byWizard) return byWizard;
    const byTxn = getSuperCategoryFromList(list, name);
    if (byTxn) return byTxn;
  } else {
    const byTxn = getSuperCategoryFromList(list, name);
    if (byTxn) return byTxn;
    const byWizard = getSuperCategoryByWizardLabelFromList(list, name);
    if (byWizard) return byWizard;
  }

  // Fallback: last entry (usually "sonstiges"). If list is somehow empty,
  // return sonstiges from the bundled snapshot so callers never get undefined.
  return list[list.length - 1] ?? BUNDLED_SUPER_CATEGORIES[BUNDLED_SUPER_CATEGORIES.length - 1];
}

export function resolveSuperCategoryForRowFromList(
  list: SuperCategory[],
  cat: { name: string; icon?: string | null },
  isWizard = false,
): SuperCategory {
  const rawIcon = (cat.icon ?? "").trim();
  const lowIcon = rawIcon.toLowerCase();
  if (lowIcon.startsWith("wl:")) {
    const scId = lowIcon.slice(3);
    const sc = list.find((s) => s.id === scId);
    if (sc) return sc;
  }
  if (rawIcon) {
    const byIconId = list.find((s) => s.id === lowIcon);
    if (byIconId) return byIconId;
  }
  return resolveSuperCategoryFromList(list, cat.name, isWizard);
}

export function superCategoryGroupLabelFromList(
  cat: { name: string; icon?: string | null },
  list: SuperCategory[],
): string {
  return resolveSuperCategoryForRowFromList(list, cat).label;
}

export function categoryIsIncomeOrientedFromList(
  list: SuperCategory[],
  cat: { name: string; icon?: string | null },
): boolean {
  const raw = (cat.icon ?? "").trim();
  const low = raw.toLowerCase();
  if (low === "sparen") return true;
  if (low.startsWith("wl:") && low.slice(3) === "sparen") return true;
  if (resolveSuperCategoryFromList(list, cat.name, false).id === "sparen") return true;
  // Wizard-Labels (z. B. «Lohn (netto)») vor Txn priorisieren, falls beides zutrifft.
  return resolveSuperCategoryFromList(list, cat.name, true).id === "sparen";
}

export function categoryIsExpenseOrientedFromList(
  list: SuperCategory[],
  cat: { name: string; icon?: string | null },
): boolean {
  return !categoryIsIncomeOrientedFromList(list, cat);
}

export function getCategoryColorFromList(list: SuperCategory[], name: string): string {
  return resolveSuperCategoryFromList(list, name, false).color;
}

export interface SuperCategoryAggregate {
  superCategory: SuperCategory;
  total: number;
  subItems: Array<{ label: string; value: number }>;
}

export function groupBySuperFromList(
  list: SuperCategory[],
  items: Array<{ category: string; total: number }>,
  isWizard = false,
): SuperCategoryAggregate[] {
  const map = new Map<string, SuperCategoryAggregate>();

  for (const item of items) {
    if (item.total <= 0) continue;
    const sc = resolveSuperCategoryFromList(list, item.category, isWizard);
    if (sc.id === "sparen") continue;

    if (!map.has(sc.id)) {
      map.set(sc.id, { superCategory: sc, total: 0, subItems: [] });
    }
    const agg = map.get(sc.id)!;
    agg.total += item.total;
    agg.subItems.push({ label: item.category, value: item.total });
  }

  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** @deprecated Nutze useTaxonomySuperCategories() */
export const SUPER_CATEGORIES = BUNDLED_SUPER_CATEGORIES;

/** @deprecated Nutze useTaxonomy().resolveSuperCategory */
export function resolveSuperCategory(name: string, isWizard = false): SuperCategory {
  return resolveSuperCategoryFromList(BUNDLED_SUPER_CATEGORIES, name, isWizard);
}

/** @deprecated Nutze useTaxonomy().resolveSuperCategoryForRow */
export function resolveSuperCategoryForRow(
  cat: { name: string; icon?: string | null },
  isWizard = false,
): SuperCategory {
  return resolveSuperCategoryForRowFromList(BUNDLED_SUPER_CATEGORIES, cat, isWizard);
}

/** @deprecated Nutze useTaxonomy().superCategoryGroupLabel */
export function superCategoryGroupLabel(cat: { name: string; icon?: string | null }): string {
  return resolveSuperCategoryForRowFromList(BUNDLED_SUPER_CATEGORIES, cat).label;
}

/** @deprecated Nutze useTaxonomy().categoryIsIncomeOriented */
export function categoryIsIncomeOriented(cat: { name: string; icon?: string | null }): boolean {
  return categoryIsIncomeOrientedFromList(BUNDLED_SUPER_CATEGORIES, cat);
}

/** @deprecated Nutze useTaxonomy().categoryIsExpenseOriented */
export function categoryIsExpenseOriented(cat: { name: string; icon?: string | null }): boolean {
  return categoryIsExpenseOrientedFromList(BUNDLED_SUPER_CATEGORIES, cat);
}

/** @deprecated Nutze useTaxonomy().getCategoryColor */
export function getCategoryColor(name: string): string {
  return getCategoryColorFromList(BUNDLED_SUPER_CATEGORIES, name);
}

/** @deprecated Nutze useTaxonomy().groupBySuper */
export function groupBySuper(
  items: Array<{ category: string; total: number }>,
  isWizard = false,
): SuperCategoryAggregate[] {
  return groupBySuperFromList(BUNDLED_SUPER_CATEGORIES, items, isWizard);
}
