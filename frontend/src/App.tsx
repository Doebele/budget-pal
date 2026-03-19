import { Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy } from "react";

import { AuthProvider, useAuth } from "@/lib/auth";
import Sidebar from "@/components/layout/Sidebar";
import LoadingScreen from "@/components/layout/LoadingScreen";

// ── Lazy loaded pages ─────────────────────────────────────────
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Transactions = lazy(() => import("@/pages/Transactions"));
const Budget = lazy(() => import("@/pages/Budget"));
const Projections = lazy(() => import("@/pages/Projections"));
const Import = lazy(() => import("@/pages/Import"));
const Accounts = lazy(() => import("@/pages/Accounts"));
const Settings = lazy(() => import("@/pages/Settings"));
const Login = lazy(() => import("@/pages/Login"));
const Register = lazy(() => import("@/pages/Register"));
const Wizard = lazy(() => import("@/pages/Wizard"));

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
      <main className="flex-1 overflow-y-auto">
        <div className="min-h-full p-6">
          <Suspense fallback={<LoadingScreen />}>{children}</Suspense>
        </div>
      </main>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
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

        {/* Wizard — full-page, no sidebar */}
        <Route
          path="/wizard"
          element={
            <ProtectedRoute>
              <Suspense fallback={<LoadingScreen />}>
                <Wizard />
              </Suspense>
            </ProtectedRoute>
          }
        />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
