/**
 * BottomNav — Mobile-only bottom tab bar (visible on screens < md).
 * Shows the 5 most important destinations. Replaces the hamburger menu
 * for primary navigation on small screens.
 */
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ArrowLeftRight,
  PiggyBank,
  TrendingUp,
  Settings,
} from "lucide-react";
import { clsx } from "clsx";

const BOTTOM_NAV_ITEMS = [
  { path: "/",             icon: LayoutDashboard, label: "Übersicht" },
  { path: "/transactions", icon: ArrowLeftRight,  label: "Transakt." },
  { path: "/budget",       icon: PiggyBank,       label: "Budget" },
  { path: "/projections",  icon: TrendingUp,      label: "Prognose" },
  { path: "/settings",     icon: Settings,        label: "Einstellungen" },
] as const;

export default function BottomNav() {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    if (path === "/transactions") return location.pathname === "/transactions";
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-bg-surface border-t border-border/50 safe-area-pb">
      <div className="flex items-stretch h-16">
        {BOTTOM_NAV_ITEMS.map(({ path, icon: Icon, label }) => {
          const active = isActive(path);
          return (
            <NavLink
              key={path}
              to={path}
              className={clsx(
                "flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
                active
                  ? "text-accent"
                  : "text-text-tertiary hover:text-text-secondary"
              )}
            >
              <Icon
                className={clsx(
                  "w-5 h-5 transition-transform",
                  active && "scale-110"
                )}
              />
              <span className="leading-none">{label}</span>
              {active && (
                <span className="absolute top-0 w-8 h-0.5 bg-accent rounded-full" />
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
