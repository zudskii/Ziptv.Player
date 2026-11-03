import type { AccountBillingDto, EntitlementDto, InvoiceDto } from '@ziptv/contracts';

import { isEntitlementActive } from '../../domain/commerce/entitlement.js';
import type { Viewer } from '../identity/viewer.js';
import type { Clock } from '../ports/clock.js';
import type { CommerceRepository, EntitlementRecord, InvoiceRecord, PackageRecord } from '../ports/commerce.js';
import type { BillingService } from './billing.service.js';
import type { EntitlementService } from './entitlement.service.js';
import type { PlaybackAuthorizationService } from './playback-authorization.service.js';

/** Account → Subscription & devices: one read model for the viewer and for support staff. */
export class AccountBillingService {
  constructor(
    private readonly deps: {
      commerce: CommerceRepository;
      billing: Pick<BillingService, 'toDto'>;
      entitlements: Pick<EntitlementService, 'viewerAccess'>;
      authorization: Pick<PlaybackAuthorizationService, 'devices' | 'playing'>;
      clock: Clock;
    },
  ) {}

  async summary(viewer: Pick<Viewer, 'userId'> & Partial<Viewer>, currentDeviceId: string | null = null): Promise<AccountBillingDto> {
    const { commerce } = this.deps;
    const [subscription, access, invoices, devices, playing] = await Promise.all([
      commerce.liveSubscription(viewer.userId),
      this.deps.entitlements.viewerAccess(viewer),
      commerce.invoicesOf(viewer.userId),
      this.deps.authorization.devices(viewer as Viewer, currentDeviceId),
      this.deps.authorization.playing(viewer.userId),
    ]);
    const packages = new Map((await commerce.findPackages([...new Set(access.entitlements.map((entitlement) => entitlement.packageId))])).map((pkg) => [pkg.id, pkg]));
    const now = this.deps.clock.now();
    return {
      subscription: subscription ? await this.deps.billing.toDto(subscription) : null,
      entitlements: access.entitlements.filter((entitlement) => !entitlement.revokedAt).map((entitlement) => toEntitlementDto(entitlement, packages.get(entitlement.packageId), now)),
      invoices: invoices.map(toInvoiceDto),
      limits: access.limits,
      devices,
      playing,
    };
  }
}

export function toEntitlementDto(entitlement: EntitlementRecord, pkg: PackageRecord | undefined, now: Date): EntitlementDto {
  return {
    id: entitlement.id,
    package: { id: entitlement.packageId, slug: pkg?.slug ?? '', name: pkg?.name ?? '' },
    kind: entitlement.kind,
    startsAt: entitlement.startsAt.toISOString(),
    endsAt: entitlement.endsAt?.toISOString() ?? null,
    active: isEntitlementActive({ packageId: entitlement.packageId, startsAt: entitlement.startsAt, endsAt: entitlement.endsAt, revoked: entitlement.revokedAt !== null }, now),
  };
}

export function toInvoiceDto(invoice: InvoiceRecord): InvoiceDto {
  return { id: invoice.id, amountMinor: invoice.amountMinor, currency: invoice.currency, status: invoice.status, periodStart: invoice.periodStart.toISOString(), periodEnd: invoice.periodEnd.toISOString(), paidAt: invoice.paidAt.toISOString() };
}
