import type { ParentalSettingsDto, ProfileDto, SourceDto } from '@ziptv/contracts';
import { KeyRound, Lock, LockOpen, ShieldCheck, Trash2 } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button, IconButton } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';
import { errorMessage } from '../../lib/api-client';
import { useHasOperatorChannels, useOperatorChannels } from '../operator/api';
import { useActiveProfile, useProfiles } from '../profiles/api';
import { useChannelList, useSources } from '../sources/api';
import { useVodOverview } from '../vod/api';
import { useParental, useRemovePin, useSetPin, useUpdateRules } from './api';
import { askPin, pinErrorMessage } from './pin-prompt';
import { Tour } from '../help/Tour';
import { t } from '../../i18n';

const OPERATOR = 'operator';

/**
 * Settings → Parental controls. One PIN per account; rules per profile (hide adult, locked
 * groups and channels). Everything is enforced by the server — this screen only edits it.
 */
export function ParentalSection() {
  const parental = useParental();
  const active = useActiveProfile();
  const data = parental.data;

  return (
    <section id="parental" className="card space-y-4 p-4" aria-labelledby="parental-title">
      <div>
        <h2 id="parental-title" className="flex items-center gap-2 font-semibold text-fg">
          <ShieldCheck className="h-4 w-4 text-brand-soft" /> {t('parental.title')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          {t('parental.intro')}
        </p>
      </div>
      {active?.kind === 'kids' ? (
        <p className="rounded-lg bg-fg/5 p-3 text-sm text-fg-muted">{t('parental.managedByAdult')}</p>
      ) : parental.isPending ? (
        <Spinner label={t('parental.loading')} />
      ) : !data ? (
        <p className="text-sm text-red-500">{errorMessage(parental.error)}</p>
      ) : data.pinSet ? (
        <>
          <PinManagement />
          <RulesEditor />
        </>
      ) : (
        <SetPinForm />
      )}
    </section>
  );
}

function SetPinForm({ current }: { current?: boolean }) {
  const id = useId();
  const setPin = useSetPin();
  const [currentPin, setCurrentPin] = useState('');
  const [pin, setPinValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 8);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (pin !== confirm) return setError(t('parental.pinsDiffer'));
    try {
      await setPin.mutateAsync({ pin, ...(current ? { currentPin } : {}) });
      toast.success(current ? t('parental.pinChanged') : t('parental.pinSet'));
      setCurrentPin('');
      setPinValue('');
      setConfirm('');
    } catch (failure) {
      setError(pinErrorMessage(failure));
    }
  };

  const field = (label: string, value: string, onChange: (value: string) => void, suffix: string) => (
    <label className="block space-y-1" htmlFor={`${id}-${suffix}`}>
      <span className="text-sm text-fg-muted">{label}</span>
      <input id={`${id}-${suffix}`} type="password" inputMode="numeric" autoComplete="off" value={value} onChange={(event) => onChange(digits(event.target.value))} className="field" required minLength={4} maxLength={8} />
    </label>
  );

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3 sm:grid-cols-3 sm:items-end">
      {current && field(t('parental.currentPin'), currentPin, setCurrentPin, 'current')}
      {field(current ? t('parental.newPin') : t('parental.pinDigits'), pin, setPinValue, 'pin')}
      {field(t('parental.repeatPin'), confirm, setConfirm, 'confirm')}
      <div className={current ? 'sm:col-span-3' : ''}>
        <Button type="submit" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={setPin.isPending} disabled={pin.length < 4 || confirm.length < 4}>
          {current ? t('parental.changePin') : t('parental.setPin')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-500 sm:col-span-3">
          {error}
        </p>
      )}
    </form>
  );
}

function PinManagement() {
  const remove = useRemovePin();
  const [changing, setChanging] = useState(false);
  return (
    <div className="space-y-3 border-b border-line/5 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm text-fg">
          <Lock className="h-4 w-4 text-emerald-500" /> {t('parental.pinIsSet')}
        </span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => setChanging((value) => !value)}>
          {changing ? t('parental.cancel') : t('parental.changePin')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<LockOpen className="h-4 w-4" />}
          onClick={() =>
            void askPin({
              title: t('parental.removeTitle'),
              description: t('parental.removeHint'),
              verify: async (pin) => void (await remove.mutateAsync(pin)),
            }).then((done) => done && toast.success(t('parental.pinRemoved')))
          }
        >
          {t('parental.removePin')}
        </Button>
      </div>
      {changing && <SetPinForm current />}
    </div>
  );
}

