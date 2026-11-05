import { Clapperboard, Home, LayoutGrid, MonitorPlay, Plus, RadioTower, Tv } from 'lucide-react';

import { ButtonLink } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { t } from '../../../i18n';

export type NoSourcesArea = 'home' | 'live' | 'guide' | 'movies' | 'series';

const ICONS: Record<NoSourcesArea, typeof Tv> = { home: Home, live: Tv, guide: LayoutGrid, movies: Clapperboard, series: MonitorPlay };

/**
 * What a screen shows while the account has no source at all. The screen stays where the person
 * asked to go — it explains itself and offers the next step, instead of redirecting elsewhere.
 */
export function NoSourcesState({ area, operatorChannels = false }: { area: NoSourcesArea; operatorChannels?: boolean }) {
  const Icon = ICONS[area];
  return (
    <div className="p-4 sm:p-6">
      <EmptyState
        className="py-16"
        icon={<Icon className="h-8 w-8" />}
        title={t(`sources.empty.${area}.title`)}
        description={t(`sources.empty.${area}.description`)}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <ButtonLink to="/setup" variant="primary" icon={<Plus className="h-4 w-4" />}>
              {t('sources.addSource')}
            </ButtonLink>
            {operatorChannels && (
              <ButtonLink to="/channels" icon={<RadioTower className="h-4 w-4" />}>
                {t('sources.watchOperator')}
              </ButtonLink>
            )}
          </div>
        }
      />
    </div>
  );
}
