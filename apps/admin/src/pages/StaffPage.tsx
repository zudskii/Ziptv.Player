import type { CreatedStaffDto, StaffDto, StaffRole } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Badge, Button, DataTable, Dialog, ErrorNote, Field, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatTime } from '../lib/nav';

const ROLES: { value: StaffRole; label: string; description: string }[] = [
  { value: 'SUPER_ADMIN', label: 'Super admin', description: 'Everything, including staff management' },
  { value: 'CONTENT_MANAGER', label: 'Content manager', description: 'Channels, providers, rights' },
  { value: 'NOC_OPERATOR', label: 'NOC operator', description: 'Monitoring and failover' },
  { value: 'SUPPORT_AGENT', label: 'Support agent', description: 'Subscribers and support cases' },
  { value: 'FINANCE', label: 'Finance', description: 'Billing and reports' },
  { value: 'VIEW_ONLY', label: 'View only', description: 'Read-only access' },
];

export function StaffPage() {
  const { me, can } = useAuth();
  const client = useQueryClient();
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => api<StaffDto[]>('/staff') });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<CreatedStaffDto | null>(null);
  const writable = can('staff:write');

  const refresh = () => client.invalidateQueries({ queryKey: ['staff'] });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<{ role: StaffRole; disabled: boolean }> }) => api<StaffDto>(`/staff/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      toast.success('Staff member updated');
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const resetMfa = useMutation({
    mutationFn: (id: string) => api<StaffDto>(`/staff/${id}/reset-mfa`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Two-factor reset: they enrol again at next sign-in');
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const resetPassword = useMutation({
    mutationFn: (id: string) => api<CreatedStaffDto>(`/staff/${id}/reset-password`, { method: 'POST' }),
    onSuccess: (result) => {
      setSecret(result);
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <>
      <PageHeader
        title="Staff"
        description="Console accounts. Roles decide what each person may do; every change is audited."
        actions={
          writable ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> Add staff member
            </Button>
          ) : undefined
        }
      />
      <ErrorNote error={staff.error} />
      <DataTable
        label="Staff"
        rows={staff.data ?? []}
        rowKey={(row) => row.id}
        empty={staff.isPending ? 'Loading…' : 'No staff yet.'}
        columns={[
          {
            header: 'Name',
            cell: (row) => (
              <div>
                <p className="font-medium">
                  {row.name} {row.id === me?.id && <span className="text-xs text-fg-subtle">(you)</span>}
                </p>
                <p className="text-xs text-fg-muted">{row.email}</p>
              </div>
            ),
          },
          {
            header: 'Role',
            cell: (row) =>
              writable && row.id !== me?.id ? (
                <select
                  aria-label={`Role of ${row.name}`}
                  className="field w-auto py-1"
                  value={row.role}
                  onChange={(e) => update.mutate({ id: row.id, patch: { role: e.target.value as StaffRole } })}
                >
                  {ROLES.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge>{ROLES.find((role) => role.value === row.role)?.label ?? row.role}</Badge>
              ),
          },
          {
            header: 'Status',
            cell: (row) => (
              <div className="flex flex-wrap gap-1">
                {row.disabled ? <Badge tone="danger">Disabled</Badge> : <Badge tone="ok">Active</Badge>}
                {!row.mfaEnabled && <Badge tone="warn">2FA not set up</Badge>}
                {row.mustChangePassword && <Badge>Temporary password</Badge>}
              </div>
            ),
          },
          { header: 'Last sign-in', cell: (row) => formatTime(row.lastLoginAt), className: 'whitespace-nowrap' },
          {
            header: 'Actions',
            cell: (row) =>
              writable && row.id !== me?.id ? (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => update.mutate({ id: row.id, patch: { disabled: !row.disabled } })}>{row.disabled ? 'Enable' : 'Disable'}</Button>
                  <Button onClick={() => resetMfa.mutate(row.id)}>Reset 2FA</Button>
                  <Button onClick={() => resetPassword.mutate(row.id)}>Reset password</Button>
                </div>
              ) : null,
          },
        ]}
      />
      <CreateStaffDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(result) => {
          setCreating(false);
          setSecret(result);
          void refresh();
        }}
      />
      <Dialog open={secret !== null} title="Temporary password" onClose={() => setSecret(null)}>
        <p className="text-sm text-fg-muted">
          Give this password to <b className="text-fg">{secret?.staff.email}</b> through a secure channel. It is shown only once; they must replace it and set up two-factor authentication at first sign-in.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-lg bg-sunken px-3 py-2 font-mono text-sm">{secret?.temporaryPassword}</code>
          <Button
            aria-label="Copy password"
            onClick={() => {
              void navigator.clipboard.writeText(secret?.temporaryPassword ?? '');
              toast.success('Copied');
            }}
          >
            <Copy className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="flex justify-end">
          <Button tone="primary" onClick={() => setSecret(null)}>
            Done
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function CreateStaffDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (result: CreatedStaffDto) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('VIEW_ONLY');
  const create = useMutation({
    mutationFn: () => api<CreatedStaffDto>('/staff', { method: 'POST', body: { email, name, role } }),
    onSuccess: (result) => {
      setEmail('');
      setName('');
      setRole('VIEW_ONLY');
      onCreated(result);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} title="Add staff member" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="block space-y-1.5">
          <span className="text-sm text-fg-muted">Role</span>
          <select className="field" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            {ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} — {option.description}
              </option>
            ))}
          </select>
        </label>
        <ErrorNote error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
