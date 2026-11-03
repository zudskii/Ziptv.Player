import type { ChangeRequestedDto, ChangeRequestPageDto, MasterChannelPageDto, PackageDetailDto, PackageDto } from '@ziptv/contracts';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';

import { Badge, Button, DataTable, Dialog, ErrorNote, Field, KeyValues, PageHeader, Section, SelectField, Spinner, TextArea } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, money } from '../lib/format';
import { useAction } from '../lib/mutation';

const sentForApproval = (result: unknown, applied: string) => toast.success(typeof result === 'object' && result !== null && 'changeRequest' in result ? 'Sent for approval — a second person must approve it in Approvals' : applied);

/** 9.6 — packages (what is sold) and their channels. Every change is approved by a second person. */
export function PackagesPage() {
  const { can } = useAuth();
  const packages = useQuery({ queryKey: ['packages'], queryFn: () => api<PackageDto[]>('/packages') });
  const pending = useQuery({ queryKey: ['change-requests', 'packages'], queryFn: () => api<ChangeRequestPageDto>('/change-requests?status=pending&kind=package.create') });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Packages & rights"
        description="Packages viewers can buy. Price, limits, status and channels change only with a second person's approval; channel rights are on each channel's page."
        actions={
          can('billing:write') ? (
            <Button tone="primary" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New package
            </Button>
          ) : undefined
        }
      />
      {pending.data && pending.data.items.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {pending.data.items.map((request) => (
            <li key={request.id} className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-amber-200">
              Waiting for approval: {request.summary} — <Link className="underline" to="/approvals">Approvals</Link>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={packages.error} />
      <DataTable
        label="Packages"
        rows={packages.data ?? []}
        rowKey={(row) => row.id}
        empty={packages.isPending ? 'Loading…' : 'No packages yet.'}
        columns={[
          { header: 'Package', cell: (row) => <Link to={`/packages/${row.id}`} className="font-medium text-amber-200 hover:underline">{row.name}</Link> },
          { header: 'Status', cell: (row) => <Badge tone={row.status === 'active' ? 'ok' : row.status === 'draft' ? 'warn' : 'neutral'}>{row.status}</Badge> },
          { header: 'Price', cell: (row) => `${money({ currency: row.currency, amountMinor: row.priceMinor })} / ${row.billingPeriod}`, className: 'whitespace-nowrap' },
          { header: 'Trial', cell: (row) => (row.trialDays ? `${row.trialDays} days` : '—') },
          { header: 'Limits', cell: (row) => `${row.maxStreams} streams · ${row.maxDevices} devices` },
          { header: 'Channels', cell: (row) => row.channels, className: 'tabular-nums' },
          { header: 'Model', cell: (row) => row.businessModel },
        ]}
      />
      <PackageDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function PackageDetailPage() {
  const { packageId = '' } = useParams();
  const { can } = useAuth();
  const pkg = useQuery({ queryKey: ['package', packageId], queryFn: () => api<PackageDetailDto>(`/packages/${packageId}`) });
  const requests = useQuery({ queryKey: ['change-requests', 'package', packageId], queryFn: () => api<ChangeRequestPageDto>(`/change-requests?targetId=${packageId}&limit=10`) });
  const channels = useQuery({ queryKey: ['channels', 'all'], queryFn: () => api<MasterChannelPageDto>('/channels?limit=200'), enabled: can('catalog:read') });
  const [editing, setEditing] = useState(false);
  const [channelEditing, setChannelEditing] = useState(false);
  if (pkg.isPending) return <Spinner />;
  if (pkg.error) return <ErrorNote error={pkg.error} />;
  const data = pkg.data;
  const names = new Map(channels.data?.items.map((channel) => [channel.id, channel.name]));
  const open = requests.data?.items.find((request) => request.status === 'pending');
  return (
    <>
      <Link to="/packages" className="text-sm text-fg-muted hover:text-fg">
        ← Packages
      </Link>
      <PageHeader
        title={data.name}
        description={`/${data.slug} · created ${formatDate(data.createdAt)}`}
        actions={
          can('billing:write') && !open ? (
            <>
              <Button onClick={() => setChannelEditing(true)}>Change channels</Button>
              <Button tone="primary" onClick={() => setEditing(true)}>
                Change terms
              </Button>
            </>
          ) : undefined
        }
      />
      {open && (
        <p className="mb-4 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-amber-200">
          Waiting for approval: {open.summary} (requested by {open.requestedBy.name}). Further changes are possible once it is decided — <Link className="underline" to="/approvals">Approvals</Link>
        </p>
      )}
      <Section title="Terms">
        <KeyValues
          rows={[
            ['Status', <Badge key="s" tone={data.status === 'active' ? 'ok' : data.status === 'draft' ? 'warn' : 'neutral'}>{data.status}</Badge>],
            ['Price', `${money({ currency: data.currency, amountMinor: data.priceMinor })} / ${data.billingPeriod}`],
            ['Free trial', data.trialDays ? `${data.trialDays} days` : 'none'],
            ['Simultaneous streams', data.maxStreams],
            ['Devices', data.maxDevices],
            ['Business model', data.businessModel],
            ['Description', data.description || '—'],
          ]}
        />
      </Section>
      <Section title={`Channels (${data.channelIds.length})`}>
        <ul className="flex flex-wrap gap-2">
          {data.channelIds.map((id) => (
            <li key={id}>
              <Link to={`/channels/${id}`}>
                <Badge>{names.get(id) ?? id.slice(-8)}</Badge>
              </Link>
            </li>
          ))}
          {data.channelIds.length === 0 && <li className="text-sm text-fg-muted">No channels yet.</li>}
        </ul>
      </Section>
      <Section title="Change history">
        <DataTable
          label="Package change requests"
          rows={requests.data?.items ?? []}
          rowKey={(row) => row.id}
          empty="No changes requested yet."
          columns={[
            { header: 'Change', cell: (row) => row.summary },
            { header: 'Status', cell: (row) => <Badge tone={row.status === 'applied' ? 'ok' : row.status === 'pending' ? 'warn' : row.status === 'withdrawn' ? 'neutral' : 'danger'}>{row.status}</Badge> },
            { header: 'Requested', cell: (row) => `${row.requestedBy.name} · ${formatDate(row.requestedAt)}` },
            { header: 'Decided', cell: (row) => (row.decidedBy ? `${row.decidedBy.name} · ${formatDate(row.decidedAt)}` : '—') },
          ]}
        />
      </Section>
      <PackageDialog open={editing} pkg={data} onClose={() => setEditing(false)} />
      <ChannelPicker open={channelEditing} pkg={data} onClose={() => setChannelEditing(false)} />
    </>
  );
}

/** Create (no `pkg`) or change the terms of a package — both go to approval. */
function PackageDialog({ open, pkg, onClose }: { open: boolean; pkg?: PackageDetailDto; onClose: () => void }) {
  const save = useAction((body: Record<string, unknown>) => api<ChangeRequestedDto | PackageDetailDto>(pkg ? `/packages/${pkg.id}` : '/packages', { method: pkg ? 'PATCH' : 'POST', body }), {
    inlineErrors: true,
    invalidate: [['packages'], ['package'], ['change-requests']],
    onSuccess: (result) => {
      sentForApproval(result, pkg ? 'Package updated' : 'Package created');
      onClose();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const body: Record<string, unknown> = {
      name: value('name'),
      description: value('description'),
      priceMinor: Math.round(Number(value('price')) * 100),
      currency: value('currency').toUpperCase(),
      billingPeriod: value('period'),
      trialDays: Number(value('trial') || 0),
      maxStreams: Number(value('streams')),
      maxDevices: Number(value('devices')),
    };
    if (pkg) {
      body.status = value('status');
      // Only what changed: the request summary (and the approver) see exactly that.
      const current: Record<string, unknown> = { name: pkg.name, description: pkg.description, priceMinor: pkg.priceMinor, currency: pkg.currency, billingPeriod: pkg.billingPeriod, trialDays: pkg.trialDays, maxStreams: pkg.maxStreams, maxDevices: pkg.maxDevices, status: pkg.status };
      for (const key of Object.keys(body)) if (body[key] === current[key]) delete body[key];
      if (Object.keys(body).length === 0) return onClose();
    }
    save.mutate(body);
  };
  return (
    <Dialog open={open} title={pkg ? `Change ${pkg.name}` : 'New package'} onClose={onClose}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Name" name="name" defaultValue={pkg?.name} required maxLength={100} />
        <TextArea label="Description" name="description" defaultValue={pkg?.description} maxLength={1000} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Price" name="price" type="number" step="0.01" min="0" required defaultValue={pkg ? pkg.priceMinor / 100 : ''} />
          <Field label="Currency" name="currency" maxLength={3} required defaultValue={pkg?.currency ?? 'GEL'} />
          <SelectField label="Per" name="period" defaultValue={pkg?.billingPeriod ?? 'month'}>
            <option value="month">month</option>
            <option value="year">year</option>
          </SelectField>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Trial days" name="trial" type="number" min="0" max="90" defaultValue={pkg?.trialDays ?? 0} />
          <Field label="Streams" name="streams" type="number" min="1" max="20" required defaultValue={pkg?.maxStreams ?? 1} />
          <Field label="Devices" name="devices" type="number" min="1" max="50" required defaultValue={pkg?.maxDevices ?? 3} />
        </div>
        {pkg && (
          <SelectField label="Status" name="status" defaultValue={pkg.status}>
            <option value="draft">Draft (not sold)</option>
            <option value="active">Active (on sale)</option>
            <option value="retired">Retired (no new sales; holders keep access)</option>
          </SelectField>
        )}
        <p className="text-xs text-fg-subtle">Price changes apply to new checkouts; existing subscribers keep what they pay.</p>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" busy={save.isPending}>
            Request approval
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChannelPicker({ open, pkg, onClose }: { open: boolean; pkg: PackageDetailDto; onClose: () => void }) {
  return (
    <Dialog open={open} title={`Channels of ${pkg.name}`} onClose={onClose}>
      {/* Mounted per opening: starts from the package's current channels. */}
      {open && <ChannelPickerBody pkg={pkg} onClose={onClose} />}
    </Dialog>
  );
}

function ChannelPickerBody({ pkg, onClose }: { pkg: PackageDetailDto; onClose: () => void }) {
  const [selected, setSelected] = useState<string[]>(pkg.channelIds);
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const results = useQuery({ queryKey: ['channels', 'picker', q], queryFn: () => api<MasterChannelPageDto>(`/channels?limit=50&status=active${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const all = useQuery({ queryKey: ['channels', 'all'], queryFn: () => api<MasterChannelPageDto>('/channels?limit=200') });
  const names = new Map(all.data?.items.map((channel) => [channel.id, channel.name]));
  const save = useAction((channelIds: string[]) => api<ChangeRequestedDto | PackageDetailDto>(`/packages/${pkg.id}`, { method: 'PATCH', body: { channelIds } }), {
    inlineErrors: true,
    invalidate: [['package'], ['change-requests']],
    onSuccess: (result) => {
      sentForApproval(result, 'Channels updated');
      onClose();
    },
  });
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {selected.map((id) => (
          <button key={id} type="button" onClick={() => setSelected(selected.filter((item) => item !== id))} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-xs text-amber-200" aria-label={`Remove ${names.get(id) ?? id}`}>
            {names.get(id) ?? id.slice(-8)} <X className="h-3 w-3" />
          </button>
        ))}
        {selected.length === 0 && <span className="text-xs text-fg-muted">No channels selected.</span>}
      </div>
      <Field label="Add channels" placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} />
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {results.data?.items
          .filter((channel) => !selected.includes(channel.id))
          .map((channel) => (
            <li key={channel.id}>
              <button type="button" onClick={() => setSelected([...selected, channel.id])} className="w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-line/10">
                + {channel.name} <span className="text-xs text-fg-subtle">{channel.activeGrants ? '' : '(no rights yet)'}</span>
              </button>
            </li>
          ))}
      </ul>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" busy={save.isPending} onClick={() => save.mutate(selected)}>
          Request approval
        </Button>
      </div>
    </>
  );
}
