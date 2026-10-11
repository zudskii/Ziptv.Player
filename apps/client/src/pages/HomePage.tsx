import { ArrowRight, Tv } from 'lucide-react';
import { Link, Navigate } from 'react-router';

import { Spinner } from '../components/ui/Spinner';
import { useSources } from '../features/sources/api';
import { describeLibrary, describeSync } from '../features/sources/source-status';

/** Home (interim): becomes the streaming dashboard (GET /home) in Phase 3. */
export function HomePage() {
  const sources = useSources();
  if (sources.isPending) return <Spinner className="py-24" />;
  if (sources.data && sources.data.length === 0) return <Navigate to="/welcome" replace />;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-fg">Home</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {(sources.data ?? []).map((source) => (
          <Link key={source.id} to={`/live/${source.id}`} className="card flex items-center gap-3 p-4 hover:bg-fg/5">
            <Tv className="h-6 w-6 text-brand-soft" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-fg">{source.name}</span>
              <span className="block truncate text-xs text-fg-muted">{describeLibrary(source)}</span>
              <span className="block truncate text-xs text-fg-subtle">{describeSync(source)}</span>
            </span>
            <ArrowRight className="h-4 w-4 text-fg-subtle" />
          </Link>
        ))}
      </div>
    </div>
  );
}
