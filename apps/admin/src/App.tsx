import type { StaffPermission } from '@ziptv/contracts';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AuditPage } from './pages/AuditPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { StaffPage } from './pages/StaffPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';

function RequireSession({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.mustChangePassword && location.pathname !== '/password') return <Navigate to="/password" replace />;
  return <>{children}</>;
}

function Allowed({ permission, children }: { permission: StaffPermission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) return <p className="card p-6 text-sm text-fg-muted">Your role does not include this section.</p>;
  return <>{children}</>;
}

export function App() {
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
