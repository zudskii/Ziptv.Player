import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router';
import { Toaster } from 'sonner';

import { AppShell } from '../components/layout/AppShell';
import { Spinner } from '../components/ui/Spinner';
import { queryClient } from '../lib/query-client';
import { SessionGate } from '../features/session/SessionGate';
import { installThemeSync, resolveTheme, useThemeStore } from '../features/theme/theme-store';
import { HomePage } from '../pages/HomePage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { AuthPage } from '../pages/auth/AuthPage';
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage';
import { VerifyEmailPage } from '../pages/auth/VerifyEmailPage';
import { OnboardingPage } from '../pages/onboarding/OnboardingPage';
import { PlaylistsPage } from '../pages/playlists/PlaylistsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { SourcesPage } from '../pages/SourcesPage';

// Player-heavy screens are only downloaded when opened.
const LivePage = lazy(() => import('../pages/live/LivePage').then((module) => ({ default: module.LivePage })));
const GuidePage = lazy(() => import('../pages/guide/GuidePage').then((module) => ({ default: module.GuidePage })));
const PlaylistEditorPage = lazy(() => import('../pages/playlists/PlaylistEditorPage').then((module) => ({ default: module.PlaylistEditorPage })));

export function App() {
  useEffect(() => installThemeSync(), []);
  const theme = resolveTheme(useThemeStore((state) => state.preference));

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Sign-in pages live outside the gate: they must open without (or after losing) a session. */}
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          {/* Opened from emails, on devices that may have no session: no gate, and none is created. */}
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/welcome" element={<Gate><OnboardingPage /></Gate>} />
          <Route element={<Gate><AppShell /></Gate>}>
            <Route index element={<HomePage />} />
            <Route path="live/:sourceId?/:channelKey?" element={<Lazy><LivePage /></Lazy>} />
            <Route path="guide/:sourceId?" element={<Lazy><GuidePage /></Lazy>} />
            <Route path="playlists" element={<PlaylistsPage />} />
            <Route path="playlists/:playlistId" element={<Lazy><PlaylistEditorPage /></Lazy>} />
            <Route path="sources" element={<SourcesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          {/* 2.x / 1.x URLs (playlist ids are source ids since 3.0) */}
          <Route path="/watch/:playlistId?/:channelKey?" element={<LegacyWatchRedirect />} />
          <Route path="/tv/*" element={<Navigate to="/live" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return <SessionGate>{children}</SessionGate>;
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Spinner className="min-h-[50vh] justify-center" label="Loading…" />}>{children}</Suspense>;
}

function LegacyWatchRedirect() {
  const { playlistId, channelKey } = useParams();
  return <Navigate to={`/live${playlistId ? `/${playlistId}` : ''}${channelKey ? `/${channelKey}` : ''}`} replace />;
}
