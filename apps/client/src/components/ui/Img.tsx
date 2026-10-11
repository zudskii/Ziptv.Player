import { useState, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { colorFor } from '../../lib/colors';

interface ImgProps {
  /** Candidate URLs, best first (direct → proxy). */
  sources: string[];
  alt?: string;
  className?: string;
  imgClassName?: string;
  fallback: ReactNode;
  fit?: 'contain' | 'cover';
}

/** Image with a fallback chain; remount with a new `key` to reset. */
export function Img({ sources, alt = '', className, imgClassName, fallback, fit = 'cover' }: ImgProps) {
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];
  return (
    <div className={cn('overflow-hidden', className)}>
      {src ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className={cn('h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover', imgClassName)}
          onError={() => setAttempt((value) => value + 1)}
        />
      ) : (
        fallback
      )}
    </div>
  );
}

/** Deterministic initials tile for items without artwork. */
export function Initials({ name, className }: { name: string; className?: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <span className={cn('flex h-full w-full items-center justify-center text-xs font-semibold text-white', className)} style={{ backgroundColor: colorFor(name) }} aria-hidden>
      {letters || '?'}
    </span>
  );
}
