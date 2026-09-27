import { useTranslation } from "react-i18next";

/** Farbe der Vergleichslinie "Median Schweiz" in allen Vermoegensdiagrammen. */
export const PEER_COLOR = "#f472b6";

/** Median des freien Vermoegens im selben Alter in Tausend CHF, null = keiner. */
export const peerK = (series: (number | null)[] | undefined, i: number) => {
  const v = series?.[i];
  return v == null ? null : Math.round(v / 1000);
};

/**
 * Schalter fuer die Vergleichslinie. Die Werte rechnet das Backend
 * (services/swiss_medians.py): Steuerdaten Kanton Luzern 2020 als Naeherung —
 * eine schweizweite Statistik nach Alter gibt es nicht.
 */
export default function PeerCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer" title={t("pages:peer.hint")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />
      {t("pages:peer.toggle")}
    </label>
  );
}
