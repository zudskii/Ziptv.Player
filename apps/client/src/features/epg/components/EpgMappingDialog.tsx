import type { ChannelDto } from '@ziptv/contracts';
import { Check, RotateCcw, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Img, Initials } from '../../../components/ui/Img';
import { Spinner } from '../../../components/ui/Spinner';
import { errorMessage } from '../../../lib/api-client';
import { imageSources } from '../../../lib/images';
import { useEpgLink, useGuideChannelSearch, useRemoveMapping, useSetMapping } from '../api';

const MATCH_LABELS = { manual: 'Chosen by you', 'tvg-id': 'Matched by tvg-id', name: 'Matched by name' } as const;

interface EpgMappingDialogProps {
  sourceId: string;
  channel: Pick<ChannelDto, 'key' | 'name'> | null;
  onClose: () => void;
}

/** EPG Mapping: which guide channel feeds this channel's programmes (manual override or automatic). */
export function EpgMappingDialog({ sourceId, channel, onClose }: EpgMappingDialogProps) {
  const [query, setQuery] = useState(channel?.name ?? '');
  const deferred = useDeferredValue(query);
  const open = channel !== null;
  const link = useEpgLink(sourceId, channel?.key ?? '', open);
  const options = useGuideChannelSearch(sourceId, deferred, open);
  const setMapping = useSetMapping();
  const removeMapping = useRemoveMapping();
  const current = link.data?.link ?? null;

  const choose = async (guideId: string, epgChannelId: string) => {
    if (!channel) return;
    try {
      await setMapping.mutateAsync({ sourceId, channelKey: channel.key, guideId, epgChannelId });
      toast.success('Guide channel updated', { description: 'Programmes appear in a moment.' });
      onClose();
    } catch (error) {
      toast.error('Could not change the guide channel', { description: errorMessage(error) });
    }
  };

  const reset = async () => {
    if (!channel) return;
    try {
      await removeMapping.mutateAsync({ sourceId, channelKey: channel.key });
      toast.success('Back to automatic matching');
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Programme guide" description={channel ? `Which guide channel shows programmes for “${channel.name}”` : undefined}>
      <div className="space-y-4">
        <div className="rounded-lg bg-sunken/50 p-3 text-sm">
          {link.isPending ? (
            <Spinner />
          ) : current ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-fg-muted">Now:</span>
              <span className="font-medium text-fg">{current.epgChannelName}</span>
              <span className="text-fg-subtle">· {current.guideName}</span>
              <Badge tone={current.match === 'manual' ? 'brand' : 'neutral'}>{MATCH_LABELS[current.match]}</Badge>
            </div>
          ) : (
            <p className="text-fg-muted">No guide channel matched automatically. Pick one below.</p>
          )}
        </div>

        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guide channels…" aria-label="Search guide channels" className="field pl-9" />
        </label>

        <ul className="scrollbar-thin max-h-72 space-y-1 overflow-y-auto" aria-label="Guide channels">
          {options.isPending ? (
            <Spinner className="py-6" />
          ) : (options.data ?? []).length === 0 ? (
            <li className="py-6 text-center text-sm text-fg-muted">No guide channels match.</li>
          ) : (
            options.data!.map((option) => {
              const selected = current?.guideId === option.guideId && current.epgChannelId === option.id;
              return (
                <li key={`${option.guideId}:${option.id}`}>
                  <button
                    type="button"
                    onClick={() => void choose(option.guideId, option.id)}
                    disabled={setMapping.isPending}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-fg/5 disabled:opacity-50"
                  >
                    <Img sources={imageSources(option.icon)} fit="contain" className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-fg/5" fallback={<Initials name={option.name} />} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{option.name}</span>
                      <span className="block truncate text-xs text-fg-subtle">
                        {option.id} · {option.guideName}
                      </span>
                    </span>
                    {selected && <Check className="h-4 w-4 text-brand-soft" />}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex justify-between gap-2">
          <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => void reset()} disabled={current?.match !== 'manual'} loading={removeMapping.isPending}>
            Use automatic
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}
