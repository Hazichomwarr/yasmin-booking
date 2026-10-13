import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AppointmentStatus, PaymentStatus } from "@prisma/client";

import * as booking from "@/lib/booking";
import { eventDetails, type AppointmentEventDetailsByType } from "@/lib/booking/appointment-events";
import type { PlacePolicyClosedReason } from "@/lib/booking/booking-policy";
import {
  LIFECYCLE_TRANSITIONS,
  PAYMENT_CONFIRMATION_TRANSITION,
} from "@/lib/booking/lifecycle-policy";
import {
  decidePaymentBeforePlace,
  decidePaymentConfirmation,
  isVerifiedCheckoutEvidence,
  paymentDecisionEvent,
  verifiedCheckoutEvidence,
  type AppointmentPaymentFacts,
  type CheckoutEvidenceInput,
  type PaymentConfirmationDecision,
  type PaymentConfirmationInput,
  type PaymentRecordFacts,
  type PlaceFacts,
  type VerifiedCheckoutEvidence,
} from "@/lib/booking/payment-policy";

/** Synthetic facts only: no identifier below refers to a real Stripe object. */

const DECIDED_AT = new Date("2027-03-01T15:30:00.000Z");
const ms = (n: number) => new Date(DECIDED_AT.getTime() + n);
const MINUTE = 60_000;
const HOLD_ACTIVE = ms(5 * MINUTE);
const HOLD_EXPIRED = ms(-5 * MINUTE);
const PAID_AT = ms(-1 * MINUTE);

const SESSION = "cs_test_synthetic_1";
const INTENT = "pi_synthetic_1";

function evidence(overrides: Partial<CheckoutEvidenceInput> = {}): VerifiedCheckoutEvidence {
  return verifiedCheckoutEvidence({
    checkoutSessionId: SESSION,
    sessionStatus: "complete",
    paymentStatus: "paid",
    paymentIntentId: INTENT,
    amountCents: 4000,
    currency: "usd",
    paidAt: PAID_AT,
    refundedOrPendingCents: 0,
    stripeEventId: "evt_synthetic_1",
    ...overrides,
  });
}

const pendingPayment: PaymentRecordFacts = {
  paymentId: "pay_synthetic_1",
  status: "PENDING",
  amountCents: 4000,
  currency: "usd",
  providerCheckoutSessionId: SESSION,
  providerPaymentIntentId: null,
  paidAt: null,
  allocatedAt: null,
  refundedAmountCents: 0,
  reconciliationReason: null,
};

const allocatedPayment: PaymentRecordFacts = {
  ...pendingPayment,
  status: "PAID",
  providerPaymentIntentId: INTENT,
  paidAt: PAID_AT,
  allocatedAt: ms(-30_000),
};

const unallocatedPayment: PaymentRecordFacts = {
  ...pendingPayment,
  status: "PAID",
  providerPaymentIntentId: INTENT,
  paidAt: PAID_AT,
  reconciliationReason: "PLACE_UNAVAILABLE",
};

const heldAppointment: AppointmentPaymentFacts = {
  status: "PENDING_PAYMENT",
  holdExpiresAt: HOLD_ACTIVE,
  depositAmountCents: 4000,
};

/** Where an allocated payment's appointment normally is. */
const CONFIRMED: Partial<AppointmentPaymentFacts> = { status: "CONFIRMED" };

const FREE: PlaceFacts = { capacity: 2, consumedByOthers: 1, bookingPolicyClosedReason: null };
const FULL: PlaceFacts = { capacity: 2, consumedByOthers: 2, bookingPolicyClosedReason: null };

function input(overrides: {
  evidence?: VerifiedCheckoutEvidence;
  payment?: Partial<PaymentRecordFacts>;
  appointment?: Partial<AppointmentPaymentFacts>;
  place?: Partial<PlaceFacts>;
  decidedAt?: Date;
} = {}): PaymentConfirmationInput {
  return {
    evidence: overrides.evidence ?? evidence(),
    payment: { ...pendingPayment, ...overrides.payment },
    appointment: { ...heldAppointment, ...overrides.appointment },
    place: { ...FREE, ...overrides.place },
    decidedAt: overrides.decidedAt ?? DECIDED_AT,
  };
}

const decide = (overrides: Parameters<typeof input>[0] = {}) => decidePaymentConfirmation(input(overrides));

