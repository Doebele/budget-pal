import { Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";

import { AuthProvider, useAuth } from "@/lib/auth";
import { useUiStore } from "@/lib/store";
import Sidebar from "@/components/layout/Sidebar";
import BottomNav from "@/components/layout/BottomNav";
import LoadingScreen from "@/components/layout/LoadingScreen";

// ── UI-Attribute (Theme / Akzent / Density) ───────────────────
function UiAttributes() {
  const theme = useUiStore((s) => s.theme);
  const accent = useUiStore((s) => s.accent);
  const density = useUiStore((s) => s.density);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accent);
  }, [accent]);
  useEffect(() => {
    document.body.setAttribute("data-density", density);
  }, [density]);

  return null;
}

// ── Lazy loaded pages ─────────────────────────────────────────
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Transactions = lazy(() => import("@/pages/Transactions"));
const ArchivedTransactions = lazy(() => import("@/pages/ArchivedTransactions"));
const Budget = lazy(() => import("@/pages/Budget"));
const Projections = lazy(() => import("@/pages/Projections"));
const Import = lazy(() => import("@/pages/Import"));
const Accounts = lazy(() => import("@/pages/Accounts"));
const Settings = lazy(() => import("@/pages/Settings"));
const Login = lazy(() => import("@/pages/Login"));
const Register = lazy(() => import("@/pages/Register"));
const Wizard = lazy(() => import("@/pages/Wizard"));
const Forecast = lazy(() => import("@/pages/Forecast"));
const Finanzplan = lazy(() => import("@/pages/Finanzplan"));
const Budgetplan = lazy(() => import("@/pages/Budgetplan"));
const Goals = lazy(() => import("@/pages/Goals"));

// ── Protected Route ───────────────────────────────────────────
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

// ── App Shell (authenticated layout) ─────────────────────────
function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6 pb-20 md:pb-6">
        <Suspense fallback={<LoadingScreen />}>{children}</Suspense>
      </main>
      <BottomNav />
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <UiAttributes />
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={
            <Suspense fallback={<LoadingScreen />}>
              <Login />
            </Suspense>
          }
        />
        <Route
          path="/register"
          element={
            <Suspense fallback={<LoadingScreen />}>
              <Register />
            </Suspense>
          }
        />

        {/* Protected routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppShell>
                <Dashboard />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/transactions"
          element={
            <ProtectedRoute>
              <AppShell>
                <Transactions />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/transactions/archived"
          element={
            <ProtectedRoute>
              <AppShell>
                <ArchivedTransactions />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/budget"
          element={
            <ProtectedRoute>
              <AppShell>
                <Budget />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/projections"
          element={
            <ProtectedRoute>
              <AppShell>
                <Projections />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/forecast"
          element={
            <ProtectedRoute>
              <AppShell>
                <Forecast />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/import"
          element={
            <ProtectedRoute>
              <AppShell>
                <Import />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/accounts"
          element={
            <ProtectedRoute>
              <AppShell>
                <Accounts />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <AppShell>
                <Settings />
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/wizard"
          element={
            <ProtectedRoute>
              <AppShell>
                <Wizard />
              </AppShell>
            </ProtectedRoute>
          }
        />
        <Route
          path="/finanzplan"
          element={
            <ProtectedRoute>
              <AppShell>
                <Finanzplan />
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/budgetplan"
          element={
            <ProtectedRoute>
              <AppShell>
                <Budgetplan />
              </AppShell>
            </ProtectedRoute>
          }
        />

        <Route
          path="/goals"
          element={
            <ProtectedRoute>
              <AppShell>
                <Goals />
              </AppShell>
            </ProtectedRoute>
          }
        />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
