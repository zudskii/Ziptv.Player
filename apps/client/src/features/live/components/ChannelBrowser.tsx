import type { NowNextDto } from '@ziptv/contracts';
import { ListFilter, Search, X } from 'lucide-react';

import { Spinner } from '../../../components/ui/Spinner';
import type { BrowsableChannel, GroupFilterValue, GroupOption } from '../browse';
import { ChannelList } from './ChannelList';
import { t } from '../../../i18n';
import { Tooltip } from '../../../components/ui/Tooltip';

interface ChannelBrowserProps {
  sourceId: string;
  loading: boolean;
  error: string | null;
  groupOptions: GroupOption[];
  group: GroupFilterValue;
  search: string;
  channels: BrowsableChannel[];
  activeKey: string | undefined;
  favorites: ReadonlySet<string>;
  nowNext?: Record<string, NowNextDto>;
  onGroupChange: (value: GroupFilterValue) => void;
  onSearchChange: (value: string) => void;
  onSelect: (channel: BrowsableChannel) => void;
  onToggleFavorite: (channel: BrowsableChannel) => void;
  onRetry: () => void;
}

export function ChannelBrowser(props: ChannelBrowserProps) {
  const { groupOptions, group, search, channels, loading, error } = props;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 rounded-xl border border-line/5 bg-surface/80 p-3" aria-label={t('live.browser.label')}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(event) => props.onSearchChange(event.target.value)}
          placeholder={t('live.browser.searchPlaceholder')}
          aria-label={t('live.browser.search')}
          className="h-10 w-full rounded-lg bg-sunken/70 pl-9 pr-9 text-sm text-fg placeholder:text-fg-subtle ring-1 ring-inset ring-line/10 focus:outline-none focus:ring-2 focus:ring-brand"
        />
        {search && (
          <Tooltip content={t('live.browser.clear')} redundant>
            <button
              type="button"
              onClick={() => props.onSearchChange('')}
              aria-label={t('live.browser.clear')}
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>

      <label className="relative block">
        <span className="sr-only">{t('live.browser.group')}</span>
        <ListFilter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        {/* Native select: scales to thousands of groups and works with TV remotes. */}
        <select
          value={group}
          onChange={(event) => props.onGroupChange(event.target.value as GroupFilterValue)}
          className="h-10 w-full appearance-none truncate rounded-lg bg-sunken/70 pl-9 pr-8 text-sm text-fg ring-1 ring-inset ring-line/10 focus:outline-none focus:ring-2 focus:ring-brand"
        >
          {groupOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} ({option.count})
            </option>
          ))}
        </select>
      </label>

      <div className="min-h-0 flex-1">
        {loading ? (
          <Spinner className="py-16" label={t('live.browser.loading')} />
        ) : error ? (
          <div className="py-12 text-center text-sm text-fg-muted">
            <p>{error}</p>
            <button type="button" onClick={props.onRetry} className="mt-3 text-brand-soft hover:underline">
              {t('live.retry')}
            </button>
          </div>
        ) : channels.length === 0 ? (
          <p className="py-12 text-center text-sm text-fg-subtle">
            {search ? t('live.noMatch', { search }) : group === 'fav' ? t('live.browser.noFav') : t('live.browser.empty')}
          </p>
        ) : (
          <ChannelList
            sourceId={props.sourceId}
            channels={channels}
            activeKey={props.activeKey}
            favorites={props.favorites}
            nowNext={props.nowNext}
            showGroups={group === 'all' || group === 'fav' || group === 'recent' || Boolean(search)}
            onSelect={props.onSelect}
            onToggleFavorite={props.onToggleFavorite}
          />
        )}
      </div>

      <p className="text-right text-xs text-fg-subtle">
        {t('live.count', { count: channels.length })}
      </p>
    </section>
  );
}
