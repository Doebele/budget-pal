import { useTranslation } from "react-i18next";

export default function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center min-h-screen bg-bg">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        <p className="text-text-tertiary text-sm">{t("common.loading")}</p>
      </div>
    </div>
  );
}
