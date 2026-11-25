import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { AppStateProvider, useAppState } from '@/state/AppState';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loading } from '@/components/ui';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useProfile } from '@/hooks/useFinance';
import { LoginPage } from '@/pages/LoginPage';
import { SetupMissingPage } from '@/pages/SetupMissingPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { SimpleHome } from '@/pages/simple/SimpleHome';
import { SimpleMovements } from '@/pages/simple/SimpleMovements';
import { DashboardPage } from '@/pages/normal/DashboardPage';
import { JournalPage } from '@/pages/normal/JournalPage';
import { IncomeStatementPage } from '@/pages/normal/IncomeStatementPage';
import { CreditCardPage } from '@/pages/normal/CreditCardPage';
import { RecurringPage } from '@/pages/normal/RecurringPage';
import { GoalsPage } from '@/pages/normal/GoalsPage';
import { SimulatorPage } from '@/pages/normal/SimulatorPage';
import { ReconcilePage } from '@/pages/normal/ReconcilePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { GuidePage } from '@/pages/GuidePage';
import { AdvisorPage } from '@/pages/AdvisorPage';
import { BankConnectionsPage } from '@/pages/normal/BankConnectionsPage';

// PDF y Excel cargan librerías pesadas: se cargan solo al entrar a esas páginas.
const ImportPage = lazy(() => import('@/pages/normal/ImportPage'));
const ExportPage = lazy(() => import('@/pages/normal/ExportPage'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

function Home() {
  const { mode } = useAppState();
  return <Navigate to={mode === 'simple' ? '/simple' : '/dashboard'} replace />;
}

function Protected() {
  const { user, loading } = useAuth();
  const profile = useProfile();
  if (loading) return <Loading label="Verificando sesión…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (profile.isLoading) return <Loading />;
  if (profile.data && !profile.data.onboardingCompletedAt) return <Navigate to="/bienvenida" replace />;
  return <AppLayout />;
}

function RoutesTree() {
  const { user, loading } = useAuth();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={!loading && user ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/bienvenida" element={user ? <OnboardingPage /> : <Navigate to="/login" replace />} />
        <Route element={<Protected />}>
          <Route index element={<Home />} />
          <Route path="/simple" element={<SimpleHome />} />
          <Route path="/simple/movimientos" element={<SimpleMovements />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/diario" element={<JournalPage />} />
          <Route path="/resultados" element={<IncomeStatementPage />} />
          <Route path="/tarjeta" element={<CreditCardPage />} />
          <Route path="/recurrentes" element={<RecurringPage />} />
          <Route path="/metas" element={<GoalsPage />} />
          <Route path="/simulador" element={<SimulatorPage />} />
          <Route path="/conciliar" element={<ReconcilePage />} />
          <Route path="/importar" element={<ImportPage />} />
          <Route path="/bancos" element={<BankConnectionsPage />} />
          <Route path="/exportar" element={<ExportPage />} />
          <Route path="/asesor" element={<AdvisorPage />} />
          <Route path="/ajustes" element={<SettingsPage />} />
          <Route path="/guia" element={<GuidePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  if (!isSupabaseConfigured) return <SetupMissingPage />;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppStateProvider>
          <BrowserRouter>
            <RoutesTree />
          </BrowserRouter>
        </AppStateProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