function RulesEditor() {
  const profiles = (useProfiles().data ?? []).filter((profile) => profile.kind === 'kids' || profile.kind === 'standard');
  const active = useActiveProfile();
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = profiles.find((profile) => profile.id === (targetId ?? active?.id)) ?? active;
  if (!target) return null;
  return (
    <div className="space-y-3">
      <label data-tour="parental-profile" className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('parental.rulesFor')}</span>
        <select className="field h-9 w-auto" value={target.id} onChange={(event) => setTargetId(event.target.value)}>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.kind === 'kids' ? t('parental.kidsProfile', { name: profile.name }) : profile.name}
            </option>
          ))}
        </select>
      </label>
      <ProfileRulesLoader key={target.id} profile={target} />
    </div>
  );
}

function ProfileRulesLoader({ profile }: { profile: ProfileDto }) {
  const query = useParental(profile.id);
  if (query.isPending) return <Spinner label={t('parental.loadingRules')} />;
  if (!query.data) return <p className="text-sm text-red-500">{errorMessage(query.error)}</p>;
  return <ProfileRules profile={profile} initial={query.data} />;
}

function ProfileRules({ profile, initial }: { profile: ProfileDto; initial: ParentalSettingsDto }) {
  const [rules, setRules] = useState<Pick<ParentalSettingsDto, 'hideAdult' | 'lockedGroups' | 'lockedChannels'>>(initial);
  const update = useUpdateRules();
  const sources = (useSources().data ?? []).filter((source) => source.revision > 0);
  const [sourceId, setSourceId] = useState<string>(sources[0]?.id ?? OPERATOR);

  const save = (next: Pick<ParentalSettingsDto, 'hideAdult' | 'lockedGroups' | 'lockedChannels'>) =>
    askPin({
      title: t('parental.enterPin'),
      description: t('parental.saveRulesOf', { name: profile.name }),
      verify: async (pin) => {
        const saved = await update.mutateAsync({ pin, profileId: profile.id, hideAdult: next.hideAdult, lockedGroups: next.lockedGroups, lockedChannels: next.lockedChannels });
        setRules({ hideAdult: saved.hideAdult, lockedGroups: saved.lockedGroups, lockedChannels: saved.lockedChannels });
      },
    }).then((done) => done && toast.success(t('parental.rulesSaved')));

  const toggleGroup = (source: string, group: string) => {
    const exists = rules.lockedGroups.some((item) => item.sourceId === source && item.group === group);
    void save({ ...rules, lockedGroups: exists ? rules.lockedGroups.filter((item) => !(item.sourceId === source && item.group === group)) : [...rules.lockedGroups, { sourceId: source, group }] });
  };
  const toggleChannel = (source: string, key: string, name: string) => {
    const exists = rules.lockedChannels.some((item) => item.sourceId === source && item.key === key);
    void save({ ...rules, lockedChannels: exists ? rules.lockedChannels.filter((item) => !(item.sourceId === source && item.key === key)) : [...rules.lockedChannels, { sourceId: source, key, name }] });
  };

  return (
    <div className="space-y-3">
      {profile.kind === 'kids' ? (
        <p className="text-sm text-fg-muted">{t('parental.kidsAlwaysHidden')}</p>
      ) : (
        <div data-tour="parental-adult">
          <Switch label={t('parental.hideAdult')} description={t('parental.hideAdultHint')} checked={rules.hideAdult} onChange={(hideAdult) => void save({ ...rules, hideAdult })} />
        </div>
      )}
      {(rules.lockedGroups.length > 0 || rules.lockedChannels.length > 0) && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('parental.locked')}>
          {rules.lockedGroups.map((item) => (
            <LockChip key={`g${item.sourceId}${item.group}`} label={item.sourceId === OPERATOR ? `${item.group} (${t('parental.licensed')})` : item.group} onRemove={() => toggleGroup(item.sourceId, item.group)} />
          ))}
          {rules.lockedChannels.map((item) => (
            <LockChip key={`c${item.sourceId}${item.key}`} label={item.name} onRemove={() => toggleChannel(item.sourceId, item.key, item.name)} />
          ))}
        </ul>
      )}
      <LockPicker sources={sources} sourceId={sourceId} onSourceChange={setSourceId} rules={rules} onToggleGroup={toggleGroup} onToggleChannel={toggleChannel} />
      <Tour
        id="parental"
        steps={() => [
          { target: 'parental-profile', title: t('help.tour.parental.profile.title'), body: t('help.tour.parental.profile.body') },
          { target: 'parental-adult', title: t('help.tour.parental.adult.title'), body: t('help.tour.parental.adult.body') },
          { target: 'parental-locks', title: t('help.tour.parental.locks.title'), body: t('help.tour.parental.locks.body') },
        ]}
      />
    </div>
  );
}

function LockChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <li className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 py-0.5 pl-2.5 pr-1 text-xs text-amber-700 dark:text-amber-300">
      <Lock className="h-3 w-3" /> {label}
      <IconButton label={t('parental.unlockNamed', { name: label })} onClick={onRemove} className="h-6 w-6">
        <Trash2 className="h-3 w-3" />
      </IconButton>
    </li>
  );
}

interface LockPickerProps {
  sources: SourceDto[];
  sourceId: string;
  onSourceChange: (id: string) => void;
  rules: Pick<ParentalSettingsDto, 'lockedGroups' | 'lockedChannels'>;
  onToggleGroup: (sourceId: string, group: string) => void;
  onToggleChannel: (sourceId: string, key: string, name: string) => void;
}

/** Groups (live groups and VOD categories) and channels of one source, or the licensed channels. */
function LockPicker({ sources, sourceId, onSourceChange, rules, onToggleGroup, onToggleChannel }: LockPickerProps) {
  const operator = useHasOperatorChannels();
  const source = sources.find((item) => item.id === sourceId);
  const channels = useChannelList(source).data?.channels ?? [];
  const movies = useVodOverview(source?.id, 'movies').data?.categories ?? [];
  const series = useVodOverview(source?.id, 'series').data?.categories ?? [];
  const licensed = useOperatorChannels().data?.channels ?? [];
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    if (sourceId === OPERATOR) return [...new Set(licensed.map((channel) => channel.category).filter((value): value is string => Boolean(value)))].sort();
    return [...new Set([...channels.flatMap((channel) => channel.groups), ...movies.map((item) => item.name), ...series.map((item) => item.name)])].sort((a, b) => a.localeCompare(b));
  }, [sourceId, licensed, channels, movies, series]);
  const term = filter.trim().toLowerCase();
  const channelOptions = (sourceId === OPERATOR ? licensed.map((channel) => ({ key: channel.id, name: channel.name })) : channels.map((channel) => ({ key: channel.key, name: channel.name })))
    .filter((channel) => term && channel.name.toLowerCase().includes(term))
    .slice(0, 20);
  const lockedGroup = (group: string) => rules.lockedGroups.some((item) => item.sourceId === sourceId && item.group === group);
  const lockedChannel = (key: string) => rules.lockedChannels.some((item) => item.sourceId === sourceId && item.key === key);

  return (
    <div data-tour="parental-locks" className="space-y-2 rounded-lg border border-line/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="field h-9 w-auto" value={sourceId} onChange={(event) => onSourceChange(event.target.value)} aria-label={t('parental.lockFrom')}>
          {sources.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          {operator && <option value={OPERATOR}>{t('parental.licensed')}</option>}
        </select>
        <input className="field h-9 min-w-0 flex-1" placeholder={t('parental.findToLock')} value={filter} onChange={(event) => setFilter(event.target.value)} aria-label={t('parental.findChannel')} />
      </div>
      {channelOptions.length > 0 && (
        <ul className="divide-y divide-line/5">
          {channelOptions.map((channel) => (
            <li key={channel.key} className="flex items-center justify-between gap-2 py-1.5 text-sm">
              <span className="truncate">{channel.name}</span>
              <Button
                size="sm"
                variant={lockedChannel(channel.key) ? 'secondary' : 'ghost'}
                icon={lockedChannel(channel.key) ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                aria-label={t(lockedChannel(channel.key) ? 'parental.unlockNamed' : 'parental.lockNamed', { name: channel.name })}
                onClick={() => onToggleChannel(sourceId, channel.key, channel.name)}
              >
                {lockedChannel(channel.key) ? t('parental.unlock') : t('parental.lock')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{t('parental.groups')}</p>
      <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
        {groups.length === 0 && <span className="text-sm text-fg-muted">{t('parental.noGroups')}</span>}
        {groups.map((group) => (
          <button
            key={group}
            type="button"
            aria-pressed={lockedGroup(group)}
            onClick={() => onToggleGroup(sourceId, group)}
            className={lockedGroup(group) ? 'rounded-full bg-amber-500/15 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300' : 'rounded-full bg-fg/5 px-2.5 py-1 text-xs text-fg-muted hover:bg-fg/10'}
          >
            {lockedGroup(group) && <Lock className="mr-1 inline h-3 w-3" />}
            {group}
          </button>
        ))}
      </div>
    </div>
  );
}
