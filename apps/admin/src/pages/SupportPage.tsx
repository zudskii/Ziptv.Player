import type { AdminUserPageDto, SupportNoteDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { Link } from 'react-router';

import { Badge, ErrorNote, PageHeader, Section } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatTime } from '../lib/nav';
import { Incidents } from './MonitoringPage';
import { statusLabel, t } from '../i18n';

/** 9.8 — support desk: find a subscriber, the latest support notes, what is broken right now. */
export function SupportPage() {
  const { can } = useAuth();
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const users = useQuery({ queryKey: ['users', 'support', q], queryFn: () => api<AdminUserPageDto>(`/users?limit=10&q=${encodeURIComponent(q)}`), enabled: q.length >= 2 && can('users:read') });
  const notes = useQuery({ queryKey: ['support-notes'], queryFn: () => api<SupportNoteDto[]>('/support/notes?limit=30') });
  return (
    <>
      <PageHeader title={t('support.title')} description={t('support.intro')} />
      {can('users:read') && (
        <Section title={t('support.find')}>
          <label className="relative block max-w-md">
            <span className="sr-only">{t('support.placeholder')}</span>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-fg-subtle" aria-hidden />
            <input className="field pl-9" placeholder={t('support.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {users.data && (
            <ul className="mt-2 max-w-md space-y-1" aria-label={t('support.matching')}>
              {users.data.items.map((user) => (
                <li key={user.id}>
                  <Link to={`/users/${user.id}`} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-line/10">
                    <span className="text-amber-200">{user.email ?? t('people.guestId', { id: user.id.slice(-8) })}</span>
                    <span className="flex gap-1">
                      {user.blocked && <Badge tone="danger">{t('support.blocked')}</Badge>}
                      {user.subscription && <Badge tone="ok">{statusLabel(user.subscription)}</Badge>}
                    </span>
                  </Link>
                </li>
              ))}
              {users.data.items.length === 0 && <li className="px-3 py-2 text-sm text-fg-muted">{t('support.noMatch')}</li>}
            </ul>
          )}
        </Section>
      )}
      {can('monitoring:read') && (
        <Section title={t('support.openIncidents')} description={t('support.openIncidentsHint')}>
          <Incidents compact />
        </Section>
      )}
      <Section title={t('support.latestNotes')}>
        <ErrorNote error={notes.error} />
        <ul className="space-y-2">
          {notes.data?.map((note) => (
            <li key={note.id} className="card p-3 text-sm">
              <p className="whitespace-pre-wrap">{note.body}</p>
              <p className="mt-1 text-xs text-fg-muted">
                <Link to={`/users/${note.userId}`} className="text-amber-200 hover:underline">
                  {note.userEmail ?? note.userId.slice(-8)}
                </Link>{' '}
                · {note.author.name} · {formatTime(note.createdAt)}
              </p>
            </li>
          ))}
          {notes.data?.length === 0 && <li className="text-sm text-fg-muted">{t('support.noNotes')}</li>}
        </ul>
      </Section>
    </>
  );
}
