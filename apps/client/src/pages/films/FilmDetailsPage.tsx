import { ArrowLeft, Play, Sparkles } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';

import { Button, ButtonLink } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Img, Initials } from '../../components/ui/Img';
import { Spinner } from '../../components/ui/Spinner';
import { useOperatorVodDetail } from '../../features/operator/api';
import { errorMessage } from '../../lib/api-client';
import { imageSources } from '../../lib/images';
import { paths } from '../../lib/routes';
import { i18n, t } from '../../i18n';
import { AccessBadge } from './AccessBadge';

/** /films/:id — one operator title: what the plan says about it, then play (or the plans that open it). */
export function FilmDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const detail = useOperatorVodDetail(id);
  if (detail.isPending) return <Spinner label={t('films.loading')} />;
  if (detail.isError) return <EmptyState tone="error" title={t('films.loadFailed')} description={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />;
  const item = detail.data;
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <Link to={paths.films} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="h-4 w-4" aria-hidden /> {t('films.back')}
      </Link>
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-lg bg-fg/5 sm:w-52">
          <Img sources={imageSources(item.poster)} className="h-full w-full" fallback={<Initials name={item.title} className="text-3xl" />} />
        </div>
        <div className="min-w-0 space-y-3">
          <h1 className="text-2xl font-bold text-fg">{item.title}</h1>
          <p className="text-sm text-fg-muted">{[item.year, item.genres.join(', '), item.durationSecs ? t('films.minutes', { count: Math.round(item.durationSecs / 60) }) : null].filter(Boolean).join(' · ')}</p>
          <AccessBadge access={item.access} />
          {item.plot && <p className="max-w-prose text-sm text-fg">{item.plot}</p>}
          {item.access === 'included' && item.type === 'movie' && (
            <Button variant="primary" icon={<Play className="h-4 w-4" />} onClick={() => navigate(paths.playFilm(item.id))}>
              {t('films.play')}
            </Button>
          )}
          {item.access === 'upgrade' && (
            <div className="space-y-2 rounded-xl border border-line/10 bg-fg/5 p-3">
              <p className="text-sm text-fg">{t('films.inPlans', { names: i18n.formatList(item.plans.map((plan) => plan.name)) })}</p>
              <ButtonLink to="/plans" variant="primary" icon={<Sparkles className="h-4 w-4" />}>
                {t('films.seePlans')}
              </ButtonLink>
            </div>
          )}
          {item.access === 'unavailable' && <p className="text-sm text-fg-muted">{t('films.notSold')}</p>}
        </div>
      </div>
      {item.type === 'series' && (
        <section className="space-y-2" aria-label={t('films.episodes')}>
          <h2 className="font-semibold text-fg">{t('films.episodes')}</h2>
          <ul className="divide-y divide-line/10 rounded-xl border border-line/10">
            {item.episodes.map((episode) => (
              <li key={episode.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-16 shrink-0 text-xs tabular-nums text-fg-subtle">{t('vod.episodeCode', { season: episode.season, episode: episode.episode })}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{episode.title}</span>
                {item.access === 'included' && (
                  <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} onClick={() => navigate(paths.playFilm(item.id, episode.id))}>
                    {t('films.play')}
                  </Button>
                )}
              </li>
            ))}
            {item.episodes.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">{t('films.noEpisodes')}</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
