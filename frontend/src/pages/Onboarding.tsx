/**
 * Onboarding — der Einstieg nach der Registrierung.
 *
 * Vorher stand hier der achtstufige Wizard mit ueber 50 Feldern, bevor die
 * App irgendetwas zeigte. Jetzt zwei Wege:
 *
 *   1. Kontoauszug hochladen — echte Zahlen, braucht die Unterlagen
 *   2. Beispieldaten laden   — anonym, sofort, nichts preisgegeben
 *
 * Der zweite Weg ist kein Spielzeug: wer die App noch nicht kennt, gibt ihr
 * keine Kontoauszuege. Erst sehen, dann vertrauen.
 */
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

import { onboardingApi, type OnboardingStatus } from "@/lib/api";
import { Flask, Reports, Trash, Upload } from "@/lib/icons";

export default function Onboarding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => onboardingApi.status().then((r) => r.data as OnboardingStatus),
  });

  const demoMut = useMutation({
    mutationFn: () => onboardingApi.loadDemo(),
    onSuccess: () => {
      // Alles neu ziehen — die Seiten haengen an Konten und Transaktionen.
      qc.invalidateQueries();
      navigate("/");
    },
  });

  const removeMut = useMutation({
    mutationFn: () => onboardingApi.removeDemo(),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <div className="min-h-full flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-10">
          <div className="w-12 h-12 rounded-xl bg-accent/15 flex items-center justify-center mx-auto mb-4">
            <Reports className="w-6 h-6 text-accent" />
          </div>
          <h1 className="font-display text-2xl font-semibold text-text-primary mb-2">
            {t("pages:onboarding.title")}
          </h1>
          <p className="text-text-secondary text-sm max-w-lg mx-auto">
            {t("pages:onboarding.subtitle")}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Weg 1 — echte Daten */}
          <button
            type="button"
            onClick={() => navigate("/import")}
            className={clsx(
              "text-left p-5 rounded-2xl border border-border bg-bg-surface",
              "hover:border-accent/60 hover:bg-bg-surface2 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <div className="w-9 h-9 rounded-lg bg-accent/15 flex items-center justify-center mb-3">
              <Upload className="w-4 h-4 text-accent" />
            </div>
            <h2 className="text-text-primary font-semibold text-sm mb-1.5">
              {t("pages:onboarding.importTitle")}
            </h2>
            <p className="text-text-secondary text-xs leading-relaxed">
              {t("pages:onboarding.importBody")}
            </p>
          </button>

          {/* Weg 2 — Beispieldaten */}
          <div
            className={clsx(
              "p-5 rounded-2xl border bg-bg-surface",
              status?.is_demo ? "border-accent/60" : "border-border",
            )}
          >
            <div className="w-9 h-9 rounded-lg bg-purple/15 flex items-center justify-center mb-3">
              <Flask className="w-4 h-4 text-purple" />
            </div>
            <h2 className="text-text-primary font-semibold text-sm mb-1.5">
              {t("pages:onboarding.demoTitle")}
            </h2>
            <p className="text-text-secondary text-xs leading-relaxed mb-4">
              {t("pages:onboarding.demoBody")}
            </p>

            {status?.is_demo ? (
              <div className="space-y-2">
                <p className="text-xs text-gain">
                  {t("pages:onboarding.demoLoaded", { count: status.transaction_count })}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => navigate("/")}
                    className="px-3 py-1.5 rounded-lg bg-accent hover:bg-accent/90 text-white text-xs font-medium transition-colors"
                  >
                    {t("pages:onboarding.toDashboard")}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeMut.mutate()}
                    disabled={removeMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-loss/40 text-loss hover:bg-loss/10 text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    <Trash className="w-3.5 h-3.5" />
                    {t("pages:onboarding.removeDemo")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => demoMut.mutate()}
                disabled={demoMut.isPending}
                className="px-3 py-1.5 rounded-lg bg-purple hover:bg-purple/90 text-white text-xs font-medium transition-colors disabled:opacity-50"
              >
                {demoMut.isPending
                  ? t("pages:onboarding.loading")
                  : t("pages:onboarding.loadDemo")}
              </button>
            )}
          </div>
        </div>

        {/* Der Wizard bleibt — aber als Angebot, nicht als Huerde. */}
        <p className="text-center text-text-tertiary text-xs mt-8">
          {t("pages:onboarding.wizardHint")}{" "}
          <button
            type="button"
            onClick={() => navigate("/wizard")}
            className="text-accent underline hover:no-underline"
          >
            {t("pages:onboarding.wizardLink")}
          </button>
        </p>

        {status?.has_transactions && (
          <p className="text-center mt-3">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="text-text-tertiary text-xs hover:text-text-primary transition-colors"
            >
              {t("pages:onboarding.skip")}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
