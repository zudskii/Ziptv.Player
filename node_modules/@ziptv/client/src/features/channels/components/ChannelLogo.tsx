import type { ChannelDto } from '@ziptv/contracts';
import { useState } from 'react';

import { config, resolveApiUrl } from '../../../config';
import { cn } from '../../../lib/cn';

interface ChannelLogoProps {
  playlistId: string;
  channel: Pick<ChannelDto, 'key' | 'name' | 'logo'>;
  className?: string;
}

/**
 * Logo with graceful degradation: direct URL → server logo proxy (mixed content, hotlink
 * protection) → generated initials. Remount with `key={channel.key}` to reset the chain.
 */
export function ChannelLogo({ playlistId, channel, className }: ChannelLogoProps) {
  const sources = logoSources(playlistId, channel);
  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];

  return (
    <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/5 ring-1 ring-inset ring-white/5', className)}>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="h-full w-full object-contain p-0.5"
          onError={() => setAttempt((value) => value + 1)}
        />
      ) : (
        <Initials name={channel.name} />
      )}
    </div>
  );
}

function logoSources(playlistId: string, channel: Pick<ChannelDto, 'key' | 'logo'>): string[] {
  const { logo } = channel;
  if (!logo) return [];
  if (logo.startsWith('data:')) return [logo];
  const proxied = resolveApiUrl(`/api/v1/media/logos/${playlistId}/${channel.key}`);
  // http:// images are blocked (or silently upgraded and broken) on https pages.
  if (config.isSecurePage && logo.startsWith('http:')) return [proxied];
  return [logo, proxied];
}

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <span className="flex h-full w-full items-center justify-center text-xs font-semibold text-white" style={{ backgroundColor: colorFor(name) }} aria-hidden>
      {letters || '?'}
    </span>
  );
}

/** Deterministic, readable background colour per channel name. */
function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 32%)`;
}
