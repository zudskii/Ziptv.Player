import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';

import { IconButton } from '../ui/Button';

interface RailProps {
  title: string;
  /** "See all" target. */
  to?: string;
  action?: ReactNode;
  children: ReactNode;
}

/** Horizontally scrolling row of cards (Home, Movies, Series). Touch scrolls natively; arrows on desktop. */
export function Rail({ title, to, action, children }: RailProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (direction: 1 | -1) => scroller.current?.scrollBy({ left: direction * scroller.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex items-center gap-2 px-4 sm:px-6">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-fg sm:text-lg">{title}</h2>
        {action}
        {to && (
          <Link to={to} className="shrink-0 text-sm text-brand-soft hover:underline">
            See all
          </Link>
        )}
        <div className="hidden shrink-0 gap-1 md:flex">
          <IconButton label={`Scroll ${title} left`} onClick={() => scroll(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton label={`Scroll ${title} right`} onClick={() => scroll(1)}>
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <div ref={scroller} className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto scroll-smooth px-4 pb-2 sm:scroll-px-6 sm:px-6" role="list">
        {children}
      </div>
    </section>
  );
}
