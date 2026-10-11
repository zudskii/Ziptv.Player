import type { SourceDto } from '@ziptv/contracts';
import { KeyRound, Link2, RefreshCw, TriangleAlert, Upload } from 'lucide-react';

import { Button } from '../../../components/ui/Button';
import { SOURCE_PROBLEMS } from '../../../lib/problems';

interface SourceProblemNoticeProps {
  source: SourceDto;
  onRetry?: () => void;
  onEdit?: () => void;
  retrying?: boolean;
}

/** Per-problem UX for a failed sync: what happened and the one action that fixes it. */
export function SourceProblemNotice({ source, onRetry, onEdit, retrying }: SourceProblemNoticeProps) {
  const error = source.sync.error;
  if (!error) return null;
  const copy = SOURCE_PROBLEMS[error.problem];
  const credentialProblem = error.problem === 'auth_failed' || error.problem === 'expired' || error.problem === 'invalid' || error.problem === 'blocked';

  return (
    <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">{copy.title}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{copy.description}</p>
          {error.message && error.message !== copy.description && <p className="mt-1 text-xs text-fg-subtle">{error.message}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {credentialProblem && onEdit && source.type !== 'm3u_file' && (
              <Button size="sm" variant="primary" icon={source.type === 'xtream' ? <KeyRound className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />} onClick={onEdit}>
                {source.type === 'xtream' ? 'Update credentials' : 'Update playlist link'}
              </Button>
            )}
            {source.type === 'm3u_file' && onEdit && (
              <Button size="sm" variant="primary" icon={<Upload className="h-3.5 w-3.5" />} onClick={onEdit}>
                Upload a new file
              </Button>
            )}
            {onRetry && source.type !== 'm3u_file' && (
              <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRetry} loading={retrying}>
                Retry now
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
