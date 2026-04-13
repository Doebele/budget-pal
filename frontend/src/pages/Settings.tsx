import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { api, authApi, settingsApi, taxonomyApi, backupApi } from "@/lib/api";
import { DEFAULT_SARON_REFERENCE_ANNUAL_PCT, SARON_INDEX_URL } from "@/lib/saron";
import { Save, ExternalLink, Wand2, RotateCcw, AlertCircle, ChevronDown, ChevronUp, Users, Plus, Pencil, Trash2, X, Check, Tag, Eye, Download, Upload, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { differenceInYears, parseISO } from "date-fns";
import { useTaxonomySuperCategories, type SuperCategory } from "@/lib/categories";

// ── Peer-Gruppe: Schlüssel je Superkategorie ───────────────────
// Summe der aufgeführten PeerGroupDefaults-Felder ergibt den monatlichen
// Peer-Ø-Betrag für diese Superkategorie.
const PEER_KEYS_BY_SC: Record<string, (keyof PeerConfig)[]> = {
  wohnen:          ["housing"],
  essen:           ["groceries", "dining_out"],
  mobilitaet:      ["transport", "travel"],
  versicherungen:  ["health_insurance", "other_insurance"],
  freizeit:        ["entertainment"],
  abos:            ["communication", "subscriptions"],
  shopping:        ["clothing"],
  bildung:         ["education"],
  steuern:         ["direct_taxes"],
  sparen:          ["pillar_3a_monthly"],
};

interface PeerConfig {
  housing: number;
  groceries: number;
  transport: number;
  health_insurance: number;
  other_insurance: number;
  communication: number;
  dining_out: number;
  entertainment: number;
  clothing: number;
  travel: number;
  education: number;
  subscriptions: number;
  direct_taxes: number;
  savings_rate: number;
  pillar_3a_monthly: number;
  peerLabel: string;
  sampleSize: string;
  incomeMedian: number;
  confidenceNote: string;
}

function peerTotal(config: PeerConfig, scId: string): number | null {
  const keys = PEER_KEYS_BY_SC[scId];
  if (!keys) return null;
  return keys.reduce((sum, k) => sum + (config[k] as number), 0);
}

function fmtCHF(v: number): string {
  return `CHF ${v.toLocaleString("de-CH", { maximumFractionDigits: 0 })}`;
}

function calcAge(birthdate: string): number | null {
  if (!birthdate) return null;
  try { return differenceInYears(new Date(), parseISO(birthdate)); } catch { return null; }
}

interface CategoryMapping {
  wizard_label: string;
  /** Superkategorie-ID (z. B. wohnen, essen) */
  transaction_category: string;
}

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const SUPER_CATEGORIES = useTaxonomySuperCategories();
  const [name, setName] = useState(user?.name || "");
  const [birthdate, setBirthdate] = useState(user?.birthdate || "");
  const [retirementAge, setRetirementAge] = useState(user?.retirement_age || 65);
  const [referenceCurrency, setReferenceCurrency] = useState<"CHF" | "EUR" | "USD">(
    (user?.currency as "CHF" | "EUR" | "USD") || "CHF"
  );
  const [saronReferenceAnnualPct, setSaronReferenceAnnualPct] = useState<number>(
    user?.saron_reference_annual_pct ?? DEFAULT_SARON_REFERENCE_ANNUAL_PCT
  );
  const [saved, setSaved] = useState(false);
  const [expandedSc, setExpandedSc] = useState<string | null>(null);
  const [budgetDefaultView, setBudgetDefaultView] = useState<"bar" | "gauge">(() => {
    try {
      return (localStorage.getItem("budgetpal_budget_default_view") as "bar" | "gauge") || "gauge";
    } catch { return "gauge"; }
  });

  function handleBudgetDefaultView(v: "bar" | "gauge") {
    setBudgetDefaultView(v);
    try { localStorage.setItem("budgetpal_budget_default_view", v); } catch {}
  }

  // ── Backup / Restore ─────────────────────────────────────────
  const [backupExporting, setBackupExporting] = useState(false);
  const [backupExportError, setBackupExportError] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importOptions, setImportOptions] = useState({
    overwrite_profile: false,
    import_transactions: true,
    import_recurring_plan: true,
    import_wizard_config: true,
    import_pension_assets: true,
  });
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importPending, setImportPending] = useState(false);

  async function handleExport() {
    setBackupExporting(true);
    setBackupExportError(null);
    try {
      const resp = await backupApi.export();
      const blob = new Blob([resp.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `budgetpal_backup_${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setBackupExportError("Export fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setBackupExporting(false);
    }
  }

  async function handleImport() {
    if (!importFile) return;
    setImportPending(true);
    setImportError(null);
    setImportResult(null);
    try {
      const text = await importFile.text();
      const parsed = JSON.parse(text);
      const resp = await backupApi.import({ backup: parsed, ...importOptions });
      setImportResult(resp.data as Record<string, unknown>);
      queryClient.invalidateQueries();
    } catch (e) {
      const msg = e instanceof SyntaxError
        ? "Ungültige JSON-Datei."
        : "Import fehlgeschlagen. Bitte Backup-Datei überprüfen.";
      setImportError(msg);
    } finally {
      setImportPending(false);
    }
  }

  // Peer config (stored from last wizard run)
  const { data: peerConfig } = useQuery<PeerConfig | null>({
    queryKey: ["wizard-peer-config"],
    queryFn: () => api.get("/wizard/peer-config").then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  // Category mapping state
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, string>>({});
  const [mappingSaved, setMappingSaved] = useState(false);
  const [mappingDirty, setMappingDirty] = useState(false);

  const age = calcAge(birthdate);
  const retirementYear = age !== null ? new Date().getFullYear() + (retirementAge - age) : null;

  useEffect(() => {
    if (user?.currency && ["CHF", "EUR", "USD"].includes(user.currency)) {
      setReferenceCurrency(user.currency as "CHF" | "EUR" | "USD");
    }
  }, [user?.currency]);

  useEffect(() => {
    if (user?.saron_reference_annual_pct != null && !Number.isNaN(user.saron_reference_annual_pct)) {
      setSaronReferenceAnnualPct(user.saron_reference_annual_pct);
    }
  }, [user?.saron_reference_annual_pct]);

  const mutation = useMutation({
    mutationFn: () =>
      authApi.updateMe({
        name,
        birthdate: birthdate || null,
        retirement_age: retirementAge,
        currency: referenceCurrency,
        saron_reference_annual_pct: saronReferenceAnnualPct,
      }),
    onSuccess: async () => {
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["multi-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["recurring-plan"] });
      queryClient.invalidateQueries({ queryKey: ["transaction-stats-budget"] });
      queryClient.invalidateQueries({ queryKey: ["budget-analysis"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  // Category mappings query
  const { data: mappingsData, isLoading: mappingsLoading } = useQuery({
    queryKey: ["category-mappings"],
    queryFn: () => settingsApi.getCategoryMappings().then((r) => r.data),
    staleTime: 60_000,
  });

  // Initialise drafts when data loads
  useEffect(() => {
    if (!mappingsData?.mappings) return;
    const init: Record<string, string> = {};
    for (const m of mappingsData.mappings as CategoryMapping[]) {
      init[m.wizard_label] = m.transaction_category;
    }
    setMappingDrafts(init);
    setMappingDirty(false);
  }, [mappingsData]);

  const saveMappingsMutation = useMutation({
    mutationFn: () =>
      settingsApi.putCategoryMappings(
        Object.entries(mappingDrafts).map(([wizard_label, transaction_category]) => ({
          wizard_label,
          transaction_category,
        }))
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["category-mappings"] });
      queryClient.invalidateQueries({ queryKey: ["multi-analysis"] });
      setMappingDirty(false);
      setMappingSaved(true);
      setTimeout(() => setMappingSaved(false), 3000);
    },
  });

  const resetMappingsMutation = useMutation({
    mutationFn: () => settingsApi.resetCategoryMappings(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["category-mappings"] });
    },
  });

  // ── Category management ───────────────────────────────────────

  interface CatEntry {
    id: number;
    name: string;
    slug: string;
    icon: string | null;   // holds supercategory ID
    color: string | null;
    is_system: boolean;
    txn_count: number;
  }

  const { data: userCats, isLoading: catsLoading } = useQuery<CatEntry[]>({
    queryKey: ["user-categories"],
    queryFn: () => api.get("/categories").then((r) => r.data),
    staleTime: 60_000,
  });

  // Only show user-created categories (not system)
  const ownCats = (userCats ?? []).filter((c) => !c.is_system);

  const [catAddForm, setCatAddForm] = useState<{
    name: string; super_id: string; color: string;
  } | null>(null);
  const [catEditId, setCatEditId] = useState<number | null>(null);
  const [catEditName, setCatEditName] = useState("");
  const [catDeleteId, setCatDeleteId] = useState<number | null>(null);
  const [catReassignTo, setCatReassignTo] = useState<number | "">("");

  function slugify(s: string) {
    return s.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-zäöü0-9-]/gi, "");
  }

  const createCatMutation = useMutation({
    mutationFn: (form: { name: string; super_id: string; color: string }) =>
      api.post("/categories", {
        name: form.name.trim(),
        slug: slugify(form.name),
        icon: form.super_id || null,
        color: form.color || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-categories"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["taxonomy"] });
      setCatAddForm(null);
    },
  });

  const updateCatMutation = useMutation({
    mutationFn: ({ id, name, icon, color }: { id: number; name: string; icon: string | null; color: string | null }) =>
      api.put(`/categories/${id}`, {
        name: name.trim(),
        slug: slugify(name),
        icon,
        color,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-categories"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["taxonomy"] });
      setCatEditId(null);
    },
  });

  const deleteCatMutation = useMutation({
    mutationFn: ({ id, reassignTo }: { id: number; reassignTo: number | "" }) => {
      const params = reassignTo ? `?reassign_to_id=${reassignTo}` : "";
      return api.delete(`/categories/${id}${params}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-categories"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["taxonomy"] });
      setCatDeleteId(null);
      setCatReassignTo("");
    },
  });

  // Group own categories by supercategory
  const catsBySupercat = SUPER_CATEGORIES.map((sc) => ({
    sc,
    cats: ownCats.filter((c) => (c.icon ?? "sonstiges") === sc.id),
  })).filter(({ cats }) => cats.length > 0);

  // ── Taxonomy label management ──────────────────────────────────

  interface LabelStat { label: string; txn_count: number; }

  const { data: labelStats } = useQuery<LabelStat[]>({
    queryKey: ["label-stats"],
    queryFn: () => api.get("/categories/label-stats").then((r) => r.data),
    staleTime: 60_000,
  });

  function txnCountFor(label: string): number {
    return labelStats?.find((s) => s.label.toLowerCase() === label.toLowerCase())?.txn_count ?? 0;
  }

  // Per-supercategory inline add state: { scId, type: 'txn'|'wizard', value }
  const [taxoAdd, setTaxoAdd] = useState<{scId: string; type: "txn" | "wizard"; value: string} | null>(null);

  // Delete / migrate state for a static label
  const [taxoDelete, setTaxoDelete] = useState<{
    scId: string; label: string; type: "txn" | "wizard"; txnCount: number;
  } | null>(null);
  const [taxoDeleteTarget, setTaxoDeleteTarget] = useState("");

  const migrateLabelMutation = useMutation({
    mutationFn: ({ old_label, new_label }: { old_label: string; new_label: string }) =>
      api.post("/categories/migrate-label", { old_label, new_label }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["label-stats"] });
      queryClient.invalidateQueries({ queryKey: ["user-categories"] });
      queryClient.invalidateQueries({ queryKey: ["categories"] });
      queryClient.invalidateQueries({ queryKey: ["taxonomy"] });
      setTaxoDelete(null);
      setTaxoDeleteTarget("");
    },
  });

  // Hidden canonical labels
  const { data: hiddenLabelsData, refetch: refetchHidden } = useQuery({
    queryKey: ["taxonomy-hidden-labels"],
    queryFn: () => taxonomyApi.getHiddenLabels().then((r) => r.data.hidden as Record<string, string[]>),
    staleTime: 60_000,
  });

  const hideLabelMutation = useMutation({
    mutationFn: ({ sc_id, label, label_type }: { sc_id: string; label: string; label_type: "txn" | "wl" }) =>
      taxonomyApi.hideCanonicalLabel(sc_id, label, label_type),
    onSuccess: () => {
      refetchHidden();
      queryClient.invalidateQueries({ queryKey: ["taxonomy"] });
    },
  });

  const unhideLabelMutation = useMutation({
    mutationFn: ({ sc_id, label, label_type }: { sc_id: string; label: string; label_type: "txn" | "wl" }) =>
      taxonomyApi.unhideCanonicalLabel(sc_id, label, label_type),
    onSuccess: () => {
      refetchHidden();
      queryClient.invalidateQueries({ queryKey: ["taxonomy"] });
    },
  });

  function isLabelHidden(scId: string, label: string, type: "txn" | "wl"): boolean {
    if (!hiddenLabelsData) return false;
    const key = `${scId}:${type}`;
    return (hiddenLabelsData[key] ?? []).some((h) => h.toLowerCase() === label.toLowerCase());
  }

  // When deleting a canonical label: migrate transactions AND hide the label from taxonomy
  function handleConfirmTaxoDelete() {
    if (!taxoDelete) return;
    const { scId, label, type } = taxoDelete;
    const labelType = type === "txn" ? "txn" : "wl";
    if (taxoDeleteTarget) {
      migrateLabelMutation.mutate(
        { old_label: label, new_label: taxoDeleteTarget },
        {
          onSuccess: () => {
            hideLabelMutation.mutate({ sc_id: scId, label, label_type: labelType });
          },
        }
      );
    } else {
      hideLabelMutation.mutate({ sc_id: scId, label, label_type: labelType });
      setTaxoDelete(null);
    }
  }

  function openTaxoDelete(scId: string, label: string, type: "txn" | "wizard") {
    const count = txnCountFor(label);
    setTaxoDelete({ scId, label, type, txnCount: count });
    setTaxoDeleteTarget("");
  }

  function renderTaxonomyAddForm(sc: SuperCategory, type: "txn" | "wizard") {
    if (!taxoAdd || taxoAdd.scId !== sc.id || taxoAdd.type !== type) return null;
    const superId = type === "txn" ? sc.id : `wl:${sc.id}`;
    const placeholder = type === "txn" ? "z.B. Kontoübertrag" : "z.B. Säule 3A";
    return (
      <div className="flex items-center gap-1 mt-1.5 w-full min-w-0 max-w-[320px]">
        <input
          autoFocus
          type="text"
          className="input-field text-[11px] flex-1 py-0.5 min-w-0"
          placeholder={placeholder}
          value={taxoAdd.value}
          onChange={(e) => setTaxoAdd((a) => (a ? { ...a, value: e.target.value } : null))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && taxoAdd.value.trim()) {
              createCatMutation.mutate({ name: taxoAdd.value.trim(), super_id: superId, color: sc.color });
              setTaxoAdd(null);
            }
            if (e.key === "Escape") setTaxoAdd(null);
          }}
        />
        <button
          type="button"
          disabled={!taxoAdd.value.trim() || createCatMutation.isPending}
          onClick={() => {
            if (taxoAdd.value.trim()) {
              createCatMutation.mutate({ name: taxoAdd.value.trim(), super_id: superId, color: sc.color });
              setTaxoAdd(null);
            }
          }}
          className="p-1 rounded text-gain hover:bg-gain/10 disabled:opacity-40 shrink-0"
        >
          <Check className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => setTaxoAdd(null)}
          className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface2 shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  // All canonical txnCategory labels across all supercategories (for reassignment dropdown)
  const allTxnLabels = SUPER_CATEGORIES.flatMap((sc) => sc.txnCategories);

  return (
    <div className="space-y-6 animate-fade-in max-w-4xl">
      <div>
        <h1 className="text-2xl font-display text-text-primary">Einstellungen</h1>
        <p className="text-text-tertiary text-sm mt-0.5">Profil und Konfiguration</p>
      </div>

      {/* Profile */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Profil</h2>
        <div className="space-y-4">
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">E-Mail</label>
            <input className="input" value={user?.email || ""} disabled readOnly />
          </div>

          <div>
            <label className="label">
              Referenzwährung
              <span className="text-text-tertiary font-normal ml-1 text-xs">
                (Aggregationen in Budgetanalyse, Reale Angaben, Budgetplan, Prognose)
              </span>
            </label>
            <select
              className="input w-full max-w-xs"
              value={referenceCurrency}
              onChange={(e) => setReferenceCurrency(e.target.value as "CHF" | "EUR" | "USD")}
            >
              <option value="CHF">Schweizer Franken (CHF)</option>
              <option value="EUR">Euro (EUR)</option>
              <option value="USD">US-Dollar (USD)</option>
            </select>
          </div>

          <div>
            <label className="label">
              SARON-Referenzzins (jährlich, % p.a.)
              <span className="text-text-tertiary font-normal ml-1 text-xs">
                (für Hypothekenangaben im Wizard)
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-3 max-w-md">
              <input
                type="number"
                min={0}
                max={25}
                step={0.01}
                className="input w-28 font-mono"
                value={saronReferenceAnnualPct}
                onChange={(e) => setSaronReferenceAnnualPct(parseFloat(e.target.value) || 0)}
              />
              <span className="text-text-tertiary text-xs">% p.a.</span>
            </div>
            <p className="text-text-tertiary text-xs mt-2 leading-relaxed">
              Referenzwert zur Darstellung von SARON-Hypotheken (kein Live-Tageszins). Quelle und Details:{" "}
              <a
                href={SARON_INDEX_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-1"
              >
                SIX SARON
                <ExternalLink className="w-3 h-3 shrink-0" />
              </a>
            </p>
          </div>

          {/* Birthdate — key for peer group & pension */}
          <div>
            <label className="label">
              Geburtsdatum
              <span className="text-text-tertiary font-normal ml-1 text-xs">(für Peer-Gruppe &amp; Pensionsberechnung)</span>
            </label>
            <div className="flex items-center gap-3">
              <input
                type="date"
                className="input w-44"
                value={birthdate}
                onChange={(e) => setBirthdate(e.target.value)}
                max={new Date().toISOString().split("T")[0]}
              />
              {age !== null && (
                <span className="text-text-secondary text-sm">
                  → <span className="text-text-primary font-medium">{age} Jahre</span>
                  {retirementYear && (
                    <span className="text-text-tertiary ml-2">· Rente ca. {retirementYear}</span>
                  )}
                </span>
              )}
            </div>
          </div>

          <div>
            <label className="label">
              Rentenalter
              <span className="text-text-tertiary font-normal ml-1 text-xs">(Ziel)</span>
            </label>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={58} max={70} step={1}
                value={retirementAge}
                onChange={(e) => setRetirementAge(+e.target.value)}
                className="w-40 accent-accent"
              />
              <span className="text-text-primary font-mono font-medium">{retirementAge}</span>
            </div>
          </div>

          <button
            onClick={() => mutation.mutate()}
            className="btn-primary flex items-center gap-2"
            disabled={mutation.isPending}
          >
            <Save className="w-4 h-4" />
            {saved ? "✓ Gespeichert!" : mutation.isPending ? "Speichern..." : "Speichern"}
          </button>
        </div>
      </div>

      {/* Empirische Angaben — Link zur Erfassung */}
      <div className="card border border-accent/20 bg-accent/5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Wand2 className="w-4 h-4 text-accent" />
          </div>
          <div className="flex-1">
            <h2 className="text-text-primary font-semibold text-sm">Empirische Angaben erneut erfassen</h2>
            <p className="text-text-tertiary text-xs mt-0.5 mb-3">
              Aktualisiere deine Basisdaten, Peer-Gruppe, Vorsorge (AHV/BVG/3a) und Finanzplan-Ziele.
            </p>
            <Link to="/wizard" className="btn-primary inline-flex items-center gap-2 text-sm py-2">
              <Wand2 className="w-3.5 h-3.5" />
              Zu empirischen Angaben
            </Link>
          </div>
        </div>
      </div>

      {/* Supercategory taxonomy */}
      <div className="card">
        <div className="mb-4">
          <h2 className="text-text-primary font-semibold text-sm">Superkategorie-Taxonomie</h2>
          <p className="text-text-tertiary text-xs mt-0.5">
            Übersicht, welche Transaktionskategorien (Reale Angaben) und Wizard-Labels (Empirische Angaben) jeder Superkategorie zugeordnet sind — inkl. gespeichertem Peer-Ø.
          </p>
          {peerConfig?.peerLabel && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-text-tertiary">
              <Users className="w-3 h-3 text-accent shrink-0" />
              <span>Peer-Gruppe: <span className="text-text-secondary font-medium">{peerConfig.peerLabel}</span></span>
              <span className="text-text-disabled">·</span>
              <span>{peerConfig.sampleSize}</span>
            </div>
          )}
        </div>

        {/* Übersicht: Superkategorie ↔ empirische vs. reale Kategorien (farbkodiert) */}
        <div className="rounded-xl border border-border/50 overflow-hidden mb-4">
          <p className="text-[11px] text-text-tertiary px-3 py-2 bg-bg-surface2/40 border-b border-border/30">
            Zuordnung aus der Taxonomie: <span className="text-text-secondary">empirische Angaben</span> (Wizard-Deckel) und{" "}
            <span className="text-text-secondary">reale Angaben</span> (Transaktionskategorien) — Farbe = Superkategorie.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="text-text-tertiary text-[11px] uppercase tracking-wide border-b border-border/30">
                  <th className="text-left py-2.5 px-3 w-[22%]">Superkategorie</th>
                  <th className="text-left py-2.5 px-3 w-[39%]">Empirische Angaben</th>
                  <th className="text-left py-2.5 px-3 w-[39%]">Reale Angaben (Ist)</th>
                </tr>
              </thead>
              <tbody>
                {SUPER_CATEGORIES.map((sc) => (
                  <tr key={sc.id} className="border-b border-border/20 last:border-0 align-top">
                    <td className="py-2.5 px-3">
                      <div className="flex items-start gap-2">
                        <span
                          className="w-1 rounded-full shrink-0 mt-0.5 self-stretch min-h-[2rem]"
                          style={{ backgroundColor: sc.color }}
                          aria-hidden
                        />
                        <span
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: sc.color + "22" }}
                        >
                          <sc.icon className="w-4 h-4" style={{ color: sc.color }} />
                        </span>
                        <span className="text-text-primary font-medium leading-snug pt-0.5">{sc.label}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap gap-1 items-center">
                          {(() => {
                            const ownWlNames = new Set(ownCats.filter((c) => c.icon === `wl:${sc.id}`).map((c) => c.name.toLowerCase()));
                            const canonicalWl = sc.wizardLabels.filter((l) => !isLabelHidden(sc.id, l, "wl") && !ownWlNames.has(l.toLowerCase()));
                            const ownWl = ownCats.filter((c) => c.icon === `wl:${sc.id}`);
                            const empty = canonicalWl.length === 0 && ownWl.length === 0;
                            return (
                              <>
                                {empty && <span className="text-text-disabled italic">—</span>}
                                {canonicalWl.map((l) => (
                                  <span
                                    key={l}
                                    className="px-1.5 py-0.5 rounded text-[11px] text-text-secondary"
                                    style={{ backgroundColor: sc.color + "24", border: `1px solid ${sc.color}44` }}
                                  >
                                    {l}
                                  </span>
                                ))}
                                {ownWl.map((c) => (
                                  <span
                                    key={c.id}
                                    className="px-1.5 py-0.5 rounded text-[11px] text-text-secondary border"
                                    style={{ backgroundColor: sc.color + "18", borderColor: sc.color + "55" }}
                                  >
                                    {c.name}
                                    <span className="text-text-disabled ml-1">(eigen)</span>
                                  </span>
                                ))}
                                <button
                                  type="button"
                                  title="Neues Wizard-Label hinzufügen"
                                  onClick={() => setTaxoAdd({ scId: sc.id, type: "wizard", value: "" })}
                                  className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-accent/10 transition-colors shrink-0"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </>
                            );
                          })()}
                        </div>
                        {renderTaxonomyAddForm(sc, "wizard")}
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap gap-1 items-center">
                          {(() => {
                            const ownTxnNames = new Set(ownCats.filter((c) => c.icon === sc.id).map((c) => c.name.toLowerCase()));
                            const canonicalTxn = sc.txnCategories.filter((c) => !isLabelHidden(sc.id, c, "txn") && !ownTxnNames.has(c.toLowerCase()));
                            const ownTxn = ownCats.filter((c) => c.icon === sc.id);
                            const empty = canonicalTxn.length === 0 && ownTxn.length === 0;
                            return (
                              <>
                                {empty && <span className="text-text-disabled italic">—</span>}
                                {canonicalTxn.map((c) => (
                                  <span
                                    key={c}
                                    className="px-1.5 py-0.5 rounded text-[11px] text-text-secondary"
                                    style={{ backgroundColor: sc.color + "18" }}
                                  >
                                    {c}
                                  </span>
                                ))}
                                {ownTxn.map((cat) => (
                                  <span
                                    key={cat.id}
                                    className="px-1.5 py-0.5 rounded text-[11px] text-text-secondary border"
                                    style={{ backgroundColor: sc.color + "14", borderColor: sc.color + "44" }}
                                  >
                                    {cat.name}
                                    <span className="text-text-disabled ml-1">(eigen)</span>
                                  </span>
                                ))}
                                <button
                                  type="button"
                                  title="Neue Transaktionskategorie hinzufügen"
                                  onClick={() => setTaxoAdd({ scId: sc.id, type: "txn", value: "" })}
                                  className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-accent/10 transition-colors shrink-0"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </>
                            );
                          })()}
                        </div>
                        {renderTaxonomyAddForm(sc, "txn")}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-xs text-text-tertiary font-medium mt-6 mb-2">
          Details: Peer-Ø, Ergänzungen und Bearbeitung (pro Superkategorie ausklappen)
        </p>
        <div className="space-y-1">
          {SUPER_CATEGORIES.filter((sc) => sc.id !== "sonstiges").map((sc) => {
            const isOpen = expandedSc === sc.id;
            const peer = peerConfig ? peerTotal(peerConfig, sc.id) : null;
            return (
              <div key={sc.id} className="rounded-lg border border-border/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedSc(isOpen ? null : sc.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-bg-surface2 transition-colors"
                >
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <span
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                      style={{ backgroundColor: sc.color + "22" }}
                    >
                      <sc.icon className="w-4 h-4" style={{ color: sc.color }} />
                    </span>
                    <span className="text-text-primary text-sm font-medium">{sc.label}</span>
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: sc.color }}
                    />
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {peer != null && peer > 0 && (
                      <span
                        className="flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: sc.color + "18", color: sc.color }}
                      >
                        <Users className="w-2.5 h-2.5" />
                        Ø {fmtCHF(peer)}/Mo
                      </span>
                    )}
                    {isOpen
                      ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary" />
                      : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />}
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 pt-2 border-t border-border/30 space-y-3 text-xs">
                    {/* Peer-Gruppe Detail */}
                    {peerConfig && peer != null && (
                      <div>
                        <p className="text-text-tertiary font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          Peer-Gruppe (BFS HABE 2021)
                        </p>
                        <div className="rounded-lg border border-border/30 overflow-hidden">
                          {(PEER_KEYS_BY_SC[sc.id] ?? []).map((key) => {
                            const val = peerConfig[key] as number;
                            if (!val || val <= 0) return null;
                            const LABEL: Record<string, string> = {
                              housing: "Wohnen (Miete/Hypothek)",
                              groceries: "Lebensmittel",
                              dining_out: "Restaurant & Takeaway",
                              transport: "Transport (ÖV + Auto)",
                              travel: "Reisen / Urlaub",
                              health_insurance: "Krankenkasse",
                              other_insurance: "Andere Versicherungen",
                              communication: "Kommunikation (Handy/Internet)",
                              subscriptions: "Abonnements (Streaming etc.)",
                              entertainment: "Freizeit & Unterhaltung",
                              clothing: "Kleidung & Schuhe",
                              education: "Weiterbildung",
                              direct_taxes: "Direkte Steuern (Kt./Gmd./Bund)",
                              pillar_3a_monthly: "Säule 3a (monatl.)",
                            };
                            return (
                              <div
                                key={key}
                                className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 last:border-0"
                                style={{ backgroundColor: sc.color + "08" }}
                              >
                                <span className="text-text-secondary">{LABEL[key] ?? key}</span>
                                <span className="font-mono text-text-primary font-medium">{fmtCHF(val)}</span>
                              </div>
                            );
                          })}
                          {(PEER_KEYS_BY_SC[sc.id] ?? []).length > 1 && (
                            <div
                              className="flex items-center justify-between px-3 py-1.5 font-semibold"
                              style={{ backgroundColor: sc.color + "15" }}
                            >
                              <span style={{ color: sc.color }}>Gesamt Peer-Ø</span>
                              <span className="font-mono" style={{ color: sc.color }}>{fmtCHF(peer)}/Mo</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {peerConfig && peer == null && (
                      <div>
                        <p className="text-text-tertiary font-semibold uppercase tracking-wide mb-1.5 flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          Peer-Gruppe (BFS HABE 2021)
                        </p>
                        <span className="text-text-disabled italic">Kein Peer-Ø für diese Kategorie verfügbar</span>
                      </div>
                    )}

                    {/* Mapping columns — interactive */}
                    <div className="grid grid-cols-2 gap-4">
                      {/* ── Transaktionskategorien ── */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-text-tertiary font-semibold uppercase tracking-wide text-[11px]">
                            Transaktionskategorien (Reale Angaben)
                          </p>
                          <button
                            type="button"
                            title="Neue Kategorie hinzufügen"
                            onClick={() => setTaxoAdd({ scId: sc.id, type: "txn", value: "" })}
                            className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-accent/10 transition-colors"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {/* Static canonical labels (exclude user-added to avoid duplicates) */}
                          {sc.txnCategories.filter((c) => !isLabelHidden(sc.id, c, "txn") && !ownCats.some((oc) => oc.icon === sc.id && oc.name.toLowerCase() === c.toLowerCase())).map((c) => (
                            taxoDelete?.label === c && taxoDelete.scId === sc.id && taxoDelete.type === "txn" ? (
                              /* Delete confirmation inline */
                              <div key={c} className="w-full mt-1 p-2 rounded-lg border border-loss/30 bg-loss/5 space-y-1.5 text-[11px]">
                                <p className="text-text-secondary">
                                  <span className="font-semibold text-loss">«{c}»</span> entfernen?
                                  {taxoDelete.txnCount > 0 && (
                                    <span className="text-text-tertiary ml-1">
                                      {taxoDelete.txnCount} Transaktion{taxoDelete.txnCount !== 1 ? "en" : ""} betroffen.
                                    </span>
                                  )}
                                </p>
                                {taxoDelete.txnCount > 0 && (
                                  <select
                                    className="input-field text-[11px] w-full"
                                    value={taxoDeleteTarget}
                                    onChange={(e) => setTaxoDeleteTarget(e.target.value)}
                                  >
                                    <option value="">— Neu zuweisen zu —</option>
                                    {allTxnLabels
                                      .filter((l) => l !== c)
                                      .map((l) => <option key={l} value={l}>{l}</option>)}
                                    {ownCats.filter((oc) => oc.name !== c).map((oc) => (
                                      <option key={oc.id} value={oc.name}>{oc.name}</option>
                                    ))}
                                  </select>
                                )}
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    disabled={(taxoDelete.txnCount > 0 && !taxoDeleteTarget) || migrateLabelMutation.isPending || hideLabelMutation.isPending}
                                    onClick={handleConfirmTaxoDelete}
                                    className="px-2 py-0.5 rounded bg-loss/20 text-loss border border-loss/30 hover:bg-loss/30 disabled:opacity-40 transition-colors"
                                  >
                                    {taxoDelete.txnCount > 0 ? "Migrieren & Ausblenden" : "Ausblenden"}
                                  </button>
                                  <button type="button" onClick={() => setTaxoDelete(null)} className="text-text-tertiary hover:text-text-primary">Abbrechen</button>
                                </div>
                              </div>
                            ) : (
                              <span
                                key={c}
                                className="group flex items-center gap-0.5 px-1.5 py-0.5 rounded text-text-secondary"
                                style={{ backgroundColor: sc.color + "18" }}
                              >
                                {c}
                                <button
                                  type="button"
                                  title="Entfernen / Migrieren"
                                  onClick={() => openTaxoDelete(sc.id, c, "txn")}
                                  className="opacity-0 group-hover:opacity-100 ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-loss/20 text-text-tertiary hover:text-loss transition-all"
                                >
                                  <X className="w-2.5 h-2.5" />
                                </button>
                              </span>
                            )
                          ))}
                          {/* User-added DB categories for this supercategory */}
                          {ownCats.filter((cat) => cat.icon === sc.id).map((cat) => (
                            <span
                              key={cat.id}
                              className="group flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-text-secondary"
                              style={{ backgroundColor: sc.color + "18", borderColor: sc.color + "44" }}
                              title="Eigene Kategorie"
                            >
                              {cat.name}
                              <button
                                type="button"
                                onClick={() => { setCatDeleteId(cat.id); setCatReassignTo(""); }}
                                className="opacity-0 group-hover:opacity-100 ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-loss/20 text-text-tertiary hover:text-loss transition-all"
                              >
                                <X className="w-2.5 h-2.5" />
                              </button>
                            </span>
                          ))}
                          {sc.txnCategories.filter((c) => !ownCats.some((oc) => oc.icon === sc.id && oc.name.toLowerCase() === c.toLowerCase())).length === 0 && ownCats.filter((cat) => cat.icon === sc.id).length === 0 && (
                            <span className="text-text-disabled italic text-[11px]">Keine — fällt in Sonstiges</span>
                          )}
                        </div>
                        {renderTaxonomyAddForm(sc, "txn")}
                      </div>

                      {/* ── Empirische Labels (Wizard) ── */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-text-tertiary font-semibold uppercase tracking-wide text-[11px]">
                            Empirische Labels (Wizard)
                          </p>
                          <button
                            type="button"
                            title="Neues Label hinzufügen"
                            onClick={() => setTaxoAdd({ scId: sc.id, type: "wizard", value: "" })}
                            className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-accent/10 transition-colors"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sc.wizardLabels.filter((l) => !isLabelHidden(sc.id, l, "wl") && !ownCats.some((oc) => oc.icon === "wl:" + sc.id && oc.name.toLowerCase() === l.toLowerCase())).length === 0 && ownCats.filter((cat) => cat.icon === "wl:" + sc.id).length === 0 ? (
                            <span className="text-text-disabled italic text-[11px]">Keine</span>
                          ) : (
                            <>
                              {sc.wizardLabels.filter((l) => !isLabelHidden(sc.id, l, "wl") && !ownCats.some((oc) => oc.icon === "wl:" + sc.id && oc.name.toLowerCase() === l.toLowerCase())).map((l) => (
                                taxoDelete?.label === l && taxoDelete.scId === sc.id && taxoDelete.type === "wizard" ? (
                                  <div key={l} className="w-full mt-1 p-2 rounded-lg border border-loss/30 bg-loss/5 space-y-1.5 text-[11px]">
                                    <p className="text-text-secondary">
                                      <span className="font-semibold text-loss">«{l}»</span> ausblenden?
                                      {taxoDelete.txnCount > 0 && (
                                        <span className="text-text-tertiary ml-1">
                                          {taxoDelete.txnCount} Transaktion{taxoDelete.txnCount !== 1 ? "en" : ""} betroffen.
                                        </span>
                                      )}
                                    </p>
                                    {taxoDelete.txnCount > 0 && (
                                      <select
                                        className="input-field text-[11px] w-full"
                                        value={taxoDeleteTarget}
                                        onChange={(e) => setTaxoDeleteTarget(e.target.value)}
                                      >
                                        <option value="">— Neu zuweisen zu —</option>
                                        {allTxnLabels.filter((tl) => tl !== l).map((tl) => <option key={tl} value={tl}>{tl}</option>)}
                                      </select>
                                    )}
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        disabled={(taxoDelete.txnCount > 0 && !taxoDeleteTarget) || migrateLabelMutation.isPending || hideLabelMutation.isPending}
                                        onClick={handleConfirmTaxoDelete}
                                        className="px-2 py-0.5 rounded bg-loss/20 text-loss border border-loss/30 hover:bg-loss/30 disabled:opacity-40 transition-colors"
                                      >
                                        {taxoDelete.txnCount > 0 ? "Migrieren & Ausblenden" : "Ausblenden"}
                                      </button>
                                      <button type="button" onClick={() => setTaxoDelete(null)} className="text-text-tertiary hover:text-text-primary">Abbrechen</button>
                                    </div>
                                  </div>
                                ) : (
                                <span
                                  key={l}
                                  className="group flex items-center gap-0.5 px-1.5 py-0.5 rounded text-text-secondary text-[11px]"
                                  style={{ backgroundColor: sc.color + "18" }}
                                >
                                  {l}
                                  <button
                                    type="button"
                                    title="Ausblenden / Migrieren"
                                    onClick={() => openTaxoDelete(sc.id, l, "wizard")}
                                    className="opacity-0 group-hover:opacity-100 ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-loss/20 text-text-tertiary hover:text-loss transition-all"
                                  >
                                    <X className="w-2.5 h-2.5" />
                                  </button>
                                </span>
                                )
                              ))}
                              {/* User-added wizard labels */}
                              {ownCats.filter((cat) => cat.icon === "wl:" + sc.id).map((cat) => (
                                <span
                                  key={cat.id}
                                  className="group flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-text-secondary text-[11px]"
                                  style={{ backgroundColor: sc.color + "18", borderColor: sc.color + "44" }}
                                >
                                  {cat.name}
                                  <button
                                    type="button"
                                    onClick={() => { setCatDeleteId(cat.id); setCatReassignTo(""); }}
                                    className="opacity-0 group-hover:opacity-100 ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full hover:bg-loss/20 text-text-tertiary hover:text-loss transition-all"
                                  >
                                    <X className="w-2.5 h-2.5" />
                                  </button>
                                </span>
                              ))}
                            </>
                          )}
                        </div>
                        {renderTaxonomyAddForm(sc, "wizard")}
                      </div>
                    </div>

                    {/* Hidden canonical labels — restore option */}
                    {(() => {
                      const hiddenTxn = (hiddenLabelsData?.[`${sc.id}:txn`] ?? []);
                      const hiddenWl = (hiddenLabelsData?.[`${sc.id}:wl`] ?? []);
                      if (hiddenTxn.length === 0 && hiddenWl.length === 0) return null;
                      return (
                        <div className="pt-2 border-t border-border/20">
                          <p className="text-text-disabled text-[10px] uppercase tracking-wide mb-1 flex items-center gap-1">
                            <Eye className="w-2.5 h-2.5" />
                            Ausgeblendete Labels — klicken zum Einblenden
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {hiddenTxn.map((l) => (
                              <button
                                key={`txn:${l}`}
                                type="button"
                                title="Wieder einblenden (Transaktionskategorie)"
                                onClick={() => unhideLabelMutation.mutate({ sc_id: sc.id, label: l, label_type: "txn" })}
                                className="px-1.5 py-0.5 rounded text-[11px] text-text-disabled border border-dashed border-border/40 hover:border-text-tertiary hover:text-text-secondary transition-colors"
                              >
                                {l}
                                <span className="ml-1 text-[10px] opacity-60">Ist</span>
                              </button>
                            ))}
                            {hiddenWl.map((l) => (
                              <button
                                key={`wl:${l}`}
                                type="button"
                                title="Wieder einblenden (Wizard-Label)"
                                onClick={() => unhideLabelMutation.mutate({ sc_id: sc.id, label: l, label_type: "wl" })}
                                className="px-1.5 py-0.5 rounded text-[11px] text-text-disabled border border-dashed border-border/40 hover:border-text-tertiary hover:text-text-secondary transition-colors"
                              >
                                {l}
                                <span className="ml-1 text-[10px] opacity-60">Emp</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Category mapping */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">Kategorie-Zuordnung</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              Ordnet jedes Budget-Label aus empirischen Angaben einer Superkategorie zu.
              Die Budgetanalyse nutzt daraus die passende Ist-Transaktionskategorie und Peer-Gruppe.
            </p>
          </div>
          <button
            type="button"
            onClick={() => resetMappingsMutation.mutate()}
            disabled={resetMappingsMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 text-text-secondary text-xs hover:bg-bg-surface2 transition-colors disabled:opacity-40"
            title="Auf Standardzuordnungen zurücksetzen"
          >
            <RotateCcw className="w-3 h-3" />
            Zurücksetzen auf Standard
          </button>
        </div>

        {mappingsLoading ? (
          <p className="text-text-tertiary text-sm py-4">Wird geladen…</p>
        ) : !mappingsData?.wizard_labels?.length ? (
          <p className="text-text-tertiary text-sm py-4">
            Keine Budgets aus empirischen Angaben gefunden. Bitte zuerst unter «Empirische Angaben» abschliessen.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50 text-text-tertiary text-xs">
                    <th className="text-left py-2 pr-4">Label aus empirischen Angaben</th>
                    <th className="text-left py-2">Superkategorie</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/20">
                  {(mappingsData?.wizard_labels as string[] || []).map((label: string) => (
                    <tr key={label} className="hover:bg-bg-surface2/30">
                      <td className="py-2 pr-4 text-text-secondary font-medium">{label}</td>
                      <td className="py-2">
                        <select
                          value={mappingDrafts[label] ?? ""}
                          onChange={(e) => {
                            setMappingDrafts((prev) => ({ ...prev, [label]: e.target.value }));
                            setMappingDirty(true);
                            setMappingSaved(false);
                          }}
                          className="input w-full max-w-md"
                        >
                          <option value="">Taxonomie-Standard (automatisch)</option>
                          {SUPER_CATEGORIES.map((sc) => (
                            <option key={sc.id} value={sc.id}>
                              {sc.emoji} {sc.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {saveMappingsMutation.isError && (
              <div className="flex items-center gap-2 text-loss text-xs bg-loss/10 border border-loss/30 rounded-lg px-3 py-2 mt-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Fehler beim Speichern.
              </div>
            )}

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => saveMappingsMutation.mutate()}
                disabled={!mappingDirty || saveMappingsMutation.isPending}
                className="btn-primary flex items-center gap-2 disabled:opacity-40"
              >
                <Save className="w-4 h-4" />
                {mappingSaved ? "✓ Gespeichert!" : saveMappingsMutation.isPending ? "Speichern..." : "Zuordnungen speichern"}
              </button>
              {mappingDirty && (
                <span className="text-xs text-warning">Ungespeicherte Änderungen</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Eigene Kategorien ── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm flex items-center gap-2">
              <Tag className="w-4 h-4 text-accent" />
              Eigene Kategorien
            </h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              Benutzerdefinierte Kategorien für Transaktionen — ergänzend zu den Systemkategorien.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCatAddForm({ name: "", super_id: "sonstiges", color: "#94a3b8" })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs font-medium hover:bg-accent/20 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Neue Kategorie
          </button>
        </div>

        {/* Add form */}
        {catAddForm && (
          <div className="mb-4 p-3 rounded-lg border border-accent/30 bg-accent/5 space-y-3">
            <p className="text-text-primary text-xs font-semibold">Neue Kategorie erstellen</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-tertiary text-[11px] mb-1 block">Name</label>
                <input
                  type="text"
                  autoFocus
                  className="input-field text-sm w-full"
                  value={catAddForm.name}
                  onChange={(e) => setCatAddForm((f) => f ? { ...f, name: e.target.value } : null)}
                  placeholder="z.B. Kontoübertrag"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && catAddForm.name.trim()) createCatMutation.mutate(catAddForm);
                    if (e.key === "Escape") setCatAddForm(null);
                  }}
                />
              </div>
              <div>
                <label className="text-text-tertiary text-[11px] mb-1 block">Superkategorie</label>
                <select
                  className="input-field text-sm w-full"
                  value={catAddForm.super_id}
                  onChange={(e) => setCatAddForm((f) => f ? { ...f, super_id: e.target.value } : null)}
                >
                  {SUPER_CATEGORIES.map((sc) => (
                    <option key={sc.id} value={sc.id}>{sc.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-text-tertiary text-[11px]">Farbe:</label>
              <input
                type="color"
                value={catAddForm.color}
                onChange={(e) => setCatAddForm((f) => f ? { ...f, color: e.target.value } : null)}
                className="w-7 h-7 rounded cursor-pointer border border-border"
              />
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => createCatMutation.mutate(catAddForm)}
                disabled={!catAddForm.name.trim() || createCatMutation.isPending}
                className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-40"
              >
                <Check className="w-3 h-3" />
                Erstellen
              </button>
              <button
                type="button"
                onClick={() => setCatAddForm(null)}
                className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface2"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {createCatMutation.isError && (
              <p className="text-loss text-xs">Fehler beim Erstellen.</p>
            )}
          </div>
        )}

        {catsLoading && (
          <p className="text-text-tertiary text-sm py-4">Wird geladen…</p>
        )}

        {!catsLoading && ownCats.length === 0 && !catAddForm && (
          <p className="text-text-tertiary text-sm py-4 text-center">
            Noch keine eigenen Kategorien. Klicke auf «Neue Kategorie» um zu beginnen.
          </p>
        )}

        {/* Grouped by supercategory */}
        {catsBySupercat.length > 0 && (
          <div className="space-y-1">
            {catsBySupercat.map(({ sc, cats }) => (
              <div key={sc.id} className="rounded-lg border border-border/40 overflow-hidden">
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  style={{ backgroundColor: sc.color + "10" }}
                >
                  <span
                    className="w-6 h-6 rounded-md flex items-center justify-center"
                    style={{ backgroundColor: sc.color + "22" }}
                  >
                    <sc.icon className="w-3.5 h-3.5" style={{ color: sc.color }} />
                  </span>
                  <span className="text-text-secondary text-xs font-semibold">{sc.label}</span>
                  <span className="text-text-disabled text-[11px] ml-auto">{cats.length} Kategorie{cats.length !== 1 ? "n" : ""}</span>
                </div>
                <div className="divide-y divide-border/20">
                  {cats.map((cat) => (
                    <div key={cat.id} className="px-3 py-2">
                      {catDeleteId === cat.id ? (
                        /* Delete confirmation */
                        <div className="space-y-2">
                          <p className="text-xs text-text-secondary">
                            <span className="text-loss font-semibold">«{cat.name}»</span> löschen?
                            {cat.txn_count > 0 && (
                              <span className="ml-1 text-text-tertiary">
                                {cat.txn_count} Transaktion{cat.txn_count !== 1 ? "en" : ""} verknüpft.
                              </span>
                            )}
                          </p>
                          {cat.txn_count > 0 && (
                            <div>
                              <label className="text-text-tertiary text-[11px] mb-1 block">
                                Neu zuweisen zu (optional):
                              </label>
                              <select
                                className="input-field text-xs w-full max-w-xs"
                                value={catReassignTo}
                                onChange={(e) => setCatReassignTo(e.target.value ? Number(e.target.value) : "")}
                              >
                                <option value="">— Keine Zuweisung (Kategorie-ID wird geleert) —</option>
                                {ownCats
                                  .filter((c) => c.id !== cat.id)
                                  .map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                  ))}
                              </select>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => deleteCatMutation.mutate({ id: cat.id, reassignTo: catReassignTo })}
                              disabled={deleteCatMutation.isPending}
                              className="text-[11px] px-2.5 py-1 rounded bg-loss/20 text-loss border border-loss/30 hover:bg-loss/30 transition-colors disabled:opacity-40"
                            >
                              Endgültig löschen
                            </button>
                            <button
                              type="button"
                              onClick={() => { setCatDeleteId(null); setCatReassignTo(""); }}
                              className="text-[11px] text-text-tertiary hover:text-text-primary"
                            >
                              Abbrechen
                            </button>
                          </div>
                        </div>
                      ) : catEditId === cat.id ? (
                        /* Inline edit */
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            type="text"
                            className="input-field text-sm flex-1"
                            value={catEditName}
                            onChange={(e) => setCatEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && catEditName.trim()) {
                                updateCatMutation.mutate({ id: cat.id, name: catEditName, icon: cat.icon, color: cat.color });
                              }
                              if (e.key === "Escape") setCatEditId(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => updateCatMutation.mutate({ id: cat.id, name: catEditName, icon: cat.icon, color: cat.color })}
                            disabled={!catEditName.trim() || updateCatMutation.isPending}
                            className="p-1.5 rounded text-gain hover:bg-gain/10 disabled:opacity-40"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setCatEditId(null)}
                            className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface2"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        /* Normal row */
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: cat.color ?? sc.color }}
                          />
                          <span className="text-text-primary text-sm flex-1">{cat.name}</span>
                          {cat.txn_count > 0 && (
                            <span className="text-[11px] text-text-tertiary font-mono bg-bg-surface2 px-1.5 py-0.5 rounded">
                              {cat.txn_count} Txn
                            </span>
                          )}
                          <button
                            type="button"
                            title="Umbenennen"
                            onClick={() => { setCatEditId(cat.id); setCatEditName(cat.name); }}
                            className="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface2 transition-colors"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            title="Löschen"
                            onClick={() => { setCatDeleteId(cat.id); setCatReassignTo(""); }}
                            className="p-1.5 rounded text-text-tertiary hover:text-loss hover:bg-loss/10 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      {/* Darstellung / Display preferences */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Darstellung</h2>
        <div className="space-y-4">
          <div>
            <label className="label mb-2 block">Standard-Ansicht Budgetanalyse</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleBudgetDefaultView("bar")}
                className={clsx(
                  "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors",
                  budgetDefaultView === "bar"
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "border-border text-text-tertiary hover:text-text-secondary",
                )}
              >
                Balkenansicht
              </button>
              <button
                type="button"
                onClick={() => handleBudgetDefaultView("gauge")}
                className={clsx(
                  "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors",
                  budgetDefaultView === "gauge"
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "border-border text-text-tertiary hover:text-text-secondary",
                )}
              >
                Gauge-Ansicht
              </button>
            </div>
            <p className="text-text-disabled text-xs mt-1.5">
              Wird beim Öffnen der Budgetanalyse als Standard verwendet.
            </p>
          </div>
        </div>
      </div>

      {/* ── Datensicherung ──────────────────────────────────────── */}
      <div className="card space-y-5">
        <h2 className="text-text-primary font-semibold text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-accent" />
          Datensicherung
        </h2>

        {/* Export */}
        <div className="space-y-2">
          <h3 className="text-text-secondary text-xs font-medium uppercase tracking-wide">Export</h3>
          <p className="text-text-tertiary text-xs">
            Exportiert alle deine Daten als JSON-Backup: Transaktionen, Konten, Budgets,
            Wiederkehrende Einträge, Wizard-Konfiguration, Säulen 1–3a und Assets.
          </p>
          <button
            type="button"
            onClick={handleExport}
            disabled={backupExporting}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Download className="w-4 h-4" />
            {backupExporting ? "Wird exportiert…" : "JSON-Backup herunterladen"}
          </button>
          {backupExportError && (
            <p className="text-loss text-xs flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {backupExportError}
            </p>
          )}
        </div>

        <div className="border-t border-border/40" />

        {/* Import */}
        <div className="space-y-3">
          <h3 className="text-text-secondary text-xs font-medium uppercase tracking-wide">Import / Wiederherstellen</h3>
          <p className="text-text-tertiary text-xs">
            Stellt Daten aus einem vorherigen JSON-Backup wieder her. Bestehende Einträge werden
            nicht überschrieben — nur fehlende Daten werden ergänzt.
          </p>

          {/* File picker */}
          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <span className="flex items-center gap-2 px-3 py-2 bg-bg-surface2 hover:bg-bg-surface border border-border text-text-secondary hover:text-text-primary rounded-lg text-sm transition-colors">
              <Upload className="w-4 h-4" />
              {importFile ? importFile.name : "Backup-Datei auswählen (.json)"}
            </span>
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => { setImportFile(e.target.files?.[0] ?? null); setImportResult(null); setImportError(null); }}
            />
          </label>

          {/* Options */}
          {importFile && (
            <div className="space-y-2 text-xs text-text-secondary">
              <p className="text-text-tertiary font-medium">Optionen:</p>
              {([
                ["import_transactions", "Transaktionen importieren"],
                ["import_recurring_plan", "Wiederkehrende Einträge importieren"],
                ["import_wizard_config", "Wizard-Konfiguration wiederherstellen"],
                ["import_pension_assets", "Säulen & Assets importieren"],
                ["overwrite_profile", "Profil-Felder überschreiben (Name, Währung, …)"],
              ] as [keyof typeof importOptions, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={importOptions[key]}
                    onChange={(e) => setImportOptions((o) => ({ ...o, [key]: e.target.checked }))}
                    className="accent-accent"
                  />
                  {label}
                </label>
              ))}
              <button
                type="button"
                onClick={handleImport}
                disabled={importPending}
                className="mt-2 flex items-center gap-2 px-4 py-2 bg-gain/80 hover:bg-gain disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Upload className="w-4 h-4" />
                {importPending ? "Wird importiert…" : "Backup importieren"}
              </button>
            </div>
          )}

          {/* Result */}
          {importResult && (
            <div className="p-3 rounded-xl bg-gain/10 border border-gain/30 text-xs space-y-1 text-gain">
              <p className="font-medium flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Import abgeschlossen</p>
              <p>Konten: +{String(importResult.accounts_created ?? 0)} · Transaktionen: +{String(importResult.transactions_created ?? 0)} übersprungen: {String(importResult.transactions_skipped ?? 0)}</p>
              <p>Wiederkehrend: +{String(importResult.recurring_plan_created ?? 0)} · Säulen: +{String(importResult.pension_created ?? 0)} · Assets: +{String(importResult.assets_created ?? 0)}</p>
              {(importResult.warnings as string[] | undefined)?.length ? (
                <p className="text-amber-400">⚠ {(importResult.warnings as string[]).join("; ")}</p>
              ) : null}
            </div>
          )}
          {importError && (
            <p className="text-loss text-xs flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" /> {importError}
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">About</h2>
        <div className="space-y-3 text-sm text-text-secondary">
          <p>Budget-Pal v1.0.0 · Persönliche Finanzplanung</p>
          <p>Schweizer Kontext · CHF · AHV/BVG/3a Rentenrechner</p>
          <p className="flex items-center gap-2">
            Domain:
            <a href="https://budgetpal.doebele12.de" target="_blank" rel="noopener" className="text-accent hover:text-accent-light flex items-center gap-1">
              budgetpal.doebele12.de <ExternalLink className="w-3 h-3" />
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
