import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Prisma } from "@prisma/client";

import { listAppointmentEvents } from "@/lib/booking";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import {
  checkoutWebhookResponse,
  listUnresolvedPaymentExceptions,
  processVerifiedCheckoutEvidence,
  recordPaymentException,
  type CheckoutEvidenceDisposition,
} from "@/lib/booking/payment-exceptions";
import type { VerifiedCheckoutEvidence } from "@/lib/booking/payment-policy";
import { prisma } from "@/lib/prisma";

import { withFailingWrites } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";
import {
  DEPOSIT,
  assertOutcome,
  assertUntouched,
  createHeld,
  createPlace,
  databaseNow,
  paid,
  paymentRow,
  unpaid,
  waitForLockWaiters,
} from "../support/payment-fixtures";

/**
 * YASMIN-1E.3A: verified charges that cannot be applied are recorded durably
 * in PaymentProcessingException, idempotently, without touching bookings.
 */

const ROUNDS = 8;

const exceptionsFor = (checkoutSessionId: string) =>
  prisma.paymentProcessingException.findMany({ where: { checkoutSessionId }, orderBy: { problem: "asc" } });

function assertRecorded(
  disposition: CheckoutEvidenceDisposition,
  problem: string,
): asserts disposition is Extract<CheckoutEvidenceDisposition, { kind: "exception-recorded" }> {
  assert.equal(disposition.kind, "exception-recorded", JSON.stringify(disposition));
  assert.equal(disposition.outcome.problem, problem);
  assert.deepEqual(checkoutWebhookResponse({ disposition }), { status: 200 });
}

/** The single exception row for `evidence`, checked against the verified charge. */
async function recordedRow(evidence: VerifiedCheckoutEvidence) {
  const rows = await exceptionsFor(evidence.checkoutSessionId);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.provider, "STRIPE");
  assert.equal(row.moneyReceived, evidence.paymentStatus === "paid");
  assert.equal(row.paymentIntentId, evidence.charge?.paymentIntentId ?? null);
  assert.equal(row.verifiedAmountCents, evidence.charge?.amountCents ?? null);
  assert.equal(row.verifiedCurrency, evidence.charge?.currency ?? null);
  assert.equal(row.resolvedAt, null);
  return row;
}

describe("payment exceptions: recording each persistent problem", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("1. missing Payment association: recorded without inventing a link", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    const evidence = paid(held);
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "PAYMENT_NOT_FOUND");

    const row = await recordedRow(evidence);
    assert.equal(row.category, "MISSING_ASSOCIATION");
    assert.equal(row.moneyReceived, true);
    assert.equal(row.verifiedAmountCents, DEPOSIT);
    assert.equal(row.expectedPaymentId, null);
    assert.equal(row.expectedAppointmentId, null);
    assert.equal(row.firstStripeEventId, evidence.stripeEventId);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" }); // 12.
  });

  it("1b. metadata naming a Payment that does not exist keeps the claim for investigation", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    const evidence = paid(held, { metadataPaymentId: "pay_missing", metadataAppointmentId: held.appointmentId });
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "PAYMENT_NOT_FOUND");
    const row = await recordedRow(evidence);
    assert.equal(row.expectedPaymentId, "pay_missing");
    assert.equal(row.expectedAppointmentId, held.appointmentId);
  });

  it("2. conflicting Checkout Session", async () => {
    const held = await createHeld(await createPlace());
    const evidence = paid(held, {
      checkoutSessionId: "cs_test_synthetic_conflicting",
      metadataPaymentId: held.paymentId,
      metadataAppointmentId: held.appointmentId,
    });
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "CHECKOUT_SESSION_MISMATCH");
    const row = await recordedRow(evidence);
    assert.equal(row.category, "IDENTITY_CONFLICT");
    assert.equal(row.expectedPaymentId, held.paymentId);
    assert.equal(row.expectedAppointmentId, held.appointmentId);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("3 + 13. conflicting PaymentIntent: the allocated Payment's evidence is not altered", async () => {
    const held = await createHeld(await createPlace());
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "confirmed");
    const before = await paymentRow(held);
    const eventsBefore = await listAppointmentEvents(held.appointmentId);

    const evidence = paid(held, { paymentIntentId: "pi_synthetic_conflicting" });
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "PAYMENT_INTENT_MISMATCH");
    const row = await recordedRow(evidence);
    assert.equal(row.paymentIntentId, "pi_synthetic_conflicting");
    assert.equal(row.expectedPaymentId, held.paymentId);

    assert.deepEqual(await paymentRow(held), before);
    assert.deepEqual(await listAppointmentEvents(held.appointmentId), eventsBefore);
  });

  it("4. incorrect appointment metadata", async () => {
    const slot = await createPlace();
    const held = await createHeld(slot, { bindSession: false });
    const unrelated = await createHeld(slot);
    const evidence = paid(held, { metadataPaymentId: held.paymentId, metadataAppointmentId: unrelated.appointmentId });
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "REFERENCE_MISMATCH");
    const row = await recordedRow(evidence);
    // The association the database actually has, not the claimed appointment.
    assert.equal(row.expectedPaymentId, held.paymentId);
    assert.equal(row.expectedAppointmentId, held.appointmentId);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
    await assertUntouched(unrelated, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("5. corrupt local Payment state", async () => {
    const held = await createHeld(await createPlace());
    await prisma.payment.update({ where: { id: held.paymentId }, data: { amountCents: 5000 } });
    const evidence = paid(held);
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "LOCAL_RECORD_INVALID");
    assert.equal((await recordedRow(evidence)).category, "CORRUPT_LOCAL_STATE");
    const payment = await paymentRow(held);
    assert.equal(payment.amountCents, 5000); // not repaired
    assert.equal(payment.status, "PENDING");
  });

  it("an unpaid report contradicting a PAID Payment is recorded with moneyReceived = false", async () => {
    const held = await createHeld(await createPlace());
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "confirmed");
    const evidence = unpaid(held, "expired");
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "LOCAL_PAID_BUT_PROVIDER_UNPAID");
    const row = await recordedRow(evidence);
    assert.equal(row.moneyReceived, false);
    assert.equal((await paymentRow(held)).status, "PAID");
  });

  it("evidence that applies is acknowledged and records nothing", async () => {
    const held = await createHeld(await createPlace());
    for (const evidence of [paid(held), paid(held), unpaid(await createHeld(held.slot), "open")]) {
      const disposition = await processVerifiedCheckoutEvidence(evidence);
      assert.equal(disposition.kind, "applied");
      assert.deepEqual(checkoutWebhookResponse({ disposition }), { status: 200 });
    }
    assert.equal(await prisma.paymentProcessingException.count(), 0);
  });
});

