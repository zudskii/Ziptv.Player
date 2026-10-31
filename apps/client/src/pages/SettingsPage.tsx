import type { ClearableData, QualityPreference, SettingsDto, StartPage, ThemePreference, UpdateSettingsRequest } from '@ziptv/contracts';
import { Monitor, Moon, Server, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { toast } from 'sonner';

import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Segmented } from '../components/ui/Segmented';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { AccountSection } from '../features/auth/components/AccountSection';
import { ProfilesSection } from '../features/profiles/ProfilesSection';
import { useThemeStore } from '../features/theme/theme-store';
import { useClearData, useSettings, useStorageUsage, useUpdateSettings } from '../features/user-state/api';
import { errorMessage } from '../lib/api-client';

const LANGUAGES = [
  { value: '', label: 'Stream default' },
  { value: 'ka', label: 'Georgian' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Russian' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'tr', label: 'Turkish' },
  { value: 'uk', label: 'Ukrainian' },
];

/** Settings: General, Playback, Appearance, EPG, Profiles, Data & Storage, Sources, Account, About. */
export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, settings.isPending]);

  const save = (patch: UpdateSettingsRequest) => update.mutate(patch, { onError: (error) => toast.error('Setting not saved', { description: errorMessage(error) }) });
  const data = settings.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-fg">Settings</h1>
      {settings.isPending ? (
        <Spinner label="Loading settings…" />
      ) : data ? (
        <>
          <GeneralSection settings={data} save={save} />
          <PlaybackSection settings={data} save={save} />
          <AppearanceSection save={save} />
          <EpgSection settings={data} save={save} />
        </>
      ) : (
        <p className="text-sm text-red-500">{errorMessage(settings.error)}</p>
      )}
      <ProfilesSection />
      {data && <DataSection settings={data} save={save} />}
      <AccountSection />
      <Section id="sources" title="Sources">
        <Link to="/sources" className="inline-flex items-center gap-2 text-sm text-brand-soft hover:underline">
          <Server className="h-4 w-4" /> Manage sources and TV guides
        </Link>
      </Section>
      <Section id="about" title="About">
        <p className="text-sm text-fg-muted">ZIPTV {__APP_VERSION__} — personal streaming hub for your own sources.</p>
        <p className="text-xs text-fg-subtle">Shortcuts: Space play/pause · ←/→ seek · ↑/↓ volume · M mute · F fullscreen · N/P next/previous · / search</p>
      </Section>
    </div>
  );
}

type Save = (patch: UpdateSettingsRequest) => void;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="card space-y-2 p-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-semibold text-fg">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SelectRow<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-fg">{label}</span>
      <select
        className="field h-9 w-auto max-w-[12rem]"
        value={String(value)}
        onChange={(event) => {
          const picked = options.find((option) => String(option.value) === event.target.value);
          if (picked) onChange(picked.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function GeneralSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  return (
    <Section id="general" title="General">
      <SelectRow<StartPage>
        label="Start page"
        value={settings.general.startPage}
        onChange={(startPage) => save({ general: { startPage } })}
        options={[
          { value: 'home', label: 'Home' },
          { value: 'live', label: 'Live TV' },
          { value: 'guide', label: 'TV Guide' },
          { value: 'movies', label: 'Movies' },
          { value: 'series', label: 'Series' },
        ]}
      />
      <Switch label="24-hour clock" checked={settings.general.use24hClock} onChange={(use24hClock) => save({ general: { use24hClock } })} />
    </Section>
  );
}

function PlaybackSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  const playback = settings.playback;
  return (
    <Section id="playback" title="Playback">
      <Switch label="Autoplay" description="Start playing as soon as a channel or video opens." checked={playback.autoplay} onChange={(autoplay) => save({ playback: { autoplay } })} />
      <Switch label="Play next episode automatically" checked={playback.autoplayNextEpisode} onChange={(autoplayNextEpisode) => save({ playback: { autoplayNextEpisode } })} />
      <Switch label="Resume where I left off" checked={playback.resumePlayback} onChange={(resumePlayback) => save({ playback: { resumePlayback } })} />
      <SelectRow<QualityPreference>
        label="Preferred quality"
        value={playback.preferredQuality}
        onChange={(preferredQuality) => save({ playback: { preferredQuality } })}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'highest', label: 'Highest' },
          { value: '1080', label: '1080p' },
          { value: '720', label: '720p' },
          { value: '480', label: '480p' },
          { value: 'lowest', label: 'Lowest (save data)' },
        ]}
      />
      <SelectRow label="Audio language" value={playback.preferredAudio} onChange={(preferredAudio) => save({ playback: { preferredAudio } })} options={LANGUAGES} />
      <SelectRow
        label="Subtitles"
        value={playback.preferredSubtitles}
        onChange={(preferredSubtitles) => save({ playback: { preferredSubtitles } })}
        options={[{ value: 'off', label: 'Off' }, ...LANGUAGES]}
      />
      <Switch
        label="Hardware acceleration"
        description="Turn off only if video stutters or shows artefacts on this device."
        checked={playback.hardwareAcceleration}
        onChange={(hardwareAcceleration) => save({ playback: { hardwareAcceleration } })}
      />
    </Section>
  );
}

