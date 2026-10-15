import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { findAdminByEmail, normalizeAdminEmail, revokeAllAdminSessions } from "./auth";
import { adminPasswordProblem, hashAdminPassword, ADMIN_PASSWORD_PARAMS } from "./password";

/**
 * Administrator provisioning (YASMIN-2A) — the ONLY way an admin password is
 * set. There is no registration route and no default credential. Operators
 * run it through scripts/admin-provision.ts, which confirms the target
 * database before calling these functions.
 *
 * - Creates the AdminUser for an email, or replaces an existing admin's
 *   password, in one READ COMMITTED transaction.
 * - A password change revokes every active session of that admin.
 * - Re-provisioning does NOT re-enable a disabled admin (`enable` does).
 * - Rows are never deleted; disabling sets disabledAt and revokes sessions.
 */

export class AdminProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminProvisioningError";
  }
}

export type ProvisionResult = { adminUserId: string; email: string; created: boolean; revokedSessions: number; disabled: boolean };

type Params = typeof ADMIN_PASSWORD_PARAMS | { N: number; r: number; p: number };

export async function provisionAdminPassword(
  input: { email: string; password: string },
  options: { hashParams?: Params } = {},
): Promise<ProvisionResult> {
  const email = normalizeAdminEmail(input.email);
  if (!email) throw new AdminProvisioningError("Enter a valid email address.");
  const problem = adminPasswordProblem(input.password, email);
  if (problem) throw new AdminProvisioningError(problem);
  const passwordHash = await hashAdminPassword(input.password, options.hashParams);

  return prisma.$transaction(async (tx) => {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const matches = await tx.adminUser.count({ where: { email: { equals: email, mode: "insensitive" } } });
    if (matches > 1) throw new AdminProvisioningError("Several AdminUser rows match this email case-insensitively; resolve them first.");
    const existing = await findAdminByEmail(email, tx);
    if (!existing) {
      const created = await tx.adminUser.create({ data: { email, passwordHash, passwordUpdatedAt: now } });
      return { adminUserId: created.id, email, created: true, revokedSessions: 0, disabled: false };
    }
    await tx.adminUser.update({ where: { id: existing.id }, data: { passwordHash, passwordUpdatedAt: now } });
    const revokedSessions = await revokeAllAdminSessions(existing.id, tx);
    return { adminUserId: existing.id, email: existing.email, created: false, revokedSessions, disabled: existing.disabledAt !== null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

/** Disables (enabled=false) or re-enables an existing admin. Disabling revokes all sessions. */
export async function setAdminEnabled(emailInput: string, enabled: boolean): Promise<ProvisionResult> {
  const email = normalizeAdminEmail(emailInput);
  if (!email) throw new AdminProvisioningError("Enter a valid email address.");
  return prisma.$transaction(async (tx) => {
    const existing = await findAdminByEmail(email, tx);
    if (!existing) throw new AdminProvisioningError("No administrator has this email.");
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    await tx.adminUser.update({ where: { id: existing.id }, data: { disabledAt: enabled ? null : (existing.disabledAt ?? now) } });
    const revokedSessions = enabled ? 0 : await revokeAllAdminSessions(existing.id, tx);
    return { adminUserId: existing.id, email: existing.email, created: false, revokedSessions, disabled: !enabled };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
