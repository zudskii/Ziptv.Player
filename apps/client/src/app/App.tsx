import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router';
import { Toaster } from 'sonner';

import { AppShell } from '../components/layout/AppShell';
import { Spinner } from '../components/ui/Spinner';
import { ApiError } from '../lib/api-client';
import { SessionGate } from '../features/session/SessionGate';
import { installThemeSync, resolveTheme, useThemeStore } from '../features/theme/theme-store';
import { HomePage } from '../pages/HomePage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { OnboardingPage } from '../pages/onboarding/OnboardingPage';
import { SettingsPage } from '../pages/SettingsPage';
import { SourcesPage } from '../pages/SourcesPage';

// Player-heavy screens are only downloaded when opened.
const LivePage = lazy(() => import('../pages/live/LivePage').then((module) => ({ default: module.LivePage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Retrying 4xx never helps (not found, validation...); network/5xx may.
      retry: (failureCount, error) => failureCount < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

export function App() {
  useEffect(() => installThemeSync(), []);
  const theme = resolveTheme(useThemeStore((state) => state.preference));

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/welcome" element={<Gate><OnboardingPage /></Gate>} />
          <Route element={<Gate><AppShell /></Gate>}>
            <Route index element={<HomePage />} />
            <Route path="live/:sourceId?/:channelKey?" element={<Lazy><LivePage /></Lazy>} />
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