function AppearanceSection({ save }: { save: Save }) {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  return (
    <Section id="appearance" title="Appearance">
      <Segmented<ThemePreference>
        label="Theme"
        value={preference}
        onChange={(theme) => {
          setPreference(theme);
          save({ appearance: { theme } });
        }}
        options={[
          { value: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
          { value: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
          { value: 'system', label: 'System', icon: <Monitor className="h-4 w-4" /> },
        ]}
      />
    </Section>
  );
}

function EpgSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  const shifts = [-180, -120, -60, -30, 0, 30, 60, 120, 180];
  return (
    <Section id="epg" title="TV guide">
      <SelectRow
        label="Time shift"
        value={settings.epg.timeShiftMinutes}
        onChange={(timeShiftMinutes) => save({ epg: { timeShiftMinutes } })}
        options={[...new Set([...shifts, settings.epg.timeShiftMinutes])].sort((a, b) => a - b).map((minutes) => ({ value: minutes, label: minutes === 0 ? 'None' : `${minutes > 0 ? '+' : '−'}${Math.abs(minutes) >= 60 ? `${Math.abs(minutes) / 60} h` : `${Math.abs(minutes)} min`}` }))}
      />
      <p className="-mt-1 text-xs text-fg-subtle">For guides whose times are off by a fixed amount.</p>
      <Switch label="Show programme progress" checked={settings.epg.showProgress} onChange={(showProgress) => save({ epg: { showProgress } })} />
    </Section>
  );
}

const CLEAR_COPY: Record<ClearableData, { label: string; title: string; description: string }> = {
  history: { label: 'Clear history', title: 'Clear watch history?', description: 'Every viewing of this profile is removed.' },
  progress: { label: 'Clear Continue Watching', title: 'Clear Continue Watching?', description: 'Saved positions of movies and episodes are removed.' },
  my_list: { label: 'Clear My List', title: 'Clear My List?', description: 'Every saved channel, movie and series of this profile is removed.' },
  cache: { label: 'Clear cache', title: 'Clear cached data?', description: 'Channel lists and guides are reloaded from the server; nothing personal is removed.' },
};

function DataSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  const usage = useStorageUsage();
  const clear = useClearData();
  const [confirm, setConfirm] = useState<ClearableData | null>(null);
  const u = usage.data;
  return (
    <Section id="data" title="Data & storage">
      {u && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {(
            [
              ['Sources', u.sources],
              ['Live channels', u.liveChannels],
              ['Movies', u.movies],
              ['Series', u.series],
              ['TV guides', u.guides],
              ['Programmes', u.programmes],
              ['My List', u.myList],
              ['Continue Watching', u.progress],
              ['History entries', u.history],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2 border-b border-line/5 py-1">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="tabular-nums text-fg">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
      <SelectRow
        label="Keep watch history"
        value={settings.data.historyRetentionDays}
        onChange={(historyRetentionDays) => save({ data: { historyRetentionDays } })}
        options={[
          { value: 30, label: '30 days' },
          { value: 90, label: '90 days' },
          { value: 180, label: '6 months' },
          { value: 365, label: '1 year' },
          { value: 0, label: 'Forever' },
        ]}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        {(Object.keys(CLEAR_COPY) as ClearableData[]).map((kind) => (
          <Button key={kind} size="sm" onClick={() => setConfirm(kind)}>
            {CLEAR_COPY[kind].label}
          </Button>
        ))}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? CLEAR_COPY[confirm].title : ''}
        description={confirm ? CLEAR_COPY[confirm].description : ''}
        confirmLabel={confirm ? CLEAR_COPY[confirm].label : ''}
        onConfirm={async () => {
          if (!confirm) return;
          await clear.mutateAsync(confirm);
          toast.success('Done');
        }}
      />
    </Section>
  );
}
