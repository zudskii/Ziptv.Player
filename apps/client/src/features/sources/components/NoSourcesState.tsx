import { Clapperboard, Home, LayoutGrid, MonitorPlay, Plus, RadioTower, Tv } from 'lucide-react';

import { ButtonLink } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';

export type NoSourcesArea = 'home' | 'live' | 'guide' | 'movies' | 'series';

const COPY: Record<NoSourcesArea, { icon: typeof Tv; title: string; description: string }> = {
  home: { icon: Home, title: 'Your library is empty', description: 'Add an M3U playlist or an Xtream Codes account: its channels, movies and series appear here.' },
  live: { icon: Tv, title: 'No channels yet', description: 'Live channels come from your sources. Add an M3U playlist or an Xtream Codes account to start watching.' },
  guide: { icon: LayoutGrid, title: 'No TV guide yet', description: 'The TV guide shows the programmes of your channels. Add a source with live channels first.' },
  movies: { icon: Clapperboard, title: 'No movies yet', description: 'Movies come from Xtream Codes accounts and from playlists that contain VOD.' },
  series: { icon: MonitorPlay, title: 'No series yet', description: 'Series come from Xtream Codes accounts and from playlists that contain VOD.' },
};

/**
 * What a screen shows while the account has no source at all. The screen stays where the person
 * asked to go — it explains itself and offers the next step, instead of redirecting elsewhere.
 */
export function NoSourcesState({ area, operatorChannels = false }: { area: NoSourcesArea; operatorChannels?: boolean }) {
  const copy = COPY[area];
  return (
    <div className="p-4 sm:p-6">
      <EmptyState
        className="py-16"
        icon={<copy.icon className="h-8 w-8" />}
        title={copy.title}
        description={copy.description}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <ButtonLink to="/setup" variant="primary" icon={<Plus className="h-4 w-4" />}>
              Add a source
            </ButtonLink>
            {operatorChannels && (
              <ButtonLink to="/channels" icon={<RadioTower className="h-4 w-4" />}>
                Watch ZIPTV channels
              </ButtonLink>
            )}
          </div>
        }
      />
    </div>
  );
}