function assertKind<K extends PaymentConfirmationDecision["kind"]>(
  decision: PaymentConfirmationDecision,
  kind: K,
): asserts decision is Extract<PaymentConfirmationDecision, { kind: K }> {
  assert.equal(decision.kind, kind, JSON.stringify(decision));
}

function assertReconcile(decision: PaymentConfirmationDecision, reason: string) {
  assertKind(decision, "reconcile");
  assert.equal(decision.reason, reason);
}

function assertInconsistent(decision: PaymentConfirmationDecision, problem: string) {
  assertKind(decision, "inconsistent");
  assert.equal(decision.problem, problem);
}

describe("confirmation", () => {
  it("1. verified payment within an active hold with a free place confirms", () => {
    const decision = decide();
    assertKind(decision, "confirm");
    assert.equal(decision.method, "within-active-hold");
    assert.deepEqual(decision.transition, { from: "PENDING_PAYMENT", to: "CONFIRMED", event: "PAYMENT_CONFIRMED" });
    assert.deepEqual(decision.receipt, {
      checkoutSessionId: SESSION,
      paymentIntentId: INTENT,
      amountCents: 4000,
      currency: "usd",
      paidAt: PAID_AT,
      previousStatus: "PENDING",
    });
    assert.deepEqual(decision.place, {
      holdExpiresAt: HOLD_ACTIVE,
      holdActive: true,
      capacity: 2,
      consumedByOthers: 1,
      bookingPolicyClosedReason: null,
    });
  });

  it("an active hold keeps its booking terms even if policy has since closed", () => {
    const decision = decide({ place: { bookingPolicyClosedReason: "SLOT_NOT_BOOKABLE" } });
    assertKind(decision, "confirm");
    assert.equal(decision.method, "within-active-hold");
  });

  it("2. verified payment after hold expiry confirms when reacquisition is valid", () => {
    const decision = decide({ appointment: { holdExpiresAt: HOLD_EXPIRED } });
    assertKind(decision, "confirm");
    assert.equal(decision.method, "reacquired-after-hold-expiry");
    assert.equal(decision.place.holdActive, false);
  });

  it("a hold with no expiry is treated as expired (full reacquisition)", () => {
    const decision = decide({ appointment: { holdExpiresAt: null } });
    assertKind(decision, "confirm");
    assert.equal(decision.method, "reacquired-after-hold-expiry");
  });
});

describe("reconciliation", () => {
  it("3. active hold but no free place: reconcile, never overbook", () => {
    const decision = decide({ place: FULL });
    assertReconcile(decision, "PLACE_UNAVAILABLE");
    assert.equal(decision.kind === "reconcile" && decision.place.holdActive, true);
  });

  it("capacity corrupted above configured is still 'no place'", () => {
    assertReconcile(decide({ place: { capacity: 2, consumedByOthers: 5 } }), "PLACE_UNAVAILABLE");
  });

  it("4. expired hold and capacity full", () => {
    assertReconcile(decide({ appointment: { holdExpiresAt: HOLD_EXPIRED }, place: FULL }), "PLACE_UNAVAILABLE");
  });

  for (const policy of [
    "INVALID_APPOINTMENT_DATE",
    "ONLINE_BOOKING_CLOSED_FOR_DAY",
    "LOCATION_NOT_BOOKABLE",
    "SLOT_NOT_BOOKABLE",
  ] satisfies PlacePolicyClosedReason[]) {
    it(`5. expired hold and booking policy closed (${policy}), even with a free place`, () => {
      const decision = decide({
        appointment: { holdExpiresAt: HOLD_EXPIRED },
        place: { bookingPolicyClosedReason: policy },
      });
      assertReconcile(decision, "PLACE_UNAVAILABLE");
      assert.equal(decision.kind === "reconcile" && decision.place.bookingPolicyClosedReason, policy);
    });
  }

  it("6. cancelled appointment receives payment", () => {
    assertReconcile(decide({ appointment: { status: "CANCELLED" } }), "APPOINTMENT_NOT_PAYABLE");
  });

  for (const status of ["COMPLETED", "NO_SHOW", "CONFIRMED"] satisfies AppointmentStatus[]) {
    it(`7. ${status} appointment receives an unallocated payment`, () => {
      assertReconcile(decide({ appointment: { status } }), "APPOINTMENT_NOT_PAYABLE");
    });
  }

  it("8. amount mismatch (under and over)", () => {
    assertReconcile(decide({ evidence: evidence({ amountCents: 3999 }) }), "AMOUNT_MISMATCH");
    assertReconcile(decide({ evidence: evidence({ amountCents: 5000 }) }), "AMOUNT_MISMATCH");
  });

  it("9. currency mismatch", () => {
    assertReconcile(decide({ evidence: evidence({ currency: "eur" }) }), "AMOUNT_MISMATCH");
  });

  it("10. refund activity before allocation (partial, pending or full)", () => {
    for (const refunded of [1, 1000, 4000]) {
      assertReconcile(
        decide({ evidence: evidence({ refundedOrPendingCents: refunded }) }),
        "REFUNDED_BEFORE_ALLOCATION",
      );
    }
  });

  it("reasons are checked in a fixed order: amount, refund, appointment, place", () => {
    assertReconcile(
      decide({
        evidence: evidence({ amountCents: 3999, refundedOrPendingCents: 100 }),
        appointment: { status: "CANCELLED" },
        place: FULL,
      }),
      "AMOUNT_MISMATCH",
    );
    assertReconcile(
      decide({ evidence: evidence({ refundedOrPendingCents: 100 }), appointment: { status: "CANCELLED" } }),
      "REFUNDED_BEFORE_ALLOCATION",
    );
    assertReconcile(decide({ appointment: { status: "CANCELLED" }, place: FULL }), "APPOINTMENT_NOT_PAYABLE");
  });

  it("the reconciliation receipt records Stripe's verified amount, not the expected one", () => {
    const decision = decide({ evidence: evidence({ amountCents: 3999, currency: "eur" }) });
    assertKind(decision, "reconcile");
    assert.equal(decision.receipt.amountCents, 3999);
    assert.equal(decision.receipt.currency, "eur");
  });
});

