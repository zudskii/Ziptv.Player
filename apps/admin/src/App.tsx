import type { StaffPermission } from '@ziptv/contracts';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { AuditPage } from './pages/AuditPage';
import { ChannelDetailPage } from './pages/ChannelDetailPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { EpgPage } from './pages/EpgPage';
import { FinancePage } from './pages/FinancePage';
import { MonitoringPage } from './pages/MonitoringPage';
import { PackageDetailPage, PackagesPage } from './pages/PackagesPage';
import { ProviderDetailPage, ProvidersPage } from './pages/ProvidersPage';
import { SupportPage } from './pages/SupportPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { StaffPage } from './pages/StaffPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';
import { t, useT } from './i18n';

function RequireSession({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label={t('common.checkingSession')} />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.mustChangePassword && location.pathname !== '/password') return <Navigate to="/password" replace />;
  return <>{children}</>;
}

function Allowed({ permission, children }: { permission: StaffPermission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) return <p className="card p-6 text-sm text-fg-muted">{t('common.noAccess')}</p>;
  return <>{children}</>;
}

export function App() {
  // Subscribing here re-renders the console when the language changes.
  useT();
  const { me } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        element={
          <RequireSession>
            <Layout />
          </RequireSession>
        }
      >
        <Route index element={<Allowed permission="system:read"><OverviewPage /></Allowed>} />
        <Route path="approvals" element={<Allowed permission="system:read"><ApprovalsPage /></Allowed>} />
        <Route path="monitoring" element={<Allowed permission="monitoring:read"><MonitoringPage /></Allowed>} />
        <Route path="channels" element={<Allowed permission="catalog:read"><ChannelsPage /></Allowed>} />
        <Route path="channels/:channelId" element={<Allowed permission="catalog:read"><ChannelDetailPage /></Allowed>} />
        <Route path="providers" element={<Allowed permission="providers:read"><ProvidersPage /></Allowed>} />
        <Route path="providers/:providerId" element={<Allowed permission="providers:read"><ProviderDetailPage /></Allowed>} />
        <Route path="epg" element={<Allowed permission="catalog:read"><EpgPage /></Allowed>} />
        <Route path="packages" element={<Allowed permission="billing:read"><PackagesPage /></Allowed>} />
        <Route path="packages/:packageId" element={<Allowed permission="billing:read"><PackageDetailPage /></Allowed>} />
        <Route path="support" element={<Allowed permission="support:read"><SupportPage /></Allowed>} />
        <Route path="finance" element={<Allowed permission="billing:read"><FinancePage /></Allowed>} />
        <Route path="users" element={<Allowed permission="users:read"><UsersPage /></Allowed>} />
        <Route path="users/:userId" element={<Allowed permission="users:read"><UserDetailPage /></Allowed>} />
        <Route path="staff" element={<Allowed permission="staff:read"><StaffPage /></Allowed>} />
        <Route path="audit" element={<Allowed permission="audit:read"><AuditPage /></Allowed>} />
        <Route path="password" element={<ChangePasswordPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
