import type { PlaylistGroupDto } from '@ziptv/contracts';
import { useId, useState } from 'react';

import { cn } from '../../../lib/cn';
import { NO_GROUP, type GroupChoice } from '../group-choice';

/**
 * Radio list: no group, one of the groups, or a new group named on the spot. Controlled; the
 * parent turns the choice into a request (and creates the new group if asked to).
 */
export function GroupPicker({ groups, value, onChange, noneLabel = 'No group' }: { groups: readonly PlaylistGroupDto[]; value: GroupChoice; onChange: (choice: GroupChoice) => void; noneLabel?: string }) {
  const name = useId();
  const [draft, setDraft] = useState('');
  const option = 'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-fg/5';

  return (
    <div role="radiogroup" className="max-h-64 space-y-0.5 overflow-y-auto">
      <label className={option}>
        <input type="radio" name={name} checked={value.type === 'none'} onChange={() => onChange(NO_GROUP)} className="accent-brand" />
        <span className="text-fg">{noneLabel}</span>
      </label>
      {groups.map((group) => (
        <label key={group.id} className={option}>
          <input type="radio" name={name} checked={value.type === 'group' && value.groupId === group.id} onChange={() => onChange({ type: 'group', groupId: group.id })} className="accent-brand" />
          <span className="min-w-0 flex-1 truncate text-fg">{group.name}</span>
          <span className="text-xs tabular-nums text-fg-subtle">{group.entryCount.toLocaleString()}</span>
        </label>
      ))}
      <label className={cn(option, 'flex-wrap')}>
        <input type="radio" name={name} checked={value.type === 'new'} onChange={() => onChange({ type: 'new', name: draft })} className="accent-brand" />
        <span className="text-fg">New group…</span>
        {value.type === 'new' && (
          <input
            autoFocus
            value={draft}
            maxLength={120}
            placeholder="Group name"
            aria-label="New group name"
            onChange={(event) => {
              setDraft(event.target.value);
              onChange({ type: 'new', name: event.target.value });
            }}
            onClick={(event) => event.preventDefault()}
            className="field ml-auto h-8 w-44"
          />
        )}
      </label>
    </div>
  );
}
