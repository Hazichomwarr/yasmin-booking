import assert from "node:assert/strict";

import type Stripe from "stripe";

import { startAuthorizedBookingCheckout } from "@/lib/booking/checkout";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { processSignedStripeWebhookEvent } from "@/lib/booking/stripe-webhook";
import { SENDING_LEASE_MS, type ConfirmationEmailAdapter, type ConfirmationMessage } from "@/lib/email/confirmation";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";
import type { StripeWebhookGateway } from "@/lib/stripe/webhook";

import { publicBookingPlace, upcomingPublicBookingDate } from "./booking-fixtures";
import { databaseNow } from "./payment-fixtures";

/**
 * Confirmation-email outbox test data (YASMIN-1G): public bookings taken
 * through Checkout and the signed-webhook path with Stripe doubles, and a
 * recording email-provider double. Synthetic identifiers only.
 */

export const checkoutAdapter: StripeCheckoutAdapter = {
  async createDepositCheckout(input) {
    return { id: `cs_outbox_${input.paymentId}`, url: "https://checkout.stripe.com/c/pay/outbox", amountCents: input.amountCents, currency: "usd", mode: "payment", status: "open", expiresAt: input.expiresAt, metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId } };
  },
  async retrieveDepositCheckout() { throw new Error("not used"); },
};

export function gateway(payment: { id: string; appointmentId: string; amountCents: number }, paymentStatus: "paid" | "unpaid" = "paid", status: "complete" | "expired" = "complete"): StripeWebhookGateway {
  return {
    constructEvent() { throw new Error("not used"); },
    async retrieveCheckoutSession(sessionId) {
      return {
        id: sessionId, status, payment_status: paymentStatus, amount_total: payment.amountCents, currency: "usd",
        metadata: { paymentId: payment.id, appointmentId: payment.appointmentId },
        payment_intent: paymentStatus === "paid" ? { id: `pi_outbox_${payment.id}`, latest_charge: { created: Math.floor(Date.now() / 1_000), amount_refunded: 0 } } : null,
      } as unknown as Stripe.Checkout.Session;
    },
  };
}

let sequence = 0;
/** A public booking with an open Checkout Session: the state just before Stripe's webhook. */
export async function pendingPublicBooking(options: { consent?: boolean } = {}) {
  sequence += 1;
  const { location, slot } = await publicBookingPlace();
  const created = await createPublicBooking({
    name: `Outbox Customer ${sequence}`, email: `outbox${sequence}@example.test`, phone: `+1 555 050 ${String(sequence).padStart(4, "0")}`,
    locationId: location.id, bookingSlotId: slot.id, appointmentDate: upcomingPublicBookingDate(),
    emailMarketingConsent: options.consent ?? false, smsMarketingConsent: options.consent ?? false,
  });
  assert.equal((await startAuthorizedBookingCheckout(created.accessToken, { adapter: checkoutAdapter })).kind, "ready");
  const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: created.booking.appointmentId } });
  return { token: created.accessToken, appointmentId: created.booking.appointmentId, payment, email: `outbox${sequence}@example.test` };
}

export const deliverWebhook = (booking: Awaited<ReturnType<typeof pendingPublicBooking>>, eventId = `evt_outbox_${booking.payment.id}`, paymentStatus: "paid" | "unpaid" = "paid", status: "complete" | "expired" = "complete") =>
  processSignedStripeWebhookEvent({ id: eventId, type: status === "expired" ? "checkout.session.expired" : "checkout.session.completed", data: { object: { id: booking.payment.providerCheckoutSessionId! } } }, gateway(booking.payment, paymentStatus, status));

export async function confirmedBooking(options: { consent?: boolean } = {}) {
  const booking = await pendingPublicBooking(options);
  assert.equal((await deliverWebhook(booking)).kind, "processed");
  return booking;
}

export type Call = { message: ConfirmationMessage; idempotencyKey: string };
export function provider(behaviour: (call: Call, n: number) => Promise<{ id: string }> = async (_call, n) => ({ id: `email_${n}` })): ConfirmationEmailAdapter & { calls: Call[] } {
  const calls: Call[] = [];
  return { calls, async send(message, { idempotencyKey }) { calls.push({ message, idempotencyKey }); return behaviour({ message, idempotencyKey }, calls.length); } };
}

export const outbox = (appointmentId: string) => prisma.bookingConfirmationEmail.findUniqueOrThrow({ where: { appointmentId } });
export const ageLease = (appointmentId: string, extraMs = 1_000) => databaseNow().then((now) =>
  prisma.bookingConfirmationEmail.update({ where: { appointmentId }, data: { lastAttemptAt: new Date(now.getTime() - SENDING_LEASE_MS - extraMs) } }));
