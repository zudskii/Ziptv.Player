import type { SourceDto } from '@ziptv/contracts';
import { ArrowRight, Clapperboard, LayoutGrid, MonitorPlay, Sparkles, Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { Brand } from '../../components/layout/Brand';
import { Button } from '../../components/ui/Button';
import { useSources } from '../../features/sources/api';
import { AddSourceForm } from '../../features/sources/components/AddSourceForm';
import { SourceProblemNotice } from '../../features/sources/components/SourceProblemNotice';
import { SyncProgress } from '../../features/sources/components/SyncProgress';
import { describeLibrary } from '../../features/sources/source-status';

type Step = 'welcome' | 'add' | 'building';

/**
 * First run: Welcome to ZIPTV → Add your source (M3U / Xtream) →
 * Connecting… Parsing channels… Matching EPG… Building your library… → Home.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const sources = useSources();
  const [step, setStep] = useState<Step>('welcome');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = sources.data?.find((item) => item.id === sourceId);
  const ready = source && source.revision > 0 && source.sync.status !== 'running' && source.sync.status !== 'queued';

  // Someone who already has sources (e.g. opened /welcome by hand) goes straight home.
  useEffect(() => {
    if (step === 'welcome' && sources.data && sources.data.length > 0) navigate('/', { replace: true });
  }, [step, sources.data, navigate]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgb(59_130_246/0.18),transparent)] px-4 py-10">
      <div className="mb-8">
        <Brand />
      </div>
      <div className="card w-full max-w-lg p-6 shadow-2xl sm:p-8">
        {step === 'welcome' && (
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-fg">Welcome to ZIPTV</h1>
            <p className="mt-3 text-fg-muted">Your personal streaming hub: Live TV with a programme guide, movies and series — all from your own sources.</p>
            <ul className="mx-auto mt-6 grid max-w-sm grid-cols-2 gap-3 text-left text-sm text-fg-muted">
              <Feature icon={<Tv className="h-4 w-4" />}>Live TV</Feature>
              <Feature icon={<LayoutGrid className="h-4 w-4" />}>TV Guide</Feature>
              <Feature icon={<Clapperboard className="h-4 w-4" />}>Movies</Feature>
              <Feature icon={<MonitorPlay className="h-4 w-4" />}>Series</Feature>
            </ul>
            <Button variant="primary" size="lg" className="mt-8 w-full" icon={<Sparkles className="h-5 w-5" />} onClick={() => setStep('add')}>
              Add your source
            </Button>
          </div>
        )}

        {step === 'add' && (
          <div>
            <h1 className="text-xl font-semibold text-fg">Add your source</h1>
            <p className="mt-1 mb-5 text-sm text-fg-muted">An M3U playlist (link or file) or your Xtream Codes account.</p>
            <AddSourceForm
              submitLabel="Continue"
              onAdded={(added: SourceDto) => {
                setSourceId(added.id);
                setStep('building');
              }}
            />
          </div>
        )}

        {step === 'building' && (
          <div>
            <h1 className="text-xl font-semibold text-fg">{ready ? 'Your library is ready' : 'Setting things up…'}</h1>
            <p className="mt-1 text-sm text-fg-muted">{source ? (ready ? describeLibrary(source) : source.name) : 'Connecting…'}</p>
            {source?.sync.status === 'failed' && source.revision === 0 ? (
              <div className="mt-6 space-y-4">
                <SourceProblemNotice source={source} onEdit={() => setStep('add')} />
                <Button variant="ghost" onClick={() => setStep('add')}>
                  Try another source
                </Button>
              </div>
            ) : (
              <SyncProgress source={source ?? { revision: 0, sync: { status: 'queued', stage: null } as SourceDto['sync'] }} className="mt-6" />
            )}
            {ready && (
              <Button variant="primary" size="lg" className="mt-8 w-full" icon={<ArrowRight className="h-5 w-5" />} onClick={() => navigate('/', { replace: true })}>
                Go to Home
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Feature({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-fg/5 px-3 py-2">
      <span className="text-brand-soft">{icon}</span>
      {children}
    </li>
  );
}
