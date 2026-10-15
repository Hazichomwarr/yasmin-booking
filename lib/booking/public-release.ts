import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { assertBookingAccessUnderLock, resolveBookingAccess } from "./access";
import { appendAppointmentEvent, eventDetails } from "./appointment-events";
import { lockAppointment } from "./appointments";
import { BookingError } from "./errors";
import { decideTransition } from "./lifecycle-policy";

/** A release was refused because payment evidence might still require action. */
export class PublicBookingReleaseConflictError extends Error {
  readonly code = "PUBLIC_BOOKING_RELEASE_CONFLICT";
  constructor() { super("The booking cannot safely be released."); }
}

/**
 * Cancels an unpaid reservation owned by `accessToken`, preserving every row
 * and revoking the one browser credential. A Payment is deliberately a hard
 * stop: an open/uncertain Session or received payment can never release
 * capacity through the customer surface. So is any unresolved payment
 * exception naming the booking (verified Stripe evidence awaiting a person).
 *
 * Lock order: the Appointment row first, as Checkout and fulfillment do, so a
 * Payment created by a concurrent Checkout start is either committed (and
 * seen here) or blocked until this release commits (and then refused).
 */
export async function releaseAuthorizedPublicBooking(
  accessToken: unknown,
  dependencies: { beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void> } = {},
): Promise<{ released: boolean }> {
  const grant = await resolveBookingAccess(accessToken);
  return prisma.$transaction(async (tx) => {
    const appointment = await lockAppointment(tx, grant.appointmentId);
    await assertBookingAccessUnderLock(tx, grant);
    const credential = await tx.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
      select: { accessTokenIssuedAt: true, accessTokenExpiresAt: true },
    });
    const payment = await tx.payment.findFirst({
      where: { appointmentId: appointment.id, purpose: "BOOKING_DEPOSIT" },
      select: { id: true },
    });
    if (payment) throw new PublicBookingReleaseConflictError();
    const [{ unresolved }] = await tx.$queryRaw<{ unresolved: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "PaymentProcessingException"
        WHERE "expectedAppointmentId" = ${appointment.id}
          AND ("resolvedAt" IS NULL OR "lastObservedAt" > "resolvedAt")
      ) AS unresolved
    `;
    if (unresolved) throw new PublicBookingReleaseConflictError();
    if (appointment.status === "CANCELLED") return { released: false };
    if (appointment.status !== "PENDING_PAYMENT") throw new PublicBookingReleaseConflictError();
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    const transition = decideTransition("cancel", appointment.status);
    if (transition.kind !== "apply") return { released: false };
    await tx.appointment.update({
      where: { id: appointment.id },
      data: { status: transition.to, accessTokenRevokedAt: now },
    });
    await appendAppointmentEvent(tx, appointment.id, transition.event, eventDetails.statusChanged(appointment.status, transition.to));
    if (!credential.accessTokenIssuedAt || !credential.accessTokenExpiresAt) {
      throw new BookingError("BOOKING_NOT_PAYABLE", "Public credential state is incomplete.");
    }
    await appendAppointmentEvent(tx, appointment.id, "ACCESS_REVOKED", eventDetails.accessRevoked({
      reason: "customer-release",
      actorId: "public-booking-release",
      tokenIssuedAt: credential.accessTokenIssuedAt,
      tokenExpiresAt: credential.accessTokenExpiresAt,
      revokedAt: now,
    }));
    await dependencies.beforeCommit?.(tx);
    return { released: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
