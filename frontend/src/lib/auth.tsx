/**
 * Auth context — provides isAuthenticated, user, login, logout.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { startAuthentication } from "@simplewebauthn/browser";

import { authApi, passkeysApi, setAuthToken, clearAuthToken, getAuthToken } from "./api";
import { useUiStore, type UiLanguage } from "./store";
import i18n from "@/i18n";

interface User {
  id: number;
  email: string;
  name: string;
  currency: string;
  locale: string;
  /** UI-Sprache ("de" | "en") — serverseitig in users.ui_language persistiert */
  ui_language?: string;
  retirement_age: number;
  /** ISO YYYY-MM-DD from GET /auth/me (alias of date_of_birth). */
  birthdate?: string | null;
  date_of_birth?: string | null;
  /** Referenz-SARON p.a. (%) — Einstellungen / Wizard */
  saron_reference_annual_pct?: number;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Anmeldung per Passkey — das Token kommt schon fertig vom Server. */
  loginWithPasskey: () => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await authApi.getMe();
      setUser(data);
      // UI-Sprache mit DB synchronisieren — die DB gewinnt (Cross-Device)
      const dbLang = data?.ui_language as UiLanguage | undefined;
      if (dbLang === "de" || dbLang === "en") {
        const store = useUiStore.getState();
        if (store.uiLanguage !== dbLang) store.setUiLanguage(dbLang);
        if (i18n.language !== dbLang) await i18n.changeLanguage(dbLang);
      }
    } catch {
      setUser(null);
      clearAuthToken();
    }
  }, []);

  useEffect(() => {
    const token = getAuthToken();
    if (token) {
      refreshUser().finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [refreshUser]);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await authApi.login({ email, password });
    setAuthToken(data.access_token);
    setUser({ id: data.user_id, email: data.email, name: data.name, currency: "CHF", locale: "de-CH", retirement_age: 65 });
    await refreshUser();
  }, [refreshUser]);

  const loginWithPasskey = useCallback(async () => {
    const options = JSON.parse((await passkeysApi.loginOptions()).data);
    // Der Browser waehlt den passenden Passkey und fuehrt die Ceremony
    const credential = await startAuthentication({ optionsJSON: options });
    const { data } = await passkeysApi.loginVerify(credential);
    setAuthToken(data.access_token);
    setUser({
      id: data.user_id, email: data.email, name: data.name,
      currency: "CHF", locale: "de-CH", retirement_age: 65,
    });
    await refreshUser();
  }, [refreshUser]);

  const logout = useCallback(() => {
    clearAuthToken();
    setUser(null);
    window.location.href = "/login";
  }, []);

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, login, loginWithPasskey, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
