import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { cn } from '../../lib/cn';
import { catalogImageProxy, imageSources, type CatalogImageType } from '../../lib/images';
import { Img, Initials } from '../ui/Img';
import { ProgressBar } from '../ui/ProgressBar';

interface PosterCardProps {
  to: string;
  sourceId: string;
  type: CatalogImageType;
  itemKey: string;
  title: string;
  image: string | null;
  subtitle?: string | null;
  /** 0..1 watch progress. */
  progress?: number | null;
  locked?: boolean;
  badge?: ReactNode;
  /** Inside a Rail: fixed width + snap; in a grid: fluid. */
  layout?: 'rail' | 'grid';
}

/** 2:3 poster card for movies and series (also used for channels with a logo). */
export function PosterCard({ to, sourceId, type, itemKey, title, image, subtitle, progress, locked, badge, layout = 'rail' }: PosterCardProps) {
  return (
    <Link
      to={to}
      role={layout === 'rail' ? 'listitem' : undefined}
      className={cn('group block min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand', layout === 'rail' && 'w-32 shrink-0 snap-start sm:w-40')}
      title={title}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-fg/5 ring-1 ring-inset ring-line/5">
        <Img
          key={`${sourceId}:${type}:${itemKey}`}
          sources={imageSources(image, catalogImageProxy(sourceId, type, itemKey))}
          fit={type === 'channel' ? 'contain' : 'cover'}
          className="h-full w-full transition-transform duration-300 group-hover:scale-[1.03]"
          imgClassName={type === 'channel' ? 'p-4' : undefined}
          fallback={<Initials name={title} className="text-2xl" />}
        />
        {locked && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-black/70 p-1 text-white" title="Locked">
            <Lock className="h-3 w-3" />
          </span>
        )}
        {badge && <span className="absolute left-1.5 top-1.5">{badge}</span>}
        {progress !== undefined && progress !== null && progress > 0 && <ProgressBar value={progress} className="absolute inset-x-1.5 bottom-1.5 w-auto bg-black/40" />}
      </div>
      <p className="mt-1.5 truncate text-sm font-medium text-fg group-hover:text-brand-soft">{title}</p>
      {subtitle && <p className="truncate text-xs text-fg-subtle">{subtitle}</p>}
    </Link>
  );
}