describe("idempotency and identity", () => {
  it("11. duplicate verification after allocation is a no-op, whatever the Stripe event id", () => {
    for (const stripeEventId of ["evt_synthetic_1", "evt_synthetic_other", null]) {
      assertKind(decide({ evidence: evidence({ stripeEventId }), payment: allocatedPayment, appointment: CONFIRMED }), "already-allocated");
    }
  });

  it("already-allocated holds after the appointment moved on in its lifecycle", () => {
    for (const status of ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED"] satisfies AppointmentStatus[]) {
      assertKind(decide({ payment: allocatedPayment, appointment: { status } }), "already-allocated");
    }
  });

  it("12. duplicate verification with an open case never allocates, even if a place is now free", () => {
    const decision = decide({ payment: unallocatedPayment, place: FREE });
    assertKind(decision, "already-recorded-unallocated");
    assert.equal(decision.reason, "PLACE_UNAVAILABLE");
  });

  it("a case closed by a full refund stays recorded-unallocated", () => {
    const decision = decide({
      payment: { ...unallocatedPayment, status: "REFUNDED", refundedAmountCents: 4000 },
    });
    assertKind(decision, "already-recorded-unallocated");
  });

  for (const previousStatus of ["EXPIRED", "FAILED"] satisfies PaymentStatus[]) {
    it(`${previousStatus === "EXPIRED" ? 13 : 14}. ${previousStatus} payment later verified PAID is recorded as received`, () => {
      const confirmed = decide({ payment: { status: previousStatus } });
      assertKind(confirmed, "confirm");
      assert.equal(confirmed.receipt.previousStatus, previousStatus);

      const reconciled = decide({ payment: { status: previousStatus }, place: FULL });
      assertReconcile(reconciled, "PLACE_UNAVAILABLE");
      assert.equal(reconciled.kind === "reconcile" && reconciled.receipt.previousStatus, previousStatus);
    });
  }

  it("15. conflicting PaymentIntent id is reported, never replaced", () => {
    assertInconsistent(
      decide({ payment: { providerPaymentIntentId: "pi_synthetic_other" } }),
      "PAYMENT_INTENT_MISMATCH",
    );
    assertInconsistent(
      decide({ payment: { ...allocatedPayment, providerPaymentIntentId: "pi_synthetic_other" }, appointment: CONFIRMED }),
      "PAYMENT_INTENT_MISMATCH",
    );
  });

  it("16. conflicting Checkout Session id is reported, never replaced", () => {
    assertInconsistent(
      decide({ payment: { providerCheckoutSessionId: "cs_test_synthetic_other" } }),
      "CHECKOUT_SESSION_MISMATCH",
    );
    assertInconsistent(
      decide({ payment: { ...allocatedPayment, providerCheckoutSessionId: "cs_test_synthetic_other" }, appointment: CONFIRMED }),
      "CHECKOUT_SESSION_MISMATCH",
    );
  });

  it("an unrecorded session id (matched by payment metadata) is accepted and carried in the receipt", () => {
    const decision = decide({ payment: { providerCheckoutSessionId: null } });
    assertKind(decision, "confirm");
    assert.equal(decision.receipt.checkoutSessionId, SESSION);
  });

  it("a different charge time for a received payment is reported", () => {
    assertInconsistent(
      decide({ evidence: evidence({ paidAt: ms(-2 * MINUTE) }), payment: allocatedPayment, appointment: CONFIRMED }),
      "PAID_AT_MISMATCH",
    );
  });

  it("an allocated charge whose verified amount changed is reported", () => {
    assertInconsistent(
      decide({ evidence: evidence({ amountCents: 3999 }), payment: allocatedPayment, appointment: CONFIRMED }),
      "VERIFIED_AMOUNT_CHANGED",
    );
  });
});

