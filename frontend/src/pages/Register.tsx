import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { authApi, setAuthToken } from "@/lib/api";
import { Reports } from "@/lib/icons";

export default function Register() {
  const navigate = useNavigate();
  const { t } = useTranslation("auth");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data } = await authApi.register({ name, email, password });
      setAuthToken(data.access_token);
      navigate("/");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg || t("register.failed"));
    } finally {
      setLoading(false);
    }
  };

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
          <h1 className="text-text-primary font-semibold text-lg mb-6">{t("register.title")}</h1>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">{t("register.name")}</label>
              <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <label className="label">{t("register.email")}</label>
              <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label">{t("register.password")}</label>
              <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>

            {error && (
              <p className="text-loss text-sm bg-loss-muted border border-loss/30 rounded-lg px-3 py-2">{error}</p>
            )}

            <button type="submit" className="btn-primary w-full py-2.5" disabled={loading}>
              {loading ? t("register.loading") : t("register.submit")}
            </button>
          </form>

          <p className="text-text-tertiary text-sm mt-4 text-center">
            {t("register.hasAccount")}{" "}
            <Link to="/login" className="text-accent hover:text-accent-light">{t("register.loginLink")}</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
