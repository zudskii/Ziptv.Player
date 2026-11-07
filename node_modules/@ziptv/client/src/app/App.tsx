import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router';
import { Toaster } from 'sonner';

import { AppShell } from '../components/layout/AppShell';
import { Spinner } from '../components/ui/Spinner';
import { queryClient } from '../lib/query-client';
import { PinDialog } from '../features/parental/PinDialog';
import { SessionGate } from '../features/session/SessionGate';
import { installThemeSync, resolveTheme, useThemeStore } from '../features/theme/theme-store';
import { HomePage } from '../pages/HomePage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { AuthPage } from '../pages/auth/AuthPage';
import { ForgotPasswordPage } from '../pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '../pages/auth/ResetPasswordPage';
import { VerifyEmailPage } from '../pages/auth/VerifyEmailPage';
import { OnboardingPage } from '../pages/onboarding/OnboardingPage';
import { WelcomePage } from '../pages/onboarding/WelcomePage';
import { PlaylistsPage } from '../pages/playlists/PlaylistsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { SourcesPage } from '../pages/SourcesPage';
import { t, useT } from '../i18n';

// Player-heavy screens are only downloaded when opened.
const LivePage = lazy(() => import('../pages/live/LivePage').then((module) => ({ default: module.LivePage })));
const GuidePage = lazy(() => import('../pages/guide/GuidePage').then((module) => ({ default: module.GuidePage })));
const PlaylistEditorPage = lazy(() => import('../pages/playlists/PlaylistEditorPage').then((module) => ({ default: module.PlaylistEditorPage })));
const VodBrowsePage = lazy(() => import('../pages/vod/VodBrowsePage').then((module) => ({ default: module.VodBrowsePage })));
const MovieDetailsPage = lazy(() => import('../pages/vod/MovieDetailsPage').then((module) => ({ default: module.MovieDetailsPage })));
const SeriesDetailsPage = lazy(() => import('../pages/vod/SeriesDetailsPage').then((module) => ({ default: module.SeriesDetailsPage })));
const PlayPage = lazy(() => import('../pages/PlayPage').then((module) => ({ default: module.PlayPage })));
const SearchPage = lazy(() => import('../pages/SearchPage').then((module) => ({ default: module.SearchPage })));
const MyListPage = lazy(() => import('../pages/MyListPage').then((module) => ({ default: module.MyListPage })));
const ChannelsPage = lazy(() => import('../pages/ChannelsPage').then((module) => ({ default: module.ChannelsPage })));
const PlansPage = lazy(() => import('../pages/billing/PlansPage').then((module) => ({ default: module.PlansPage })));
const AccountPage = lazy(() => import('../pages/billing/AccountPage').then((module) => ({ default: module.AccountPage })));
const BillingReturnPage = lazy(() => import('../pages/billing/BillingReturnPage').then((module) => ({ default: module.BillingReturnPage })));
const MultiViewPage = lazy(() => import('../pages/MultiViewPage').then((module) => ({ default: module.MultiViewPage })));
const FilmsPage = lazy(() => import('../pages/films/FilmsPage').then((module) => ({ default: module.FilmsPage })));
const FilmDetailsPage = lazy(() => import('../pages/films/FilmDetailsPage').then((module) => ({ default: module.FilmDetailsPage })));
const FilmPlayPage = lazy(() => import('../pages/films/FilmPlayPage').then((module) => ({ default: module.FilmPlayPage })));
const HistoryPage = lazy(() => import('../pages/HistoryPage').then((module) => ({ default: module.HistoryPage })));

export function App() {
  // Subscribing here re-renders the whole tree when the language changes.
  useT();
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
          {/* The front door for a device without a session; with one it sends straight back in. */}
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/setup" element={<Gate><OnboardingPage /></Gate>} />
          <Route element={<Gate><AppShell /></Gate>}>
            <Route index element={<HomePage />} />
            <Route path="live/:sourceId?/:channelKey?" element={<Lazy><LivePage /></Lazy>} />
            <Route path="channels/:channelId?" element={<Lazy><ChannelsPage /></Lazy>} />
            <Route path="guide/:sourceId?" element={<Lazy><GuidePage /></Lazy>} />
            <Route path="multiview" element={<Lazy><MultiViewPage /></Lazy>} />
            <Route path="movies/:sourceId?" element={<Lazy><VodBrowsePage key="movies" kind="movies" /></Lazy>} />
            <Route path="movies/:sourceId/:key" element={<Lazy><MovieDetailsPage /></Lazy>} />
            <Route path="series/:sourceId?" element={<Lazy><VodBrowsePage key="series" kind="series" /></Lazy>} />
            <Route path="series/:sourceId/:key" element={<Lazy><SeriesDetailsPage /></Lazy>} />
            <Route path="play/movie/:sourceId/:key" element={<Lazy><PlayPage type="movie" /></Lazy>} />
            <Route path="play/episode/:sourceId/:seriesKey/:key" element={<Lazy><PlayPage type="episode" /></Lazy>} />
            <Route path="my-list" element={<Lazy><MyListPage /></Lazy>} />
            <Route path="history" element={<Lazy><HistoryPage /></Lazy>} />
            <Route path="search" element={<Lazy><SearchPage /></Lazy>} />
            <Route path="playlists" element={<PlaylistsPage />} />
            <Route path="playlists/:playlistId" element={<Lazy><PlaylistEditorPage /></Lazy>} />
            <Route path="sources" element={<SourcesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="films" element={<Lazy><FilmsPage /></Lazy>} />
            <Route path="films/:id" element={<Lazy><FilmDetailsPage /></Lazy>} />
            <Route path="films/:id/play" element={<Lazy><FilmPlayPage /></Lazy>} />
            <Route path="plans" element={<Lazy><PlansPage /></Lazy>} />
            <Route path="account" element={<Lazy><AccountPage /></Lazy>} />
            <Route path="billing/return" element={<Lazy><BillingReturnPage /></Lazy>} />
          </Route>
          {/* 2.x / 1.x URLs (playlist ids are source ids since 3.0) */}
          <Route path="/watch/:playlistId?/:channelKey?" element={<LegacyWatchRedirect />} />
          <Route path="/tv/*" element={<Navigate to="/live" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
      <PinDialog />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}

function Gate({ children }: { children: ReactNode }) {
  return <SessionGate>{children}</SessionGate>;
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Spinner className="min-h-[50vh] justify-center" label={t('common.loading')} />}>{children}</Suspense>;
}

function LegacyWatchRedirect() {
  const { playlistId, channelKey } = useParams();
  return <Navigate to={`/live${playlistId ? `/${playlistId}` : ''}${channelKey ? `/${channelKey}` : ''}`} replace />;
}
