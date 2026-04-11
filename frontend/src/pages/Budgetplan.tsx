/**
 * Budgetplan — Annual recurring income/expense planner.
 *
 * Two views:
 *   1. Kalender  — 12 month columns, horizontal scroll, entry chips
 *   2. Monate    — Accordion list, one row per month with summary stats
 *
 * CRUD via slide-in sidebar editor.
 * Kalender: Einträge per Griff auf andere Monatsspalte ziehen (verschieben); mit Wahltaste (⌥) kopieren.
 * Filter: Alle | Nur Ausgaben | Nur Einnahmen (localStorage persisted)
 * Year navigation: prev/next buttons.
 */
import { useState, useMemo, useEffect, useRef, type DragEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Plus,
  X,
  Pencil,
  Trash2,
  Sparkles,
  CheckSquare,
  Square,
  Library,
  GripVertical,
} from "lucide-react";
import { clsx } from "clsx";

import { recurringPlanApi, accountsApi, categoriesApi } from "@/lib/api";
import { useTaxonomy } from "@/lib/categories";
import { matchPlanEntryProviderId } from "@/lib/planEntryProviderMatch";
import { formatCHF } from "@/lib/theme";
import ProviderBrandIcon from "@/components/wizard/ProviderBrandIcon";

// ── Types ────────────────────────────────────────────────────

