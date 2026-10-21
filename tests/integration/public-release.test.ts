import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBookingAccess, revokeBookingAccess } from "@/lib/booking/access";
import { startAuthorizedBookingCheckout } from "@/lib/booking/checkout";
import { isBookingAccessError } from "@/lib/booking/errors";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import { createPublicBooking } from "@/lib/booking/public-booking";
import { PublicBookingReleaseConflictError, releaseAuthorizedPublicBooking } from "@/lib/booking/public-release";
import { BOOKING_COOKIE_NAME } from "@/lib/http/booking-cookie";
import { createPublicBookingApi, defaultPublicBookingApiDeps } from "@/lib/http/public-booking-api";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";

import { consumedIn, publicBookingPlace, upcomingPublicBookingDate, withFailingWrites } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";
import { databaseNow, holdRowLock, paid, waitForLockWaiters } from "../support/payment-fixtures";

let sequence = 0;
async function book(options: { consent?: boolean; capacity?: number } = {}) {
  sequence += 1;
  const { location, slot } = await publicBookingPlace({ capacity: options.capacity });
  const category = await prisma.hairstyleCategory.create({
    data: {
      name: `Release category ${sequence}`,
      slug: `release-category-${sequence}`,
    },
  });
  const hairstyle = await prisma.hairstyle.create({
    data: {
      categoryId: category.id,
      name: `Release style ${sequence}`,
      slug: `release-style-${sequence}`,
      priceCents: 20_000,
    },
  });
  const created = await createPublicBooking({
    name: `Release Customer ${sequence}`,
    email: `release${sequence}@example.test`,
    phone: `+1 555 040 ${String(sequence).padStart(4, "0")}`,
    locationId: location.id,
    bookingSlotId: slot.id,
    appointmentDate: upcomingPublicBookingDate(),
    hairstyleId: hairstyle.id,
    emailMarketingConsent: options.consent ?? false,
  });
  return { token: created.accessToken, appointmentId: created.booking.appointmentId, slot, date: created.booking.appointmentDate };
}

type Adapter = StripeCheckoutAdapter & { creates: () => number };
function stripe(options: { failCreate?: boolean; retrieveStatus?: string } = {}): Adapter {
  let creates = 0;
  const session = (input: { paymentId: string; appointmentId: string; amountCents: number; expiresAt: Date }, status = "open") => ({
    id: `cs_release_${input.paymentId}`, url: "https://checkout.stripe.com/c/pay/release", amountCents: input.amountCents, currency: "usd",
    mode: "payment", status, expiresAt: input.expiresAt, metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
  });
  return {
    creates: () => creates,
    async createDepositCheckout(input) {
      creates += 1;
      if (options.failCreate) throw new Error("simulated Stripe timeout");
      return session(input);
    },
    async retrieveDepositCheckout(sessionId) {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { providerCheckoutSessionId: sessionId } });
      return session({ paymentId: payment.id, appointmentId: payment.appointmentId, amountCents: payment.amountCents, expiresAt: payment.providerCheckoutExpiresAt! }, options.retrieveStatus ?? "open");
    },
  };
}

/** Everything a release could touch, for exact before/after comparison. */
async function snapshot(appointmentId: string) {
  const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId }, include: { customer: true, bookingSlot: true, payments: true, events: { orderBy: { createdAt: "asc" } } } });
  const consent = await prisma.marketingConsentEvent.findMany({ where: { customerId: appointment.customerId }, orderBy: { occurredAt: "asc" } });
  return { appointment, consent };
}

async function assertNothingReleased(appointmentId: string, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(appointmentId);
  assert.deepEqual(after, before);
  assert.equal(after.appointment.accessTokenRevokedAt, null);
}

const conflict = (error: unknown) => error instanceof PublicBookingReleaseConflictError;
const revoked = (error: unknown) => isBookingAccessError(error) && error.reason === "REVOKED";