describe("payment exceptions: idempotency and observation history", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("6 + 10. repeated delivery with different Stripe Event ids updates one row; first observation kept", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    const deliveries = [paid(held), paid(held), paid(held, { stripeEventId: null }), paid(held)];
    const recorded = [];
    const before = await databaseNow();
    for (const evidence of deliveries) {
      const disposition = await processVerifiedCheckoutEvidence(evidence);
      assertRecorded(disposition, "PAYMENT_NOT_FOUND");
      recorded.push(disposition.exception);
    }
    const after = await databaseNow();

    assert.deepEqual(recorded.map((r) => r.created), [true, false, false, false]);
    assert.deepEqual(recorded.map((r) => r.occurrenceCount), [1, 2, 3, 4]);
    assert.equal(new Set(recorded.map((r) => r.id)).size, 1);

    const row = await recordedRow(deliveries[0]);
    assert.equal(row.occurrenceCount, 4);
    assert.equal(row.firstStripeEventId, deliveries[0].stripeEventId);
    assert.equal(row.lastStripeEventId, deliveries[3].stripeEventId);
    assert.deepEqual(row.firstObservedAt, recorded[0].firstObservedAt);
    for (const r of recorded) assert.deepEqual(r.firstObservedAt, recorded[0].firstObservedAt);
    for (let i = 1; i < recorded.length; i++) {
      assert.ok(recorded[i].lastObservedAt >= recorded[i - 1].lastObservedAt, "last observation never moves back");
    }
    assert.ok(row.firstObservedAt.getTime() >= before.getTime() - 1, "database clock, UTC");
    assert.ok(row.lastObservedAt.getTime() <= after.getTime() + 1);
    assert.ok(row.lastObservedAt > row.firstObservedAt);
  });

  it(`7. concurrent recording of the same exception: one row, every occurrence counted (${ROUNDS} rounds)`, async () => {
    const slot = await createPlace({ capacity: 50 });
    for (let round = 1; round <= ROUNDS; round++) {
      const held = await createHeld(slot, { bindSession: false });
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => processVerifiedCheckoutEvidence(paid(held))));
      assert.deepEqual(results.filter((r) => r.status === "rejected"), [], `round ${round}`);
      const created = results.map((r) => (r as PromiseFulfilledResult<CheckoutEvidenceDisposition>).value);
      assert.equal(created.filter((d) => d.kind === "exception-recorded" && d.exception.created).length, 1);
      assert.equal((await recordedRow(paid(held))).occurrenceCount, 6);
    }
  });

  it("7b. recorders queued behind an uncommitted insert of the same key all land on that one row", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    const evidence = paid(held);

    // Barrier: an open transaction holding the same unique key.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const ready = new Promise<void>((resolve) => (inserted = resolve));
    const barrier = prisma
      .$transaction(
        async (tx) => {
          await tx.paymentProcessingException.create({
            data: {
              provider: "STRIPE",
              checkoutSessionId: evidence.checkoutSessionId,
              category: "MISSING_ASSOCIATION",
              problem: "PAYMENT_NOT_FOUND",
              moneyReceived: false,
              firstObservedAt: new Date(),
              lastObservedAt: new Date(),
            },
          });
          inserted();
          await released;
          throw new Error("barrier rolled back");
        },
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    await ready;

    const racing = Promise.all(Array.from({ length: 4 }, () => processVerifiedCheckoutEvidence(paid(held))));
    await waitForLockWaiters(4);
    release();
    await barrier;
    const dispositions = await racing;

    const exceptions = dispositions.map((d) => (d.kind === "exception-recorded" ? d.exception : null));
    assert.equal(exceptions.filter((e) => e?.created).length, 1);
    assert.equal(new Set(exceptions.map((e) => e?.id)).size, 1);
    assert.equal((await recordedRow(evidence)).occurrenceCount, 4);
  });

  it("8. two genuinely different charges are two exceptions", async () => {
    const slot = await createPlace();
    const first = await createHeld(slot, { bindSession: false });
    const second = await createHeld(slot, { bindSession: false });
    assertRecorded(await processVerifiedCheckoutEvidence(paid(first)), "PAYMENT_NOT_FOUND");
    assertRecorded(await processVerifiedCheckoutEvidence(paid(second)), "PAYMENT_NOT_FOUND");
    const rows = await prisma.paymentProcessingException.findMany({ orderBy: { firstObservedAt: "asc" } });
    assert.deepEqual(rows.map((r) => r.paymentIntentId), [first.intent, second.intent]);
    assert.deepEqual(rows.map((r) => r.occurrenceCount), [1, 1]);
  });

  it("the same session with a different problem is a different exception", async () => {
    const held = await createHeld(await createPlace());
    assertOutcome(await applyVerifiedCheckoutSession(paid(held)), "confirmed");
    assertRecorded(
      await processVerifiedCheckoutEvidence(paid(held, { paymentIntentId: "pi_synthetic_other" })),
      "PAYMENT_INTENT_MISMATCH",
    );
    assertRecorded(await processVerifiedCheckoutEvidence(unpaid(held, "expired")), "LOCAL_PAID_BUT_PROVIDER_UNPAID");
    const rows = await exceptionsFor(held.session);
    assert.deepEqual(rows.map((r) => r.problem).sort(), ["LOCAL_PAID_BUT_PROVIDER_UNPAID", "PAYMENT_INTENT_MISMATCH"]);
  });
});

