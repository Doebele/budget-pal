import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { accountsApi } from "@/lib/api";
import { formatCHF } from "@/lib/theme";
import { Plus, Wallet, Edit2 } from "lucide-react";
import { clsx } from "clsx";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Girokonto", savings: "Sparkonto",
  investment: "Anlagekonto", credit: "Kreditkarte", cash: "Bargeld",
};

export default function Accounts() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", bank: "", currency: "CHF", balance: 0, account_type: "checking" });

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: () => accountsApi.create(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setShowForm(false);
      setForm({ name: "", bank: "", currency: "CHF", balance: 0, account_type: "checking" });
    },
  });

  const totalBalance = (accounts || []).reduce((s: number, a: { balance: number }) => s + a.balance, 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Konten</h1>
          <p className="text-text-tertiary text-sm mt-0.5">Gesamtsaldo: <span className="text-text-primary font-mono font-semibold">{formatCHF(totalBalance)}</span></p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> Konto hinzufügen
        </button>
      </div>

      {showForm && (
        <div className="card">
          <h2 className="text-text-primary font-semibold text-sm mb-4">Neues Konto</h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="z.B. UBS Privatkonto" />
            </div>
            <div>
              <label className="label">Bank</label>
              <input className="input" value={form.bank} onChange={(e) => setForm((f) => ({ ...f, bank: e.target.value }))} placeholder="z.B. UBS" />
            </div>
            <div>
              <label className="label">Kontotyp</label>
              <select className="input" value={form.account_type} onChange={(e) => setForm((f) => ({ ...f, account_type: e.target.value }))}>
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Anfangssaldo</label>
              <input type="number" className="input" value={form.balance} onChange={(e) => setForm((f) => ({ ...f, balance: +e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => createMutation.mutate()} className="btn-primary" disabled={!form.name || !form.bank || createMutation.isPending}>
              {createMutation.isPending ? "Speichern..." : "Erstellen"}
            </button>
            <button onClick={() => setShowForm(false)} className="btn-secondary">Abbrechen</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(accounts || []).map((account: { id: number; name: string; bank: string; balance: number; account_type: string; currency: string }) => (
          <div key={account.id} className="card hover:border-accent/30 transition-colors">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center">
                  <Wallet className="w-4 h-4 text-accent" />
                </div>
                <div>
                  <p className="text-text-primary font-medium text-sm">{account.name}</p>
                  <p className="text-text-tertiary text-xs">{account.bank} · {ACCOUNT_TYPE_LABELS[account.account_type] || account.account_type}</p>
                </div>
              </div>
              <button className="text-text-tertiary hover:text-text-primary transition-colors">
                <Edit2 className="w-4 h-4" />
              </button>
            </div>
            <p className={clsx("text-2xl font-mono font-semibold", account.balance >= 0 ? "text-text-primary" : "text-loss")}>
              {formatCHF(account.balance)}
            </p>
            <p className="text-text-tertiary text-xs mt-1">{account.currency}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
