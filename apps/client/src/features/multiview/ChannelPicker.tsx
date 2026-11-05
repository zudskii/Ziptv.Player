import type { ChannelDto, OperatorChannelDto, SourceDto } from '@ziptv/contracts';
import { Search, TriangleAlert } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';

import { Dialog } from '../../components/ui/Dialog';
import { Img, Initials } from '../../components/ui/Img';
import { Spinner } from '../../components/ui/Spinner';
import { cn } from '../../lib/cn';
import { imageSources } from '../../lib/images';
import { matchesQuery, normalizeForSearch } from '../../lib/search';
import { useHasOperatorChannels, useOperatorChannels } from '../operator/api';
import { useChannelList, useSources } from '../sources/api';
import type { Tile } from './multiview-store';
import { t } from '../../i18n';

const LICENSED = '__licensed__';

interface ChannelPickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (tile: Tile) => void;
  /** How many other tiles already play from each source (connection limits). */
  usage: (sourceId: string) => number;
}

/** Choose what a Multi-view tile plays: a live channel of one of the viewer's sources, or a licensed channel. */
export function ChannelPicker({ open, onClose, onPick, usage }: ChannelPickerProps) {
  return (
    <Dialog open={open} onClose={onClose} title={t('multiview.choose')} className="w-[min(94vw,32rem)]">
      {open && <PickerBody onPick={onPick} usage={usage} />}
    </Dialog>
  );
}

function PickerBody({ onPick, usage }: Pick<ChannelPickerProps, 'onPick' | 'usage'>) {
  const sources = (useSources().data ?? []).filter((source) => source.revision > 0 && source.stats.live > 0);
  const operator = useHasOperatorChannels();
  const [origin, setOrigin] = useState<string>(operator ? LICENSED : (sources[0]?.id ?? ''));
  const [search, setSearch] = useState('');
  const term = normalizeForSearch(useDeferredValue(search));
  const source = sources.find((item) => item.id === origin);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select className="field h-10 w-auto max-w-[45%]" value={origin} onChange={(event) => setOrigin(event.target.value)} aria-label={t('multiview.from')}>
          {operator && <option value={LICENSED}>{t('multiview.licensed')}</option>}
          {sources.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('multiview.search')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input className="field h-10 pl-9" placeholder={t('multiview.searchPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
        </label>
      </div>
      {source && <ConnectionHint source={source} used={usage(source.id)} />}
      {origin === LICENSED ? <LicensedList term={term} onPick={onPick} /> : source ? <SourceList source={source} term={term} onPick={onPick} /> : <p className="text-sm text-fg-muted">{t('multiview.addSourceFirst')}</p>}
    </div>
  );
}

function ConnectionHint({ source, used }: { source: SourceDto; used: number }) {
  const limit = source.account?.maxConnections ?? null;
  if (!limit || used < limit) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {t('multiview.connectionHint', { source: source.name, limit, used })}
    </p>
  );
}

function SourceList({ source, term, onPick }: { source: SourceDto; term: string; onPick: (tile: Tile) => void }) {
  const query = useChannelList(source);
  const channels = useMemo(() => (query.data?.channels ?? []).filter((channel) => !channel.unplayableReason && matchesQuery(normalizeForSearch(channel.name), term)).slice(0, 200), [query.data, term]);
  if (query.isPending) return <Spinner label={t('multiview.loading')} />;
  return (
    <ChannelRows
      rows={channels.map((channel: ChannelDto) => ({ id: channel.key, name: channel.name, logo: channel.logo, detail: channel.groups[0] ?? null, locked: channel.locked }))}
      onPick={(row) => onPick({ content: { type: 'channel', sourceId: source.id, key: row.id }, title: row.name })}
    />
  );
}

function LicensedList({ term, onPick }: { term: string; onPick: (tile: Tile) => void }) {
  const query = useOperatorChannels();
  const channels = useMemo(() => (query.data?.channels ?? []).filter((channel) => matchesQuery(normalizeForSearch(channel.name), term)), [query.data, term]);
  if (query.isPending) return <Spinner label={t('multiview.loading')} />;
  return (
    <ChannelRows
      rows={channels.map((channel: OperatorChannelDto) => ({ id: channel.id, name: channel.name, logo: channel.logo, detail: channel.category, locked: channel.locked || channel.parentalLock }))}
      onPick={(row) => onPick({ content: { type: 'operator', channelId: row.id }, title: row.name })}
    />
  );
}

interface Row {
  id: string;
  name: string;
  logo: string | null;
  detail: string | null;
  locked: boolean;
}

function ChannelRows({ rows, onPick }: { rows: Row[]; onPick: (row: Row) => void }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-fg-muted">{t('multiview.noMatch')}</p>;
  return (
    <ul className="max-h-[50vh] overflow-y-auto" aria-label={t('multiview.channels')}>
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" onClick={() => onPick(row)} className={cn('flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-fg/5')}>
            <Img sources={imageSources(row.logo)} fit="contain" className="h-8 w-11 shrink-0 rounded-md bg-fg/5" imgClassName="p-1" fallback={<Initials name={row.name} />} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{row.name}</span>
              {row.detail && <span className="block truncate text-xs text-fg-subtle">{row.detail}</span>}
            </span>
            {row.locked && <span className="text-xs text-fg-subtle">{t('multiview.locked')}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
