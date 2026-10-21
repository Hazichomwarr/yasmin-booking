import type { BookingConfirmationEmail, ConfirmationEmailKind } from "@prisma/client";

import { formatSalonAddress } from "@/lib/booking/location-address";
import { PUBLIC_EMAIL_PATTERN } from "@/lib/booking/public-booking-rules";
import { prisma } from "@/lib/prisma";

/**
 * Booking confirmation email outbox (YASMIN-1G).
 *
 * Payment fulfillment writes independent customer and owner notification rows
 * in the same
 * transaction that confirms the appointment; nothing here runs inside it, so
 * fulfillment never depends on email. This worker delivers rows afterwards.
 *
 *   PENDING ──claim──▶ SENDING ──provider ok──▶ SENT
 *      ▲                  │
 *      └──── FAILED ◀─────┘ provider error / timeout (retried until MAX_ATTEMPTS)
 *
 * - Claims are conditional updates on (state, attemptCount), so concurrent
 *   workers can never both claim one row. attemptCount is also the fence: a
 *   worker only completes the attempt it claimed, so a stale worker that
 *   returns after its lease was taken over cannot overwrite the newer result.
 * - A SENDING row whose lease (SENDING_LEASE_MS since lastAttemptAt, by the
 *   database clock) has passed belongs to a worker that crashed or hung; the
 *   next run takes it over as a new attempt.
 * - Delivery is AT LEAST ONCE. A timeout or lost response after the provider
 *   accepted the message is an unknown outcome. Every attempt for a row sends
 *   the same Resend Idempotency-Key, which Resend de-duplicates for 24 hours;
 *   a retry after that window can produce a duplicate email.
 * - Rows that exhaust MAX_ATTEMPTS stay FAILED (terminal) and visible, with
 *   a non-sensitive lastError; nothing deletes them.
 * - Marketing consent plays no part: this is a transactional message.
 */

export const MAX_ATTEMPTS = 5;
export const SENDING_LEASE_MS = 10 * 60_000;
export const PROVIDER_TIMEOUT_MS = 10_000;

export type ConfirmationMessage = { to: string; subject: string; text: string };
type Env = Readonly<Record<string, string | undefined>>;

export type ConfirmationEmailAdapter = {
  send(message: ConfirmationMessage, options: { idempotencyKey: string }): Promise<{ id: string }>;
};

/** A provider failure. `outcome-unknown`: the provider may have accepted the message. */
export class ConfirmationEmailDeliveryError extends Error {
  constructor(readonly kind: "rejected" | "outcome-unknown") {
    super(`Confirmation email delivery failed (${kind}).`);
    this.name = "ConfirmationEmailDeliveryError";
  }
}

/** A server configuration problem, never a customer-address or provider error. */
export class ConfirmationEmailConfigurationError extends Error {
  constructor(readonly code: "owner-recipient-not-configured") {
    super("Salon notification recipient is not configured.");
    this.name = "ConfirmationEmailConfigurationError";
  }
}

/** Resend's HTTP API works in Vercel/serverless without an SMTP socket. */
export function resendConfirmationEmailAdapter(): ConfirmationEmailAdapter {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BOOKING_FROM_EMAIL;
  if (!key || !from) throw new Error("Confirmation email requires RESEND_API_KEY and BOOKING_FROM_EMAIL.");
  return {
    async send(message, { idempotencyKey }) {
      let response: Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
      } catch {
        throw new ConfirmationEmailDeliveryError("outcome-unknown");
      }
      if (response.status >= 500 || response.status === 429) throw new ConfirmationEmailDeliveryError("outcome-unknown");
      if (!response.ok) throw new ConfirmationEmailDeliveryError("rejected");
      const body = await response.json().catch(() => ({})) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id) throw new ConfirmationEmailDeliveryError("outcome-unknown");
      return { id: body.id };
    },
  };
}