describe("unpaid sessions", () => {
  it("17. unpaid Checkout Session: nothing received", () => {
    const unpaid = (sessionStatus: string) => evidence({ sessionStatus, paymentStatus: "unpaid" });

    assert.deepEqual(decide({ evidence: unpaid("open") }), { kind: "not-paid", expirePayment: false });
    assert.deepEqual(decide({ evidence: unpaid("complete") }), { kind: "not-paid", expirePayment: false });
    assert.deepEqual(decide({ evidence: unpaid("expired") }), { kind: "not-paid", expirePayment: true });
    for (const status of ["FAILED", "EXPIRED"] satisfies PaymentStatus[]) {
      assert.deepEqual(decide({ evidence: unpaid("expired"), payment: { status } }), {
        kind: "not-paid",
        expirePayment: false,
      });
    }
  });

  it("unpaid evidence for a received payment is reported", () => {
    assertInconsistent(
      decide({ evidence: evidence({ sessionStatus: "expired", paymentStatus: "unpaid" }), payment: allocatedPayment, appointment: CONFIRMED }),
      "LOCAL_PAID_BUT_PROVIDER_UNPAID",
    );
  });

  it("a session that required no payment is reported", () => {
    assertInconsistent(
      decide({ evidence: evidence({ paymentStatus: "no_payment_required" }) }),
      "NO_PAYMENT_REQUIRED",
    );
  });
});

describe("18. invalid or inconsistent local state", () => {
  const cases: [string, Parameters<typeof input>[0], string][] = [
    ["Payment amount differs from the deposit snapshot", { payment: { amountCents: 3000 } }, "LOCAL_RECORD_INVALID"],
    ["PAID without paidAt", { payment: { status: "PAID", providerPaymentIntentId: INTENT } }, "LOCAL_RECORD_INVALID"],
    ["paidAt on a PENDING payment", { payment: { paidAt: PAID_AT } }, "LOCAL_RECORD_INVALID"],
    ["received without PaymentIntent", { payment: { ...allocatedPayment, providerPaymentIntentId: null } }, "LOCAL_RECORD_INVALID"],
    ["allocated without receipt", { payment: { allocatedAt: PAID_AT }, appointment: { status: "CONFIRMED" } }, "LOCAL_RECORD_INVALID"],
    ["received, unallocated, no case", { payment: { ...unallocatedPayment, reconciliationReason: null } }, "LOCAL_RECORD_INVALID"],
    ["case without receipt", { payment: { reconciliationReason: "PLACE_UNAVAILABLE" } }, "LOCAL_RECORD_INVALID"],
    ["refund without receipt", { payment: { refundedAmountCents: 100 } }, "LOCAL_RECORD_INVALID"],
    ["allocated while the appointment is still pending", { payment: allocatedPayment }, "ALLOCATED_BUT_APPOINTMENT_PENDING"],
  ];
  for (const [label, overrides, problem] of cases) {
    it(label, () => assertInconsistent(decide(overrides), problem));
  }

  it("rejects malformed place facts or decision instant (programming errors)", () => {
    assert.throws(() => decide({ place: { capacity: -1 } }));
    assert.throws(() => decide({ place: { consumedByOthers: 1.5 } }));
    assert.throws(() => decide({ decidedAt: new Date(Number.NaN) }));
  });
});

