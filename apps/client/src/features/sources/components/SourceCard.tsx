import type { SourceDto } from '@ziptv/contracts';
import { CalendarClock, FileText, Globe, KeyRound, MoreHorizontal, Pencil, RefreshCw, Trash2, TriangleAlert, Tv, Users } from 'lucide-react';
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
import { i18n, t } from '../../../i18n';
import { useActiveProfile, useProfiles } from '../../profiles/api';

const TYPE_ICONS = { m3u_url: Globe, m3u_file: FileText, xtream: KeyRound } as const;

export function SourceCard({ source, onEdit, onProfiles }: { source: SourceDto; onEdit: (source: SourceDto) => void; onProfiles?: (source: SourceDto) => void }) {
  const profiles = useProfiles().data ?? [];
  const active = useActiveProfile();
  const seenBy = profiles.filter((profile) => source.profileIds.includes(profile.id));
  const hereToo = !active || source.profileIds.includes(active.id);
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
      toast.error(t('sources.toast.syncFailed'), { description: errorMessage(error) });
    }
  };

  const convertToXtream = async () => {
    try {
      await convert.mutateAsync(source.id);
      toast.success(t('sources.toast.switched'), { description: t('sources.toast.switchedHint') });
    } catch (error) {
      toast.error(t('sources.toast.switchFailed'), { description: errorMessage(error) });
    }
  };

  const doDelete = async () => {
    if (!window.confirm(t('sources.card.removeConfirm', { name: source.name }))) return;
    try {
      await remove.mutateAsync(source.id);
      toast.success(t('sources.toast.removed', { name: source.name }));
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
            {!hereToo && <Badge>{t('library.notHere')}</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            {source.origin.kind === 'file' ? source.origin.fileName : source.origin.kind === 'xtream' ? `${source.origin.username} @ ${source.origin.host}` : source.origin.host}
          </p>
          <p className="mt-2 text-sm text-fg-muted">{describeLibrary(source)}</p>
          {profiles.length > 1 && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-fg-subtle">
              <Users className="h-3.5 w-3.5" aria-hidden />
              {seenBy.length > 0 ? t('library.seenBy', { names: i18n.formatList(seenBy.map((profile) => profile.name)) }) : t('library.nobody')}
              {onProfiles && (
                <button type="button" onClick={() => onProfiles(source)} className="ml-1 font-medium text-brand-soft hover:underline">
                  {t('library.change')}
                </button>
              )}
            </p>
          )}
          <p className="mt-0.5 text-xs text-fg-subtle">
            {describeSync(source, now)}
            {source.sync.autoSync && source.sync.nextSyncAt && !syncing && t('sources.card.next', { when: formatIn(source.sync.nextSyncAt, now) })}
            {source.epg.guides > 0 && t('sources.card.withGuide', { count: source.stats.epgMapped })}
          </p>
          {source.account && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-fg-subtle">
              <CalendarClock className="h-3.5 w-3.5" />
              {t('sources.card.account', { status: source.account.status.toLowerCase() })}
              {source.account.expiresAt && t('sources.card.expires', { date: new Date(source.account.expiresAt).toLocaleDateString(i18n.locale) })}
              {source.account.maxConnections !== null && t('sources.card.connections', { count: source.account.maxConnections })}
            </p>
          )}
          {(source.health.failedPlays > 0 || source.health.message) && source.health.state !== 'online' && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-500">
              <TriangleAlert className="h-3.5 w-3.5" />
              {source.health.failedPlays > 0 ? t('sources.card.failedPlays', { failed: source.health.failedPlays, plays: source.health.plays }) : source.health.message}
              {source.health.checkedAt && t('sources.card.checked', { when: formatAgo(source.health.checkedAt, now) })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {source.type !== 'm3u_file' && (
            <Button size="sm" icon={<RefreshCw className={syncing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />} onClick={() => void syncNow()} disabled={syncing} loading={sync.isPending}>
              <span className="hidden sm:inline">{syncing ? t('sources.card.syncing') : t('sources.card.syncNow')}</span>
            </Button>
          )}
          <Popover
            trigger={({ toggle, open }) => (
              <IconButton label={t('sources.card.more')} onClick={toggle} active={open}>
                <MoreHorizontal className="h-4 w-4" />
              </IconButton>
            )}
          >
            {(close) => (
              <ul className="w-52 py-1 text-sm" role="menu">
                {hereToo && source.revision > 0 && source.stats.live > 0 && (
                  <MenuLink to={`/live/${source.id}`} icon={<Tv className="h-4 w-4" />} onClick={close}>
                    {t('sources.card.openLive')}
                  </MenuLink>
                )}
                <MenuItem icon={<Pencil className="h-4 w-4" />} onClick={() => {
                    close();
                    onEdit(source);
                  }}>
                  {t('sources.card.settings')}
                </MenuItem>
                {source.warningCount > 0 && (
                  <MenuItem icon={<TriangleAlert className="h-4 w-4" />} onClick={() => {
                      close();
                      setShowWarnings((value) => !value);
                    }}>
                    {t(showWarnings ? 'sources.card.warningsHide' : 'sources.card.warningsShow', { count: source.warningCount })}
                  </MenuItem>
                )}
                <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onClick={() => {
                    close();
                    void doDelete();
                  }}>
                  {t('sources.card.remove')}
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
            {t('sources.card.xtreamHint')}
          </p>
          <Button size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => void convertToXtream()} loading={convert.isPending} disabled={syncing}>
            {t('sources.card.switch')}
          </Button>
        </div>
      )}

      {showWarnings && (
        <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-sunken/60 p-2 font-mono text-xs text-amber-500/90">
          {source.warnings.map((warning) => (
            <li key={`${warning.line}-${warning.code}-${warning.message}`}>
              {warning.line > 0 && t('sources.card.line', { line: warning.line })}
              {warning.message}
            </li>
          ))}
          {source.warningCount > source.warnings.length && <li className="text-fg-subtle">{t('sources.card.andMore', { count: source.warningCount - source.warnings.length })}</li>}
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
