import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { authApi } from "@/lib/api";
import { Save, ExternalLink, Wand2 } from "lucide-react";
import { Link } from "react-router-dom";
import { differenceInYears, parseISO } from "date-fns";

function calcAge(birthdate: string): number | null {
  if (!birthdate) return null;
  try { return differenceInYears(new Date(), parseISO(birthdate)); } catch { return null; }
}

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [birthdate, setBirthdate] = useState(user?.birthdate || "");
  const [retirementAge, setRetirementAge] = useState(user?.retirement_age || 65);
  const [saved, setSaved] = useState(false);

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

      {/* Wizard shortcut */}
      <div className="card border border-accent/20 bg-accent/5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Wand2 className="w-4 h-4 text-accent" />
          </div>
          <div className="flex-1">
            <h2 className="text-text-primary font-semibold text-sm">Setup-Wizard erneut ausführen</h2>
            <p className="text-text-tertiary text-xs mt-0.5 mb-3">
              Aktualisiere deine Basisdaten, Peer-Gruppe, Vorsorge (AHV/BVG/3a) und Finanzplan-Ziele.
            </p>
            <Link to="/wizard" className="btn-primary inline-flex items-center gap-2 text-sm py-2">
              <Wand2 className="w-3.5 h-3.5" />
              Wizard starten
            </Link>
          </div>
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
