/**
 * Goals page — manage financial targets.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "@/lib/api";
import { formatAmount } from "@/lib/theme";
import { Calendar, EditPencil, GraphUp, NavArrowRight, Plus, Position, Trash, Trophy, Wallet, Xmark } from "@/lib/icons";
import { clsx } from "clsx";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";
import { Link } from "react-router-dom";

type GoalType = "savings" | "debt_payoff" | "emergency_fund" | "purchase" | "retirement" | "other";

interface Goal {
  id: number;
  name: string;
  goal_type: GoalType;
  target_amount: number;
  current_amount: number;
  monthly_contribution: number;
  deadline?: string | null;
  linked_account_id?: number | null;
  linked_account_name?: string | null;
  notes?: string | null;
  is_achieved: boolean;
  progress_pct: number;
  remaining: number;
  months_to_target?: number | null;
  eta?: string | null;
}

const GOAL_TYPE_META: Record<GoalType, { label: string; emoji: string; color: string }> = {
  savings:        { label: "Sparziel",         emoji: "💰", color: "#10b981" },
  debt_payoff:    { label: "Schulden abbezahlen", emoji: "📉", color: "#f43f5e" },
  emergency_fund: { label: "Notgroschen",      emoji: "🛡️", color: "#3b82f6" },
  purchase:       { label: "Anschaffung",      emoji: "🛒", color: "#f59e0b" },
  retirement:     { label: "Rente",            emoji: "🌴", color: "#a78bfa" },
  other:          { label: "Sonstiges",        emoji: "🎯", color: "#6b7280" },
};

const DEFAULT_FORM = {
  name: "",
  goal_type: "savings" as GoalType,
  target_amount: "",
  current_amount: "0",
  monthly_contribution: "",
  deadline: "",
  notes: "",
};

export default function Goals() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["goals"],
    queryFn: () => goalsApi.list().then((r) => r.data),
  });

  const createMut = useMutation({
    mutationFn: (data: Record<string, unknown>) => goalsApi.create(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["goals"] }); resetForm(); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => goalsApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["goals"] }); resetForm(); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => goalsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["goals"] }); setConfirmDeleteId(null); },
  });

  function resetForm() {
    setShowForm(false);
    setEditingGoal(null);
    setForm(DEFAULT_FORM);
  }

  function startEdit(g: Goal) {
    setEditingGoal(g);
    setForm({
      name: g.name,
      goal_type: g.goal_type,
      target_amount: String(g.target_amount),
      current_amount: String(g.current_amount),
      monthly_contribution: String(g.monthly_contribution),
      deadline: g.deadline ? g.deadline.slice(0, 10) : "",
      notes: g.notes ?? "",
    });
    setShowForm(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      name: form.name,
      goal_type: form.goal_type,
      target_amount: parseFloat(form.target_amount) || 0,
      current_amount: parseFloat(form.current_amount) || 0,
      monthly_contribution: parseFloat(form.monthly_contribution) || 0,
      deadline: form.deadline || null,
      notes: form.notes || null,
    };
    if (editingGoal) {
      updateMut.mutate({ id: editingGoal.id, data: payload });
    } else {
      createMut.mutate(payload);
    }
  }

  const activeGoals = goals.filter((g) => !g.is_achieved);
  const achievedGoals = goals.filter((g) => g.is_achieved);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-display text-text-primary">Sparziele</h1>
          <p className="text-text-tertiary text-sm mt-0.5">
            {activeGoals.length} aktive Ziele
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Neues Ziel
        </button>
      </div>

      {/* Form panel */}
      {showForm && (
        <div className="card border-accent/30 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary font-semibold text-sm flex items-center gap-2">
              <Position className="w-4 h-4 text-accent" />
              {editingGoal ? "Ziel bearbeiten" : "Neues Ziel"}
            </h2>
            <button onClick={resetForm} className="text-text-tertiary hover:text-text-primary">
              <Xmark className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs text-text-tertiary mb-1">Bezeichnung *</label>
              <input
                required
                className="input w-full"
                placeholder="z.B. Notgroschen aufbauen"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-text-tertiary mb-1">Typ</label>
              <select
                className="input w-full"
                value={form.goal_type}
                onChange={(e) => setForm((f) => ({ ...f, goal_type: e.target.value as GoalType }))}
              >
                {Object.entries(GOAL_TYPE_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.emoji} {v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-tertiary mb-1">Zieltermin</label>
              <input
                type="date"
                className="input w-full"
                value={form.deadline}
                onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-text-tertiary mb-1">Zielbetrag (CHF) *</label>
              <input
                required
                type="number"
                min="0"
                step="0.01"
                className="input w-full font-mono"
                placeholder="10000"
                value={form.target_amount}
                onChange={(e) => setForm((f) => ({ ...f, target_amount: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-text-tertiary mb-1">Aktueller Stand (CHF)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="input w-full font-mono"
                value={form.current_amount}
                onChange={(e) => setForm((f) => ({ ...f, current_amount: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-text-tertiary mb-1">Monatliche Einlage (CHF)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className="input w-full font-mono"
                placeholder="500"
                value={form.monthly_contribution}
                onChange={(e) => setForm((f) => ({ ...f, monthly_contribution: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-text-tertiary mb-1">Notizen</label>
              <input
                className="input w-full"
                placeholder="Optional"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="md:col-span-2 flex justify-end gap-2 pt-2">
              <button type="button" onClick={resetForm} className="btn-secondary">
                Abbrechen
              </button>
              <button
                type="submit"
                disabled={createMut.isPending || updateMut.isPending}
                className="btn-primary disabled:opacity-50"
              >
                {editingGoal ? "Speichern" : "Erstellen"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="card animate-pulse">
              <div className="skeleton h-4 w-32 rounded mb-3" />
              <div className="skeleton h-3 w-full rounded mb-2" />
              <div className="skeleton h-2 w-full rounded" />
            </div>
          ))}
        </div>
      )}

      {/* Active goals grid */}
      {!isLoading && activeGoals.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeGoals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              onEdit={() => startEdit(g)}
              onDelete={() => setConfirmDeleteId(g.id)}
              confirmDelete={confirmDeleteId === g.id}
              onCancelDelete={() => setConfirmDeleteId(null)}
              onConfirmDelete={() => deleteMut.mutate(g.id)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && goals.length === 0 && (
        <div className="card flex flex-col items-center justify-center py-16 text-center">
          <Position className="w-12 h-12 text-text-tertiary mb-3" />
          <p className="text-text-primary font-medium mb-1">Noch keine Ziele</p>
          <p className="text-text-tertiary text-sm mb-4">
            Erstelle dein erstes Sparziel und verfolge deinen Fortschritt.
          </p>
          <button onClick={() => setShowForm(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" /> Erstes Ziel erstellen
          </button>
        </div>
      )}

      {/* Achieved goals */}
      {achievedGoals.length > 0 && (
        <div>
          <h2 className="text-text-tertiary text-xs uppercase tracking-widest font-medium mb-3 flex items-center gap-2">
            <Trophy className="w-3.5 h-3.5 text-warning" />
            Erreichte Ziele
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 opacity-60">
            {achievedGoals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                onEdit={() => startEdit(g)}
                onDelete={() => setConfirmDeleteId(g.id)}
                confirmDelete={confirmDeleteId === g.id}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onConfirmDelete={() => deleteMut.mutate(g.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── GoalCard ──────────────────────────────────────────────────

interface GoalCardProps {
  goal: Goal;
  onEdit: () => void;
  onDelete: () => void;
  confirmDelete: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}

function GoalCard({ goal, onEdit, onDelete, confirmDelete, onCancelDelete, onConfirmDelete }: GoalCardProps) {
  const meta = GOAL_TYPE_META[goal.goal_type] ?? GOAL_TYPE_META.other;
  const barColor = goal.is_achieved ? "#10b981" : meta.color;

  return (
    <div className="card group relative flex flex-col gap-3">
      {/* Top row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center text-lg shrink-0"
            style={{ backgroundColor: barColor + "22" }}
          >
            {goal.is_achieved ? "🏆" : meta.emoji}
          </span>
          <div className="min-w-0">
            <p className="text-text-primary text-sm font-semibold truncate">{goal.name}</p>
            <p className="text-text-tertiary text-xs">{meta.label}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button onClick={onEdit} className="text-text-tertiary hover:text-accent transition-colors p-1">
            <EditPencil className="w-3.5 h-3.5" />
          </button>
          {confirmDelete ? (
            <>
              <button onClick={onConfirmDelete} className="text-[10px] px-1.5 py-0.5 rounded bg-loss/20 text-loss border border-loss/30 hover:bg-loss/40 whitespace-nowrap">
                Löschen
              </button>
              <button onClick={onCancelDelete} className="text-text-tertiary hover:text-text-secondary p-1">
                <Xmark className="w-3 h-3" />
              </button>
            </>
          ) : (
            <button onClick={onDelete} className="text-text-tertiary hover:text-loss transition-colors p-1">
              <Trash className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="font-mono font-medium text-text-primary">
            {formatAmount(goal.current_amount, "CHF")}
          </span>
          <span className="text-text-tertiary font-mono">
            {formatAmount(goal.target_amount, "CHF")}
          </span>
        </div>
        <div className="h-2 bg-bg-surface2 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(100, goal.progress_pct)}%`, backgroundColor: barColor }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-text-tertiary">
          <span>{goal.progress_pct.toFixed(1)}% erreicht</span>
          {!goal.is_achieved && (
            <span>noch {formatAmount(goal.remaining, "CHF")}</span>
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        {goal.monthly_contribution > 0 && (
          <span className="flex items-center gap-1 px-2 py-0.5 bg-bg-surface2 rounded-full text-text-secondary">
            <GraphUp className="w-2.5 h-2.5" />
            {formatAmount(goal.monthly_contribution, "CHF")}/Mt.
          </span>
        )}
        {goal.months_to_target != null && goal.months_to_target > 0 && (
          <span className="flex items-center gap-1 px-2 py-0.5 bg-bg-surface2 rounded-full text-text-secondary">
            <Calendar className="w-2.5 h-2.5" />
            {goal.months_to_target} Monate
          </span>
        )}
        {goal.deadline && (
          <span className="flex items-center gap-1 px-2 py-0.5 bg-bg-surface2 rounded-full text-text-secondary">
            <Calendar className="w-2.5 h-2.5" />
            bis {format(parseISO(goal.deadline), "MM.yyyy", { locale: de })}
          </span>
        )}
        {goal.linked_account_name && (
          <span className="flex items-center gap-1 px-2 py-0.5 bg-bg-surface2 rounded-full text-text-secondary">
            <Wallet className="w-2.5 h-2.5" />
            {goal.linked_account_name}
          </span>
        )}
      </div>

      {goal.is_achieved && (
        <div className="flex items-center gap-1.5 text-xs text-gain bg-gain/10 rounded-lg px-2 py-1.5">
          <Trophy className="w-3 h-3" />
          Ziel erreicht!
        </div>
      )}
    </div>
  );
}
