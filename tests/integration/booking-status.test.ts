import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelAppointment, completeAppointment, isBookingAccessError } from "@/lib/booking";
import { revokeBookingAccess, type BookingAccessClock } from "@/lib/booking/access";
import { getAuthorizedBookingStatus } from "@/lib/booking/booking-status";
import { startAuthorizedBookingCheckout } from "@/lib/booking/checkout";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import { verifiedCheckoutEvidence } from "@/lib/booking/payment-policy";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";

import { publicBookingPlace, upcomingPublicBookingDate } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const STATUS_KEYS = [
  "appointmentDate",
  "balanceDueCents",
  "canStartCheckout",
  "depositAmountCents",
  "depositPaid",
  "hairstyleName",
  "holdExpiresAt",
  "locationAddress",
  "locationName",
  "slotTime",
  "state",
  "totalPriceCents",
];

const stripe: StripeCheckoutAdapter = {
  async createDepositCheckout(input) {
    return {
      id: `cs_status_${input.paymentId}`,
      url: `https://checkout.stripe.com/c/pay/cs_status_${input.paymentId}`,
      amountCents: input.amountCents,
      currency: input.currency,
      mode: "payment",
      status: "open",
      expiresAt: input.expiresAt,
      metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
    };
  },
  async retrieveDepositCheckout() {
    throw new Error("not used");
  },
};

let sequence = 0;
async function book(options: { name?: string; hairstyle?: boolean } = {}) {
  sequence += 1;
  const { location, slot } = await publicBookingPlace({ name: "Status Street" });
  return createPublicBooking({
    name: options.name ?? `Status Customer ${sequence}`,
    email: `status${sequence}@example.test`,
    phone: `+1 555 010 ${String(sequence).padStart(4, "0")}`,
    locationId: location.id,
    bookingSlotId: slot.id,
    appointmentDate: upcomingPublicBookingDate(),
    customerNotes: "Private note for the stylist",
    preferredStylistName: "Amina",
  });
}

async function pay(appointmentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { appointmentId_purpose: { appointmentId, purpose: "BOOKING_DEPOSIT" } },
  });
  return applyVerifiedCheckoutSession(
    verifiedCheckoutEvidence({
      checkoutSessionId: payment.providerCheckoutSessionId!,
      sessionStatus: "complete",
      paymentStatus: "paid",
      paymentIntentId: `pi_status_${payment.id}`,
      amountCents: payment.amountCents,
      currency: "usd",
      paidAt: new Date(),
      metadataPaymentId: payment.id,
      metadataAppointmentId: appointmentId,
    }),
  );
}

const at = (instant: Date): BookingAccessClock => ({ now: async () => new Date(instant) });

