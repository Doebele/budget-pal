/**
 * Rail — einklappbare Desktop-Navigation, portiert von application-pal.
 * Breiten 52/220px, Tooltips bei eingeklappter Rail (600ms Delay),
 * Footer mit Density-/Sprach-/Theme-Toggle und User-Block.
 */
import { useState, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  DashboardSpeed,
  Globe,
  HalfMoon,
  LogOut,
  Reports,
  SidebarCollapse,
  Sofa,
  SunLight,
} from "@/lib/icons";
import { useUiStore, type UiLanguage } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { authApi } from "@/lib/api";
import NotificationBell from "./NotificationBell";
import { NAV_ITEMS, SETTINGS_ITEM, isNavItemActive } from "./navItems";
import i18n from "@/i18n";
import deFlagUrl from "round-flag-icons/flags/de.svg?url";
import gbFlagUrl from "round-flag-icons/flags/gb.svg?url";

const RAIL_EXPANDED = 220;
const RAIL_COLLAPSED = 52;

function FlagIcon({ lang, size = 15 }: { lang: UiLanguage; size?: number }) {
  return (
    <img
      src={lang === "de" ? deFlagUrl : gbFlagUrl}
      width={size}
      height={size}
      style={{ borderRadius: "50%", display: "block", flexShrink: 0, objectFit: "cover" }}
      alt={lang}
    />
  );
}

// ── Tooltip bei eingeklappter Rail ────────────────────────────
function RailTooltip({ label, visible }: { label: string; visible: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        left: RAIL_COLLAPSED + 8,
        top: "50%",
        transform: "translateY(-50%)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "5px 10px",
        fontSize: 12,
        fontWeight: 600,
        color: "var(--fg-1)",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        zIndex: 200,
        boxShadow: "var(--shadow-card)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.12s ease",
      }}
    >
      {label}
    </div>
  );
}