describe("payment exceptions: failure behavior and contract", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  it("9. exception persistence failure is a retryable failure, never an acknowledgement", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    const evidence = paid(held);

    let failure: unknown = null;
    await withFailingWrites("PaymentProcessingException", "INSERT", () =>
      processVerifiedCheckoutEvidence(evidence).catch((error: unknown) => {
        failure = error;
      }),
    );
    assert.ok(failure instanceof Error && /forced test failure/.test(failure.message), String(failure));
    assert.deepEqual(checkoutWebhookResponse({ error: failure }), { status: 500, retryable: true });
    assert.equal(await prisma.paymentProcessingException.count(), 0);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });

    // Stripe's redelivery then records it.
    assertRecorded(await processVerifiedCheckoutEvidence(evidence), "PAYMENT_NOT_FOUND");
    assert.equal((await recordedRow(evidence)).occurrenceCount, 1);
  });

  it("9b. a failed re-observation leaves the existing record unchanged", async () => {
    const held = await createHeld(await createPlace(), { bindSession: false });
    assertRecorded(await processVerifiedCheckoutEvidence(paid(held)), "PAYMENT_NOT_FOUND");
    const before = await recordedRow(paid(held));
    await assert.rejects(
      withFailingWrites("PaymentProcessingException", "UPDATE", () => processVerifiedCheckoutEvidence(paid(held))),
      /forced test failure/,
    );
    assert.deepEqual(await recordedRow(paid(held)), before);
  });

  it("invalid signature is rejected without retry", () => {
    assert.deepEqual(checkoutWebhookResponse({ signature: "invalid" }), { status: 400, retryable: false });
  });

  it("unverified evidence is never fulfilled and never recorded", async () => {
    const held = await createHeld(await createPlace());
    const forged = { ...paid(held) } as VerifiedCheckoutEvidence;
    await assert.rejects(processVerifiedCheckoutEvidence(forged), /only from verified Checkout evidence/);
    const outcome = await applyVerifiedCheckoutSession(forged);
    assertOutcome(outcome, "inconsistent");
    await assert.rejects(recordPaymentException(forged, outcome), /only from verified/);
    assert.equal(await prisma.paymentProcessingException.count(), 0);
    await assertUntouched(held, { payment: "PENDING", appointment: "PENDING_PAYMENT" });
  });

  it("an outcome produced for different evidence is refused", async () => {
    const slot = await createPlace();
    const a = await createHeld(slot, { bindSession: false });
    const b = await createHeld(slot, { bindSession: false });
    const outcome = await applyVerifiedCheckoutSession(paid(a));
    assertOutcome(outcome, "inconsistent");
    await assert.rejects(recordPaymentException(paid(b), outcome), /not produced for this evidence/);
    assert.equal(await prisma.paymentProcessingException.count(), 0);
  });

  it("11. unresolved exceptions stay discoverable; a resolved one reappears if observed again", async () => {
    const slot = await createPlace();
    const [x, y] = [await createHeld(slot, { bindSession: false }), await createHeld(slot, { bindSession: false })];
    assertRecorded(await processVerifiedCheckoutEvidence(paid(x)), "PAYMENT_NOT_FOUND");
    assertRecorded(await processVerifiedCheckoutEvidence(paid(y)), "PAYMENT_NOT_FOUND");
    assert.deepEqual((await listUnresolvedPaymentExceptions()).map((e) => e.checkoutSessionId), [x.session, y.session]);

    // A human resolves x (no service does this automatically).
    const resolvedAt = await databaseNow();
    await prisma.paymentProcessingException.updateMany({
      where: { checkoutSessionId: x.session },
      data: { resolvedAt, resolutionNote: "Refunded manually in Stripe." },
    });
    assert.deepEqual((await listUnresolvedPaymentExceptions()).map((e) => e.checkoutSessionId), [y.session]);

    // x is delivered again: recorded, not auto-resolved or auto-reopened, but listed.
    assertRecorded(await processVerifiedCheckoutEvidence(paid(x)), "PAYMENT_NOT_FOUND");
    const [row] = await exceptionsFor(x.session);
    assert.deepEqual(row.resolvedAt, resolvedAt);
    assert.equal(row.resolutionNote, "Refunded manually in Stripe.");
    assert.deepEqual(
      (await listUnresolvedPaymentExceptions()).map((e) => e.checkoutSessionId),
      [x.session, y.session],
    );
  });

  it("CHECK constraints refuse malformed exception rows", async () => {
    const base = {
      provider: "STRIPE" as const,
      checkoutSessionId: "cs_test_synthetic_check",
      category: "MISSING_ASSOCIATION" as const,
      problem: "PAYMENT_NOT_FOUND" as const,
      moneyReceived: false,
      firstObservedAt: new Date("2027-01-01T00:00:00Z"),
      lastObservedAt: new Date("2027-01-01T00:00:00Z"),
    };
    const cases: [Partial<Prisma.PaymentProcessingExceptionCreateInput>, string][] = [
      [{ moneyReceived: true }, "money_has_charge"],
      [{ category: "IDENTITY_CONFLICT" }, "category_matches_problem"],
      [{ verifiedAmountCents: 4000 }, "amount_pair"],
      [{ verifiedAmountCents: 0, verifiedCurrency: "usd" }, "amount_positive"],
      [{ verifiedAmountCents: 4000, verifiedCurrency: "USD" }, "currency_iso"],
      [{ checkoutSessionId: "not-a-session" }, "session_id"],
      [{ paymentIntentId: "ch_synthetic" }, "intent_id"],
      [{ firstStripeEventId: "event-1" }, "event_ids"],
      [{ occurrenceCount: 0 }, "occurrences_positive"],
      [{ lastObservedAt: new Date("2026-12-31T00:00:00Z") }, "observation_order"],
      [{ resolvedAt: new Date("2026-12-31T00:00:00Z") }, "resolution_order"],
      [{ resolutionNote: "note without resolution" }, "note_needs_resolution"],
    ];
    for (const [overrides, check] of cases) {
      await assert.rejects(
        prisma.paymentProcessingException.create({ data: { ...base, ...overrides } }),
        new RegExp(`PaymentProcessingException_${check}\\b`),
        check,
      );
    }
    const [{ checks }] = await prisma.$queryRaw<{ checks: number }[]>`
      SELECT count(*)::int AS checks FROM pg_constraint
      WHERE conrelid = '"PaymentProcessingException"'::regclass AND contype = 'c'
    `;
    assert.equal(checks, cases.length);
  });
});
