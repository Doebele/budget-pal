import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { authApi } from "@/lib/api";
import { Save, ExternalLink } from "lucide-react";

export default function Settings() {
  const { user, refreshUser } = useAuth();
  const [name, setName] = useState(user?.name || "");
  const [retirementAge, setRetirementAge] = useState(user?.retirement_age || 65);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: () => authApi.updateMe({ name, retirement_age: retirementAge }),
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
          <div>
            <label className="label">Rentenalter</label>
            <input type="number" className="input w-32" value={retirementAge} onChange={(e) => setRetirementAge(+e.target.value)} min={55} max={75} />
          </div>
          <button
            onClick={() => mutation.mutate()}
            className="btn-primary flex items-center gap-2"
            disabled={mutation.isPending}
          >
            <Save className="w-4 h-4" />
            {saved ? "Gespeichert!" : mutation.isPending ? "Speichern..." : "Speichern"}
          </button>
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
