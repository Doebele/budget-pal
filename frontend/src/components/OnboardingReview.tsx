import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { categoriesApi, onboardingApi, type ReviewGroup } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatAmount } from "@/lib/theme";
import { Check } from "@/lib/icons";

interface Category {
  id: number;
  name: string;
}

/**
 * Bestätigungsschleife über die grössten Händler.
 *
 * Gruppiert nach Händler statt nach einzelner Buchung: Stufe 0 der
 * Kategorisierung schlägt über `merchant_normalized` nach. Ein bestätigter
 * Händler wirkt damit auf alle seine Buchungen — auch auf die des nächsten
 * Imports. Zehn Bestätigungen sind in einer Minute erledigt und decken
 * oft die halbe Liste ab; ein Formular über alle Buchungen bricht jeder ab.
 */
export default function OnboardingReview() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const refCcy = user?.currency ?? "CHF";

  const [picked, setPicked] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const { data: groups = [] } = useQuery({
    queryKey: ["onboarding-review"],
    queryFn: () => onboardingApi.review().then((r) => r.data),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list().then((r) => r.data as Category[]),
  });

  const options = useMemo(
    () => [...categories].sort((a, b) => a.name.localeCompare(b.name, "de")),
    [categories],
  );

  const confirmMut = useMutation({
    mutationFn: (entries: Array<{ merchant: string; category: string }>) =>
      onboardingApi.confirmReview(entries),
    onSuccess: () => {
      setDone(true);
      qc.invalidateQueries({ queryKey: ["onboarding-review"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  if (done) {
    return (
      <div className="card p-5 flex items-center gap-2 text-gain text-sm">
        <Check className="w-4 h-4" />
        {t("pages:onboarding.reviewDone")}
      </div>
    );
  }
  if (groups.length === 0) return null;

  function categoryFor(group: ReviewGroup): string {
    return picked[group.merchant] ?? group.category ?? "";
  }

  function submit() {
    const entries = groups
      .map((g) => ({ merchant: g.merchant, category: categoryFor(g) }))
      .filter((e) => e.category);
    confirmMut.mutate(entries);
  }

  return (
    <div className="card p-5">
      <h2 className="text-text-primary font-semibold text-sm mb-1">
        {t("pages:onboarding.reviewTitle")}
      </h2>
      <p className="text-text-secondary text-xs mb-4">
        {t("pages:onboarding.reviewBody")}
      </p>

      <div className="divide-y divide-border/40">
        {groups.map((group) => (
          <div key={group.merchant} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-text-primary text-sm truncate">{group.merchant}</p>
              <p className="text-text-tertiary text-[11px]">
                {t("pages:onboarding.reviewCount", { count: group.count })} ·{" "}
                {formatAmount(Math.abs(group.total), refCcy)}
              </p>
            </div>
            <select
              value={categoryFor(group)}
              onChange={(e) =>
                setPicked((prev) => ({ ...prev, [group.merchant]: e.target.value }))
              }
              aria-label={group.merchant}
              className="bg-bg-surface2 border border-border rounded-lg px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent max-w-[12rem]"
            >
              <option value="">{t("pages:onboarding.reviewNoCategory")}</option>
              {options.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={submit}
          disabled={confirmMut.isPending}
          className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent/90 text-white text-xs font-medium transition-colors disabled:opacity-50"
        >
          {confirmMut.isPending
            ? t("pages:onboarding.reviewSaving")
            : t("pages:onboarding.reviewConfirm")}
        </button>
        <button
          type="button"
          onClick={() => setDone(true)}
          className="text-text-tertiary text-xs hover:text-text-primary transition-colors"
        >
          {t("pages:onboarding.reviewSkip")}
        </button>
      </div>
    </div>
  );
}
