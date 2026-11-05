import type { SourceDto } from '@ziptv/contracts';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Brand } from '../../components/layout/Brand';
import { Button } from '../../components/ui/Button';
import { useSources } from '../../features/sources/api';
import { AddSourceForm } from '../../features/sources/components/AddSourceForm';
import { SourceProblemNotice } from '../../features/sources/components/SourceProblemNotice';
import { SyncProgress } from '../../features/sources/components/SyncProgress';
import { describeLibrary } from '../../features/sources/source-status';
import { t } from '../../i18n';

type Step = 'add' | 'building';

/**
 * `/setup` — adding a source with its first sync shown step by step: Add your source (M3U / Xtream)
 * → Connecting… Parsing channels… Matching EPG… Building your library… → Home. Reached from the
 * "Add a source" of every empty screen; the welcome (choosing how to get in) is `/welcome`.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const sources = useSources();
  const [step, setStep] = useState<Step>('add');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = sources.data?.find((item) => item.id === sourceId);
  const ready = source && source.revision > 0 && source.sync.status !== 'running' && source.sync.status !== 'queued';

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-[radial-gradient(60rem_30rem_at_50%_-10%,rgb(59_130_246/0.18),transparent)] px-4 py-10">
      <div className="mb-8">
        <Brand />
      </div>
      <div className="card w-full max-w-lg p-6 shadow-2xl sm:p-8">
        {step === 'add' && (
          <div>
            <h1 className="text-xl font-semibold text-fg">{t('setup.title')}</h1>
            <p className="mt-1 mb-5 text-sm text-fg-muted">{t('setup.subtitle')}</p>
            <AddSourceForm
              submitLabel={t('setup.continue')}
              onAdded={(added: SourceDto) => {
                setSourceId(added.id);
                setStep('building');
              }}
            />
            <Link to="/" className="mt-4 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
              <ArrowLeft className="h-4 w-4" /> {t('setup.back')}
            </Link>
          </div>
        )}

        {step === 'building' && (
          <div>
            <h1 className="text-xl font-semibold text-fg">{ready ? t('setup.ready') : t('setup.settingUp')}</h1>
            <p className="mt-1 text-sm text-fg-muted">{source ? (ready ? describeLibrary(source) : source.name) : t('setup.connecting')}</p>
            {source?.sync.status === 'failed' && source.revision === 0 ? (
              <div className="mt-6 space-y-4">
                <SourceProblemNotice source={source} onEdit={() => setStep('add')} />
                <Button variant="ghost" onClick={() => setStep('add')}>
                  {t('setup.tryAnother')}
                </Button>
              </div>
            ) : (
              <SyncProgress source={source ?? { revision: 0, sync: { status: 'queued', stage: null } as SourceDto['sync'] }} className="mt-6" />
            )}
            {ready && (
              <Button variant="primary" size="lg" className="mt-8 w-full" icon={<ArrowRight className="h-5 w-5" />} onClick={() => navigate('/', { replace: true })}>
                {t('setup.goHome')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
