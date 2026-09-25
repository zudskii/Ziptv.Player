import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Toaster } from 'sonner';

import { Spinner } from '../components/ui/Spinner';
import { ApiError } from '../lib/api-client';
import { SessionGate } from '../features/session/SessionGate';
import { HomePage } from '../pages/HomePage';
import { NotFoundPage } from '../pages/NotFoundPage';

// The player (and its hooks/virtual list) is only downloaded when someone opens it.
const WatchPage = lazy(() => import('../pages/watch/WatchPage').then((module) => ({ default: module.WatchPage })));

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
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/watch/:playlistId?/:channelKey?"
            element={
              <SessionGate>
                <Suspense fallback={<Spinner className="min-h-dvh justify-center" label="Loading player…" />}>
                  <WatchPage />
                </Suspense>
              </SessionGate>
            }
          />
          {/* 1.x URLs */}
          <Route path="/tv/*" element={<Navigate to="/watch" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
