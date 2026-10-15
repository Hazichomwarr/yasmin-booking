import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { Prisma, type AppointmentEventType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { NOW, WEEK, createAppointmentIn, createLocation } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

/**
 * Migration #3 (payment foundation): the CHECK constraints and uniqueness
 * rules on Payment, exercised with synthetic rows against real PostgreSQL.
 * No Stripe objects exist behind any identifier here.
 */

const PAYMENT_CHECKS = [
  "Payment_allocation_needs_receipt",
  "Payment_amount_positive",
  "Payment_case_needs_receipt",
  "Payment_checkout_recovery_lease_pair",
  "Payment_currency_iso",
  "Payment_received_has_intent",
  "Payment_received_iff_paidAt",
  "Payment_refund_bounds",
  "Payment_refund_needs_receipt",
  "Payment_refunded_iff_full",
  "Payment_unallocated_has_case",
] as const;

type PaymentCheck = (typeof PAYMENT_CHECKS)[number];

let appointmentId: string;
let intentSequence = 0;

/** The appointment every payment under test belongs to. */
async function createSyntheticAppointment() {
  const { slot } = await createLocation();
  const appointment = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });
  appointmentId = appointment.id;
}

/** A synthetic deposit row; `overrides` describe the state under test. */
function deposit(overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
  return prisma.payment.create({
    data: {
      appointmentId,
      provider: "STRIPE",
      purpose: "BOOKING_DEPOSIT",
      amountCents: 4000,
      ...overrides,
    },
  });
}

/** Received-money facts with a unique synthetic PaymentIntent id. */
function received(status: "PAID" | "REFUNDED" = "PAID") {
  return { status, paidAt: NOW, providerPaymentIntentId: `pi_synthetic_${++intentSequence}` };
}

async function assertViolates(action: Promise<unknown>, constraint: PaymentCheck) {
  await assert.rejects(action, (error: unknown) => {
    const message = String(error instanceof Error ? error.message : error);
    assert.match(message, new RegExp(`\\b${constraint}\\b`), `expected ${constraint}, got: ${message}`);
    for (const other of PAYMENT_CHECKS) {
      if (other !== constraint) assert.doesNotMatch(message, new RegExp(`\\b${other}\\b`));
    }
    return true;
  });
}

