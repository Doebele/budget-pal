/**
 * MobileDrawer — Hamburger-Navigation für Screens < md
 * (aus der früheren Sidebar extrahiert; nutzt die gemeinsame NAV_ITEMS-Quelle).
 */
import { Fragment, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogOut, Menu, Reports, Xmark } from "@/lib/icons";
import { useAuth } from "@/lib/auth";
import { clsx } from "clsx";
import NotificationBell from "./NotificationBell";
import { NAV_ITEMS, SETTINGS_ITEM, isNavItemActive } from "./navItems";

export default function MobileDrawer() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const drawerContent = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-border/50">
        <div className="w-8 h-8 rounded-lg bg-gradient-accent flex items-center justify-center flex-shrink-0">
          <Reports className="w-4 h-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-display text-text-primary font-semibold text-base leading-tight">Budget</span>
          <span className="font-display text-accent font-semibold text-base leading-tight">Pal</span>
        </div>
        <NotificationBell />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto scrollbar-hide">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <Fragment key={item.path}>
              <NavLink
                to={item.path}
                onClick={() => setOpen(false)}
                className={clsx(
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150",
                  isNavItemActive(location.pathname, item.path)
                    ? "bg-accent/15 text-accent"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-surface2"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span>{t(item.labelKey)}</span>
              </NavLink>
              {item.dividerAfter && (
                <div role="separator" aria-hidden className="my-2 mx-1 border-t border-border/50" />
              )}
            </Fragment>
          );
        })}
      </nav>

      {/* Einstellungen + User */}
      <div className="px-2 py-2 border-t border-border/50 space-y-1">
        <NavLink
          to={SETTINGS_ITEM.path}
          onClick={() => setOpen(false)}
          className={clsx(
            "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-150",
            isNavItemActive(location.pathname, SETTINGS_ITEM.path)
              ? "bg-accent/15 text-accent"
              : "text-text-secondary hover:text-text-primary hover:bg-bg-surface2"
          )}
        >
          <SETTINGS_ITEM.icon className="w-4 h-4 flex-shrink-0" />
          <span>{t(SETTINGS_ITEM.labelKey)}</span>
        </NavLink>

        <div className="flex items-center gap-3 px-3 py-2.5 mt-1">
          <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center flex-shrink-0">
            <span className="text-accent text-xs font-semibold">
              {user?.name?.charAt(0).toUpperCase() || "U"}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-text-primary text-xs font-medium truncate">{user?.name}</p>
            <p className="text-text-tertiary text-xs truncate">{user?.email}</p>
          </div>
          <button
            onClick={logout}
            className="text-text-tertiary hover:text-loss transition-colors"
            title={t("user.logout")}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Hamburger-Button */}
      <button
        className="md:hidden fixed top-3 right-3 z-50 p-2 bg-bg-surface/90 backdrop-blur rounded-lg border border-border/60 shadow-sm"
        onClick={() => setOpen(!open)}
        aria-label={open ? t("common.closeMenu") : t("common.openMenu")}
      >
        {open ? (
          <Xmark className="w-4 h-4 text-text-primary" />
        ) : (
          <Menu className="w-4 h-4 text-text-primary" />
        )}
      </button>

      {/* Overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 bg-black/60 z-40" onClick={() => setOpen(false)} />
      )}

      {/* Drawer */}
      <div
        className={clsx(
          "md:hidden fixed inset-y-0 left-0 z-50 w-64 bg-bg-surface border-r border-border/50 transform transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {drawerContent}
      </div>
    </>
  );
}