describe("19. exact hold-expiry boundary (same rule as capacity)", () => {
  it("expiry 1 ms after the decision instant: hold active", () => {
    const decision = decide({ appointment: { holdExpiresAt: ms(1) }, place: { bookingPolicyClosedReason: "SLOT_NOT_BOOKABLE" } });
    assertKind(decision, "confirm");
    assert.equal(decision.method, "within-active-hold");
  });

  it("expiry exactly at the decision instant: expired, so full reacquisition applies", () => {
    const decision = decide({ appointment: { holdExpiresAt: ms(0) } });
    assertKind(decision, "confirm");
    assert.equal(decision.method, "reacquired-after-hold-expiry");

    assertReconcile(
      decide({ appointment: { holdExpiresAt: ms(0) }, place: { bookingPolicyClosedReason: "SLOT_NOT_BOOKABLE" } }),
      "PLACE_UNAVAILABLE",
    );
  });

  it("expiry 1 ms before the decision instant: expired", () => {
    const decision = decide({ appointment: { holdExpiresAt: ms(-1) } });
    assertKind(decision, "confirm");
    assert.equal(decision.method, "reacquired-after-hold-expiry");
  });
});

describe("evidence normalization", () => {
  it("builds frozen evidence and copies instants", () => {
    const paidAt = new Date(PAID_AT.getTime());
    const verified = evidence({ paidAt });
    paidAt.setTime(0);
    assert.equal(verified.charge?.paidAt.getTime(), PAID_AT.getTime());
    assert.ok(Object.isFrozen(verified));
    assert.ok(Object.isFrozen(verified.charge));
  });

  it("drops charge facts from unpaid sessions", () => {
    assert.equal(evidence({ paymentStatus: "unpaid", sessionStatus: "open" }).charge, null);
  });

  const bad: [string, Partial<CheckoutEvidenceInput>][] = [
    ["non-session id", { checkoutSessionId: "pi_synthetic_1" }],
    ["unknown session status", { sessionStatus: "paid" }],
    ["unknown payment status", { paymentStatus: "succeeded" }],
    ["paid but session still open", { sessionStatus: "open" }],
    ["paid without PaymentIntent", { paymentIntentId: null }],
    ["non-PaymentIntent id", { paymentIntentId: "ch_synthetic_1" }],
    ["zero amount", { amountCents: 0 }],
    ["fractional amount", { amountCents: 40.5 }],
    ["uppercase currency", { currency: "USD" }],
    ["missing paidAt", { paidAt: null }],
    ["invalid paidAt", { paidAt: new Date(Number.NaN) }],
    ["refund above amount", { refundedOrPendingCents: 4001 }],
    ["negative refund", { refundedOrPendingCents: -1 }],
    ["non-event id", { stripeEventId: "cs_test_synthetic_1" }],
  ];
  for (const [label, overrides] of bad) {
    it(`rejects ${label}`, () => assert.throws(() => evidence(overrides), /Unusable Stripe checkout evidence/));
  }
});

describe("purity", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  }

  it("never mutates its inputs, including money snapshots and instants", () => {
    const scenarios = [
      input(),
      input({ appointment: { holdExpiresAt: HOLD_EXPIRED }, place: FULL }),
      input({ evidence: evidence({ amountCents: 3999 }) }),
      input({ payment: allocatedPayment, appointment: { status: "CONFIRMED" } }),
      input({ payment: unallocatedPayment }),
    ];
    for (const scenario of scenarios) {
      const before = structuredClone({ ...scenario, evidence: { ...scenario.evidence } });
      deepFreeze(scenario);
      const decision = decidePaymentConfirmation(scenario);
      paymentDecisionEvent(decision, scenario);
      assert.deepEqual({ ...scenario, evidence: { ...scenario.evidence } }, before);

      // Returned instants are copies: mutating them cannot reach the inputs.
      if (decision.kind === "confirm" || decision.kind === "reconcile") {
        decision.receipt.paidAt.setTime(0);
        decision.place.holdExpiresAt?.setTime(0);
        assert.equal(scenario.evidence.charge?.paidAt.getTime(), PAID_AT.getTime());
        assert.notEqual(scenario.appointment.holdExpiresAt?.getTime(), 0);
      }
    }
  });

  it("is deterministic", () => {
    assert.deepEqual(decide(), decide());
    assert.deepEqual(decide({ place: FULL }), decide({ place: FULL }));
  });
});

