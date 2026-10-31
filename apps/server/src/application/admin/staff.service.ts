import { randomBytes } from 'node:crypto';

import type { CreatedStaffDto, StaffDto } from '@ziptv/contracts';

import { stateHash } from '../../domain/admin/audit.js';
import type { StaffRole } from '../../domain/admin/rbac.js';
import { normalizeEmail } from '../../domain/identity/credentials.js';
import { newEntityId } from '../../domain/shared/ids.js';
import { AppError } from '../errors.js';
import type { AdminTransaction, AdminUnitOfWork, StaffRecord, StaffRepository } from '../ports/admin.js';
import type { Clock } from '../ports/clock.js';
import type { PasswordHasher } from '../ports/password-hasher.js';
import { actorOf, type AdminContext, type StaffPrincipal } from './principal.js';

export function toStaffDto(staff: StaffRecord): StaffDto {
  return {
    id: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    mfaEnabled: staff.mfaEnabledAt !== null,
    disabled: staff.disabledAt !== null,
    mustChangePassword: staff.mustChangePassword,
    lastLoginAt: staff.lastLoginAt?.toISOString() ?? null,
    createdAt: staff.createdAt.toISOString(),
  };
}

/** What is fingerprinted in audit entries (never secrets or password hashes). */
const auditState = (staff: StaffRecord) => ({ email: staff.email, name: staff.name, role: staff.role, disabled: staff.disabledAt !== null, mfa: staff.mfaEnabledAt !== null });

function temporaryPassword(): string {
  return randomBytes(15).toString('base64url'); // 20 chars, 120 bits
}

/** Staff administration (SUPER_ADMIN). Every change is audited in the same transaction. */
export class StaffService {
  constructor(
    private readonly deps: {
      staff: StaffRepository;
      uow: AdminUnitOfWork;
      hasher: PasswordHasher;
      clock: Clock;
    },
  ) {}

  async list(): Promise<StaffDto[]> {
    return (await this.deps.staff.list()).map(toStaffDto);
  }

  async create(actor: StaffPrincipal, input: { email: string; name: string; role: StaffRole }, context: AdminContext): Promise<CreatedStaffDto> {
    const email = normalizeEmail(input.email);
    if (await this.deps.staff.findByEmail(email)) throw new AppError('EMAIL_TAKEN', 409, 'A staff member with this email already exists.');
    const password = temporaryPassword();
    const passwordHash = await this.deps.hasher.hash(password);
    const now = this.deps.clock.now();
    const staff = await this.deps.uow.run(async (tx) => {
      const created = await tx.staff.create({ id: newEntityId(), email, name: input.name.trim(), role: input.role, passwordHash, now });
      await tx.audit.append({ ...this.entry(actor, context, 'staff.created', created), beforeHash: null, afterHash: stateHash(auditState(created)), details: { email, role: input.role } });
      return created;
    });
    return { staff: toStaffDto(staff), temporaryPassword: password };
  }

  async update(actor: StaffPrincipal, id: string, patch: { name?: string | undefined; role?: StaffRole | undefined; disabled?: boolean | undefined }, context: AdminContext): Promise<StaffDto> {
    const updated = await this.deps.uow.run(async (tx) => {
      // Two administrators demoting each other at once must not leave zero super admins.
      await tx.staff.lockAdministration();
      const before = await this.require(tx, id);
      if (id === actor.id && (patch.role !== undefined || patch.disabled !== undefined)) {
        throw AppError.forbidden('You cannot change your own role or disable yourself. Ask another administrator.');
      }
      const losesSuper = before.role === 'SUPER_ADMIN' && !before.disabledAt && ((patch.role !== undefined && patch.role !== 'SUPER_ADMIN') || patch.disabled === true);
      if (losesSuper && (await tx.staff.countActiveSuperAdmins()) <= 1) {
        throw new AppError('LAST_SUPER_ADMIN', 409, 'This is the last active super administrator.');
      }
      const now = this.deps.clock.now();
      const after = await tx.staff.update(
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.disabled !== undefined ? { disabledAt: patch.disabled ? (before.disabledAt ?? now) : null } : {}),
        },
        now,
      );
      // A disabled account or a changed role must not keep working sessions with old permissions.
      const signedOut = patch.disabled === true || (patch.role !== undefined && patch.role !== before.role) ? await tx.staffSessions.deleteForStaff(id) : 0;
      await tx.audit.append({
        ...this.entry(actor, context, 'staff.updated', before),
        beforeHash: stateHash(auditState(before)),
        afterHash: stateHash(auditState(after!)),
        details: { changes: diff(auditState(before), auditState(after!)), sessionsSignedOut: signedOut },
      });
      return after!;
    });
    return toStaffDto(updated);
  }

  async resetMfa(actor: StaffPrincipal, id: string, context: AdminContext): Promise<StaffDto> {
    if (id === actor.id) throw AppError.forbidden('Ask another administrator to reset your two-factor authentication.');
    const updated = await this.deps.uow.run(async (tx) => {
      const before = await this.require(tx, id);
      const after = await tx.staff.update(id, { mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null }, this.deps.clock.now());
      await tx.staff.resetMfaFailures(id); // also lifts a lock-out
      const signedOut = await tx.staffSessions.deleteForStaff(id);
      await tx.audit.append({ ...this.entry(actor, context, 'staff.mfa_reset', before), beforeHash: stateHash(auditState(before)), afterHash: stateHash(auditState(after!)), details: { sessionsSignedOut: signedOut } });
      return after!;
    });
    return toStaffDto(updated);
  }

  async resetPassword(actor: StaffPrincipal, id: string, context: AdminContext): Promise<CreatedStaffDto> {
    if (id === actor.id) throw AppError.forbidden('Change your own password from your profile.');
    const password = temporaryPassword();
    const passwordHash = await this.deps.hasher.hash(password);
    const updated = await this.deps.uow.run(async (tx) => {
      const before = await this.require(tx, id);
      const after = await tx.staff.update(id, { passwordHash, mustChangePassword: true }, this.deps.clock.now());
      await tx.staff.resetMfaFailures(id);
      const signedOut = await tx.staffSessions.deleteForStaff(id);
      await tx.audit.append({ ...this.entry(actor, context, 'staff.password_reset', before), details: { sessionsSignedOut: signedOut } });
      return after!;
    });
    return { staff: toStaffDto(updated), temporaryPassword: password };
  }

  private async require(tx: AdminTransaction, id: string): Promise<StaffRecord> {
    const staff = await tx.staff.findById(id);
    if (!staff) throw AppError.notFound('Staff member');
    return staff;
  }

  private entry(actor: StaffPrincipal, context: AdminContext, action: string, target: StaffRecord) {
    return { ...actorOf(actor, context), occurredAt: this.deps.clock.now(), action, targetType: 'staff', targetId: target.id, beforeHash: null, afterHash: null };
  }
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  return changes;
}
