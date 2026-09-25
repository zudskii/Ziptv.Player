import { FileUp, Globe, Keyboard, Layers, MonitorPlay, ShieldCheck, Zap } from 'lucide-react';
import type { ComponentType } from 'react';
import { Link } from 'react-router';

import { Brand } from '../components/layout/Brand';
import { SiteFooter } from '../components/layout/SiteFooter';

const LOGOS = ['setanta.png', 'premier.png', 'uefa.jpg', 'netflix.png', 'universal.png', 'cooking.jpg', 'bbc.svg', 'cartoon.svg', 'discovery.png'];

const FEATURES: { icon: ComponentType<{ className?: string }>; title: string; text: string }[] = [
  { icon: FileUp, title: 'Any M3U playlist', text: 'Extended and plain M3U/M3U8 and PLS, in any encoding. Groups, logos and names are read exactly as your provider wrote them.' },
  { icon: Globe, title: 'Import by URL', text: 'Paste your provider link and refresh it any time to pick up new channels and rotated tokens.' },
  { icon: Zap, title: 'Streams that just play', text: 'HLS, MPEG-TS, FLV, MP4 and DASH. HTTP-only and header-protected streams are routed through a secure proxy automatically.' },
  { icon: Layers, title: 'Groups, search, favorites', text: 'Instant search across thousands of channels, favorites and recently watched — per playlist.' },
  { icon: Keyboard, title: 'Remote-friendly', text: 'Keyboard and TV-remote shortcuts for play, volume, fullscreen and channel up/down.' },
  { icon: ShieldCheck, title: 'No account needed', text: 'Your playlists are private to your browser session. Nothing to sign up for.' },
];

export function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-white/5 bg-ink-900/80 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Brand />
          <Link
            to="/watch"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white shadow-lg shadow-brand/20 hover:bg-brand-strong"
          >
            <MonitorPlay className="h-4 w-4" /> Open player
          </Link>
        </nav>
      </header>

      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgba(59,130,246,0.25),transparent)]" />
          <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 text-center sm:pt-28">
            <h1 className="text-4xl font-bold leading-tight tracking-tight text-white sm:text-6xl">
              All your channels.
              <br />
              <span className="bg-gradient-to-r from-brand-soft to-cyan-300 bg-clip-text text-transparent">One player.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-300">
              Upload an M3U playlist or paste your provider's URL and start watching in seconds — organised by groups, searchable and with
              favorites.
            </p>
            <div className="mt-10 flex flex-wrap justify-center gap-3">
              <Link to="/watch" className="inline-flex h-12 items-center gap-2 rounded-xl bg-brand px-6 font-semibold text-white shadow-xl shadow-brand/25 hover:bg-brand-strong">
                <MonitorPlay className="h-5 w-5" /> Start watching
              </Link>
              <a href="#features" className="inline-flex h-12 items-center rounded-xl px-6 font-medium text-slate-200 ring-1 ring-inset ring-white/15 hover:bg-white/5">
                How it works
              </a>
            </div>
          </div>
        </section>

        <section aria-label="Channel logos" className="relative overflow-hidden border-y border-white/5 bg-ink-850/60 py-8">
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-ink-900 to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-ink-900 to-transparent" />
          <div className="flex w-max animate-marquee gap-12 motion-reduce:animate-none">
            {[...LOGOS, ...LOGOS].map((logo, index) => (
              <div key={`${logo}-${index}`} className="flex h-16 w-32 items-center justify-center rounded-xl bg-white/90 p-2 shadow-lg">
                <img src={`/brand/${logo}`} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20">
          <h2 className="text-center text-3xl font-bold text-white">Built for real-world playlists</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-slate-400">
            Provider playlists are messy. ZIPTV is designed to read them faithfully and play as many streams as a browser possibly can.
          </p>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <article key={title} className="rounded-2xl border border-white/5 bg-ink-850/70 p-6">
                <div className="inline-flex rounded-lg bg-brand/10 p-2.5 text-brand-soft">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
