import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  appendAppointmentEvent,
  eventDetails,
  type BookingAccessRevocationReason,
} from "./appointment-events";
import { lockAppointment } from "./appointments";
import { BookingAccessError, BookingError } from "./errors";

/**
 * Anonymous customer booking access (YASMIN-1F.1) — internal foundation.
 *
 * A customer proves access to ONE appointment with an opaque bearer token:
 * 32 random bytes, base64url-encoded (43 characters). Only its SHA-256 digest
 * (lowercase hex) is stored, on the Appointment itself, so the authorization
 * fact is read under the same appointment row lock every mutation already
 * takes — no new lock in the global order.
 *
 *   issue ──▶ active ──(clock reaches expiresAt)──▶ expired
 *                └────(revokeBookingAccess)──────▶ revoked
 *
 * - The raw token exists only in `issueBookingAccess`'s return value. It is
 *   never persisted, logged, or written into an event.
 * - The appointment id is never a credential: resolution starts from the
 *   token alone, and mutations re-check a grant this module issued.
 * - Expiry is fixed at issuance (BOOKING_ACCESS_TTL_MS), never extended.
 *   A token is valid while now < expiresAt; at expiresAt it has expired.
 * - Time is the database clock. The `clock` options are test seams only; a
 *   public boundary must never derive a clock from request input.
 * - Access says nothing about what the booking allows: checkout eligibility,
 *   cancellation, etc. stay with their own services (BookingError).
 * - Appointments without a token (all pre-existing and admin-created ones)
 *   simply have no public access.
 *
 * Internal: imported by path by the future public booking boundary, not
 * re-exported from the barrel. No HTTP, cookie, or Stripe concerns here.
 */

export const BOOKING_ACCESS_TOKEN_BYTES = 32;

/** Fixed lifetime of a booking-access token. The only place it is defined. */
export const BOOKING_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

/** base64url without padding: 32 bytes → 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface BookingAccessClock {
  now(tx?: Prisma.TransactionClient): Promise<Date>;
}

export const databaseAccessClock: BookingAccessClock = {
  async now(tx) {
    const client = tx ?? prisma;
    const [{ now }] = await client.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return now;
  },
};

export function generateBookingAccessToken(): string {
  return randomBytes(BOOKING_ACCESS_TOKEN_BYTES).toString("base64url");
}

export function isWellFormedBookingAccessToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** SHA-256 of the token, lowercase hex. The token has 256 bits of entropy, so no slow hash or salt is needed. */
export function hashBookingAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function bookingAccessExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + BOOKING_ACCESS_TTL_MS);
}

/** Exactly the columns persisted for a credential — the raw token is not among them. */
export type BookingAccessCredential = {
  accessTokenHash: string;
  accessTokenIssuedAt: Date;
  accessTokenExpiresAt: Date;
};

/** A fresh token and the credential to persist for it. Pure apart from randomness. */
export function newBookingAccessCredential(issuedAt: Date): {
  token: string;
  credential: BookingAccessCredential;
} {
  const token = generateBookingAccessToken();
  return {
    token,
    credential: {
      accessTokenHash: hashBookingAccessToken(token),
      accessTokenIssuedAt: issuedAt,
      accessTokenExpiresAt: bookingAccessExpiry(issuedAt),
    },
  };
}

export type IssuedBookingAccess = {
  /** Returned once. The caller hands it to the browser and drops it. */
  token: string;
  issuedAt: Date;
  expiresAt: Date;
};

/**
 * Issues the appointment's booking-access token inside the caller's
 * transaction (intended: the transaction that creates the hold).
 *
 * An appointment gets at most one token: the write is conditional on no token
 * existing, so a second issuance throws instead of silently rotating.
 * Rotation is not supported.
 */
export async function issueBookingAccess(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  clock: BookingAccessClock = databaseAccessClock,
): Promise<IssuedBookingAccess> {
  const issuedAt = await clock.now(tx);
  const { token, credential } = newBookingAccessCredential(issuedAt);

  const { count } = await tx.appointment.updateMany({
    where: { id: appointmentId, accessTokenHash: null },
    data: credential,
  });
  if (count === 0) {
    const exists = await tx.appointment.findUnique({ where: { id: appointmentId }, select: { id: true } });
    if (!exists) {
      throw new BookingError("APPOINTMENT_NOT_FOUND", `Appointment ${appointmentId} does not exist.`);
    }
    throw new Error(`Appointment ${appointmentId} already has booking access; rotation is not supported.`);
  }

  return { token, issuedAt: credential.accessTokenIssuedAt, expiresAt: credential.accessTokenExpiresAt };
}

/**
 * Proof that a token resolved to `appointmentId`. Only this module creates
 * grants; the digest it was resolved from is kept out of the object (so it
 * cannot leak through logging or serialization) for the under-lock re-check.
 */
export type BookingAccessGrant = Readonly<{ appointmentId: string }>;

const grantDigests = new WeakMap<BookingAccessGrant, string>();

export function isBookingAccessGrant(value: unknown): value is BookingAccessGrant {
  return typeof value === "object" && value !== null && grantDigests.has(value as BookingAccessGrant);
}

