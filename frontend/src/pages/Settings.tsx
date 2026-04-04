import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { authApi, settingsApi } from "@/lib/api";
import { Save, ExternalLink, Wand2, RotateCcw, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "react-router-dom";
import { differenceInYears, parseISO } from "date-fns";
import { SUPER_CATEGORIES } from "@/lib/categories";

function calcAge(birthdate: string): number | null {
  if (!birthdate) return null;
  try { return differenceInYears(new Date(), parseISO(birthdate)); } catch { return null; }
}

interface CategoryMapping {
  wizard_label: string;
  transaction_category: string;
}

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user?.name || "");
  const [birthdate, setBirthdate] = useState(user?.birthdate || "");
  const [retirementAge, setRetirementAge] = useState(user?.retirement_age || 65);
  const [saved, setSaved] = useState(false);
  const [expandedSc, setExpandedSc] = useState<string | null>(null);

  // Category mapping state
  const [mappingDrafts, setMappingDrafts] = useState<Record<string, string>>({});
  const [mappingSaved, setMappingSaved] = useState(false);
  const [mappingDirty, setMappingDirty] = useState(false);

  const age = calcAge(birthdate);
  const retirementYear = age !== null ? new Date().getFullYear() + (retirementAge - age) : null;

  const mutation = useMutation({
    mutationFn: () => authApi.updateMe({ name, birthdate: birthdate || null, retirement_age: retirementAge }),
    onSuccess: async () => {
      await refreshUser();
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

  return (
    <div className="space-y-6 animate-fade-in max-w-2xl">
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

      {/* Category mapping */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-semibold text-sm">Kategorie-Zuordnung</h2>
            <p className="text-text-tertiary text-xs mt-0.5">
              Verknüpft Budgetkategorien aus empirischen Angaben mit deinen Transaktionskategorien (für die «Ist»-Spalte).
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
                    <th className="text-left py-2">Transaktionskategorie (Ist)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/20">
                  {(mappingsData?.wizard_labels as string[] || []).map((label: string) => (
                    <tr key={label} className="hover:bg-bg-surface2/30">
                      <td className="py-2 pr-4 text-text-secondary font-medium">{label}</td>
                      <td className="py-2">
                        <select
                          value={mappingDrafts[label] || ""}
                          onChange={(e) => {
                            setMappingDrafts((prev) => ({ ...prev, [label]: e.target.value }));
                            setMappingDirty(true);
                            setMappingSaved(false);
                          }}
                          className="input w-full max-w-xs"
                        >
                          <option value="">— Keine Zuordnung —</option>
                          {(mappingsData?.transaction_categories as string[] || []).map((cat: string) => (
                            <option key={cat} value={cat}>{cat}</option>
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

      {/* Supercategory taxonomy */}
      <div className="card">
        <div className="mb-4">
          <h2 className="text-text-primary font-semibold text-sm">Superkategorie-Taxonomie</h2>
          <p className="text-text-tertiary text-xs mt-0.5">
            Übersicht, welche Transaktionskategorien (Reale Angaben) und Wizard-Labels (Empirische Angaben) jeder Superkategorie zugeordnet sind.
          </p>
        </div>
        <div className="space-y-1">
          {SUPER_CATEGORIES.filter((sc) => sc.id !== "sonstiges").map((sc) => {
            const isOpen = expandedSc === sc.id;
            return (
              <div key={sc.id} className="rounded-lg border border-border/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedSc(isOpen ? null : sc.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-bg-surface2 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
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
                  {isOpen
                    ? <ChevronUp className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                    : <ChevronDown className="w-3.5 h-3.5 text-text-tertiary shrink-0" />}
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 pt-1 border-t border-border/30 grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <p className="text-text-tertiary font-semibold uppercase tracking-wide mb-1.5">
                        Transaktionskategorien (Reale Angaben)
                      </p>
                      {sc.txnCategories.length === 0 ? (
                        <span className="text-text-disabled italic">Keine — fällt in Sonstiges</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {sc.txnCategories.map((c) => (
                            <span
                              key={c}
                              className="px-1.5 py-0.5 rounded text-text-secondary"
                              style={{ backgroundColor: sc.color + "18" }}
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-text-tertiary font-semibold uppercase tracking-wide mb-1.5">
                        Empirische Labels (Wizard)
                      </p>
                      {sc.wizardLabels.length === 0 ? (
                        <span className="text-text-disabled italic">Keine</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {sc.wizardLabels.map((l) => (
                            <span
                              key={l}
                              className="px-1.5 py-0.5 rounded text-text-secondary"
                              style={{ backgroundColor: sc.color + "18" }}
                            >
                              {l}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Info */}
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