/** The same key for every attempt of one outbox row. Not a secret; no customer data. */
export function confirmationIdempotencyKey(row: Pick<BookingConfirmationEmail, "id" | "kind">): string {
  return `booking-notification/${row.kind.toLowerCase()}/${row.id}`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Built only from booking-time snapshots and the location's contact details,
 * so retries send an identical payload (required by the idempotency key).
 * Never includes tokens, links, identifiers or payment-provider details.
 */
type NotificationRow = {
  appointmentId: string;
  recipientEmail: string | null;
  kind?: ConfirmationEmailKind;
  appointment: {
    locationNameSnapshot: string;
    appointmentDate: Date;
    slotTimeSnapshot: string;
    hairstyleNameSnapshot: string | null;
    hairstyleVariantNameSnapshot: string | null;
    totalPriceCents: number;
    depositAmountCents: number;
    balanceDueCents: number;
    customer: { name: string; email: string; phone: string };
    location: {
      addressLine1: string | null;
      addressLine2: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
      phone: string | null;
    };
  };
};

/** Exact server-only owner-recipient validation; never falls back to customer data. */
export function salonNotificationRecipient(env: Env = process.env): string {
  const email = env.SALON_NOTIFICATION_EMAIL?.trim().toLowerCase() ?? "";
  if (!email || email.length > 254 || !PUBLIC_EMAIL_PATTERN.test(email)) {
    throw new ConfirmationEmailConfigurationError("owner-recipient-not-configured");
  }
  return email;
}

/** Stable non-secret reference for staff and customer correspondence. */
export function bookingReference(appointmentId: string): string {
  return `YB-${appointmentId.slice(-8).toUpperCase()}`;
}

export function confirmationMessage(row: NotificationRow, env: Env = process.env): ConfirmationMessage {
  const { appointment } = row;
  const { location } = appointment;
  const address = formatSalonAddress(location);
  const style = [appointment.hairstyleNameSnapshot, appointment.hairstyleVariantNameSnapshot].filter(Boolean).join(" — ");
  const reference = bookingReference(row.appointmentId);
  const schedule = `${appointment.locationNameSnapshot} · ${appointment.appointmentDate.toISOString().slice(0, 10)} at ${appointment.slotTimeSnapshot} ET`;

  if (row.kind === "OWNER_NEW_BOOKING") {
    return {
      to: salonNotificationRecipient(env),
      subject: `New booking confirmed · ${reference}`,
      text: [
        "New confirmed appointment.",
        `Booking reference: ${reference}`,
        `Customer: ${appointment.customer.name}`,
        `Email: ${appointment.customer.email}`,
        `Phone: ${appointment.customer.phone}`,
        schedule,
        style && `Style: ${style}`,
        `Total: ${money(appointment.totalPriceCents)}`,
        `Deposit paid: ${money(appointment.depositAmountCents)}`,
        `Balance due at salon: ${money(appointment.balanceDueCents)}`,
      ].filter(Boolean).join("\n"),
    };
  }

  if (!row.recipientEmail) throw new ConfirmationEmailConfigurationError("owner-recipient-not-configured");
  return {
    to: row.recipientEmail,
    subject: "Your Yasmin's Beauty Salon appointment is confirmed",
    text: [
      "Your appointment is confirmed.",
      `Booking reference: ${reference}`,
      schedule,
      style && `Style: ${style}`,
      address && `Location: ${address}`,
      `Total: ${money(appointment.totalPriceCents)}`,
      `Deposit paid: ${money(appointment.depositAmountCents)} (nonrefundable)`,
      `Balance due after service: ${money(appointment.balanceDueCents)}`,
      location.phone && `Contact: ${location.phone}`,
    ].filter(Boolean).join("\n"),
  };
}

export type DeliveryRunSummary = { sent: number; failed: number; exhausted: number };

/**
 * One worker run over at most `limit` due rows. Safe to invoke concurrently
 * and repeatedly. `afterClaim` is an internal test seam only.
 */
export async function deliverPendingConfirmationEmails(
  adapter: ConfirmationEmailAdapter,
  options: { limit?: number; afterClaim?: (rowId: string) => Promise<void>; env?: () => Env } = {},
): Promise<DeliveryRunSummary> {
  const summary: DeliveryRunSummary = { sent: 0, failed: 0, exhausted: 0 };
  const now = await databaseNow();
  const staleBefore = new Date(now.getTime() - SENDING_LEASE_MS);
  const due = await prisma.bookingConfirmationEmail.findMany({
    where: {
      OR: [
        { state: { in: ["PENDING", "FAILED"] }, attemptCount: { lt: MAX_ATTEMPTS } },
        { state: "SENDING", lastAttemptAt: { lte: staleBefore } },
      ],
    },
    take: options.limit ?? 10,
    orderBy: { createdAt: "asc" },
    include: { appointment: { include: { location: true, customer: true } } },
  });

  for (const row of due) {
    const sameClaim = { id: row.id, state: row.state, attemptCount: row.attemptCount, lastAttemptAt: row.lastAttemptAt };
    if (row.attemptCount >= MAX_ATTEMPTS) {
      // A worker died during the final attempt: its outcome is unknown, and no retries remain.
      const ended = await prisma.bookingConfirmationEmail.updateMany({ where: sameClaim, data: { state: "FAILED", lastError: "attempts-exhausted:outcome-unknown" } });
      summary.exhausted += ended.count;
      continue;
    }
    const attempt = row.attemptCount + 1;
    const claimed = await prisma.bookingConfirmationEmail.updateMany({
      where: sameClaim,
      data: { state: "SENDING", attemptCount: attempt, lastAttemptAt: await databaseNow(), lastError: null },
    });
    if (claimed.count !== 1) continue;
    await options.afterClaim?.(row.id);

    const mine = { id: row.id, state: "SENDING" as const, attemptCount: attempt };
    try {
      const sent = await adapter.send(confirmationMessage(row, options.env?.() ?? process.env), { idempotencyKey: confirmationIdempotencyKey(row) });
      const done = await prisma.bookingConfirmationEmail.updateMany({ where: mine, data: { state: "SENT", sentAt: await databaseNow(), providerMessageId: sent.id, lastError: null } });
      if (done.count === 1) summary.sent += 1;
    } catch (error) {
      const kind = error instanceof ConfirmationEmailConfigurationError
        ? error.code
        : error instanceof ConfirmationEmailDeliveryError ? error.kind : "outcome-unknown";
      const terminal = attempt >= MAX_ATTEMPTS;
      const done = await prisma.bookingConfirmationEmail.updateMany({
        where: mine,
        data: { state: "FAILED", lastError: terminal ? `attempts-exhausted:${kind}` : kind },
      });
      if (done.count === 1) summary[terminal ? "exhausted" : "failed"] += 1;
    }
  }
  return summary;
}

async function databaseNow(): Promise<Date> {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now;
}
