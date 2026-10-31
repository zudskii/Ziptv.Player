import type { ThemePreference } from '@ziptv/contracts';
import { Monitor, Moon, Server, Sun } from 'lucide-react';
import { Link } from 'react-router';

import { Segmented } from '../components/ui/Segmented';
import { AccountSection } from '../features/auth/components/AccountSection';
import { useThemeStore } from '../features/theme/theme-store';

/** Settings (Appearance, Sources, About); the remaining sections arrive with their phases. */
export function SettingsPage() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-fg">Settings</h1>

      <AccountSection />

      <section className="card space-y-3 p-4" aria-labelledby="appearance">
        <h2 id="appearance" className="font-semibold text-fg">
          Appearance
        </h2>
        <Segmented<ThemePreference>
          label="Theme"
          value={preference}
          onChange={setPreference}
          options={[
            { value: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
            { value: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
            { value: 'system', label: 'System', icon: <Monitor className="h-4 w-4" /> },
          ]}
        />
      </section>

      <section className="card p-4" aria-labelledby="sources">
        <h2 id="sources" className="font-semibold text-fg">
          Sources
        </h2>
        <Link to="/sources" className="mt-2 inline-flex items-center gap-2 text-sm text-brand-soft hover:underline">
          <Server className="h-4 w-4" /> Manage sources
        </Link>
      </section>

      <section className="card p-4 text-sm text-fg-muted" aria-labelledby="about">
        <h2 id="about" className="font-semibold text-fg">
          About
        </h2>
        <p className="mt-2">ZIPTV {__APP_VERSION__} — personal streaming hub for your own sources.</p>
      </section>
    </div>
  );
}
