import type { ContentRefDto } from '@ziptv/contracts';
import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { IconButton } from '../../components/ui/Button';
import { VideoPlayer } from '../../features/player/components/VideoPlayer';
import { useOperatorVodDetail } from '../../features/operator/api';
import { paths } from '../../lib/routes';
import { t } from '../../i18n';

/** /films/:id/play[?episode=] — an operator film or episode (the server checks the plan on every plan request). */
export function FilmPlayPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const episodeId = params.get('episode') ?? undefined;
  const navigate = useNavigate();
  const detail = useOperatorVodDetail(id);
  const content = useMemo<ContentRefDto | undefined>(() => (id ? { type: 'operator_vod', vodId: id, ...(episodeId ? { episodeId } : {}) } : undefined), [id, episodeId]);
  const episode = detail.data?.episodes.find((candidate) => candidate.id === episodeId);
  const title = episode?.title ?? detail.data?.title ?? t('kind.movie');
  const subtitle = episode && detail.data ? `${detail.data.title} · ${t('vod.episodeCode', { season: episode.season, episode: episode.episode })}` : detail.data?.year ? String(detail.data.year) : null;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-2 sm:p-4">
      <div className="flex items-center gap-2">
        <IconButton label={t('kind.back')} onClick={() => navigate(id ? paths.film(id) : paths.films)}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-fg">{title}</h1>
          {subtitle && <p className="truncate text-sm text-fg-muted">{subtitle}</p>}
        </div>
      </div>
      <VideoPlayer content={content} title={title} />
    </div>
  );
}
