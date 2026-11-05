import type { AppLanguage, ClearableData, QualityPreference, SettingsDto, StartPage, ThemePreference, UpdateSettingsRequest } from '@ziptv/contracts';
import { LOCALE_NAMES, LOCALES } from '@ziptv/i18n';
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
import { setLanguage, t, useT } from '../i18n';
import { errorMessage } from '../lib/api-client';
import { languageName } from '../lib/language-name';
import { formatShift } from '../lib/time';

/** Audio / subtitle languages offered, named in the current UI language when shown. */
const STREAM_LANGUAGES = ['ka', 'en', 'ru', 'de', 'fr', 'es', 'it', 'tr', 'uk'] as const;

function streamLanguages(locale: string): { value: string; label: string }[] {
  return [{ value: '', label: t('settings.streamDefault') }, ...STREAM_LANGUAGES.map((code) => ({ value: code, label: languageName(code, locale) }))];
}

/** Settings: General, Playback, Appearance, EPG, Profiles, Data & Storage, Sources, Account, About. */
export function SettingsPage() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, settings.isPending]);

  const save = (patch: UpdateSettingsRequest) => update.mutate(patch, { onError: (error) => toast.error(t('settings.notSaved'), { description: errorMessage(error) }) });
  const data = settings.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-fg">{t('settings.title')}</h1>
      {settings.isPending ? (
        <Spinner label={t('settings.loading')} />
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
      <Section id="sources" title={t('settings.sources')}>
        <Link to="/sources" className="inline-flex items-center gap-2 text-sm text-brand-soft hover:underline">
          <Server className="h-4 w-4" /> {t('settings.manageSources')}
        </Link>
      </Section>
      <Section id="about" title={t('settings.about')}>
        <p className="text-sm text-fg-muted">{t('settings.aboutText', { version: __APP_VERSION__ })}</p>
        <p className="text-xs text-fg-subtle">{t('settings.shortcuts')}</p>
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
  const { locale } = useT();
  return (
    <Section id="general" title={t('settings.general')}>
      <SelectRow<AppLanguage | ''>
        label={t('settings.language')}
        value={settings.general.language}
        onChange={(language) => {
          // Shown at once; '' keeps whatever this device uses now.
          if (language) void setLanguage(language);
          save({ general: { language } });
        }}
        options={[{ value: '', label: t('settings.languageDevice', { language: LOCALE_NAMES[locale] }) }, ...LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))]}
      />
      <SelectRow<StartPage>
        label={t('settings.startPage')}
        value={settings.general.startPage}
        onChange={(startPage) => save({ general: { startPage } })}
        options={[
          { value: 'home', label: t('settings.page.home') },
          { value: 'live', label: t('settings.page.live') },
          { value: 'guide', label: t('settings.page.guide') },
          { value: 'movies', label: t('settings.page.movies') },
          { value: 'series', label: t('settings.page.series') },
        ]}
      />
      <Switch label={t('settings.clock24')} checked={settings.general.use24hClock} onChange={(use24hClock) => save({ general: { use24hClock } })} />
    </Section>
  );
}

function PlaybackSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  const { locale } = useT();
  const playback = settings.playback;
  const languages = streamLanguages(locale);
  return (
    <Section id="playback" title={t('settings.playback')}>
      <Switch label={t('settings.autoplay')} description={t('settings.autoplayHint')} checked={playback.autoplay} onChange={(autoplay) => save({ playback: { autoplay } })} />
      <Switch label={t('settings.nextEpisode')} checked={playback.autoplayNextEpisode} onChange={(autoplayNextEpisode) => save({ playback: { autoplayNextEpisode } })} />
      <Switch label={t('settings.resume')} checked={playback.resumePlayback} onChange={(resumePlayback) => save({ playback: { resumePlayback } })} />
      <SelectRow<QualityPreference>
        label={t('settings.quality')}
        value={playback.preferredQuality}
        onChange={(preferredQuality) => save({ playback: { preferredQuality } })}
        options={[
          { value: 'auto', label: t('settings.qualityAuto') },
          { value: 'highest', label: t('settings.qualityHighest') },
          { value: '1080', label: '1080p' },
          { value: '720', label: '720p' },
          { value: '480', label: '480p' },
          { value: 'lowest', label: t('settings.qualityLowest') },
        ]}
      />
      <SelectRow label={t('settings.audioLanguage')} value={playback.preferredAudio} onChange={(preferredAudio) => save({ playback: { preferredAudio } })} options={languages} />
      <SelectRow
        label={t('settings.subtitles')}
        value={playback.preferredSubtitles}
        onChange={(preferredSubtitles) => save({ playback: { preferredSubtitles } })}
        options={[{ value: 'off', label: t('common.off') }, ...languages]}
      />
      <Switch
        label={t('settings.hwAccel')}
        description={t('settings.hwAccelHint')}
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
    <Section id="appearance" title={t('settings.appearance')}>
      <Segmented<ThemePreference>
        label={t('settings.theme')}
        value={preference}
        onChange={(theme) => {
          setPreference(theme);
          save({ appearance: { theme } });
        }}
        options={[
          { value: 'dark', label: t('settings.themeDark'), icon: <Moon className="h-4 w-4" /> },
          { value: 'light', label: t('settings.themeLight'), icon: <Sun className="h-4 w-4" /> },
          { value: 'system', label: t('settings.themeSystem'), icon: <Monitor className="h-4 w-4" /> },
        ]}
      />
    </Section>
  );
}

function EpgSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  const shifts = [-180, -120, -60, -30, 0, 30, 60, 120, 180];
  return (
    <Section id="epg" title={t('settings.epg')}>
      <SelectRow
        label={t('settings.timeShift')}
        value={settings.epg.timeShiftMinutes}
        onChange={(timeShiftMinutes) => save({ epg: { timeShiftMinutes } })}
        options={[...new Set([...shifts, settings.epg.timeShiftMinutes])].sort((a, b) => a - b).map((minutes) => ({ value: minutes, label: minutes === 0 ? t('common.none') : formatShift(minutes) }))}
      />
      <p className="-mt-1 text-xs text-fg-subtle">{t('settings.timeShiftHint')}</p>
      <Switch label={t('settings.showProgress')} checked={settings.epg.showProgress} onChange={(showProgress) => save({ epg: { showProgress } })} />
    </Section>
  );
}

const CLEARABLE: readonly ClearableData[] = ['history', 'progress', 'my_list', 'cache'];
const clearCopy = (kind: ClearableData) => ({
  label: t(`settings.clear.${kind}.label`),
  title: t(`settings.clear.${kind}.title`),
  description: t(`settings.clear.${kind}.description`),
});

function DataSection({ settings, save }: { settings: SettingsDto; save: Save }) {
  const { locale } = useT();
  const usage = useStorageUsage();
  const clear = useClearData();
  const [confirm, setConfirm] = useState<ClearableData | null>(null);
  const u = usage.data;
  return (
    <Section id="data" title={t('settings.data')}>
      {u && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          {(
            [
              ['sources', u.sources],
              ['liveChannels', u.liveChannels],
              ['movies', u.movies],
              ['series', u.series],
              ['guides', u.guides],
              ['programmes', u.programmes],
              ['myList', u.myList],
              ['progress', u.progress],
              ['history', u.history],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2 border-b border-line/5 py-1">
              <dt className="text-fg-muted">{t(`settings.usage.${label}`)}</dt>
              <dd className="tabular-nums text-fg">{value.toLocaleString(locale)}</dd>
            </div>
          ))}
        </dl>
      )}
      <SelectRow
        label={t('settings.keepHistory')}
        value={settings.data.historyRetentionDays}
        onChange={(historyRetentionDays) => save({ data: { historyRetentionDays } })}
        options={[
          { value: 30, label: t('settings.retention.days', { count: 30 }) },
          { value: 90, label: t('settings.retention.days', { count: 90 }) },
          { value: 180, label: t('settings.retention.months', { count: 6 }) },
          { value: 365, label: t('settings.retention.year') },
          { value: 0, label: t('settings.retention.forever') },
        ]}
      />
      <div className="flex flex-wrap gap-2 pt-1">
        {CLEARABLE.map((kind) => (
          <Button key={kind} size="sm" onClick={() => setConfirm(kind)}>
            {clearCopy(kind).label}
          </Button>
        ))}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? clearCopy(confirm).title : ''}
        description={confirm ? clearCopy(confirm).description : ''}
        confirmLabel={confirm ? clearCopy(confirm).label : ''}
        onConfirm={async () => {
          if (!confirm) return;
          await clear.mutateAsync(confirm);
          toast.success(t('settings.done'));
        }}
      />
    </Section>
  );
}