describe("migration #3 schema", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  beforeEach(createSyntheticAppointment);

  it("installs exactly the payment CHECK constraints", async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"Payment"'::regclass AND contype = 'c'
      ORDER BY conname
    `;
    assert.deepEqual(
      rows.map((r) => r.conname),
    [...PAYMENT_CHECKS],
    );
  });

  it("accepts the new enum values", async () => {
    await deposit({ status: "EXPIRED", providerCheckoutExpiresAt: NOW });

    for (const type of [
      "HOLD_EXPIRY_CHANGED",
      "PAYMENT_RECEIVED_UNCONFIRMED",
      "PAYMENT_REFUND_UPDATED",
    ] satisfies AppointmentEventType[]) {
      await prisma.appointmentEvent.create({ data: { appointmentId, type } });
    }
    assert.equal(await prisma.appointmentEvent.count({ where: { appointmentId } }), 3);
  });
});

describe("valid payment states", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  beforeEach(createSyntheticAppointment);

  it("pending attempt, with and without a checkout expiry", async () => {
    const pending = await deposit();
    assert.equal(pending.status, "PENDING");
    assert.equal(pending.currency, "usd");
    assert.equal(pending.refundedAmountCents, 0);
    assert.equal(pending.allocatedAt, null);

    await prisma.payment.update({
      where: { id: pending.id },
      data: { providerCheckoutSessionId: "cs_synthetic_1", providerCheckoutExpiresAt: NOW },
    });
  });

  for (const status of ["FAILED", "EXPIRED"] as const) {
    it(`${status} with no money received`, async () => {
      await deposit({ status });
    });
  }

  it("paid and allocated", async () => {
    await deposit({ ...received(), allocatedAt: NOW });
  });

  for (const reason of [
    "PLACE_UNAVAILABLE",
    "APPOINTMENT_NOT_PAYABLE",
    "AMOUNT_MISMATCH",
    "REFUNDED_BEFORE_ALLOCATION",
  ] as const) {
    it(`paid, unallocated, with an open case (${reason})`, async () => {
      await deposit({ ...received(), reconciliationReason: reason, reconciliationNote: "Synthetic note" });
    });
  }

  it("unallocated case later allocated (rebooked) keeps its reason", async () => {
    const payment = await deposit({ ...received(), reconciliationReason: "PLACE_UNAVAILABLE" });
    await prisma.payment.update({ where: { id: payment.id }, data: { allocatedAt: NOW } });
  });

  it("partially refunded stays PAID", async () => {
    await deposit({ ...received(), allocatedAt: NOW, refundedAmountCents: 1000, refundsSyncedAt: NOW });
  });

  it("fully refunded allocated charge is REFUNDED", async () => {
    await deposit({ ...received("REFUNDED"), allocatedAt: NOW, refundedAmountCents: 4000 });
  });

  it("fully refunded closes an unallocated case without allocation", async () => {
    const payment = await deposit({ ...received(), reconciliationReason: "PLACE_UNAVAILABLE" });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "REFUNDED", refundedAmountCents: 4000, refundsSyncedAt: NOW },
    });
  });

  it("a failed refund returns REFUNDED to PAID", async () => {
    const payment = await deposit({ ...received("REFUNDED"), allocatedAt: NOW, refundedAmountCents: 4000 });
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "PAID", refundedAmountCents: 0 },
    });
  });
});

describe("invalid payment states are rejected", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  beforeEach(createSyntheticAppointment);

  it("non-positive amount", async () => {
    await assertViolates(deposit({ amountCents: 0 }), "Payment_amount_positive");
    await assertViolates(deposit({ amountCents: -4000 }), "Payment_amount_positive");
  });

  for (const currency of ["USD", "us", "usdd", "", "u5d"]) {
    it(`currency ${JSON.stringify(currency)}`, async () => {
      await assertViolates(deposit({ currency }), "Payment_currency_iso");
    });
  }

  it("PAID without paidAt", async () => {
    await assertViolates(
      deposit({ status: "PAID", providerPaymentIntentId: "pi_synthetic_no_paid_at", allocatedAt: null }),
      "Payment_received_iff_paidAt",
    );
  });

  for (const status of ["PENDING", "FAILED", "EXPIRED"] as const) {
    it(`paidAt on a ${status} payment`, async () => {
      await assertViolates(
        deposit({ status, paidAt: NOW, providerPaymentIntentId: `pi_synthetic_${status}`, allocatedAt: NOW }),
        "Payment_received_iff_paidAt",
      );
    });
  }

  it("received payment without a PaymentIntent", async () => {
    await assertViolates(
      deposit({ status: "PAID", paidAt: NOW, allocatedAt: NOW }),
      "Payment_received_has_intent",
    );
  });

  it("allocation without a received payment", async () => {
    await assertViolates(deposit({ allocatedAt: NOW }), "Payment_allocation_needs_receipt");
  });

  it("received payment that is neither allocated nor in reconciliation", async () => {
    await assertViolates(deposit(received()), "Payment_unallocated_has_case");
  });

  it("allocation evidence cannot be removed from an unreconciled charge", async () => {
    const payment = await deposit({ ...received(), allocatedAt: NOW });
    await assertViolates(
      prisma.payment.update({ where: { id: payment.id }, data: { allocatedAt: null } }),
      "Payment_unallocated_has_case",
    );
  });

  it("reconciliation reason without a received payment", async () => {
    await assertViolates(
      deposit({ reconciliationReason: "PLACE_UNAVAILABLE" }),
      "Payment_case_needs_receipt",
    );
  });

  it("refund outside 0..amountCents", async () => {
    await assertViolates(
      deposit({ ...received(), allocatedAt: NOW, refundedAmountCents: -1 }),
      "Payment_refund_bounds",
    );
    await assertViolates(
      deposit({ ...received(), allocatedAt: NOW, refundedAmountCents: 4001 }),
      "Payment_refund_bounds",
    );
  });

  it("refund without a received payment", async () => {
    await assertViolates(deposit({ refundedAmountCents: 1000 }), "Payment_refund_needs_receipt");
  });

  it("PAID with the full amount refunded", async () => {
    await assertViolates(
      deposit({ ...received(), allocatedAt: NOW, refundedAmountCents: 4000 }),
      "Payment_refunded_iff_full",
    );
  });

  it("REFUNDED with only a partial refund", async () => {
    await assertViolates(
      deposit({ ...received("REFUNDED"), allocatedAt: NOW, refundedAmountCents: 1000 }),
      "Payment_refunded_iff_full",
    );
  });

  it("a note cannot stand in for refund evidence", async () => {
    await assertViolates(
      deposit({
        ...received("REFUNDED"),
        reconciliationReason: "PLACE_UNAVAILABLE",
        reconciliationNote: "Refunded in the Dashboard",
      }),
      "Payment_refunded_iff_full",
    );
  });
});

describe("payment uniqueness", { skip: integrationSkip }, () => {
  useCleanTestDatabase();
  beforeEach(createSyntheticAppointment);

  const assertUniqueViolation = (action: Promise<unknown>, fields: string[]) =>
    assert.rejects(action, (error: unknown) => {
      assert.ok(error instanceof Prisma.PrismaClientKnownRequestError, String(error));
      assert.equal(error.code, "P2002");
      assert.deepEqual(error.meta?.target, fields);
      return true;
    });

  it("one deposit attempt per appointment, whatever its status", async () => {
    await deposit({ status: "FAILED" });
    await assertUniqueViolation(deposit(), ["appointmentId", "purpose"]);
  });

  it("deposits for different appointments are independent", async () => {
    await deposit();
    const { slot } = await createLocation({ name: "Other Street" });
    const other = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });
    await prisma.payment.create({
      data: { appointmentId: other.id, provider: "STRIPE", purpose: "BOOKING_DEPOSIT", amountCents: 4000 },
    });
  });

  it("a PaymentIntent belongs to at most one payment", async () => {
    await deposit({ ...received(), allocatedAt: NOW, providerPaymentIntentId: "pi_synthetic_shared" });
    const { slot } = await createLocation({ name: "Other Street" });
    const other = await createAppointmentIn({ slot, appointmentDate: WEEK.monday });
    await assertUniqueViolation(
      prisma.payment.create({
        data: {
          appointmentId: other.id,
          provider: "STRIPE",
          purpose: "BOOKING_DEPOSIT",
          amountCents: 4000,
          status: "PAID",
          paidAt: NOW,
          allocatedAt: NOW,
          providerPaymentIntentId: "pi_synthetic_shared",
        },
      }),
      ["providerPaymentIntentId"],
    );
  });
});
