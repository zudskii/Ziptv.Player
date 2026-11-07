import type { OperatorVodItemDto } from '@ziptv/contracts';
import { Check, Lock } from 'lucide-react';

import { Badge } from '../../components/ui/Badge';
import { t } from '../../i18n';

/** What the entitlement engine says about a title for this viewer: in the plan, or an upgrade. */
export function AccessBadge({ access }: { access: OperatorVodItemDto['access'] }) {
  if (access === 'included') return <Badge tone="success" icon={<Check className="h-3 w-3" />}>{t('films.included')}</Badge>;
  if (access === 'upgrade') return <Badge tone="brand" icon={<Lock className="h-3 w-3" />}>{t('films.upgrade')}</Badge>;
  return <Badge tone="neutral">{t('films.unavailable')}</Badge>;
}