// ── Einzelner Rail-Button ─────────────────────────────────────
function RailBtn({
  icon,
  label,
  active,
  onClick,
  open,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  open: boolean;
  badge?: string | number;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const handleMouseEnter = () => {
    if (!open) {
      timerRef.current = setTimeout(() => setTooltipVisible(true), 600);
    }
  };
  const handleMouseLeave = () => {
    setTooltipVisible(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        className={"rail-btn" + (active ? " active" : "")}
        onClick={onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{ justifyContent: open ? "flex-start" : "center" }}
        title={open ? undefined : label}
      >
        <span className="rail-icon">{icon}</span>
        {open && (
          <span
            className="rail-label"
            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {label}
          </span>
        )}
        {open && badge != null && <span className="rail-badge">{badge}</span>}
      </button>
      {!open && <RailTooltip label={label} visible={tooltipVisible} />}
    </div>
  );
}

// ── Abschnitts-Label ──────────────────────────────────────────
function RailSection({ label, open }: { label: string; open: boolean }) {
  if (!open) return null;
  return <div className="rail-section-label">{label}</div>;
}

// ── Haupt-Rail ────────────────────────────────────────────────
export default function Rail() {
  const { railOpen, toggleRail, theme, toggleTheme, density, toggleDensity, uiLanguage, setUiLanguage } =
    useUiStore();
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const location = useLocation();
  const [confirmLogout, setConfirmLogout] = useState(false);

  const changeLanguage = async (lang: UiLanguage) => {
    setUiLanguage(lang);
    await i18n.changeLanguage(lang);
    // DB-Persistenz — bewusst fire-and-forget, UI wechselt sofort
    try {
      await authApi.updateMe({ ui_language: lang });
    } catch {
      /* silent */
    }
  };

  const initials = user?.name?.charAt(0).toUpperCase() || "U";

  return (
    <aside
      className="rail hidden md:flex"
      style={{
        width: railOpen ? RAIL_EXPANDED : RAIL_COLLAPSED,
        transition: "width 0.22s cubic-bezier(0.4,0,0.2,1)",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* ── Header ── */}
      <div className="rail-header">
        {railOpen && (
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <div className="w-7 h-7 rounded-lg bg-gradient-accent flex items-center justify-center flex-shrink-0">
              <Reports width={14} height={14} className="text-white" />
            </div>
            <div
              className="font-display"
              style={{ overflow: "hidden", whiteSpace: "nowrap", fontSize: 15, fontWeight: 600 }}
            >
              <span style={{ color: "var(--fg-1)" }}>Budget</span>
              <span style={{ color: "var(--accent)" }}>Pal</span>
            </div>
            <div style={{ marginLeft: "auto" }}>
              <NotificationBell />
            </div>
          </div>
        )}
        <button
          className="rail-toggle-btn"
          onClick={toggleRail}
          title={railOpen ? t("rail.collapseSidebar") : t("rail.expandSidebar")}
          style={{ transform: railOpen ? "none" : "scaleX(-1)" }}
        >
          <SidebarCollapse width={15} height={15} />
        </button>
      </div>

      {/* ── Navigation ── */}
      <div className="rail-body">
        <RailSection label={t("nav.workspace")} open={railOpen} />
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.path}>
              <NavLink to={item.path} style={{ textDecoration: "none", display: "block", position: "relative" }}>
                <RailBtn
                  icon={<Icon width={15} height={15} />}
                  label={t(item.labelKey)}
                  active={isNavItemActive(location.pathname, item.path)}
                  open={railOpen}
                />
              </NavLink>
              {item.dividerAfter && <div className="rail-divider" />}
            </div>
          );
        })}
        <NavLink to={SETTINGS_ITEM.path} style={{ textDecoration: "none", display: "block", position: "relative" }}>
          <RailBtn
            icon={<SETTINGS_ITEM.icon width={15} height={15} />}
            label={t(SETTINGS_ITEM.labelKey)}
            active={isNavItemActive(location.pathname, SETTINGS_ITEM.path)}
            open={railOpen}
          />
        </NavLink>
      </div>

      {/* ── Footer ── */}
      <div className="rail-footer">
        {/* Density-Toggle */}
        {railOpen ? (
          <div className="rail-density-row">
            <button
              className={"rail-density-btn" + (density === "high" ? " active" : "")}
              onClick={() => density !== "high" && toggleDensity()}
              title={t("rail.highDensity")}
            >
              <DashboardSpeed width={13} height={13} />
              <span>{t("rail.highDensity")}</span>
            </button>
            <button
              className={"rail-density-btn" + (density === "low" ? " active" : "")}
              onClick={() => density !== "low" && toggleDensity()}
              title={t("rail.lowDensity")}
            >
              <Sofa width={13} height={13} />
              <span>{t("rail.lowDensity")}</span>
            </button>
          </div>
        ) : (
          <RailBtn
            icon={density === "high" ? <DashboardSpeed width={15} height={15} /> : <Sofa width={15} height={15} />}
            label={density === "high" ? t("rail.highDensity") : t("rail.lowDensity")}
            onClick={toggleDensity}
            open={false}
          />
        )}

        {/* Sprach-Toggle */}
        {railOpen ? (
          <div className="rail-lang-row">
            <button
              className={"rail-density-btn" + (uiLanguage === "de" ? " active" : "")}
              onClick={() => changeLanguage("de")}
              title={t("rail.languageGerman")}
            >
              <FlagIcon lang="de" size={13} />
              <span>DE</span>
            </button>
            <button
              className={"rail-density-btn" + (uiLanguage === "en" ? " active" : "")}
              onClick={() => changeLanguage("en")}
              title={t("rail.languageEnglish")}
            >
              <FlagIcon lang="en" size={13} />
              <span>EN</span>
            </button>
          </div>
        ) : (
          <RailBtn
            icon={<Globe width={15} height={15} />}
            label={uiLanguage.toUpperCase()}
            onClick={() => changeLanguage(uiLanguage === "de" ? "en" : "de")}
            open={false}
          />
        )}

        {/* Theme-Toggle */}
        {railOpen ? (
          <div className="rail-theme-row">
            <button
              className={"rail-density-btn" + (theme === "light" ? " active" : "")}
              onClick={() => theme !== "light" && toggleTheme()}
              title={t("rail.lightMode")}
            >
              <SunLight width={13} height={13} />
              <span>{t("rail.lightMode")}</span>
            </button>
            <button
              className={"rail-density-btn" + (theme === "dark" ? " active" : "")}
              onClick={() => theme !== "dark" && toggleTheme()}
              title={t("rail.darkMode")}
            >
              <HalfMoon width={13} height={13} />
              <span>{t("rail.darkMode")}</span>
            </button>
          </div>
        ) : (
          <RailBtn
            icon={theme === "dark" ? <HalfMoon width={15} height={15} /> : <SunLight width={15} height={15} />}
            label={theme === "dark" ? t("rail.darkMode") : t("rail.lightMode")}
            onClick={toggleTheme}
            open={false}
          />
        )}

        {/* User + Logout (zweistufige Bestätigung) */}
        {confirmLogout ? (
          <div
            style={{
              padding: "8px 8px 6px",
              borderRadius: 8,
              background: "rgba(248,113,113,0.07)",
              border: "1px solid rgba(248,113,113,0.2)",
              margin: "2px 0",
            }}
          >
            {railOpen && (
              <div style={{ fontSize: 11, color: "var(--fg-2)", lineHeight: 1.4, marginBottom: 8 }}>
                {t("user.confirmLogout")}
              </div>
            )}
            <div style={{ display: "flex", gap: 6, flexDirection: railOpen ? "row" : "column" }}>
              <button
                onClick={logout}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  borderRadius: 6,
                  border: "none",
                  background: "#ef4444",
                  color: "#fff",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 600,
                }}
                title={t("user.logout")}
              >
                {railOpen ? t("user.logout") : <LogOut width={13} height={13} style={{ margin: "0 auto" }} />}
              </button>
              <button
                onClick={() => setConfirmLogout(false)}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--fg-2)",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 500,
                }}
                title={t("buttons.cancel")}
              >
                {railOpen ? t("buttons.cancel") : "✕"}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="rail-user"
            onClick={() => setConfirmLogout(true)}
            style={{ cursor: "pointer", justifyContent: railOpen ? "flex-start" : "center" }}
            title={railOpen ? t("user.logout") : (user?.email ?? t("user.account"))}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: "var(--accent)",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                color: "#fff",
              }}
            >
              {initials}
            </div>
            {railOpen && (
              <>
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--fg-1)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {user?.name ?? t("user.account")}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--fg-3)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {user?.email}
                  </div>
                </div>
                <LogOut width={14} height={14} style={{ color: "var(--fg-3)", flexShrink: 0 }} />
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