describe("safe unpaid release (YASMIN-1G)", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("cancels an unpaid booking without a Payment, revokes its credential and frees its place, keeping every row", async () => {
    const booking = await book({ consent: true });
    const before = await snapshot(booking.appointmentId);
    assert.equal(await consumedIn(booking.slot.id, booking.date, await databaseNow()), 1);

    assert.deepEqual(await releaseAuthorizedPublicBooking(booking.token), { released: true });

    const after = await snapshot(booking.appointmentId);
    assert.equal(after.appointment.status, "CANCELLED");
    assert.ok(after.appointment.accessTokenRevokedAt);
    assert.equal(after.appointment.accessTokenHash, before.appointment.accessTokenHash);
    assert.deepEqual(after.appointment.holdExpiresAt, before.appointment.holdExpiresAt);
    assert.deepEqual(after.appointment.customer, before.appointment.customer);
    assert.deepEqual(after.appointment.bookingSlot, before.appointment.bookingSlot);
    assert.deepEqual(after.appointment.payments, []);
    assert.deepEqual(after.consent, before.consent);
    assert.equal(after.consent.length, 1);
    assert.deepEqual(after.appointment.events.map((event) => event.type), ["CREATED", "CANCELLED", "ACCESS_REVOKED"]);
    assert.deepEqual(after.appointment.events[1].details, { schemaVersion: 1, fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED" });
    assert.equal((after.appointment.events[2].details as { reason: string }).reason, "customer-release");
    assert.equal(await consumedIn(booking.slot.id, booking.date, await databaseNow()), 0);
    await assert.rejects(resolveBookingAccess(booking.token), revoked);
  });

  it("refuses while a Checkout Session is open", async () => {
    const booking = await book();
    const adapter = stripe();
    assert.equal((await startAuthorizedBookingCheckout(booking.token, { adapter })).kind, "ready");
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token), conflict);
    await assertNothingReleased(booking.appointmentId, before);
  });

  it("refuses after an uncertain Checkout creation (Payment without a Session, recovery lease held)", async () => {
    const booking = await book();
    const result = await startAuthorizedBookingCheckout(booking.token, { adapter: stripe({ failCreate: true }) });
    assert.deepEqual([result.kind, result.kind === "ambiguous" && result.reason], ["ambiguous", "checkout-creation-unconfirmed"]);
    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: booking.appointmentId } });
    assert.equal(payment.providerCheckoutSessionId, null);
    assert.ok(payment.checkoutRecoveryLeaseToken);
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token), conflict);
    await assertNothingReleased(booking.appointmentId, before);
  });

  it("refuses while payment awaits confirmation (Stripe reports the Session complete)", async () => {
    const booking = await book();
    await startAuthorizedBookingCheckout(booking.token, { adapter: stripe() });
    const resumed = await startAuthorizedBookingCheckout(booking.token, { adapter: stripe({ retrieveStatus: "complete" }) });
    assert.equal(resumed.kind === "ambiguous" && resumed.reason, "payment-awaiting-confirmation");
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token), conflict);
    await assertNothingReleased(booking.appointmentId, before);
  });

  it("refuses once payment was received and confirmed", async () => {
    const booking = await book();
    await startAuthorizedBookingCheckout(booking.token, { adapter: stripe() });
    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: booking.appointmentId } });
    const now = await databaseNow();
    const outcome = await applyVerifiedCheckoutSession(paid({ slot: booking.slot, appointmentId: booking.appointmentId, paymentId: payment.id, session: payment.providerCheckoutSessionId!, intent: "pi_release_paid", paidAt: new Date(Math.floor(now.getTime() / 1000) * 1000 - 30_000) }));
    assert.equal(outcome.kind, "confirmed");
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token), conflict);
    await assertNothingReleased(booking.appointmentId, before);
    assert.equal(before.appointment.status, "CONFIRMED");
  });

  it("refuses while an unresolved payment exception names the booking, and allows it once resolved", async () => {
    const booking = await book();
    const observed = await databaseNow();
    const exception = await prisma.paymentProcessingException.create({ data: {
      provider: "STRIPE", checkoutSessionId: "cs_release_orphan", paymentIntentId: "pi_release_orphan", verifiedAmountCents: 4_000, verifiedCurrency: "usd", expectedAppointmentId: booking.appointmentId,
      category: "MISSING_ASSOCIATION", problem: "PAYMENT_NOT_FOUND", moneyReceived: true, firstObservedAt: observed, lastObservedAt: observed,
    } });
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token), conflict);
    await assertNothingReleased(booking.appointmentId, before);

    await prisma.paymentProcessingException.update({ where: { id: exception.id }, data: { resolvedAt: new Date(observed.getTime() + 1000) } });
    assert.deepEqual(await releaseAuthorizedPublicBooking(booking.token), { released: true });
  });

  it("serializes release against Checkout initiation: one wins, never both (6 rounds)", async () => {
    for (let round = 0; round < 6; round += 1) {
      const booking = await book();
      const adapter = stripe();
      const unlock = await holdRowLock("Appointment", booking.appointmentId);
      const racing = Promise.allSettled([
        releaseAuthorizedPublicBooking(booking.token),
        startAuthorizedBookingCheckout(booking.token, { adapter }),
      ]);
      await waitForLockWaiters(2);
      await unlock();
      const [release, checkout] = await racing;
      const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId }, include: { payments: true } });
      if (release.status === "fulfilled") {
        assert.equal(appointment.status, "CANCELLED");
        assert.equal(appointment.payments.length, 0);
        assert.equal(adapter.creates(), 0);
        assert.equal(checkout.status, "rejected");
      } else {
        assert.ok(conflict(release.reason), String(release.reason));
        assert.equal(appointment.status, "PENDING_PAYMENT");
        assert.equal(appointment.accessTokenRevokedAt, null);
        assert.equal(appointment.payments.length, 1);
      }
    }
  });

  it("never lets a release undo webhook fulfillment racing with it", async () => {
    const booking = await book();
    await startAuthorizedBookingCheckout(booking.token, { adapter: stripe() });
    const payment = await prisma.payment.findFirstOrThrow({ where: { appointmentId: booking.appointmentId } });
    const now = await databaseNow();
    const evidence = paid({ slot: booking.slot, appointmentId: booking.appointmentId, paymentId: payment.id, session: payment.providerCheckoutSessionId!, intent: "pi_release_race", paidAt: new Date(Math.floor(now.getTime() / 1000) * 1000 - 30_000) });
    const unlock = await holdRowLock("Appointment", booking.appointmentId);
    const racing = Promise.allSettled([releaseAuthorizedPublicBooking(booking.token), applyVerifiedCheckoutSession(evidence)]);
    await waitForLockWaiters(2);
    await unlock();
    const [release, fulfilled] = await racing;
    assert.ok(release.status === "rejected" && conflict(release.reason));
    assert.ok(fulfilled.status === "fulfilled" && fulfilled.value.kind === "confirmed");
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId } });
    assert.equal(appointment.status, "CONFIRMED");
    assert.equal(appointment.accessTokenRevokedAt, null);
    assert.equal(await prisma.bookingConfirmationEmail.count({ where: { appointmentId: booking.appointmentId } }), 2);
  });

  it("never releases around a Checkout recovery lease racing with it", async () => {
    const booking = await book();
    await startAuthorizedBookingCheckout(booking.token, { adapter: stripe({ failCreate: true }) });
    // Let the 30 s lease lapse so a resume may recover; release must still refuse.
    await prisma.payment.updateMany({ where: { appointmentId: booking.appointmentId }, data: { checkoutRecoveryLeasedAt: new Date((await databaseNow()).getTime() - 60_000) } });
    const unlock = await holdRowLock("Appointment", booking.appointmentId);
    const racing = Promise.allSettled([releaseAuthorizedPublicBooking(booking.token), startAuthorizedBookingCheckout(booking.token, { adapter: stripe() })]);
    await waitForLockWaiters(2);
    await unlock();
    const [release] = await racing;
    assert.ok(release.status === "rejected" && conflict(release.reason));
    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: booking.appointmentId } });
    assert.equal(appointment.status, "PENDING_PAYMENT");
    assert.equal(appointment.accessTokenRevokedAt, null);
  });

  it("admits exactly one of two concurrent releases", async () => {
    const booking = await book();
    const results = await Promise.allSettled([releaseAuthorizedPublicBooking(booking.token), releaseAuthorizedPublicBooking(booking.token)]);
    assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.released).length, 1);
    for (const result of results) if (result.status === "rejected") assert.ok(revoked(result.reason), String(result.reason));
    const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: booking.appointmentId } });
    assert.equal(events.filter((event) => event.type === "CANCELLED").length, 1);
    assert.equal(events.filter((event) => event.type === "ACCESS_REVOKED").length, 1);
  });

  it("rejects a revoked credential without touching the booking", async () => {
    const booking = await book();
    await revokeBookingAccess({ appointmentId: booking.appointmentId, reason: "administrative", actorId: "test-admin" });
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token), revoked);
    assert.deepEqual(await snapshot(booking.appointmentId), before);
  });

  it("rolls back status, revocation and events together", async () => {
    const booking = await book();
    const before = await snapshot(booking.appointmentId);
    await assert.rejects(releaseAuthorizedPublicBooking(booking.token, { beforeCommit: async () => { throw new Error("forced rollback"); } }), /forced rollback/);
    await assertNothingReleased(booking.appointmentId, before);
    await withFailingWrites("AppointmentEvent", "INSERT", () => assert.rejects(releaseAuthorizedPublicBooking(booking.token), /forced test failure/));
    await assertNothingReleased(booking.appointmentId, before);
    assert.deepEqual(await releaseAuthorizedPublicBooking(booking.token), { released: true });
  });

  it("over HTTP: clears the cookie on success, maps an unsafe release to 409, and lets the browser book again", async () => {
    const env = { PUBLIC_BOOKING_ENABLED: "true", APP_BASE_URL: "https://book.yasmin.example", RATE_LIMIT_SECRET: "x".repeat(40), TRUSTED_CLIENT_IP_SOURCE: "none" };
    const api = createPublicBookingApi({ ...defaultPublicBookingApiDeps, env: () => env, log: () => {} });
    const post = (token: string) => api.releaseBooking(new Request("https://book.yasmin.example/api/bookings/release", { method: "POST", headers: { origin: env.APP_BASE_URL, "content-type": "application/json", cookie: `${BOOKING_COOKIE_NAME}=${token}` }, body: "{}" }));

    const unsafe = await book();
    await startAuthorizedBookingCheckout(unsafe.token, { adapter: stripe() });
    const refused = await post(unsafe.token);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error.code, "BOOKING_RELEASE_UNSAFE");
    assert.equal(refused.headers.get("set-cookie"), null);

    const safe = await book();
    const released = await post(safe.token);
    assert.equal(released.status, 200);
    assert.deepEqual(await released.json(), { released: true });
    assert.match(released.headers.get("set-cookie") ?? "", new RegExp(`^${BOOKING_COOKIE_NAME}=; Max-Age=0;`));
    const again = await post(safe.token);
    assert.equal(again.status, 401);
  });
});
