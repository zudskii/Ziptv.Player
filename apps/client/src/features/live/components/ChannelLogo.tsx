import type { ChannelDto } from '@ziptv/contracts';

import { Img, Initials } from '../../../components/ui/Img';
import { catalogImageProxy, imageSources } from '../../../lib/images';
import { cn } from '../../../lib/cn';

interface ChannelLogoProps {
  sourceId: string;
  channel: Pick<ChannelDto, 'key' | 'name' | 'logo'>;
  className?: string;
}

/**
 * Logo with graceful degradation: direct URL → server image proxy (mixed content, hotlink
 * protection) → generated initials. Remount with `key={channel.key}` to reset the chain.
 */
export function ChannelLogo({ sourceId, channel, className }: ChannelLogoProps) {
  return (
    <Img
      key={`${sourceId}:${channel.key}`}
      sources={imageSources(channel.logo, catalogImageProxy(sourceId, 'channel', channel.key))}
      fit="contain"
      className={cn('flex shrink-0 items-center justify-center rounded-md bg-fg/5 ring-1 ring-inset ring-line/5', className)}
      imgClassName="p-0.5"
      fallback={<Initials name={channel.name} />}
    />
  );
}
