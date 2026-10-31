import type { SourceDto } from '@ziptv/contracts';
import { CalendarClock, FileText, Globe, KeyRound, MoreHorizontal, Pencil, RefreshCw, Trash2, TriangleAlert, Tv } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import { Badge } from '../../../components/ui/Badge';
import { Button, IconButton } from '../../../components/ui/Button';
import { Popover } from '../../../components/ui/Popover';
import { errorMessage } from '../../../lib/api-client';
import { formatAgo, formatIn } from '../../../lib/time';
import { useNow } from '../../../lib/use-now';
import { isSyncing, useConvertToXtream, useDeleteSource, useSyncSource } from '../api';
import { describeLibrary, describeSync, HEALTH_LABELS, SOURCE_TYPE_LABELS } from '../source-status';
import { SourceProblemNotice } from './SourceProblemNotice';
import { SyncProgress } from './SyncProgress';

const TYPE_ICONS = { m3u_url: Globe, m3u_file: FileText, xtream: KeyRound } as const;

export function SourceCard({ source, onEdit }: { source: SourceDto; onEdit: (source: SourceDto) => void }) {
  const now = useNow(30_000);
  const sync = useSyncSource();
  const remove = useDeleteSource();
  const convert = useConvertToXtream();
  const [showWarnings, setShowWarnings] = useState(false);
  const Icon = TYPE_ICONS[source.type];
  const syncing = isSyncing(source);
  const health = HEALTH_LABELS[source.health.state];

  const syncNow = async () => {
    try {
      await sync.mutateAsync(source.id);
    } catch (error) {
      toast.error('Sync failed to start', { description: errorMessage(error) });
    }
  };

  const convertToXtream = async () => {
    try {
      await convert.mutateAsync(source.id);
      toast.success('Switched to the Xtream API', { description: 'Your favourites and progress stay where they are. Syncing now…' });
    } catch (error) {
      toast.error('Could not switch to Xtream', { description: errorMessage(error) });
    }
  };

  const doDelete = async () => {
    if (!window.confirm(`Remove “${source.name}”? Its channels, movies and series disappear from ZIPTV.`)) return;
    try {
      await remove.mutateAsync(source.id);
      toast.success(`“${source.name}” removed`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <article className="card p-4" aria-label={source.name}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand-soft">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold text-fg">{source.name}</h3>
            <Badge>{SOURCE_TYPE_LABELS[source.type]}</Badge>
            {source.revision > 0 && source.health.state !== 'unknown' && <Badge tone={health.tone}>{health.label}</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            {source.origin.kind === 'file' ? source.origin.fileName : source.origin.kind === 'xtream' ? `${source.origin.username} @ ${source.origin.host}` : source.origin.host}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{describeLibrary(source)}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {describeSync(source, now)}
            {source.sync.autoSync && source.sync.nextSyncAt && !syncing && ` · next ${formatIn(source.sync.nextSyncAt, now)}`}
            {source.epg.guides > 0 && ` · ${source.stats.epgMapped.toLocaleString()} channel${source.stats.epgMapped === 1 ? '' : 's'} with guide`}
          </p>
          {source.account && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-fg-subtle">
              <CalendarClock className="h-3.5 w-3.5" />
              Account {source.account.status.toLowerCase()}
              {source.account.expiresAt && ` · expires ${new Date(source.account.expiresAt).toLocaleDateString()}`}
              {source.account.maxConnections !== null && ` · ${source.account.maxConnections} connection${source.account.maxConnections === 1 ? '' : 's'}`}
            </p>
          )}
          {source.health.unstableStreams + source.health.offlineStreams > 0 && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-500">
              <TriangleAlert className="h-3.5 w-3.5" />
              {source.health.unstableStreams + source.health.offlineStreams} stream{source.health.unstableStreams + source.health.offlineStreams === 1 ? '' : 's'} unstable
              {source.health.checkedAt && ` · checked ${formatAgo(source.health.checkedAt, now)}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {source.type !== 'm3u_file' && (
            <Button size="sm" icon={<RefreshCw className={syncing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />} onClick={() => void syncNow()} disabled={syncing} loading={sync.isPending}>
              <span className="hidden sm:inline">{syncing ? 'Syncing' : 'Sync now'}</span>
            </Button>
          )}
          <Popover
            trigger={({ toggle, open }) => (
              <IconButton label="More actions" onClick={toggle} active={open}>
                <MoreHorizontal className="h-4 w-4" />
              </IconButton>
            )}
          >
            {(close) => (
              <ul className="w-52 py-1 text-sm" role="menu">
                {source.revision > 0 && source.stats.live > 0 && (
                  <MenuLink to={`/live/${source.id}`} icon={<Tv className="h-4 w-4" />} onClick={close}>
                    Open in Live TV
                  </MenuLink>
                )}
                <MenuItem icon={<Pencil className="h-4 w-4" />} onClick={() => {
                    close();
                    onEdit(source);
                  }}>
                  Settings
                </MenuItem>
                {source.warningCount > 0 && (
                  <MenuItem icon={<TriangleAlert className="h-4 w-4" />} onClick={() => {
                      close();
                      setShowWarnings((value) => !value);
                    }}>
                    {showWarnings ? 'Hide' : 'Show'} {source.warningCount} import warnings
                  </MenuItem>
                )}
                <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onClick={() => {
                    close();
                    void doDelete();
                  }}>
                  Remove source
                </MenuItem>
              </ul>
            )}
          </Popover>
        </div>
      </div>

      {syncing && source.revision === 0 && <SyncProgress source={source} className="mt-4 border-t border-line/5 pt-4" />}
      {source.sync.status === 'failed' && (
        <div className="mt-3">
          <SourceProblemNotice source={source} onRetry={() => void syncNow()} onEdit={() => onEdit(source)} retrying={sync.isPending} />
        </div>
      )}

      {source.type === 'm3u_url' && source.xtreamCandidate && source.revision > 0 && source.sync.status !== 'failed' && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-brand/20 bg-brand/5 p-3 text-sm sm:flex-row sm:items-center">
          <p className="flex-1 text-fg-muted">
            This link comes from an Xtream Codes panel. Switch to the Xtream API for movie and series details, account status and archive.
          </p>
          <Button size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => void convertToXtream()} loading={convert.isPending} disabled={syncing}>
            Switch to Xtream
          </Button>
        </div>
      )}

      {showWarnings && (
        <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-sunken/60 p-2 font-mono text-xs text-amber-500/90">
          {source.warnings.map((warning) => (
            <li key={`${warning.line}-${warning.code}-${warning.message}`}>
              {warning.line > 0 && `line ${warning.line}: `}
              {warning.message}
            </li>
          ))}
          {source.warningCount > source.warnings.length && <li className="text-fg-subtle">…and {source.warningCount - source.warnings.length} more</li>}
        </ul>
      )}
    </article>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <li>
      <button type="button" role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-fg/5 ${danger ? 'text-red-500' : 'text-fg'}`}>
        {icon}
        {children}
      </button>
    </li>
  );
}

function MenuLink({ to, icon, children, onClick }: { to: string; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <li>
      <Link to={to} role="menuitem" onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-fg hover:bg-fg/5">
        {icon}
        {children}
      </Link>
    </li>
  );
}
