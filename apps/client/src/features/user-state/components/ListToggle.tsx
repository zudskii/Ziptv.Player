import type { ListItemType } from '@ziptv/contracts';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '../../../components/ui/Button';
import { errorMessage } from '../../../lib/api-client';
import { useListKeys, useMyList, useToggleListItem } from '../api';

/** "My List" button for details pages (optimistic; `initial` until the list has loaded). */
export function ListToggle({ type, sourceId, itemKey, initial = false }: { type: ListItemType; sourceId: string; itemKey: string; initial?: boolean }) {
  const loaded = Boolean(useMyList().data);
  const keys = useListKeys(sourceId, type);
  const toggle = useToggleListItem();
  const inList = loaded ? keys.has(itemKey) : initial;
  return (
    <Button
      icon={inList ? <BookmarkCheck className="h-4 w-4" /> : <BookmarkPlus className="h-4 w-4" />}
      aria-pressed={inList}
      onClick={() =>
        toggle.mutate(
          { item: { type, sourceId, key: itemKey }, add: !inList },
          { onError: (error) => toast.error(inList ? 'Could not remove from My List' : 'Could not add to My List', { description: errorMessage(error) }) },
        )
      }
    >
      {inList ? 'In My List' : 'My List'}
    </Button>
  );
}
