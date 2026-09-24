import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { authApi } from "@/lib/api";
import { Reports } from "@/lib/icons";

/**
 * "Passwort vergessen" und "Neues Passwort setzen" — beide oeffentlich.
 * Das Token kommt im URL-Fragment (#token=…): der Browser schickt es an
 * keinen Server, es steht also in keinem Zugriffslog und keinem Referer.
 */

const MIN_LENGTH = 8;

function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-accent flex items-center justify-center">
            <Reports className="w-5 h-5 text-white" />
          </div>
          <span className="font-display text-2xl text-text-primary">
            Budget<span className="text-accent">Pal</span>
          </span>
        </div>
        <div className="card">
          <h1 className="text-text-primary font-semibold text-lg mb-4">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "ok"; children: React.ReactNode }) {
  const cls =
    tone === "error"
      ? "text-loss bg-loss-muted border-loss/30"
      : "text-gain bg-gain-muted border-gain/30";
  return <p className={`text-sm border rounded-lg px-3 py-2 ${cls}`}>{children}</p>;
}

export function ForgotPassword() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await authApi.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(statusOf(err) === 429 ? t("forgot.tooMany") : t("forgot.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Shell title={t("forgot.title")}>
      {sent ? (
        <Notice tone="ok">{t("forgot.sent")}</Notice>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-text-secondary text-sm">{t("forgot.intro")}</p>
          <div>
            <label className="label">{t("forgot.email")}</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className="btn-primary w-full py-2.5" disabled={loading}>
            {loading ? t("forgot.loading") : t("forgot.submit")}
          </button>
        </form>
      )}
      <p className="text-text-tertiary text-sm mt-4 text-center">
        <Link to="/login" className="text-accent hover:text-accent-light">
          {t("forgot.back")}
        </Link>
      </p>
    </Shell>
  );
}

export function ResetPassword() {
  const { t } = useTranslation("auth");
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<"form" | "done" | "invalid">(token ? "form" : "invalid");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < MIN_LENGTH) return setError(t("reset.tooShort"));
    if (password !== confirm) return setError(t("reset.mismatch"));
    setLoading(true);
    try {
      await authApi.resetPassword(token, password);
      // Token aus der Adresszeile und dem Verlauf nehmen — es ist verbraucht
      window.history.replaceState(null, "", window.location.pathname);
      setState("done");
    } catch (err) {
      const status = statusOf(err);
      if (status === 400) setState("invalid");
      else setError(status === 429 ? t("reset.tooMany") : t("reset.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Shell title={t("reset.title")}>
      {state === "done" && (
        <div className="space-y-4">
          <Notice tone="ok">{t("reset.done")}</Notice>
          <Link to="/login" className="btn-primary w-full py-2.5 block text-center">
            {t("reset.toLogin")}
          </Link>
        </div>
      )}
      {state === "invalid" && (
        <div className="space-y-4">
          <Notice tone="error">{t("reset.invalid")}</Notice>
          <Link to="/forgot-password" className="btn-primary w-full py-2.5 block text-center">
            {t("reset.requestNew")}
          </Link>
        </div>
      )}
      {state === "form" && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">{t("reset.password")}</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_LENGTH}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="label">{t("reset.confirm")}</label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className="btn-primary w-full py-2.5" disabled={loading}>
            {loading ? t("reset.loading") : t("reset.submit")}
          </button>
        </form>
      )}
    </Shell>
  );
}
