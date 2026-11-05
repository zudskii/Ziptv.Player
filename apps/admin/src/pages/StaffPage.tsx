import type { CreatedStaffDto, StaffDto, StaffRole } from '@ziptv/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Badge, Button, DataTable, Dialog, ErrorNote, Field, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatTime } from '../lib/nav';
import { t, tx } from '../i18n';

const ROLES: { value: StaffRole; readonly label: string; readonly description: string }[] = (['SUPER_ADMIN', 'CONTENT_MANAGER', 'NOC_OPERATOR', 'SUPPORT_AGENT', 'FINANCE', 'VIEW_ONLY'] as const).map((value) => ({
  value,
  get label() {
    return t(`staffx.role.${value}.label`);
  },
  get description() {
    return t(`staffx.role.${value}.description`);
  },
}));

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
      toast.success(t('staff.updated'));
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const resetMfa = useMutation({
    mutationFn: (id: string) => api<StaffDto>(`/staff/${id}/reset-mfa`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('staff.mfaReset'));
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
        title={t('common.staff')}
        description={t('staff.intro')}
        actions={
          writable ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <UserPlus className="h-4 w-4" aria-hidden /> {t('staff.add')}
            </Button>
          ) : undefined
        }
      />
      <ErrorNote error={staff.error} />
      <DataTable
        label={t('common.staff')}
        rows={staff.data ?? []}
        rowKey={(row) => row.id}
        empty={staff.isPending ? t('common.loading') : t('staff.none')}
        columns={[
          {
            header: t('common.name'),
            cell: (row) => (
              <div>
                <p className="font-medium">
                  {row.name} {row.id === me?.id && <span className="text-xs text-fg-subtle">{t('staff.you')}</span>}
                </p>
                <p className="text-xs text-fg-muted">{row.email}</p>
              </div>
            ),
          },
          {
            header: t('common.role'),
            cell: (row) =>
              writable && row.id !== me?.id ? (
                <select
                  aria-label={t('staffx.roleOf', { name: row.name })}
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
            header: t('common.status'),
            cell: (row) => (
              <div className="flex flex-wrap gap-1">
                {row.disabled ? <Badge tone="danger">{t('staff.disabled')}</Badge> : <Badge tone="ok">{t('common.activeCap')}</Badge>}
                {!row.mfaEnabled && <Badge tone="warn">{t('staff.no2fa')}</Badge>}
                {row.mustChangePassword && <Badge>{t('staff.temporary')}</Badge>}
              </div>
            ),
          },
          { header: t('staff.lastSignIn'), cell: (row) => formatTime(row.lastLoginAt), className: 'whitespace-nowrap' },
          {
            header: t('staff.actions'),
            cell: (row) =>
              writable && row.id !== me?.id ? (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => update.mutate({ id: row.id, patch: { disabled: !row.disabled } })}>{row.disabled ? t('staff.enable') : t('staff.disable')}</Button>
                  <Button onClick={() => resetMfa.mutate(row.id)}>{t('staff.resetMfa')}</Button>
                  <Button onClick={() => resetPassword.mutate(row.id)}>{t('staff.resetPassword')}</Button>
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
      <Dialog open={secret !== null} title={t('staff.temporary')} onClose={() => setSecret(null)}>
        <p className="text-sm text-fg-muted">
          {tx('staffx.giveTo', { email: secret?.staff.email ?? '', b: (chunks) => <b className="text-fg">{chunks}</b> })}
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-lg bg-sunken px-3 py-2 font-mono text-sm">{secret?.temporaryPassword}</code>
          <Button
            aria-label={t('staff.copyPassword')}
            onClick={() => {
              void navigator.clipboard.writeText(secret?.temporaryPassword ?? '');
              toast.success(t('staff.copied'));
            }}
          >
            <Copy className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="flex justify-end">
          <Button tone="primary" onClick={() => setSecret(null)}>
            {t('staff.done')}
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
    <Dialog open={open} title={t('staff.add')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('common.name')} required value={name} onChange={(e) => setName(e.target.value)} />
        <Field label={t('common.email')} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="block space-y-1.5">
          <span className="text-sm text-fg-muted">{t('common.role')}</span>
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
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button tone="primary" type="submit" busy={create.isPending}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
