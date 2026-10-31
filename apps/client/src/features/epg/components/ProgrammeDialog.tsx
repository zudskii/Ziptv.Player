import type { ChannelDto, ProgrammeDto } from '@ziptv/contracts';
import { CalendarDays, Clock, History, Play } from 'lucide-react';

import { Badge, LiveBadge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Img } from '../../../components/ui/Img';
import { ProgressBar } from '../../../components/ui/ProgressBar';
import { imageSources } from '../../../lib/images';
import { formatDay, formatDuration, formatRange } from '../../../lib/time';
import { useNow } from '../../../lib/use-now';
import { minutesLeft, programmeProgress, programmeState } from '../programme';

interface ProgrammeDialogProps {
  programme: ProgrammeDto | null;
  channel: Pick<ChannelDto, 'name'> | null;
  onClose: () => void;
  /** Programme on air → switch to the channel. */
  onWatchLive?: () => void;
  /** Past programme with archive → replay it (catch-up). */
  onWatchArchive?: (programme: ProgrammeDto) => void;
}

/** Programme details from the guide / mini guide / search, with Watch actions. */
export function ProgrammeDialog({ programme, channel, onClose, onWatchLive, onWatchArchive }: ProgrammeDialogProps) {
  const now = useNow(30_000);
  if (!programme) return <Dialog open={false} onClose={onClose} title="">{null}</Dialog>;
  const state = programmeState(programme, now);
  const duration = (new Date(programme.end).getTime() - new Date(programme.start).getTime()) / 1000;

  return (
    <Dialog open onClose={onClose} title={programme.title} description={[channel?.name, programme.subtitle].filter(Boolean).join(' · ') || undefined}>
      <div className="space-y-4">
        {programme.icon && (
          <Img sources={imageSources(programme.icon)} className="aspect-video w-full rounded-lg bg-fg/5" fallback={null} />
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          {state === 'live' && <LiveBadge />}
          {state === 'past' && programme.catchup && <Badge tone="brand" icon={<History className="h-3 w-3" />}>Archive</Badge>}
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-4 w-4" /> {formatDay(programme.start, now)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-4 w-4" /> {formatRange(programme.start, programme.end)} · {formatDuration(duration)}
          </span>
          {programme.episode && <Badge>{programme.episode}</Badge>}
          {programme.rating && <Badge>{programme.rating}</Badge>}
        </div>
        {state === 'live' && (
          <div className="space-y-1">
            <ProgressBar value={programmeProgress(programme, now)} tone="live" label="Programme progress" />
            <p className="text-xs text-fg-subtle">{minutesLeft(programme, now)} min left</p>
          </div>
        )}
        {programme.categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {programme.categories.map((category) => (
              <Badge key={category}>{category}</Badge>
            ))}
          </div>
        )}
        {programme.description && <p className="whitespace-pre-line text-sm leading-relaxed text-fg-muted">{programme.description}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {state === 'live' && onWatchLive && (
            <Button variant="primary" icon={<Play className="h-4 w-4 fill-current" />} onClick={onWatchLive}>
              Watch live
            </Button>
          )}
          {state === 'past' && programme.catchup && onWatchArchive && (
            <Button variant="primary" icon={<Play className="h-4 w-4 fill-current" />} onClick={() => onWatchArchive(programme)}>
              Watch
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