describe("lifecycle integration", () => {
  it("payment confirmation is not a lifecycle command", () => {
    assert.ok(!Object.values(LIFECYCLE_TRANSITIONS).some((rule) => rule.to === "CONFIRMED"));
    assert.ok(!("confirm" in LIFECYCLE_TRANSITIONS));
    assert.equal(PAYMENT_CONFIRMATION_TRANSITION.from, "PENDING_PAYMENT");
    assert.equal(PAYMENT_CONFIRMATION_TRANSITION.to, "CONFIRMED");
  });

  it("the booking module still exports no confirm/payment entry point", () => {
    const names = Object.keys(booking).filter((name) => /confirm|payment/i.test(name));
    assert.deepEqual(names, []);
  });
});

describe("20. typed audit-event payloads", () => {
  it("PAYMENT_CONFIRMED payload from a confirm decision", () => {
    const scenario = input();
    const event = paymentDecisionEvent(decidePaymentConfirmation(scenario), scenario);
    assert.deepEqual(event, {
      type: "PAYMENT_CONFIRMED",
      details: {
        schemaVersion: 1,
        fromStatus: "PENDING_PAYMENT",
        toStatus: "CONFIRMED",
        payment: {
          paymentId: "pay_synthetic_1",
          checkoutSessionId: SESSION,
          paymentIntentId: INTENT,
          amountCents: 4000,
          currency: "usd",
          paidAt: "2027-03-01T15:29:00.000Z",
        },
        previousPaymentStatus: "PENDING",
        allocatedAt: "2027-03-01T15:30:00.000Z",
        confirmation: "within-active-hold",
        hold: { expiresAt: "2027-03-01T15:35:00.000Z", activeAtDecision: true, paidBeforeExpiry: true },
        capacity: { configured: 2, consumedByOthers: 1 },
        decidedAt: "2027-03-01T15:30:00.000Z",
        stripeEventId: "evt_synthetic_1",
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  });

  it("PAYMENT_RECEIVED_UNCONFIRMED payload keeps verified and recorded amounts apart", () => {
    const scenario = input({
      evidence: evidence({ amountCents: 3999, stripeEventId: null }),
      payment: { status: "EXPIRED" },
      appointment: { holdExpiresAt: HOLD_EXPIRED },
    });
    const event = paymentDecisionEvent(decidePaymentConfirmation(scenario), scenario);
    assert.deepEqual(event, {
      type: "PAYMENT_RECEIVED_UNCONFIRMED",
      details: {
        schemaVersion: 1,
        payment: {
          paymentId: "pay_synthetic_1",
          checkoutSessionId: SESSION,
          paymentIntentId: INTENT,
          amountCents: 3999,
          currency: "usd",
          paidAt: "2027-03-01T15:29:00.000Z",
        },
        recorded: { amountCents: 4000, currency: "usd" },
        previousPaymentStatus: "EXPIRED",
        reason: "AMOUNT_MISMATCH",
        appointmentStatus: "PENDING_PAYMENT",
        hold: { expiresAt: "2027-03-01T15:25:00.000Z", activeAtDecision: false, paidBeforeExpiry: false },
        capacity: { configured: 2, consumedByOthers: 1 },
        bookingPolicyClosedReason: null,
        decidedAt: "2027-03-01T15:30:00.000Z",
        stripeEventId: null,
      },
    });
  });

  it("records the blocking policy reason for an expired hold", () => {
    const scenario = input({
      appointment: { holdExpiresAt: HOLD_EXPIRED },
      place: { bookingPolicyClosedReason: "INVALID_APPOINTMENT_DATE" },
    });
    const event = paymentDecisionEvent(decidePaymentConfirmation(scenario), scenario);
    assert.equal(event?.type, "PAYMENT_RECEIVED_UNCONFIRMED");
    assert.equal(
      event?.type === "PAYMENT_RECEIVED_UNCONFIRMED" && event.details.bookingPolicyClosedReason,
      "INVALID_APPOINTMENT_DATE",
    );
  });

  it("decisions that change nothing produce no event", () => {
    for (const scenario of [
      input({ payment: allocatedPayment, appointment: { status: "CONFIRMED" } }),
      input({ payment: unallocatedPayment }),
      input({ evidence: evidence({ paymentStatus: "unpaid", sessionStatus: "open" }) }),
      input({ payment: { providerPaymentIntentId: "pi_synthetic_other" } }),
    ]) {
      assert.equal(paymentDecisionEvent(decidePaymentConfirmation(scenario), scenario), null);
    }
  });

  it("HOLD_EXPIRY_CHANGED payload", () => {
    assert.deepEqual(
      eventDetails.holdExpiryChanged({
        reason: "checkout-started",
        before: ms(10 * MINUTE),
        after: ms(39 * MINUTE),
        paymentId: "pay_synthetic_1",
        checkoutExpiresAt: ms(34 * MINUTE),
        decidedAt: DECIDED_AT,
      }),
      {
        schemaVersion: 1,
        reason: "checkout-started",
        before: "2027-03-01T15:40:00.000Z",
        after: "2027-03-01T16:09:00.000Z",
        paymentId: "pay_synthetic_1",
        checkoutExpiresAt: "2027-03-01T16:04:00.000Z",
        decidedAt: "2027-03-01T15:30:00.000Z",
      },
    );
  });

  it("PAYMENT_REFUND_UPDATED payload", () => {
    assert.deepEqual(
      eventDetails.paymentRefundUpdated({
        paymentId: "pay_synthetic_1",
        before: { refundedAmountCents: 0, status: "PAID" },
        after: { refundedAmountCents: 4000, status: "REFUNDED" },
        refunds: [
          { id: "re_synthetic_1", amountCents: 1000, status: "succeeded" },
          { id: "re_synthetic_2", amountCents: 3000, status: "succeeded" },
          { id: "re_synthetic_3", amountCents: 500, status: "failed" },
        ],
        decidedAt: DECIDED_AT,
        stripeEventId: "evt_synthetic_9",
      }),
      {
        schemaVersion: 1,
        paymentId: "pay_synthetic_1",
        before: { refundedAmountCents: 0, status: "PAID" },
        after: { refundedAmountCents: 4000, status: "REFUNDED" },
        refunds: [
          { id: "re_synthetic_1", amountCents: 1000, status: "succeeded" },
          { id: "re_synthetic_2", amountCents: 3000, status: "succeeded" },
          { id: "re_synthetic_3", amountCents: 500, status: "failed" },
        ],
        decidedAt: "2027-03-01T15:30:00.000Z",
        stripeEventId: "evt_synthetic_9",
      },
    );
  });

  it("builders refuse malformed facts instead of storing them", () => {
    const confirmed = {
      payment: {
        paymentId: "pay_synthetic_1",
        checkoutSessionId: SESSION,
        paymentIntentId: INTENT,
        amountCents: 4000,
        currency: "usd",
        paidAt: PAID_AT,
      },
      previousPaymentStatus: "PENDING" as const,
      allocatedAt: DECIDED_AT,
      confirmation: "within-active-hold" as const,
      hold: { expiresAt: HOLD_ACTIVE, activeAtDecision: true },
      capacity: { configured: 2, consumedByOthers: 1 },
      decidedAt: DECIDED_AT,
      stripeEventId: null,
    };
    assert.doesNotThrow(() => eventDetails.paymentConfirmed(confirmed));
    for (const broken of [
      { ...confirmed, payment: { ...confirmed.payment, amountCents: -1 } },
      { ...confirmed, payment: { ...confirmed.payment, amountCents: 40.5 } },
      { ...confirmed, payment: { ...confirmed.payment, currency: "USD" } },
      { ...confirmed, payment: { ...confirmed.payment, paymentId: " " } },
      { ...confirmed, payment: { ...confirmed.payment, paidAt: new Date(Number.NaN) } },
      { ...confirmed, capacity: { configured: -1, consumedByOthers: 0 } },
      { ...confirmed, stripeEventId: "" },
    ]) {
      assert.throws(() => eventDetails.paymentConfirmed(broken), /Event details/);
    }

    assert.throws(
      () =>
        eventDetails.paymentRefundUpdated({
          paymentId: "pay_synthetic_1",
          before: { refundedAmountCents: 0, status: "PAID" },
          after: { refundedAmountCents: 0, status: "PAID" },
          refunds: [{ id: "re_synthetic_1", amountCents: 100, status: "refunded" as "succeeded" }],
          decidedAt: DECIDED_AT,
          stripeEventId: null,
        }),
      /not a Stripe refund status/,
    );
  });

  it("contracts are enforced at compile time (checked by tsc)", () => {
    const plain = {
      checkoutSessionId: SESSION,
      sessionStatus: "complete",
      paymentStatus: "paid",
      charge: null,
      stripeEventId: null,
    } as const;
    // @ts-expect-error — a plain object is not verified evidence; use verifiedCheckoutEvidence.
    const unverified: VerifiedCheckoutEvidence = plain;

    // @ts-expect-error — PAYMENT_CONFIRMED has its own contract, not a bare status change.
    const wrongDetails: AppointmentEventDetailsByType["PAYMENT_CONFIRMED"] = eventDetails.statusChanged(
      "PENDING_PAYMENT",
      "CONFIRMED",
    );

    // @ts-expect-error — CUSTOMER_UPDATED has no contract yet, so nothing can be written for it.
    const noContract: AppointmentEventDetailsByType["CUSTOMER_UPDATED"] = eventDetails.statusChanged(
      "CONFIRMED",
      "CONFIRMED",
    );

    assert.ok(unverified && wrongDetails && noContract);
  });
});

describe("place-independent phase (1E.3 fast path)", () => {
  const scenarios: [string, PaymentConfirmationInput][] = [
    ["first receipt", input()],
    ["first receipt after EXPIRED", input({ payment: { status: "EXPIRED" } })],
    ["first receipt after FAILED", input({ payment: { status: "FAILED" } })],
    ["first receipt, amount mismatch", input({ evidence: evidence({ amountCents: 1 }) })],
    ["first receipt, cancelled appointment", input({ appointment: { status: "CANCELLED" } })],
    ["already allocated", input({ payment: allocatedPayment, appointment: CONFIRMED })],
    ["already recorded unallocated", input({ payment: unallocatedPayment })],
    ["unpaid open", input({ evidence: evidence({ paymentStatus: "unpaid", sessionStatus: "open" }) })],
    ["unpaid expired", input({ evidence: evidence({ paymentStatus: "unpaid", sessionStatus: "expired" }) })],
    ["intent mismatch", input({ payment: { ...allocatedPayment, providerPaymentIntentId: "pi_other" }, appointment: CONFIRMED })],
    ["session mismatch", input({ payment: { providerCheckoutSessionId: "cs_test_other" } })],
    ["corrupt record", input({ payment: { amountCents: 1 } })],
  ];

  for (const [label, scenario] of scenarios) {
    it(`${label}: same decision with or without the separate first phase`, () => {
      const early = decidePaymentBeforePlace(scenario);
      const full = decidePaymentConfirmation(scenario);
      if (early.kind === "place-required") {
        assert.ok(full.kind === "confirm" || full.kind === "reconcile", JSON.stringify(full));
        assert.ok(["PENDING", "EXPIRED", "FAILED"].includes(scenario.payment.status));
      } else {
        assert.deepEqual(early, full);
      }
    });
  }

  it("needs neither place facts nor a decision instant", () => {
    const { evidence: e, payment, appointment } = input({ payment: allocatedPayment, appointment: CONFIRMED });
    assert.deepEqual(decidePaymentBeforePlace({ evidence: e, payment, appointment }), { kind: "already-allocated" });
  });
});

describe("evidence reference and runtime verification", () => {
  it("carries the server-set metadata reference, frozen", () => {
    const e = evidence({ metadataPaymentId: "pay_synthetic_1", metadataAppointmentId: "appt_synthetic_1" });
    assert.deepEqual(e.reference, { paymentId: "pay_synthetic_1", appointmentId: "appt_synthetic_1" });
    assert.ok(Object.isFrozen(e.reference));
    assert.equal(evidence().reference, null);
  });

  it("requires both metadata ids or neither", () => {
    for (const bad of [
      { metadataPaymentId: "pay_synthetic_1" },
      { metadataAppointmentId: "appt_synthetic_1" },
      { metadataPaymentId: " ", metadataAppointmentId: "appt_synthetic_1" },
      { metadataPaymentId: "pay synthetic", metadataAppointmentId: "appt_synthetic_1" },
    ]) {
      assert.throws(() => evidence(bad), /metadata must carry both/);
    }
  });

  it("only evidence issued by verifiedCheckoutEvidence passes the runtime check", () => {
    const issued = evidence();
    assert.equal(isVerifiedCheckoutEvidence(issued), true);
    assert.equal(isVerifiedCheckoutEvidence({ ...issued }), false);
    assert.equal(isVerifiedCheckoutEvidence(JSON.parse(JSON.stringify(issued))), false);
    assert.equal(isVerifiedCheckoutEvidence(null), false);
    assert.equal(isVerifiedCheckoutEvidence("cs_test_synthetic_1"), false);
  });

  it("PAYMENT_CONFIRMED records the status the Payment had before the charge", () => {
    const scenario = input({ payment: { status: "EXPIRED" } });
    const event = paymentDecisionEvent(decidePaymentConfirmation(scenario), scenario);
    assert.equal(event?.type, "PAYMENT_CONFIRMED");
    assert.equal(event?.details.previousPaymentStatus, "EXPIRED");
  });
});
