import type { SourceDto } from '@ziptv/contracts';
import { Plus, Server } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import { Button } from '../../components/ui/Button';
import { FullscreenMessage } from '../../components/ui/FullscreenMessage';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api-client';
import { usePlayerPrefs } from '../../features/player/player-prefs';
import { useSources } from '../../features/sources/api';
import { SourceProblemNotice } from '../../features/sources/components/SourceProblemNotice';
import { SyncProgress } from '../../features/sources/components/SyncProgress';
import { LiveWorkspace } from './LiveWorkspace';

/** /live[/:sourceId[/:channelKey]] — picks the source; the channel UI lives in LiveWorkspace. */
export function LivePage() {
  const { sourceId, channelKey } = useParams();
  const navigate = useNavigate();
  const sourcesQuery = useSources();
  const activeSourceId = usePlayerPrefs((state) => state.activeSourceId);
  const setActiveSource = usePlayerPrefs((state) => state.setActiveSource);

  const sources = sourcesQuery.data ?? [];
  const withLive = sources.filter((source) => source.stats.live > 0 || source.revision === 0);
  const source = pickSource(withLive, sourceId, activeSourceId);

  // Keep the URL canonical (/live → /live/:id[/:lastChannel]) and remember the choice.
  useEffect(() => {
    if (!source) return;
    if (source.id !== activeSourceId) setActiveSource(source.id);
    if (source.id !== sourceId) {
      const resume = usePlayerPrefs.getState().lastChannel[source.id];
      navigate(`/live/${source.id}${resume ? `/${resume}` : ''}`, { replace: true });
    }
  }, [source, sourceId, activeSourceId, setActiveSource, navigate]);

  if (sourcesQuery.isPending) return <Spinner className="py-24" label="Loading your sources…" />;
  if (sourcesQuery.isError) {
    return <FullscreenMessage tone="error" title="Couldn't load your sources" description={errorMessage(sourcesQuery.error)} action={{ label: 'Try again', onClick: () => void sourcesQuery.refetch() }} />;
  }
  if (sources.length === 0) return <Navigate to="/welcome" replace />;
  if (!source) {
    return (
      <FullscreenMessage title="No live channels yet" description="None of your sources has live channels. Add an M3U playlist or an Xtream account." icon={<Server className="h-7 w-7" />}>
        <Link to="/sources" className="mt-6">
          <Button variant="primary" icon={<Plus className="h-4 w-4" />}>
            Add a source
          </Button>
        </Link>
      </FullscreenMessage>
    );
  }

  if (source.revision === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-lg font-semibold text-fg">{source.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">ZIPTV is reading this source for the first time.</p>
        {source.sync.status === 'failed' ? <div className="mt-6"><SourceProblemNotice source={source} /></div> : <SyncProgress source={source} className="mt-6" />}
      </div>
    );
  }

  return (
    <LiveWorkspace
      key={source.id}
      source={source}
      sources={withLive}
      channelKey={source.id === sourceId ? channelKey : undefined}
      onSelectSource={(id) => {
        const resume = usePlayerPrefs.getState().lastChannel[id];
        navigate(`/live/${id}${resume ? `/${resume}` : ''}`);
      }}
    />
  );
}

function pickSource(sources: SourceDto[], fromUrl: string | undefined, remembered: string | null): SourceDto | undefined {
  return sources.find((s) => s.id === fromUrl) ?? sources.find((s) => s.id === remembered) ?? sources.find((s) => s.revision > 0) ?? sources[0];
}
