import type { AdminUserDetailDto } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import { Badge, Button, DataTable, Dialog, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatTime } from '../lib/nav';

export function UserDetailPage() {
  const { userId = '' } = useParams();
  const { can } = useAuth();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const user = useQuery({ queryKey: ['user', userId], queryFn: () => api<AdminUserDetailDto>(`/users/${userId}`) });
  const revoke = useMutation({
    mutationFn: () => api<{ revoked: number }>(`/users/${userId}/revoke-sessions`, { method: 'POST' }),
    onSuccess: async (result) => {
      toast.success(`Signed out ${result.revoked} device${result.revoked === 1 ? '' : 's'}`);
      setConfirm(false);
      await client.invalidateQueries({ queryKey: ['user', userId] });
    },
  });

  if (user.isPending) return <Spinner />;
  if (user.error) return <ErrorNote error={user.error} />;
  const data = user.data;
  return (
    <>
      <Link to="/users" className="text-sm text-fg-muted hover:text-fg">
        ← Subscribers
      </Link>
      <PageHeader
        title={data.email ?? `Guest ${data.id.slice(-8)}`}
        description={`Account ${data.id} · created ${formatTime(data.createdAt)}`}
        actions={
          can('users:write') && data.sessionsList.length > 0 ? (
            <Button tone="danger" onClick={() => setConfirm(true)}>
              <LogOut className="h-4 w-4" aria-hidden /> Sign out all devices
            </Button>
          ) : undefined
        }
      />
      <div className="mb-6 flex flex-wrap gap-2">
        {data.isGuest ? <Badge>Guest</Badge> : <Badge tone={data.emailVerified ? 'ok' : 'neutral'}>{data.emailVerified ? 'Email verified' : 'Email not verified'}</Badge>}
        <Badge>Last seen {formatTime(data.lastSeenAt)}</Badge>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-fg-muted">Devices</h2>
      <DataTable
        label="Devices"
        rows={data.sessionsList}
        rowKey={(row) => row.id}
        empty="No signed-in devices."
        columns={[
          { header: 'Device', cell: (row) => <span className="text-fg-muted">{row.userAgent ?? 'Unknown'}</span> },
          { header: 'Signed in', cell: (row) => formatTime(row.createdAt) },
          { header: 'Last active', cell: (row) => formatTime(row.lastSeenAt) },
          { header: 'Expires', cell: (row) => (row.expiresAt ? formatTime(row.expiresAt) : 'Never (guest)') },
        ]}
      />

      <h2 className="mb-3 mt-8 text-sm font-semibold text-fg-muted">Sources</h2>
      <DataTable
        label="Sources"
        rows={data.sourcesList}
        rowKey={(row) => row.id}
        empty="No sources."
        columns={[
          { header: 'Name', cell: (row) => row.name },
          { header: 'Type', cell: (row) => <Badge>{row.type}</Badge> },
          { header: 'Status', cell: (row) => <Badge tone={row.status === 'failed' ? 'danger' : row.status === 'idle' ? 'ok' : 'warn'}>{row.status}</Badge> },
          { header: 'Last sync', cell: (row) => formatTime(row.lastSuccessAt) },
        ]}
      />

      <Dialog open={confirm} title="Sign out all devices?" onClose={() => setConfirm(false)}>
        <p className="text-sm text-fg-muted">Every device of this account is signed out and its streams stop. The subscriber is notified. This is recorded in the audit log.</p>
        <ErrorNote error={revoke.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button tone="danger" busy={revoke.isPending} onClick={() => revoke.mutate()}>
            Sign out all devices
          </Button>
        </div>
      </Dialog>
    </>
  );
}
