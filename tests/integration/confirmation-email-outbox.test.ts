import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelAppointment } from "@/lib/booking";
import {
  ConfirmationEmailDeliveryError,
  MAX_ATTEMPTS,
  deliverPendingConfirmationEmails,
} from "@/lib/email/confirmation";
import { prisma } from "@/lib/prisma";

import { ageLease, confirmedBooking, deliverWebhook, outbox, pendingPublicBooking, provider } from "../support/confirmation-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

describe("confirmation email outbox (YASMIN-1G)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("records no delivery intent before verified payment, nor for unpaid, expired or unallocated payments", async () => {
    const booking = await pendingPublicBooking();
    assert.equal(await prisma.bookingConfirmationEmail.count(), 0);
    assert.equal((await deliverWebhook(booking, "evt_outbox_open", "unpaid")).kind, "processed");
    assert.equal((await deliverWebhook(booking, "evt_outbox_expired", "unpaid", "expired")).kind, "processed");
    assert.equal(await prisma.bookingConfirmationEmail.count(), 0);

    const cancelled = await pendingPublicBooking();
    await cancelAppointment(cancelled.appointmentId);
    assert.equal((await deliverWebhook(cancelled)).kind, "reconciliation-recorded");
    assert.equal(await prisma.bookingConfirmationEmail.count(), 0);
  });

  it("records a customer PENDING intent with the confirmation, independent of marketing consent", async () => {
    const booking = await confirmedBooking({ consent: false });
    const row = await outbox(booking.appointmentId);
    assert.equal(row.state, "PENDING");
    assert.equal(row.attemptCount, 0);
    assert.equal(row.recipientEmail, booking.email);
    const customer = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId }, include: { customer: true } });
    assert.equal(customer.customer.emailMarketingAt, null);
    assert.equal(customer.status, "CONFIRMED");
    const sent = provider();
    assert.deepEqual(await deliverPendingConfirmationEmails(sent), { sent: 1, failed: 0, exhausted: 0 });
    assert.equal(sent.calls[0].message.to, booking.email);
  });

  it("keeps one intent per recipient across duplicate, concurrent and re-sent webhook deliveries", async () => {
    const booking = await pendingPublicBooking();
    await Promise.all([deliverWebhook(booking, "evt_outbox_dup"), deliverWebhook(booking, "evt_outbox_dup"), deliverWebhook(booking, "evt_outbox_other")]);
    assert.equal((await deliverWebhook(booking, "evt_outbox_dup")).kind, "duplicate");
    await deliverWebhook(booking, "evt_outbox_third");
    assert.equal(await prisma.bookingConfirmationEmail.count({ where: { appointmentId: booking.appointmentId } }), 2);
  });

  it("never lets an existing outbox row block or roll back webhook fulfillment", async () => {
    const booking = await pendingPublicBooking();
    await prisma.bookingConfirmationEmail.create({ data: { appointmentId: booking.appointmentId, recipientEmail: "stale@example.test", state: "SENT" } });
    assert.equal((await deliverWebhook(booking)).kind, "processed");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId } })).status, "CONFIRMED");
    assert.equal(await prisma.bookingConfirmationEmail.count(), 2);
  });

  it("lets only one of two concurrent workers claim a message", async () => {
    const booking = await confirmedBooking();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = provider(async (_call, n) => { await gate; return { id: `email_${n}` }; });
    const workers = Promise.all([deliverPendingConfirmationEmails(slow), deliverPendingConfirmationEmails(slow)]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const summaries = await workers;
    assert.equal(slow.calls.length, 1);
    assert.equal(summaries.reduce((sum, run) => sum + run.sent, 0), 1);
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.providerMessageId], ["SENT", 1, "email_1"]);
  });

  it("records a provider timeout as an unknown outcome and retries with the same idempotency key", async () => {
    const booking = await confirmedBooking();
    const flaky = provider(async (_call, n) => { if (n === 1) throw new ConfirmationEmailDeliveryError("outcome-unknown"); return { id: "email_retry" }; });
    assert.deepEqual(await deliverPendingConfirmationEmails(flaky), { sent: 0, failed: 1, exhausted: 0 });
    let row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.lastError, row.sentAt], ["FAILED", 1, "outcome-unknown", null]);
    assert.deepEqual(await deliverPendingConfirmationEmails(flaky), { sent: 1, failed: 0, exhausted: 0 });
    row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.lastError, row.providerMessageId], ["SENT", 2, null, "email_retry"]);
    assert.equal(flaky.calls[0].idempotencyKey, flaky.calls[1].idempotencyKey);
  });

  it("re-sends after provider success with a lost response (at least once), with an identical payload and key", async () => {
    const booking = await confirmedBooking();
    const accepted: string[] = [];
    const lossy = provider(async (call, n) => { accepted.push(call.idempotencyKey); if (n === 1) throw new ConfirmationEmailDeliveryError("outcome-unknown"); return { id: "email_after_loss" }; });
    await deliverPendingConfirmationEmails(lossy);
    await deliverPendingConfirmationEmails(lossy);
    // The provider saw the message twice; only its Idempotency-Key (24 h window) prevents a second email.
    assert.equal(accepted.length, 2);
    assert.equal(new Set(accepted).size, 1);
    assert.deepEqual(lossy.calls[0].message, lossy.calls[1].message);
    assert.equal((await outbox(booking.appointmentId)).state, "SENT");
  });

  it("recovers a message whose worker crashed after claiming it, but only after the lease expires", async () => {
    const booking = await confirmedBooking();
    const crash = provider();
    await assert.rejects(deliverPendingConfirmationEmails(crash, { afterClaim: async () => { throw new Error("worker crashed"); } }), /worker crashed/);
    let row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount], ["SENDING", 1]);

    const early = provider();
    assert.deepEqual(await deliverPendingConfirmationEmails(early), { sent: 0, failed: 0, exhausted: 0 });
    assert.equal(early.calls.length, 0);

    await ageLease(booking.appointmentId);
    const takeover = provider();
    assert.deepEqual(await deliverPendingConfirmationEmails(takeover), { sent: 1, failed: 0, exhausted: 0 });
    row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.providerMessageId], ["SENT", 2, "email_1"]);
  });

  it("fences a stale worker that returns after its lease was taken over", async () => {
    const booking = await confirmedBooking();
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    let claimed!: () => void;
    const staleClaimed = new Promise<void>((resolve) => { claimed = resolve; });
    const stale = provider(async () => { claimed(); await staleGate; throw new ConfirmationEmailDeliveryError("outcome-unknown"); });
    const staleRun = deliverPendingConfirmationEmails(stale);
    await staleClaimed;

    await ageLease(booking.appointmentId);
    const fresh = provider(async () => ({ id: "email_fresh" }));
    assert.deepEqual(await deliverPendingConfirmationEmails(fresh), { sent: 1, failed: 0, exhausted: 0 });

    releaseStale();
    assert.deepEqual(await staleRun, { sent: 0, failed: 0, exhausted: 0 });
    const row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.providerMessageId, row.lastError], ["SENT", 2, "email_fresh", null]);
  });

  it("stops after MAX_ATTEMPTS and keeps the terminal failure visible", async () => {
    const booking = await confirmedBooking();
    const broken = provider(async () => { throw new ConfirmationEmailDeliveryError("rejected"); });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) await deliverPendingConfirmationEmails(broken);
    assert.equal(broken.calls.length, MAX_ATTEMPTS);
    let row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.attemptCount, row.lastError], ["FAILED", MAX_ATTEMPTS, "attempts-exhausted:rejected"]);
    assert.deepEqual(await deliverPendingConfirmationEmails(broken), { sent: 0, failed: 0, exhausted: 0 });
    assert.equal(broken.calls.length, MAX_ATTEMPTS);

    // A worker that died during the final attempt: its outcome is unknown and no retry remains.
    await prisma.bookingConfirmationEmail.update({ where: { id: row.id }, data: { state: "SENDING" } });
    await ageLease(booking.appointmentId);
    assert.deepEqual(await deliverPendingConfirmationEmails(broken), { sent: 0, failed: 0, exhausted: 1 });
    row = await outbox(booking.appointmentId);
    assert.deepEqual([row.state, row.lastError], ["FAILED", "attempts-exhausted:outcome-unknown"]);
    assert.equal(broken.calls.length, MAX_ATTEMPTS);
  });

  it("sends only booking facts: no credential, identifier, provider id or secret", async () => {
    const booking = await confirmedBooking();
    const sent = provider();
    await deliverPendingConfirmationEmails(sent);
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId }, include: { payments: true } });
    const { message, idempotencyKey } = sent.calls[0];
    const visible = JSON.stringify(message);
    for (const secret of [booking.token, appointment.accessTokenHash!, appointment.id, appointment.payments[0].id, appointment.payments[0].providerCheckoutSessionId!, appointment.payments[0].providerPaymentIntentId!, "pi_outbox", "cs_outbox"]) {
      assert.equal(visible.includes(secret), false, secret);
      assert.equal(idempotencyKey.includes(secret), false, secret);
    }
    assert.match(message.text, /Deposit paid: \$40\.00 \(nonrefundable\)/);
    assert.match(message.text, /Balance due after service: \$160\.00/);
    assert.match(idempotencyKey, /^booking-notification\/customer_confirmation\/[a-z0-9]+$/);
    const row = await outbox(booking.appointmentId);
    assert.equal(row.lastError, null);
  });
});
