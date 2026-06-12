/**
 * Gemeinsame Navigations-Konfiguration für Rail (Desktop),
 * MobileDrawer (Hamburger) und BottomNav (Mobile-Tabs).
 * Labels sind i18n-Schlüssel im "common"-Namespace.
 */
import {
  Archive,
  Brain,
  Calendar,
  DashboardDots,
  DataTransferBoth,
  GraphUp,
  MagicWand,
  PiggyBank,
  Position,
  Settings,
  StatsReport,
  Upload,
  Wallet,
  type IconComponent,
} from "@/lib/icons";

export type NavItem = {
  path: string;
  icon: IconComponent;
  /** i18n-Schlüssel, z. B. "nav.dashboard" */
  labelKey: string;
  dividerAfter?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { path: "/", icon: DashboardDots, labelKey: "nav.dashboard" },
  { path: "/finanzplan", icon: StatsReport, labelKey: "nav.finanzplan" },
  { path: "/budget", icon: PiggyBank, labelKey: "nav.budget" },
  { path: "/budgetplan", icon: Calendar, labelKey: "nav.budgetplan" },
  { path: "/goals", icon: Position, labelKey: "nav.goals" },
  { path: "/forecast", icon: Brain, labelKey: "nav.forecast" },
  { path: "/projections", icon: GraphUp, labelKey: "nav.projections", dividerAfter: true },
  { path: "/wizard", icon: MagicWand, labelKey: "nav.wizard" },
  { path: "/transactions", icon: DataTransferBoth, labelKey: "nav.transactions" },
  { path: "/import", icon: Upload, labelKey: "nav.import" },
  { path: "/accounts", icon: Wallet, labelKey: "nav.accounts" },
  { path: "/transactions/archived", icon: Archive, labelKey: "nav.archive" },
];

export const SETTINGS_ITEM: NavItem = {
  path: "/settings",
  icon: Settings,
  labelKey: "nav.settings",
};

/** Aktiv-Logik — exakte Matches für "/" und "/transactions" (wegen /transactions/archived). */
export function isNavItemActive(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/";
  if (path === "/transactions") return pathname === "/transactions";
  return pathname === path || pathname.startsWith(`${path}/`);
}