/**
 * Resolves a presented token to the appointment it grants access to.
 * Read-only: takes no lock. Throws BookingAccessError (MALFORMED, UNKNOWN,
 * REVOKED, EXPIRED); a public boundary must answer all of them the same way.
 */
export async function resolveBookingAccess(
  token: unknown,
  options: { clock?: BookingAccessClock } = {},
): Promise<BookingAccessGrant> {
  if (!isWellFormedBookingAccessToken(token)) throw new BookingAccessError("MALFORMED");

  const digest = hashBookingAccessToken(token);
  const row = await prisma.appointment.findUnique({
    where: { accessTokenHash: digest },
    select: { id: true, accessTokenExpiresAt: true, accessTokenRevokedAt: true },
  });
  if (!row || !row.accessTokenExpiresAt) throw new BookingAccessError("UNKNOWN");

  assertActive(row.accessTokenRevokedAt, row.accessTokenExpiresAt, await (options.clock ?? databaseAccessClock).now());

  const grant: BookingAccessGrant = Object.freeze({ appointmentId: row.id });
  grantDigests.set(grant, digest);
  return grant;
}

/**
 * Re-validates a grant inside a mutation's transaction, under the appointment
 * row lock (taken here if the caller has not already — re-locking the same
 * row in one transaction does not wait). Call it FIRST, before any Payment or
 * BookingSlot lock, to keep the global lock order.
 *
 * Catches revocation or expiry between resolution and the mutation. Throws
 * BookingAccessError, or Error for an object that is not a grant from
 * `resolveBookingAccess` (a programming error, never an authorization path).
 */
export async function assertBookingAccessUnderLock(
  tx: Prisma.TransactionClient,
  grant: BookingAccessGrant,
  clock: BookingAccessClock = databaseAccessClock,
): Promise<void> {
  const digest = grantDigests.get(grant);
  if (digest === undefined) throw new Error("Not a booking-access grant issued by resolveBookingAccess.");

  const [row] = await tx.$queryRaw<
    { accessTokenHash: string | null; accessTokenExpiresAt: Date | null; accessTokenRevokedAt: Date | null }[]
  >`
    SELECT "accessTokenHash", "accessTokenExpiresAt", "accessTokenRevokedAt"
    FROM "Appointment" WHERE "id" = ${grant.appointmentId} FOR UPDATE
  `;
  if (!row || row.accessTokenHash === null || row.accessTokenExpiresAt === null || !sameDigest(row.accessTokenHash, digest)) {
    throw new BookingAccessError("UNKNOWN");
  }
  assertActive(row.accessTokenRevokedAt, row.accessTokenExpiresAt, await clock.now(tx));
}

function assertActive(revokedAt: Date | null, expiresAt: Date, now: Date): void {
  if (revokedAt !== null) throw new BookingAccessError("REVOKED");
  if (now.getTime() >= expiresAt.getTime()) throw new BookingAccessError("EXPIRED");
}

/** Constant-time comparison of two hex digests. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export type RevokeBookingAccessInput = {
  appointmentId: string;
  reason: BookingAccessRevocationReason;
  /** Who is revoking (e.g. an AdminUser id). Recorded in the event. */
  actorId: string;
};

export type BookingAccessRevocation =
  /** This call revoked the token and appended ACCESS_REVOKED. */
  | { outcome: "revoked"; revokedAt: Date }
  /** Already revoked: nothing written; `revokedAt` is the original revocation. */
  | { outcome: "already-revoked"; revokedAt: Date }
  /** The appointment never had a token: nothing to revoke, nothing written. */
  | { outcome: "not-issued" };

/**
 * Revokes the appointment's booking-access token (internal admin operation;
 * the caller is responsible for authenticating the actor).
 *
 * One READ COMMITTED transaction: lock the appointment, set
 * accessTokenRevokedAt (database clock), append ACCESS_REVOKED. Both commit or
 * neither does. Revocation is permanent; an expired token can still be
 * revoked. Status, payments and existing events are untouched.
 */
export async function revokeBookingAccess(input: RevokeBookingAccessInput): Promise<BookingAccessRevocation> {
  return prisma.$transaction(
    async (tx) => {
      await lockAppointment(tx, input.appointmentId);
      const current = await tx.appointment.findUniqueOrThrow({
        where: { id: input.appointmentId },
        select: { accessTokenHash: true, accessTokenIssuedAt: true, accessTokenExpiresAt: true, accessTokenRevokedAt: true },
      });
      if (current.accessTokenHash === null || !current.accessTokenIssuedAt || !current.accessTokenExpiresAt) {
        return { outcome: "not-issued" };
      }
      if (current.accessTokenRevokedAt !== null) {
        return { outcome: "already-revoked", revokedAt: current.accessTokenRevokedAt };
      }

      const revokedAt = await databaseAccessClock.now(tx);
      const details = eventDetails.accessRevoked({
        reason: input.reason,
        actorId: input.actorId,
        tokenIssuedAt: current.accessTokenIssuedAt,
        tokenExpiresAt: current.accessTokenExpiresAt,
        revokedAt,
      });
      await tx.appointment.update({
        where: { id: input.appointmentId },
        data: { accessTokenRevokedAt: revokedAt },
        select: { id: true },
      });
      await appendAppointmentEvent(tx, input.appointmentId, "ACCESS_REVOKED", details);
      return { outcome: "revoked", revokedAt };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