describe("authorized booking status", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("returns exactly the allow-listed DTO for an awaiting-payment booking", async () => {
    const created = await book();
    const status = await getAuthorizedBookingStatus(created.accessToken);

    assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
    assert.equal(status.state, "awaiting-payment");
    assert.equal(status.canStartCheckout, true);
    assert.deepEqual(status.holdExpiresAt, created.booking.holdExpiresAt);
    assert.equal(status.locationName, created.booking.locationName);
    assert.equal(status.locationAddress, null);
    assert.equal(status.appointmentDate, upcomingPublicBookingDate());
    assert.equal(status.slotTime, created.booking.slotTime);
    assert.match(status.slotTime, /^\d{2}:\d{2}$/);
    assert.equal(status.hairstyleName, null);
    assert.deepEqual([status.totalPriceCents, status.depositAmountCents, status.balanceDueCents], [20_000, 4_000, 16_000]);
    assert.equal(status.depositPaid, false);
  });

  it("never discloses PII, notes, identifiers, provider ids, hashes or events", async () => {
    const created = await book({ name: "Distinctive Person" });
    await startAuthorizedBookingCheckout(created.accessToken, { adapter: stripe });
    const status = await getAuthorizedBookingStatus(created.accessToken);
    const json = JSON.stringify(status);

    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: created.booking.appointmentId },
      include: { customer: true, payments: true, events: true },
    });
    for (const secret of [
      appointment.id,
      appointment.customerId,
      appointment.customer.name,
      appointment.customer.email,
      appointment.customer.phone,
      appointment.customerNotes!,
      appointment.preferredStylistName!,
      appointment.accessTokenHash!,
      created.accessToken,
      appointment.payments[0].id,
      appointment.payments[0].providerCheckoutSessionId!,
      ...appointment.events.map((e) => e.id),
    ]) {
      assert.ok(!json.includes(secret), `leaked ${secret}`);
    }
    assert.equal(status.state, "payment-in-progress");
  });

  it("reports the location's configured street address separately from its name", async () => {
    const created = await book();
    await prisma.salonLocation.updateMany({ data: { addressLine1: "524 William St", city: "East Orange", state: "NJ" } });
    const status = await getAuthorizedBookingStatus(created.accessToken);
    assert.equal(status.locationAddress, "524 William St, East Orange, NJ");
    assert.equal(status.locationName, "Status Street");
  });

  it("is isolated to the credential's booking", async () => {
    const a = await book();
    const b = await book();
    await cancelAppointment(b.booking.appointmentId);

    assert.equal((await getAuthorizedBookingStatus(a.accessToken)).state, "awaiting-payment");
    assert.equal((await getAuthorizedBookingStatus(a.accessToken)).locationName, a.booking.locationName);
    assert.equal((await getAuthorizedBookingStatus(b.accessToken)).state, "cancelled");
  });

  it("rejects expired, revoked, unknown and malformed credentials", async () => {
    const created = await book();
    await assert.rejects(
      getAuthorizedBookingStatus(created.accessToken, { clock: at(created.accessExpiresAt) }),
      (e) => isBookingAccessError(e, "EXPIRED"),
    );
    await assert.rejects(getAuthorizedBookingStatus("A".repeat(43)), (e) => isBookingAccessError(e, "UNKNOWN"));
    await assert.rejects(getAuthorizedBookingStatus(created.booking.appointmentId), (e) => isBookingAccessError(e, "MALFORMED"));
    await revokeBookingAccess({ appointmentId: created.booking.appointmentId, reason: "administrative", actorId: "admin_1" });
    await assert.rejects(getAuthorizedBookingStatus(created.accessToken), (e) => isBookingAccessError(e, "REVOKED"));
  });

  it("follows the booking through checkout, confirmation and completion", async () => {
    const created = await book();
    const id = created.booking.appointmentId;
    const state = async () => (await getAuthorizedBookingStatus(created.accessToken)).state;

    assert.equal(await state(), "awaiting-payment");
    assert.equal((await startAuthorizedBookingCheckout(created.accessToken, { adapter: stripe })).kind, "ready");
    const inProgress = await getAuthorizedBookingStatus(created.accessToken);
    assert.equal(inProgress.state, "payment-in-progress");
    assert.ok(inProgress.holdExpiresAt);
    assert.equal(inProgress.depositPaid, false);

    assert.equal((await pay(id)).kind, "confirmed");
    const confirmed = await getAuthorizedBookingStatus(created.accessToken);
    assert.deepEqual([confirmed.state, confirmed.depositPaid, confirmed.holdExpiresAt, confirmed.canStartCheckout], ["confirmed", true, null, false]);

    await completeAppointment(id);
    assert.equal(await state(), "closed");
  });

  it("reports money received for a cancelled booking as needs-attention", async () => {
    const created = await book();
    await startAuthorizedBookingCheckout(created.accessToken, { adapter: stripe });
    await cancelAppointment(created.booking.appointmentId);
    assert.equal((await pay(created.booking.appointmentId)).kind, "reconciled");

    const status = await getAuthorizedBookingStatus(created.accessToken);
    assert.deepEqual([status.state, status.depositPaid, status.canStartCheckout], ["needs-attention", false, false]);
  });

  it("reports a lapsed unpaid hold as expired", async () => {
    const created = await book();
    await prisma.appointment.update({ where: { id: created.booking.appointmentId }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    const status = await getAuthorizedBookingStatus(created.accessToken);
    assert.deepEqual([status.state, status.holdExpiresAt, status.canStartCheckout], ["expired", null, false]);
  });

  it("writes nothing", async () => {
    const created = await book();
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId }, include: { events: true, payments: true } });
    await getAuthorizedBookingStatus(created.accessToken);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: created.booking.appointmentId }, include: { events: true, payments: true } });
    assert.deepEqual(after, before);
  });
});
