import { ArrowLeft, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/Button';
import { Img, Initials } from '../../components/ui/Img';
import { catalogImageProxy, imageSources } from '../../lib/images';

interface DetailsHeaderProps {
  sourceId: string;
  type: 'movie' | 'series';
  itemKey: string;
  title: string;
  image: string | null;
  meta: (string | null | undefined)[];
  genres: string[];
  plot: string | null;
  locked: boolean;
  actions: ReactNode;
  children?: ReactNode;
}

/** Poster + backdrop + facts + actions, shared by movie and series details. */
export function DetailsHeader({ sourceId, type, itemKey, title, image, meta, genres, plot, locked, actions, children }: DetailsHeaderProps) {
  const navigate = useNavigate();
  const sources = imageSources(image, catalogImageProxy(sourceId, type, itemKey));
  return (
    <section className="relative overflow-hidden">
      {sources.length > 0 && (
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-25 blur-2xl" aria-hidden>
          <Img sources={sources} className="h-full w-full scale-110" fallback={null} />
        </div>
      )}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-canvas/40 to-canvas" aria-hidden />
      <div className="mx-auto max-w-5xl px-4 pb-6 pt-4 sm:px-6">
        <IconButton label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <div className="mt-2 flex flex-col gap-5 sm:flex-row">
          <Img
            key={`${sourceId}:${itemKey}`}
            sources={sources}
            className="aspect-[2/3] w-36 shrink-0 self-center rounded-xl bg-fg/5 shadow-2xl ring-1 ring-line/10 sm:w-48 sm:self-start"
            fallback={<Initials name={title} className="text-3xl" />}
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-fg sm:text-3xl">{title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
              {meta.filter(Boolean).join(' · ')}
              {locked && (
                <Badge tone="warning" icon={<Lock className="h-3 w-3" />}>
                  Locked
                </Badge>
              )}
            </p>
            {genres.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {genres.map((genre) => (
                  <Badge key={genre}>{genre}</Badge>
                ))}
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
            {plot && <p className="mt-4 max-w-3xl whitespace-pre-line text-sm leading-relaxed text-fg-muted">{plot}</p>}
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