interface RecurringPlanEntry {
  id: number;
  user_id: number;
  account_id: number | null;
  category_id: number | null;
  description: string;
  amount: number;
  periodicity: string;
  start_date: string;
  end_date: string | null;
  is_future: boolean;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface Account {
  id: number;
  name: string;
}

interface Category {
  id: number;
  name: string;
  parent_id?: number | null;
  icon?: string | null;
  is_system?: boolean;
  txn_count?: number;
}

interface PrefillSuggestion {
  description: string;
  amount: number;
  periodicity: string;
  category: string | null;
  notes: string | null;
  source: string;
}

const DND_ENTRY_MIME = "application/x-budgetplan-recurring-entry";

// ── Constants ─────────────────────────────────────────────────

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

const PERIODICITIES = [
  { value: "weekly", label: "Wöchentlich" },
  { value: "monthly", label: "Monatlich" },
  { value: "quarterly", label: "Quartalsweise" },
  { value: "halfyearly", label: "Halbjährlich" },
  { value: "yearly", label: "Jährlich" },
];

const PERIOD_FACTOR: Record<string, number> = {
  weekly: 4.33,
  monthly: 1,
  quarterly: 1 / 3,
  halfyearly: 1 / 6,
  yearly: 1 / 12,
};

// ── Helpers ───────────────────────────────────────────────────

function getApplicableMonths(entry: RecurringPlanEntry, year: number): number[] {
  const sd = new Date(entry.start_date + "T00:00:00");
  const ed = entry.end_date ? new Date(entry.end_date + "T00:00:00") : null;
  const startM = sd.getFullYear() < year ? 1 : sd.getFullYear() === year ? sd.getMonth() + 1 : null;
  if (startM === null) return [];
  const endM = ed
    ? ed.getFullYear() > year
      ? 12
      : ed.getFullYear() === year
      ? ed.getMonth() + 1
      : null
    : 12;
  if (endM === null) return [];
  const anchor = sd.getMonth() + 1;
  const months: number[] = [];
  for (let m = startM; m <= endM; m++) {
    switch (entry.periodicity) {
      case "weekly":
      case "monthly":
        months.push(m);
        break;
      case "quarterly":
        if (((m - anchor) % 3 + 3) % 3 === 0) months.push(m);
        break;
      case "halfyearly":
        if (((m - anchor) % 6 + 6) % 6 === 0) months.push(m);
        break;
      case "yearly":
        if (m === anchor) months.push(m);
        break;
    }
  }
  return months;
}

function periodicityLabel(p: string): string {
  return PERIODICITIES.find((x) => x.value === p)?.label ?? p;
}

const ISO_FAR = "9999-12-31";

function isoCmp(a: string, b: string): number {
  return a.localeCompare(b);
}

function isoMax(a: string, b: string): string {
  return isoCmp(a, b) >= 0 ? a : b;
}

function isoMin(a: string, b: string): string {
  return isoCmp(a, b) <= 0 ? a : b;
}

/** Last calendar day of month `month` (1–12) as YYYY-MM-DD. */
function lastDayOfMonthStr(y: number, month: number): string {
  const d = new Date(y, month, 0);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  return `${d.getFullYear()}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Split sorted month indices into consecutive runs, e.g. [1,2,4,5] → [[1,2],[4,5]]. */
function runsFromSortedMonths(months: number[]): number[][] {
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const runs: number[][] = [];
  let s = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] !== sorted[i - 1] + 1) {
      runs.push(sorted.slice(s, i));
      s = i;
    }
  }
  return runs;
}

function entryToCreatePayload(
  entry: RecurringPlanEntry,
  start_date: string,
  end_date: string | null,
  periodicity: string,
): Record<string, unknown> {
  return {
    description: entry.description,
    amount: entry.amount,
    periodicity,
    start_date,
    end_date,
    category_id: entry.category_id,
    account_id: entry.account_id,
    is_future: entry.is_future,
    notes: entry.notes,
  };
}

/**
 * Remove one plan month from a recurring row: either delete the row or replace it with
 * narrower / split rows so other months stay intact.
 */
function planRemoveMonthFromEntry(
  entry: RecurringPlanEntry,
  planYear: number,
  removeMonth: number,
): { creates: Record<string, unknown>[]; deleteId: number | null } {
  const inYear = getApplicableMonths(entry, planYear);
  if (!inYear.includes(removeMonth)) {
    return { creates: [], deleteId: null };
  }
  const remaining = inYear.filter((x) => x !== removeMonth).sort((a, b) => a - b);
  if (remaining.length === 0) {
    return { creates: [], deleteId: entry.id };
  }

  const entryEnd = entry.end_date ?? ISO_FAR;

  if (entry.periodicity === "monthly" || entry.periodicity === "weekly") {
    const coversAllMonthsInYear =
      inYear.length === 12 && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((mm) => inYear.includes(mm));
    if (!entry.end_date && coversAllMonthsInYear && remaining.length === 11) {
      const gap = inYear.find((mm) => !remaining.includes(mm));
      if (gap != null) {
        const creates: Record<string, unknown>[] = [];
        if (gap > 1) {
          const y0 = `${planYear}-01-01`;
          const hi = lastDayOfMonthStr(planYear, gap - 1);
          const ns = isoMax(entry.start_date, y0);
          const ne = hi;
          if (isoCmp(ns, ne) <= 0) {
            creates.push(entryToCreatePayload(entry, ns, ne, entry.periodicity));
          }
        }
        if (gap < 12) {
          const segLo = `${planYear}-${String(gap + 1).padStart(2, "0")}-01`;
          const ns = isoMax(entry.start_date, segLo);
          creates.push(entryToCreatePayload(entry, ns, null, entry.periodicity));
        }
        if (creates.length > 0) {
          return { creates, deleteId: entry.id };
        }
      }
    }

    const runs = runsFromSortedMonths(remaining);
    const creates: Record<string, unknown>[] = [];
    for (const run of runs) {
      const segLo = `${planYear}-${String(run[0]).padStart(2, "0")}-01`;
      const segHi = lastDayOfMonthStr(planYear, run[run.length - 1]);
      const newStart = isoMax(entry.start_date, segLo);
      let newEnd: string | null;
      if (!entry.end_date && run[run.length - 1] === 12) {
        newEnd = null;
      } else {
        const cap = isoMin(entryEnd, segHi);
        newEnd = cap === ISO_FAR ? null : cap;
      }
      const endBound = newEnd ?? ISO_FAR;
      if (isoCmp(newStart, endBound) > 0) continue;
      creates.push(entryToCreatePayload(entry, newStart, newEnd, entry.periodicity));
    }
    if (creates.length === 0) {
      return { creates: [], deleteId: null };
    }
    return { creates, deleteId: entry.id };
  }

  // quarterly / halfyearly / yearly: replace with one yearly row per remaining month in planYear
  const creates: Record<string, unknown>[] = [];
  for (const m of remaining) {
    const sd = `${planYear}-${String(m).padStart(2, "0")}-01`;
    creates.push(entryToCreatePayload(entry, sd, entry.end_date, "yearly"));
  }
  return { creates, deleteId: entry.id };
}

/** Strip leading emoji / ZWJ so native option text does not break layout; picker uses Lucide icons instead. */
function plainCategoryLabel(name: string): string {
  let s = name;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D]+/u, "").replace(/^\s+/, "");
    if (next === s) break;
    s = next;
  }
  const t = s.trim();
  return t || name;
}

function matchCategoryId(categories: Category[], hint: string | null): string {
  if (!hint?.trim()) return "";
  const lower = hint.trim().toLowerCase();
  const exact = categories.find((c) => c.name.trim().toLowerCase() === lower);
  if (exact) return String(exact.id);
  const plain = plainCategoryLabel(hint).toLowerCase();
  const byPlain = categories.find((c) => plainCategoryLabel(c.name).toLowerCase() === plain);
  if (byPlain) return String(byPlain.id);
  return "";
}

interface CategoryPickerProps {
  value: string;
  onChange: (categoryId: string) => void;
  groupedCategoryOptions: Array<{ label: string; items: Category[] }>;
  groupedCategoryIds: Set<number>;
  categories: Category[];
  /** true = Ausgabe, false = Einnahme */
  isExpense: boolean;
}

function BudgetplanCategoryPicker({
  value,
  onChange,
  groupedCategoryOptions,
  groupedCategoryIds,
  categories,
  isExpense,
}: CategoryPickerProps) {
  const { resolveSuperCategoryForRow, categoryIsIncomeOriented, categoryIsExpenseOriented } =
    useTaxonomy();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selectedId = value ? parseInt(value, 10) : NaN;
  const selectedCat = !Number.isNaN(selectedId) ? categories.find((c) => c.id === selectedId) : undefined;
  const selectedSc = selectedCat ? resolveSuperCategoryForRow(selectedCat) : null;
  const SelectedIcon = selectedSc?.icon;
  const selectedMatchesFlow = selectedCat
    ? isExpense
      ? categoryIsExpenseOriented(selectedCat)
      : categoryIsIncomeOriented(selectedCat)
    : true;
  const showOrphanAssigned =
    selectedCat && (!groupedCategoryIds.has(selectedCat.id) || !selectedMatchesFlow);

  function selectRow(id: string) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary text-left focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {selectedCat && SelectedIcon ? (
          <>
            <SelectedIcon className="w-4 h-4 shrink-0" style={{ color: selectedSc!.color }} />
            <span className="flex-1 truncate">{plainCategoryLabel(selectedCat.name)}</span>
          </>
        ) : (
          <span className="flex-1 text-text-tertiary">Keine Kategorie</span>
        )}
        <ChevronDown className={clsx("w-4 h-4 shrink-0 text-text-tertiary transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-[60] mt-1 max-h-[min(70vh,22rem)] overflow-y-auto rounded-lg border border-border bg-bg-surface shadow-xl py-1">
          <button
            type="button"
            onClick={() => selectRow("")}
            className={clsx(
              "w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-surface2 transition-colors",
              !value && "bg-accent/10"
            )}
          >
            <span className="text-text-tertiary text-xs flex-1">Keine Kategorie</span>
          </button>
          {showOrphanAssigned && (
            <div className="border-t border-border/40 pt-1 mt-1">
              <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                Aktuell zugewiesen
              </p>
              {(() => {
                const sc = resolveSuperCategoryForRow(selectedCat);
                const Icon = sc.icon;
                return (
                  <button
                    type="button"
                    onClick={() => selectRow(String(selectedCat.id))}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-surface2"
                  >
                    <Icon className="w-4 h-4 shrink-0" style={{ color: sc.color }} />
                    <span className="truncate">{plainCategoryLabel(selectedCat.name)}</span>
                  </button>
                );
              })()}
            </div>
          )}
          {groupedCategoryOptions.length === 0 && (
            <p className="px-3 py-2 text-xs text-text-tertiary">
              {isExpense
                ? "Keine passenden Kategorien geladen."
                : "Keine Einnahmen-Kategorien in der Superkategorie «Sparen». Unter Einstellungen → Taxonomie eigene Kategorien mit Superkategorie «Sparen» anlegen oder Server neu starten."}
            </p>
          )}
          {groupedCategoryOptions.map((group) => (
            <div key={group.label} className="border-t border-border/40 first:border-t-0">
              <p className="sticky top-0 z-[1] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary bg-bg-surface/95 backdrop-blur-sm">
                {group.label}
              </p>
              {group.items.map((c) => {
                const sc = resolveSuperCategoryForRow(c);
                const Icon = sc.icon;
                const active = value === String(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => selectRow(String(c.id))}
                    className={clsx(
                      "w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-bg-surface2 transition-colors",
                      active && "bg-accent/15"
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" style={{ color: sc.color }} />
                    <span className="truncate text-text-primary">{plainCategoryLabel(c.name)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Editor form state ─────────────────────────────────────────

interface FormState {
  description: string;
  amountAbs: string;
  isExpense: boolean;
  periodicity: string;
  category_id: string;
  account_id: string;
  start_date: string;
  end_date: string;
  is_future: boolean;
  notes: string;
}

function emptyForm(defaultMonth?: number | null): FormState {
  const today = new Date();
  const year = today.getFullYear();
  const m = defaultMonth ?? today.getMonth() + 1;
  const startDate = `${year}-${String(m).padStart(2, "0")}-01`;
  return {
    description: "",
    amountAbs: "",
    isExpense: true,
    periodicity: "monthly",
    category_id: "",
    account_id: "",
    start_date: startDate,
    end_date: "",
    is_future: true,
    notes: "",
  };
}

function entryToForm(e: RecurringPlanEntry): FormState {
  return {
    description: e.description,
    amountAbs: String(Math.abs(e.amount)),
    isExpense: e.amount < 0,
    periodicity: e.periodicity,
    category_id: e.category_id != null ? String(e.category_id) : "",
    account_id: e.account_id != null ? String(e.account_id) : "",
    start_date: e.start_date,
    end_date: e.end_date ?? "",
    is_future: e.is_future,
    notes: e.notes ?? "",
  };
}

// ── Main page ─────────────────────────────────────────────────

export default function Budgetplan() {
  const qc = useQueryClient();
  const {
    superCategories,
    superCategoryGroupLabel,
    resolveSuperCategoryForRow,
    resolveSuperCategory,
    categoryIsIncomeOriented,
    categoryIsExpenseOriented,
  } = useTaxonomy();

  // Persisted state
  const [year, setYear] = useState(new Date().getFullYear());
  const [view, setView] = useState<"calendar" | "accordion">(
    () => (localStorage.getItem("budgetplan_view") as "calendar" | "accordion") ?? "calendar"
  );
  const [filter, setFilter] = useState<"all" | "income" | "expense">(
    () => (localStorage.getItem("budgetplan_filter") as "all" | "income" | "expense") ?? "all"
  );

  // UI state
  const [openMonths, setOpenMonths] = useState<Set<number>>(new Set());
  const [editEntry, setEditEntry] = useState<RecurringPlanEntry | null>(null);
  const [addMonth, setAddMonth] = useState<number | null>(null);
  const sidebarOpen = editEntry !== null || addMonth !== null;

  // Form
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);

  // Prefill panel
  const [prefillOpen, setPrefillOpen] = useState(false);
  const [prefillSource, setPrefillSource] = useState<"historical" | "empirical">("empirical");
  const [prefillSourceYear, setPrefillSourceYear] = useState(new Date().getFullYear() - 1);
  const [prefillSelected, setPrefillSelected] = useState<Set<string>>(new Set());
  const [prefillResult, setPrefillResult] = useState<{ created: number; skipped: number } | null>(null);

  // Neuer Eintrag: Vorlage aus historisch / empirisch
  const [editorTemplateOpen, setEditorTemplateOpen] = useState(false);
  const [editorTplSource, setEditorTplSource] = useState<"historical" | "empirical">("empirical");
  const [editorTplYear, setEditorTplYear] = useState(new Date().getFullYear() - 1);

  /** Monat leeren — Bestätigungsdialog (Monatsindex 1–12 oder null) */
  const [clearMonthDialog, setClearMonthDialog] = useState<number | null>(null);

  /** Kalender: Drag & Drop auf Monatsspalte */
  const [dndOverMonth, setDndOverMonth] = useState<number | null>(null);
  const [dndDraggingId, setDndDraggingId] = useState<number | null>(null);

  // Queries
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["recurring-plan", year],
    queryFn: () => recurringPlanApi.list({ year }).then((r) => r.data as RecurringPlanEntry[]),
  });
  const { data: accounts = [] } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data as Account[]),
  });
  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list().then((r) => r.data as Category[]),
  });

  const bootstrapPeerRef = useRef(false);
  useEffect(() => {
    if (bootstrapPeerRef.current) return;
    bootstrapPeerRef.current = true;
    categoriesApi
      .bootstrapPeerSystem()
      .then((r) => {
        if ((r.data?.inserted ?? 0) > 0) {
          qc.invalidateQueries({ queryKey: ["categories"] });
        }
      })
      .catch(() => {});
  }, [qc]);

  // Suggest query (only fires when prefill panel is open)
  const { data: suggestions = [], isLoading: suggestLoading } = useQuery({
    queryKey: ["recurring-plan-suggest", prefillSource, prefillSourceYear],
    queryFn: () =>
      recurringPlanApi.suggest(prefillSource, prefillSourceYear).then((r) => r.data as PrefillSuggestion[]),
    enabled: prefillOpen,
    staleTime: 60_000,
  });

  const { data: editorSuggestions = [], isLoading: editorSuggestLoading } = useQuery({
    queryKey: ["recurring-plan-suggest", editorTplSource, editorTplYear, "editor"],
    queryFn: () =>
      recurringPlanApi.suggest(editorTplSource, editorTplYear).then((r) => r.data as PrefillSuggestion[]),
    enabled: sidebarOpen && editEntry === null && editorTemplateOpen,
    staleTime: 60_000,
  });

  const filteredEntries = useMemo(
    () =>
      entries.filter((e) =>
        filter === "all" ? true : filter === "income" ? e.amount > 0 : e.amount < 0
      ),
    [entries, filter]
  );

  const monthEntries = useMemo(() => {
    const map: Record<number, RecurringPlanEntry[]> = {};
    for (let m = 1; m <= 12; m++) map[m] = [];
    for (const entry of filteredEntries) {
      for (const m of getApplicableMonths(entry, year)) {
        map[m].push(entry);
      }
    }
    return map;
  }, [filteredEntries, year]);

  // Reset selection to all-checked when suggestions change
  useEffect(() => {
    if (suggestions.length > 0) {
      setPrefillSelected(new Set(suggestions.map((s) => `${s.description}::${s.periodicity}`)));
    }
  }, [suggestions]);

  // Mutations
  const invalidate = () => qc.invalidateQueries({ queryKey: ["recurring-plan", year] });

  const createMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => recurringPlanApi.create(data),
    onSuccess: () => { invalidate(); closeEditor(); },
    onError: (e: unknown) => setFormError(String((e as { message?: string })?.message ?? "Fehler beim Speichern")),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      recurringPlanApi.update(id, data),
    onSuccess: () => { invalidate(); closeEditor(); },
    onError: (e: unknown) => setFormError(String((e as { message?: string })?.message ?? "Fehler beim Speichern")),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => recurringPlanApi.delete(id),
    onSuccess: () => { invalidate(); closeEditor(); },
  });

  const dndMoveMut = useMutation({
    mutationFn: ({
      id,
      start_date,
      end_date,
    }: {
      id: number;
      start_date: string;
      end_date: string | null;
    }) => recurringPlanApi.update(id, { start_date, end_date }),
    onSuccess: () => invalidate(),
  });

  const dndCopyMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => recurringPlanApi.create(payload),
    onSuccess: () => invalidate(),
  });

  const clearMonthMut = useMutation({
    mutationFn: async (payload: { month: number; rows: RecurringPlanEntry[] }) => {
      const { month: targetMonth, rows } = payload;
      const unique = [...new Map(rows.map((e) => [e.id, e])).values()];
      for (const entry of unique) {
        const { creates, deleteId } = planRemoveMonthFromEntry(entry, year, targetMonth);
        if (!deleteId) continue;
        for (const body of creates) {
          await recurringPlanApi.create(body);
        }
        await recurringPlanApi.delete(deleteId);
      }
    },
    onSuccess: () => {
      invalidate();
      setClearMonthDialog(null);
    },
  });

  const prefillMut = useMutation({
    mutationFn: (entries: PrefillSuggestion[]) =>
      recurringPlanApi
        .prefill({ source: prefillSource, year: prefillSourceYear, target_year: year, entries })
        .then((r) => r.data as { created: number; skipped: number }),
    onSuccess: (result) => {
      invalidate();
      setPrefillResult(result);
      setPrefillOpen(false);
    },
  });

  function handlePrefillSubmit() {
    const selected = suggestions.filter((s) =>
      prefillSelected.has(`${s.description}::${s.periodicity}`)
    );
    prefillMut.mutate(selected);
  }

  // Editor open/close
  function openEdit(entry: RecurringPlanEntry) {
    setEditEntry(entry);
    setAddMonth(null);
    setEditorTemplateOpen(false);
    setForm(entryToForm(entry));
    setFormError(null);
  }
  function openAdd(month?: number) {
    setEditEntry(null);
    setAddMonth(month ?? null);
    setEditorTemplateOpen(false);
    setForm(emptyForm(month));
    setFormError(null);
  }

  function applySuggestionToForm(s: PrefillSuggestion) {
    const abs = Math.abs(s.amount);
    const catId = matchCategoryId(categories, s.category);
    setForm((f) => ({
      ...f,
      description: s.description,
      amountAbs: String(abs),
      isExpense: s.amount < 0,
      periodicity: s.periodicity,
      category_id: catId,
      notes: s.notes ?? f.notes,
      is_future: false,
    }));
    setFormError(null);
  }

  function closeEditor() {
    setEditEntry(null);
    setAddMonth(null);
    setFormError(null);
  }

  function handleSave() {
    const absVal = parseFloat(form.amountAbs);
    if (!form.description.trim()) { setFormError("Bezeichnung erforderlich"); return; }
    if (isNaN(absVal) || absVal <= 0) { setFormError("Gültiger Betrag erforderlich"); return; }
    if (!form.start_date) { setFormError("Startdatum erforderlich"); return; }

    const payload: Record<string, unknown> = {
      description: form.description.trim(),
      amount: form.isExpense ? -absVal : absVal,
      periodicity: form.periodicity,
      start_date: form.start_date,
      end_date: form.end_date || null,
      category_id: form.category_id ? parseInt(form.category_id) : null,
      account_id: form.account_id ? parseInt(form.account_id) : null,
      is_future: form.is_future,
      notes: form.notes.trim() || null,
    };

    if (editEntry) {
      updateMut.mutate({ id: editEntry.id, data: payload });
    } else {
      createMut.mutate(payload);
    }
  }

  const dndBusy = dndMoveMut.isPending || dndCopyMut.isPending;

  function handleRecurringDragStart(e: DragEvent, entry: RecurringPlanEntry) {
    e.dataTransfer.setData(DND_ENTRY_MIME, JSON.stringify({ id: entry.id }));
    e.dataTransfer.effectAllowed = "copyMove";
    setDndDraggingId(entry.id);
  }

  function handleRecurringDragEnd() {
    setDndDraggingId(null);
    setDndOverMonth(null);
  }

  function handleMonthColumnDragOver(e: DragEvent, month: number) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    setDndOverMonth(month);
  }

  function handleMonthColumnDrop(e: DragEvent, targetMonth: number) {
    e.preventDefault();
    setDndOverMonth(null);
    if (dndBusy) return;
    const raw = e.dataTransfer.getData(DND_ENTRY_MIME);
    if (!raw) return;
    let parsed: { id?: number };
    try {
      parsed = JSON.parse(raw) as { id?: number };
    } catch {
      return;
    }
    const id = parsed.id;
    if (id == null) return;
    const entry = entries.find((x) => x.id === id);
    if (!entry) return;

    const newStart = `${year}-${String(targetMonth).padStart(2, "0")}-01`;
    const newEnd =
      entry.end_date == null || entry.end_date >= newStart ? entry.end_date ?? null : null;

    if (!e.altKey) {
      if (entry.start_date === newStart && (entry.end_date ?? null) === newEnd) return;
      dndMoveMut.mutate({ id, start_date: newStart, end_date: newEnd });
    } else {
      dndCopyMut.mutate(entryToCreatePayload(entry, newStart, newEnd, entry.periodicity));
    }
  }

  // Category dropdown: dedupe and group by Superkategorie-Taxonomie (same as Einstellungen).
  const groupedCategoryOptions = useMemo(() => {
    const parentIds = new Set<number>();
    for (const c of categories) {
      if (c.parent_id != null) parentIds.add(c.parent_id);
    }

    // Blätter + Eltern mit icon «sparen» (System-Einnahmen), damit nicht nur Unterkategorien
    // erscheinen, wenn die DB Hierarchie mit Zwischenknoten modelliert ist.
    const leaves = categories.filter(
      (c) =>
        !parentIds.has(c.id) || String(c.icon ?? "").trim().toLowerCase() === "sparen",
    );

    type Bucket = { label: string; items: Category[] };
    const buckets = new Map<string, Bucket>();
    const optionByKey = new Map<string, Category>();

    function pickPreferredCategory(a: Category, b: Category): Category {
      const aWl = String(a.icon ?? "").startsWith("wl:") ? 1 : 0;
      const bWl = String(b.icon ?? "").startsWith("wl:") ? 1 : 0;
      if (aWl !== bWl) return aWl < bWl ? a : b;

      const aUser = a.is_system ? 0 : 1;
      const bUser = b.is_system ? 0 : 1;
      if (aUser !== bUser) return aUser > bUser ? a : b;

      const aCount = a.txn_count ?? 0;
      const bCount = b.txn_count ?? 0;
      if (aCount !== bCount) return aCount > bCount ? a : b;

      return a.id < b.id ? a : b;
    }

    for (const cat of leaves) {
      const sid = resolveSuperCategoryForRow(cat).id;
      const dedupKey = `${sid}::${cat.name.trim().toLowerCase()}`;
      const existing = optionByKey.get(dedupKey);
      optionByKey.set(dedupKey, existing ? pickPreferredCategory(existing, cat) : cat);
    }

    const superCategoryGroupOrder = [...superCategories.map((sc) => sc.label), "Weitere Kategorien"];

    for (const cat of optionByKey.values()) {
      const label = superCategoryGroupLabel(cat);
      const bucket = buckets.get(label) ?? { label, items: [] };
      bucket.items.push(cat);
      buckets.set(label, bucket);
    }

    for (const bucket of buckets.values()) {
      bucket.items.sort((a, b) => a.name.localeCompare(b.name, "de-CH"));
    }

    const flowExpense = form.isExpense;
    return Array.from(buckets.values())
      .map((bucket) => ({
        ...bucket,
        items: bucket.items.filter((c) =>
          flowExpense ? categoryIsExpenseOriented(c) : categoryIsIncomeOriented(c),
        ),
      }))
      .filter((bucket) => bucket.items.length > 0)
      .sort((a, b) => {
        const ai = superCategoryGroupOrder.indexOf(a.label);
        const bi = superCategoryGroupOrder.indexOf(b.label);
        const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
        const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
        if (av !== bv) return av - bv;
        return a.label.localeCompare(b.label, "de-CH");
      });
  }, [
    categories,
    form.isExpense,
    superCategories,
    superCategoryGroupLabel,
    resolveSuperCategoryForRow,
    categoryIsIncomeOriented,
    categoryIsExpenseOriented,
  ]);

  const groupedCategoryIds = useMemo(
    () => new Set(groupedCategoryOptions.flatMap((g) => g.items.map((i) => i.id))),
    [groupedCategoryOptions]
  );

  // Summary per month
  function monthSummary(m: number) {
    const list = monthEntries[m];
    const income = list.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const expense = list.filter((e) => e.amount < 0).reduce((s, e) => s + Math.abs(e.amount), 0);
    return { income, expense, count: list.length };
  }

  // View/filter persist
  function setViewPersist(v: "calendar" | "accordion") {
    setView(v);
    localStorage.setItem("budgetplan_view", v);
  }
  function setFilterPersist(f: "all" | "income" | "expense") {
    setFilter(f);
    localStorage.setItem("budgetplan_filter", f);
  }

  return (
    <div className="flex flex-col h-full gap-0">
      {/* ── Monat leeren: Bestätigung (kein window.confirm — zuverlässig in eingebetteten Webviews) ── */}
      {clearMonthDialog != null && (
        <>
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[70]"
            aria-hidden
            onClick={() => {
              if (!clearMonthMut.isPending) setClearMonthDialog(null);
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-month-title"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md mx-4 bg-bg-surface border border-border rounded-xl shadow-2xl z-[80] p-5"
          >
            <h3 id="clear-month-title" className="text-text-primary font-semibold text-base mb-2">
              {MONTH_NAMES[clearMonthDialog - 1]} {year} leeren?
            </h3>
            <p className="text-sm text-text-secondary mb-3">
              Die Posten werden in diesem Monat nicht mehr angezeigt. Wiederkehrende Einträge werden, soweit möglich,{" "}
              <span className="text-text-primary font-medium">aufgeteilt oder begrenzt</span>, damit sie in den anderen
              Monaten bestehen bleiben. Komplett nur in diesem Monat vorkommende Zeilen werden entfernt.
            </p>
            <p className="text-xs text-text-tertiary mb-4">
              Betroffene Planzeilen:{" "}
              <span className="font-mono text-text-primary">
                {new Set(monthEntries[clearMonthDialog].map((e) => e.id)).size}
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={clearMonthMut.isPending}
                onClick={() => setClearMonthDialog(null)}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-bg-surface2 rounded-lg transition-colors disabled:opacity-50"
              >
                Abbrechen
              </button>
              <button
                type="button"
                disabled={clearMonthMut.isPending}
                onClick={() =>
                  clearMonthMut.mutate({
                    month: clearMonthDialog,
                    rows: monthEntries[clearMonthDialog],
                  })
                }
                className="px-4 py-2 text-sm font-medium bg-loss hover:bg-loss/90 text-white rounded-lg transition-colors disabled:opacity-60"
              >
                {clearMonthMut.isPending ? "Wird verarbeitet…" : "Entfernen"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-2">
          <CalendarRange className="w-5 h-5 text-accent" />
          <h1 className="text-text-primary font-semibold text-lg">Budgetplan</h1>
        </div>

        {/* Year nav */}
        <div className="flex items-center gap-1 bg-bg-surface2 rounded-lg px-2 py-1">
          <button
            onClick={() => setYear((y) => y - 1)}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-mono text-sm text-text-primary px-2 min-w-[4rem] text-center">
            {year}
          </span>
          <button
            onClick={() => setYear((y) => y + 1)}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Filter pills */}
        <div className="flex gap-1">
          {(["all", "expense", "income"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilterPersist(f)}
              className={clsx(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                filter === f
                  ? "bg-accent text-white"
                  : "bg-bg-surface2 text-text-secondary hover:text-text-primary"
              )}
            >
              {f === "all" ? "Alle" : f === "expense" ? "Nur Ausgaben" : "Nur Einnahmen"}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Vorbefüllen button */}
        <button
          onClick={() => { closeEditor(); setPrefillOpen(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-bg-surface2 hover:bg-bg-surface border border-border text-text-secondary hover:text-text-primary rounded-lg text-sm font-medium transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          Vorbefüllen
        </button>

        {/* View toggle */}
        <div className="flex gap-1 bg-bg-surface2 rounded-lg p-1">
          <button
            onClick={() => setViewPersist("calendar")}
            className={clsx(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              view === "calendar"
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Kalender
          </button>
          <button
            onClick={() => setViewPersist("accordion")}
            className={clsx(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              view === "accordion"
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            Monate
          </button>
        </div>

        {/* Add button */}
        <button
          onClick={() => openAdd()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent/90 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" />
          Eintrag
        </button>
      </div>

      {/* ── Prefill success banner ── */}
      {prefillResult && (
        <div className="flex items-center gap-3 mb-3 px-4 py-3 bg-gain/10 border border-gain/30 rounded-xl text-sm text-gain">
          <Sparkles className="w-4 h-4 flex-shrink-0" />
          <span>{prefillResult.created} Einträge erstellt{prefillResult.skipped > 0 ? `, ${prefillResult.skipped} bereits vorhanden übersprungen` : ""}.</span>
          <button onClick={() => setPrefillResult(null)} className="ml-auto text-text-tertiary hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
          Laden…
        </div>
      )}

      {/* ── Calendar view ── */}
      {!isLoading && view === "calendar" && (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-3 h-full min-w-max pb-2">
            {MONTH_NAMES.map((name, idx) => {
              const m = idx + 1;
              const list = monthEntries[m];
              const { income, expense } = monthSummary(m);
              const net = income - expense;
              return (
                <div
                  key={m}
                  className={clsx(
                    "flex flex-col w-52 flex-shrink-0 bg-bg-surface rounded-xl border overflow-hidden transition-shadow",
                    dndOverMonth === m ? "border-accent ring-2 ring-accent/40" : "border-border/50"
                  )}
                  onDragOver={(e) => handleMonthColumnDragOver(e, m)}
                  onDrop={(e) => handleMonthColumnDrop(e, m)}
                >
                  {/* Month header */}
                  <div className="px-3 pt-3 pb-2 border-b border-border/30">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-text-primary text-sm font-semibold">{name}</p>
                      {list.length > 0 && (
                        <button
                          type="button"
                          title="Einträge in diesem Monat aus dem Plan entfernen"
                          disabled={clearMonthMut.isPending}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setClearMonthDialog(m);
                          }}
                          className="p-1 rounded-md text-text-tertiary hover:text-loss hover:bg-loss/10 transition-colors disabled:opacity-50 shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="mt-2 flex flex-col items-end gap-0.5 text-right tabular-nums">
                      {income === 0 && expense === 0 ? (
                        <span className="text-text-tertiary text-xs">—</span>
                      ) : (
                        <>
                          {income > 0 && (
                            <span className="text-gain text-[11px] font-medium leading-tight">
                              +{formatCHF(income, false)}
                            </span>
                          )}
                          {expense > 0 && (
                            <span className="text-loss text-[11px] font-medium leading-tight">
                              −{formatCHF(expense, false)}
                            </span>
                          )}
                          {(income > 0 || expense > 0) && (
                            <div className="w-full mt-1.5 pt-1.5 border-t border-border/25 text-right">
                              <p className="text-[10px] font-medium uppercase tracking-wide text-text-tertiary mb-0.5">
                                Saldo
                              </p>
                              <p
                                className={clsx(
                                  "text-base font-semibold leading-tight",
                                  net >= 0 ? "text-gain" : "text-loss"
                                )}
                              >
                                {net >= 0 ? "+" : "−"}
                                {formatCHF(Math.abs(net), false)}
                              </p>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Entry chips */}
                  <div className="flex-1 overflow-y-auto scrollbar-hide p-2 space-y-1.5">
                    {list.length === 0 && (
                      <p className="text-text-tertiary text-xs text-center py-2">Keine Einträge</p>
                    )}
                    {list.map((entry) => {
                      const cat = categories.find((c) => c.id === entry.category_id);
                      const sc = cat
                        ? resolveSuperCategoryForRow(cat)
                        : resolveSuperCategory(entry.description, true);
                      const providerId = matchPlanEntryProviderId(entry.description);
                      const ScIcon = sc.icon;
                      return (
                        <div
                          key={entry.id}
                          className={clsx(
                            "w-full flex items-stretch rounded-lg border text-xs transition-opacity",
                            entry.amount < 0
                              ? "bg-loss/5 border-loss/20"
                              : "bg-gain/5 border-gain/20",
                            dndDraggingId === entry.id && "opacity-50"
                          )}
                        >
                          <button
                            type="button"
                            draggable={!dndBusy}
                            onDragStart={(e) => handleRecurringDragStart(e, entry)}
                            onDragEnd={handleRecurringDragEnd}
                            className={clsx(
                              "flex items-center px-1 shrink-0 cursor-grab active:cursor-grabbing touch-none",
                              "text-text-tertiary hover:text-text-primary border-r border-border/30 bg-transparent",
                              dndBusy && "opacity-40 pointer-events-none cursor-not-allowed"
                            )}
                            title="In anderen Monat ziehen. Mit Wahltaste (⌥) beim Loslassen kopieren."
                            aria-label="Eintrag in anderen Monat ziehen; mit Wahltaste kopieren"
                          >
                            <GripVertical className="w-3.5 h-3.5" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(entry)}
                            title={entry.description}
                            className={clsx(
                              "flex flex-1 min-w-0 flex-col gap-1.5 text-left px-2 py-2 rounded-r-lg transition-colors",
                              entry.amount < 0 ? "hover:border-loss/40" : "hover:border-gain/40"
                            )}
                          >
                            <div className="flex w-full min-w-0 items-center justify-between gap-2">
                              <div className="shrink-0 flex items-center">
                                {providerId ? (
                                  <ProviderBrandIcon providerId={providerId} size={22} className="rounded-md" />
                                ) : (
                                  <div
                                    className="flex items-center justify-center rounded-md shrink-0 border border-border/40 bg-bg-surface2"
                                    style={{ width: 22, height: 22 }}
                                    aria-hidden
                                  >
                                    <ScIcon className="w-[13px] h-[13px] text-text-secondary" strokeWidth={2.4} />
                                  </div>
                                )}
                              </div>
                              <span
                                className={clsx(
                                  "font-semibold tabular-nums text-right min-w-0 shrink-0",
                                  entry.amount < 0 ? "text-loss" : "text-gain"
                                )}
                              >
                                {entry.amount < 0 ? "−" : "+"}
                                {formatCHF(Math.abs(entry.amount), false)}
                              </span>
                            </div>
                            <span
                              className="inline-flex self-start max-w-full rounded-full px-2 py-0.5 text-[10px] font-semibold truncate border"
                              style={{
                                backgroundColor: `${sc.color}28`,
                                color: sc.color,
                                borderColor: `${sc.color}55`,
                              }}
                            >
                              {sc.label}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Add button */}
                  <div className="px-2 pb-2">
                    <button
                      onClick={() => openAdd(m)}
                      className="w-full flex items-center justify-center gap-1 py-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-surface2 rounded-lg text-xs transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Hinzufügen
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Accordion view ── */}
      {!isLoading && view === "accordion" && (
        <div className="flex-1 overflow-y-auto space-y-2">
          {MONTH_NAMES.map((name, idx) => {
            const m = idx + 1;
            const list = monthEntries[m];
            const { income, expense, count } = monthSummary(m);
            const isOpen = openMonths.has(m);
            const net = income - expense;
            return (
              <div key={m} className="bg-bg-surface rounded-xl border border-border/50 overflow-hidden">
                {/* Row header */}
                <div className="flex items-center gap-1 px-2 sm:px-3 py-2 hover:bg-bg-surface2 transition-colors">
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-3 sm:gap-4 min-w-0 py-1 pl-2 text-left"
                    onClick={() =>
                      setOpenMonths((prev) => {
                        const next = new Set(prev);
                        isOpen ? next.delete(m) : next.add(m);
                        return next;
                      })
                    }
                  >
                    <span className="text-text-primary font-semibold text-sm w-20 sm:w-24 shrink-0">{name}</span>
                    <span className="text-text-tertiary text-xs shrink-0 hidden sm:inline">
                      {count} {count === 1 ? "Eintrag" : "Einträge"}
                    </span>
                    <div className="flex flex-wrap gap-2 sm:gap-3 ml-auto text-xs justify-end">
                      {income > 0 && <span className="text-gain font-medium">+{formatCHF(income, true)}</span>}
                      {expense > 0 && <span className="text-loss font-medium">−{formatCHF(expense, true)}</span>}
                      {count > 0 && (
                        <span className={clsx("font-semibold", net >= 0 ? "text-gain" : "text-loss")}>
                          = {net >= 0 ? "+" : "−"}{formatCHF(Math.abs(net), true)}
                        </span>
                      )}
                    </div>
                    <ChevronDown
                      className={clsx(
                        "w-4 h-4 text-text-tertiary transition-transform flex-shrink-0",
                        isOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {count > 0 && (
                    <button
                      type="button"
                      title="Einträge in diesem Monat aus dem Plan entfernen"
                      disabled={clearMonthMut.isPending}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setClearMonthDialog(m);
                      }}
                      className="p-2 rounded-md text-text-tertiary hover:text-loss hover:bg-loss/10 transition-colors disabled:opacity-50 shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* Expanded content */}
                {isOpen && (
                  <div className="border-t border-border/30 px-4 py-3">
                    {list.length === 0 ? (
                      <p className="text-text-tertiary text-sm py-2">Keine Einträge in diesem Monat.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-text-tertiary text-xs uppercase tracking-wide">
                            <th className="text-left pb-2 font-medium">Bezeichnung</th>
                            <th className="text-right pb-2 font-medium">Betrag</th>
                            <th className="text-left pb-2 font-medium pl-4">Periodizität</th>
                            <th className="text-left pb-2 font-medium pl-4 hidden sm:table-cell">Kategorie</th>
                            <th className="w-8" />
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((entry) => {
                            const cat = categories.find((c) => c.id === entry.category_id);
                            return (
                              <tr
                                key={entry.id}
                                className="border-t border-border/20 hover:bg-bg-surface2 cursor-pointer transition-colors"
                                onClick={() => openEdit(entry)}
                              >
                                <td className="py-2 text-text-primary font-medium">{entry.description}</td>
                                <td className={clsx(
                                  "py-2 text-right font-semibold tabular-nums",
                                  entry.amount < 0 ? "text-loss" : "text-gain"
                                )}>
                                  {entry.amount < 0 ? "−" : "+"}{formatCHF(Math.abs(entry.amount), true)}
                                </td>
                                <td className="py-2 pl-4 text-text-secondary text-xs">{periodicityLabel(entry.periodicity)}</td>
                                <td className="py-2 pl-4 text-text-secondary text-xs hidden sm:table-cell">
                                  {cat?.name ?? "—"}
                                </td>
                                <td className="py-2 text-right">
                                  <Pencil className="w-3.5 h-3.5 text-text-tertiary" />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    <button
                      onClick={() => openAdd(m)}
                      className="mt-3 flex items-center gap-1 text-text-tertiary hover:text-accent text-xs transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Eintrag hinzufügen
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Slide-in editor sidebar ── */}
      {sidebarOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={closeEditor}
          />
          <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-bg-surface border-l border-border flex flex-col z-50 shadow-2xl">
            {/* Sidebar header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <h2 className="text-text-primary font-semibold text-base">
                {editEntry ? "Eintrag bearbeiten" : "Neuer Eintrag"}
              </h2>
              <button onClick={closeEditor} className="text-text-tertiary hover:text-text-primary transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {!editEntry && (
                <div className="rounded-xl border border-border/50 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setEditorTemplateOpen((o) => !o)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-bg-surface2 hover:bg-bg-surface2/80 text-left transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <Library className="w-4 h-4 text-accent shrink-0" />
                      Aus Vorlage (historisch / empirisch)
                    </span>
                    <ChevronDown
                      className={clsx("w-4 h-4 text-text-tertiary shrink-0 transition-transform", editorTemplateOpen && "rotate-180")}
                    />
                  </button>
                  {editorTemplateOpen && (
                    <div className="px-3 py-3 space-y-3 border-t border-border/40 bg-bg-surface">
                      <div>
                        <label className="block text-xs text-text-tertiary mb-1.5">Datenquelle</label>
                        <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
                          {(["empirical", "historical"] as const).map((src) => (
                            <button
                              key={src}
                              type="button"
                              onClick={() => setEditorTplSource(src)}
                              className={clsx(
                                "flex-1 px-2 py-2 transition-colors",
                                editorTplSource === src
                                  ? "bg-accent text-white"
                                  : "bg-bg-surface2 text-text-secondary hover:text-text-primary"
                              )}
                            >
                              {src === "historical" ? "Historisch" : "Empirisch"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-text-tertiary mb-1">Quelljahr</label>
                        <div className="flex items-center gap-1 bg-bg-surface2 rounded-lg px-2 py-1 w-fit">
                          <button
                            type="button"
                            onClick={() => setEditorTplYear((y) => y - 1)}
                            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                          <span className="font-mono text-sm text-text-primary px-2 min-w-[4rem] text-center">
                            {editorTplYear}
                          </span>
                          <button
                            type="button"
                            onClick={() => setEditorTplYear((y) => y + 1)}
                            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                        <p className="text-[11px] text-text-tertiary mt-1.5">
                          Vorschlag übernehmen, Werte anpassen und als neuen Eintrag für{" "}
                          <span className="font-semibold text-text-primary">{year}</span> speichern.
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs text-text-tertiary mb-1.5">Vorschläge</label>
                        {editorSuggestLoading && (
                          <div className="space-y-1.5">
                            {[1, 2, 3].map((i) => (
                              <div key={i} className="h-9 bg-bg-surface2 rounded-lg animate-pulse" />
                            ))}
                          </div>
                        )}
                        {!editorSuggestLoading && editorSuggestions.length === 0 && (
                          <p className="text-xs text-text-tertiary py-2 px-2 rounded-lg border border-border/30">
                            {editorTplSource === "empirical"
                              ? "Keine Wizard-Daten gefunden."
                              : "Keine wiederkehrenden Transaktionen im Quelljahr."}
                          </p>
                        )}
                        <div className="max-h-44 overflow-y-auto space-y-1 pr-0.5">
                          {!editorSuggestLoading &&
                            editorSuggestions.map((s) => {
                              const key = `${s.description}::${s.periodicity}`;
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() => applySuggestionToForm(s)}
                                  className={clsx(
                                    "w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left text-xs transition-colors",
                                    s.amount < 0
                                      ? "bg-loss/5 border-loss/20 hover:border-loss/40"
                                      : "bg-gain/5 border-gain/20 hover:border-gain/40"
                                  )}
                                >
                                  <span className="flex-1 text-text-primary font-medium truncate">{s.description}</span>
                                  <span
                                    className={clsx(
                                      "font-semibold tabular-nums shrink-0",
                                      s.amount < 0 ? "text-loss" : "text-gain"
                                    )}
                                  >
                                    {s.amount < 0 ? "−" : "+"}
                                    {formatCHF(Math.abs(s.amount), true)}
                                  </span>
                                  <span className="text-text-tertiary shrink-0 text-[10px]">
                                    {periodicityLabel(s.periodicity)}
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Description */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Bezeichnung</label>
                <input
                  type="text"
                  className="w-full bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="z. B. Miete, Lohn, Netflix…"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </div>

              {/* Amount + sign */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Betrag (CHF)</label>
                <div className="flex gap-2">
                  <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => {
                          if (f.isExpense) return f;
                          let category_id = f.category_id;
                          if (category_id) {
                            const cat = categories.find((c) => c.id === parseInt(category_id, 10));
                            if (cat && categoryIsIncomeOriented(cat)) category_id = "";
                          }
                          return { ...f, isExpense: true, category_id };
                        })
                      }
                      className={clsx(
                        "px-3 py-2 transition-colors",
                        form.isExpense ? "bg-loss text-white" : "bg-bg-surface2 text-text-secondary hover:text-text-primary"
                      )}
                    >
                      − Ausgabe
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => {
                          if (!f.isExpense) return f;
                          let category_id = f.category_id;
                          if (category_id) {
                            const cat = categories.find((c) => c.id === parseInt(category_id, 10));
                            if (cat && categoryIsExpenseOriented(cat)) category_id = "";
                          }
                          return { ...f, isExpense: false, category_id };
                        })
                      }
                      className={clsx(
                        "px-3 py-2 transition-colors",
                        !form.isExpense ? "bg-gain text-white" : "bg-bg-surface2 text-text-secondary hover:text-text-primary"
                      )}
                    >
                      + Einnahme
                    </button>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="flex-1 bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
                    placeholder="0.00"
                    value={form.amountAbs}
                    onChange={(e) => setForm((f) => ({ ...f, amountAbs: e.target.value }))}
                  />
                </div>
              </div>

              {/* Periodicity */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Periodizität</label>
                <select
                  className="w-full bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.periodicity}
                  onChange={(e) => setForm((f) => ({ ...f, periodicity: e.target.value }))}
                >
                  {PERIODICITIES.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-tertiary mb-1">Startdatum</label>
                  <input
                    type="date"
                    className="w-full bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    value={form.start_date}
                    onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-tertiary mb-1">Enddatum (optional)</label>
                  <input
                    type="date"
                    className="w-full bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    value={form.end_date}
                    onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
                  />
                </div>
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Kategorie (optional)</label>
                <p className="text-[11px] text-text-tertiary mb-1.5">
                  {form.isExpense
                    ? "Alle Kategorien außer Super «Sparen» (Ausgaben), gruppiert nach Superkategorie — bei Bedarf nach unten scrollen."
                    : "Nur Kategorien der Superkategorie «Sparen» (Einnahmen / Finanzprodukte)."}
                </p>
                <BudgetplanCategoryPicker
                  value={form.category_id}
                  onChange={(category_id) => setForm((f) => ({ ...f, category_id }))}
                  groupedCategoryOptions={groupedCategoryOptions}
                  groupedCategoryIds={groupedCategoryIds}
                  categories={categories}
                  isExpense={form.isExpense}
                />
              </div>

              {/* Account */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Konto (optional)</label>
                <select
                  className="w-full bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  value={form.account_id}
                  onChange={(e) => setForm((f) => ({ ...f, account_id: e.target.value }))}
                >
                  <option value="">Kein Konto</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={String(a.id)}>{a.name}</option>
                  ))}
                </select>
              </div>

              {/* is_future toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-text-primary">Geplanter Eintrag</p>
                  <p className="text-xs text-text-tertiary">Deaktivieren für historische/empirische Einträge</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, is_future: !f.is_future }))}
                  className={clsx(
                    "relative w-10 h-5 rounded-full transition-colors flex-shrink-0",
                    form.is_future ? "bg-accent" : "bg-bg-surface2 border border-border"
                  )}
                >
                  <span
                    className={clsx(
                      "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                      form.is_future ? "left-5" : "left-0.5"
                    )}
                  />
                </button>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Notizen (optional)</label>
                <textarea
                  rows={2}
                  className="w-full bg-bg-surface2 border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                  placeholder="Beliebige Notizen…"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </div>

              {formError && (
                <p className="text-loss text-sm">{formError}</p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-4 border-t border-border/50">
              {editEntry && (
                <button
                  onClick={() => deleteMut.mutate(editEntry.id)}
                  disabled={deleteMut.isPending}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm text-loss hover:bg-loss/10 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                  Löschen
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={closeEditor}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-bg-surface2 rounded-lg transition-colors"
              >
                Abbrechen
              </button>
              <button
                onClick={handleSave}
                disabled={createMut.isPending || updateMut.isPending}
                className="px-4 py-2 text-sm font-medium bg-accent hover:bg-accent/90 text-white rounded-lg transition-colors disabled:opacity-60"
              >
                {createMut.isPending || updateMut.isPending ? "Speichern…" : "Speichern"}
              </button>
            </div>
          </div>
        </>
      )}
      {/* ── Prefill slide-in panel ── */}
      {prefillOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={() => setPrefillOpen(false)}
          />
          <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-bg-surface border-l border-border flex flex-col z-50 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <h2 className="text-text-primary font-semibold text-base flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-accent" />
                Budgetplan vorbefüllen
              </h2>
              <button onClick={() => setPrefillOpen(false)} className="text-text-tertiary hover:text-text-primary transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* Source toggle */}
              <div>
                <label className="block text-xs text-text-tertiary mb-2">Datenquelle</label>
                <div className="flex rounded-lg border border-border overflow-hidden text-xs font-medium">
                  {(["empirical", "historical"] as const).map((src) => (
                    <button
                      key={src}
                      onClick={() => setPrefillSource(src)}
                      className={clsx(
                        "flex-1 px-3 py-2 transition-colors",
                        prefillSource === src
                          ? "bg-accent text-white"
                          : "bg-bg-surface2 text-text-secondary hover:text-text-primary"
                      )}
                    >
                      {src === "historical" ? "Historische Transaktionen" : "Empirische Angaben"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Source year */}
              <div>
                <label className="block text-xs text-text-tertiary mb-1">Quelljahr</label>
                <div className="flex items-center gap-1 bg-bg-surface2 rounded-lg px-2 py-1 w-fit">
                  <button
                    onClick={() => setPrefillSourceYear((y) => y - 1)}
                    className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="font-mono text-sm text-text-primary px-2 min-w-[4rem] text-center">
                    {prefillSourceYear}
                  </span>
                  <button
                    onClick={() => setPrefillSourceYear((y) => y + 1)}
                    className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-text-tertiary mt-1.5">
                  Einträge werden in <span className="font-semibold text-text-primary">{year}</span> erstellt.
                </p>
              </div>

              {/* Preview list */}
              <div>
                <label className="block text-xs text-text-tertiary mb-2">
                  Vorschau — {suggestLoading ? "wird geladen…" : `${prefillSelected.size} von ${suggestions.length} ausgewählt`}
                </label>

                {suggestLoading && (
                  <div className="space-y-1.5">
                    {[1, 2, 3, 4].map((i) => (
                      <div key={i} className="h-10 bg-bg-surface2 rounded-lg animate-pulse" />
                    ))}
                  </div>
                )}

                {!suggestLoading && suggestions.length === 0 && (
                  <div className="px-4 py-6 text-center text-text-tertiary text-sm rounded-xl border border-border/30">
                    {prefillSource === "empirical"
                      ? "Keine Wizard-Daten gefunden. Bitte zuerst die Empirischen Angaben ausfüllen."
                      : "Keine wiederkehrenden Transaktionen im Quelljahr gefunden."}
                  </div>
                )}

                <div className="space-y-1">
                  {suggestions.map((s) => {
                    const key = `${s.description}::${s.periodicity}`;
                    const checked = prefillSelected.has(key);
                    return (
                      <button
                        key={key}
                        onClick={() =>
                          setPrefillSelected((prev) => {
                            const next = new Set(prev);
                            checked ? next.delete(key) : next.add(key);
                            return next;
                          })
                        }
                        className={clsx(
                          "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-colors",
                          checked
                            ? s.amount < 0
                              ? "bg-loss/5 border-loss/20 hover:border-loss/40"
                              : "bg-gain/5 border-gain/20 hover:border-gain/40"
                            : "bg-bg-surface2 border-border/30 opacity-50 hover:opacity-70"
                        )}
                      >
                        {checked
                          ? <CheckSquare className="w-3.5 h-3.5 flex-shrink-0 text-accent" />
                          : <Square className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />}
                        <span className="flex-1 text-text-primary font-medium truncate">{s.description}</span>
                        <span className={clsx("font-semibold tabular-nums flex-shrink-0", s.amount < 0 ? "text-loss" : "text-gain")}>
                          {s.amount < 0 ? "−" : "+"}{formatCHF(Math.abs(s.amount), true)}
                        </span>
                        <span className="text-text-tertiary flex-shrink-0">{periodicityLabel(s.periodicity)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {prefillMut.isError && (
                <p className="text-loss text-sm">Fehler beim Erstellen der Einträge.</p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-4 border-t border-border/50">
              <button
                onClick={() => setPrefillOpen(false)}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-bg-surface2 rounded-lg transition-colors"
              >
                Abbrechen
              </button>
              <div className="flex-1" />
              <button
                onClick={handlePrefillSubmit}
                disabled={prefillMut.isPending || prefillSelected.size === 0 || suggestLoading}
                className="px-4 py-2 text-sm font-medium bg-accent hover:bg-accent/90 text-white rounded-lg transition-colors disabled:opacity-60"
              >
                {prefillMut.isPending
                  ? "Übernehmen…"
                  : `${prefillSelected.size} Einträge übernehmen`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
