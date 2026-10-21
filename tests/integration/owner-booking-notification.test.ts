import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfirmationEmailDeliveryError,
  deliverPendingConfirmationEmails,
} from "@/lib/email/confirmation";
import { prisma } from "@/lib/prisma";

import {
  confirmedBooking,
  deliverWebhook,
  outbox,
  pendingPublicBooking,
  provider,
} from "../support/confirmation-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const ownerEnv = () => ({ SALON_NOTIFICATION_EMAIL: "yasmin@example.test" });

describe("customer and owner booking notifications (YASMIN-4B.2)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("records two independent notification jobs atomically with authoritative confirmation", async () => {
    const booking = await confirmedBooking({ keepOwner: true });
    const jobs = await prisma.bookingConfirmationEmail.findMany({
      where: { appointmentId: booking.appointmentId },
      orderBy: { kind: "asc" },
    });

    assert.deepEqual(jobs.map((job) => [job.kind, job.recipientEmail, job.state, job.attemptCount]), [
      ["CUSTOMER_CONFIRMATION", booking.email, "PENDING", 0],
      ["OWNER_NEW_BOOKING", null, "PENDING", 0],
    ]);

    await prisma.salonLocation.update({
      where: { id: (await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId } })).locationId },
      data: { addressLine1: "524 William St", city: "East Orange", state: "NJ", postalCode: "07017" },
    });
    const sent = provider();
    assert.deepEqual(await deliverPendingConfirmationEmails(sent, { env: ownerEnv }), { sent: 2, failed: 0, exhausted: 0 });
    const customer = sent.calls.find((call) => call.message.to === booking.email);
    const owner = sent.calls.find((call) => call.message.to === "yasmin@example.test");
    assert.ok(customer);
    assert.ok(owner);
    assert.match(customer.message.text, /524 William St, East Orange, NJ 07017/);
    assert.match(customer.message.text, /Deposit paid: \$40\.00 \(nonrefundable\)/);
    assert.match(customer.message.text, /Balance due after service: \$160\.00/);
    assert.match(owner.message.text, /Customer: Outbox Customer/);
    assert.match(owner.message.text, /Email: outbox\d+@example\.test/);
    assert.match(owner.message.text, /Phone: \+1 555 050/);
    assert.equal(owner.message.text.includes(booking.appointmentId), false);
    assert.notEqual(customer.message.to, owner.message.to);
    assert.notEqual(sent.calls[0].idempotencyKey, sent.calls[1].idempotencyKey);
  });

  it("replayed webhook deliveries never create duplicate jobs for either recipient", async () => {
    const booking = await pendingPublicBooking();
    await Promise.all([
      deliverWebhook(booking, "evt_owner_repeat"),
      deliverWebhook(booking, "evt_owner_repeat"),
      deliverWebhook(booking, "evt_owner_repeat_other"),
    ]);
    assert.equal(await prisma.bookingConfirmationEmail.count({ where: { appointmentId: booking.appointmentId } }), 2);
    assert.equal(await prisma.bookingConfirmationEmail.count({ where: { appointmentId: booking.appointmentId, kind: "CUSTOMER_CONFIRMATION" } }), 1);
    assert.equal(await prisma.bookingConfirmationEmail.count({ where: { appointmentId: booking.appointmentId, kind: "OWNER_NEW_BOOKING" } }), 1);
  });

  it("records a missing owner recipient visibly while still delivering the customer confirmation", async () => {
    const booking = await confirmedBooking({ keepOwner: true });
    const sent = provider();
    assert.deepEqual(await deliverPendingConfirmationEmails(sent, { env: () => ({}) }), { sent: 1, failed: 1, exhausted: 0 });
    assert.equal(sent.calls.length, 1);
    assert.equal(sent.calls[0].message.to, booking.email);
    const owner = await outbox(booking.appointmentId, "OWNER_NEW_BOOKING");
    assert.deepEqual([owner.state, owner.attemptCount, owner.lastError], ["FAILED", 1, "owner-recipient-not-configured"]);
  });

  it("retries the owner independently after its provider failure without resending the customer", async () => {
    const booking = await confirmedBooking({ keepOwner: true });
    const flaky = provider(async (call) => {
      if (call.message.to === "yasmin@example.test") throw new ConfirmationEmailDeliveryError("outcome-unknown");
      return { id: "customer-delivered" };
    });
    assert.deepEqual(await deliverPendingConfirmationEmails(flaky, { env: ownerEnv }), { sent: 1, failed: 1, exhausted: 0 });
    assert.equal((await outbox(booking.appointmentId)).state, "SENT");
    assert.equal((await outbox(booking.appointmentId, "OWNER_NEW_BOOKING")).state, "FAILED");

    const recovered = provider();
    assert.deepEqual(await deliverPendingConfirmationEmails(recovered, { env: ownerEnv }), { sent: 1, failed: 0, exhausted: 0 });
    assert.equal(recovered.calls.length, 1);
    assert.equal(recovered.calls[0].message.to, "yasmin@example.test");
    assert.equal((await outbox(booking.appointmentId, "OWNER_NEW_BOOKING")).state, "SENT");
  });
});
