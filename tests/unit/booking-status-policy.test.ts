import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PaymentStatus } from "@prisma/client";

import { derivePublicBookingState, isSafeToLeaveBehind, type BookingStatusFacts } from "@/lib/booking/booking-status";
import { MIN_ORIGINAL_HOLD_MS } from "@/lib/booking/checkout";

const NOW = new Date("2027-03-01T15:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

type PaymentFacts = NonNullable<BookingStatusFacts["payment"]>;
const payment = (status: PaymentStatus, overrides: Partial<PaymentFacts> = {}): PaymentFacts => ({
  status,
  hasCheckoutSession: true,
  received: status === "PAID" || status === "REFUNDED",
  allocated: false,
  ...overrides,
});
const facts = (overrides: Partial<BookingStatusFacts>): BookingStatusFacts => ({
  appointmentStatus: "PENDING_PAYMENT",
  holdExpiresAt: at(10 * 60_000),
  payment: null,
  unresolvedPaymentException: false,
  ...overrides,
});
const derive = (overrides: Partial<BookingStatusFacts>) => derivePublicBookingState(facts(overrides), NOW);

describe("public booking state derivation", () => {
  it("confirmed and closed bookings", () => {
    assert.deepEqual(derive({ appointmentStatus: "CONFIRMED", payment: payment("PAID", { allocated: true }) }), { state: "confirmed", canStartCheckout: false });
    // A later (partial or full) refund never un-confirms the booking.
    assert.equal(derive({ appointmentStatus: "CONFIRMED", payment: payment("REFUNDED", { allocated: true }) }).state, "confirmed");
    assert.equal(derive({ appointmentStatus: "COMPLETED" }).state, "closed");
    assert.equal(derive({ appointmentStatus: "NO_SHOW" }).state, "closed");
  });

  it("paid-but-unallocated money needs attention, even when cancelled or expired", () => {
    const unallocated = payment("PAID", { allocated: false });
    assert.equal(derive({ payment: unallocated }).state, "needs-attention");
    assert.equal(derive({ appointmentStatus: "CANCELLED", payment: unallocated }).state, "needs-attention");
    assert.equal(derive({ holdExpiresAt: at(-60_000), payment: unallocated }).state, "needs-attention");
  });

  it("cancelled bookings, including fully refunded or allocated-then-cancelled ones", () => {
    assert.equal(derive({ appointmentStatus: "CANCELLED" }).state, "cancelled");
    assert.equal(derive({ appointmentStatus: "CANCELLED", payment: payment("REFUNDED") }).state, "cancelled");
    assert.equal(derive({ appointmentStatus: "CANCELLED", payment: payment("PAID", { allocated: true }) }).state, "cancelled");
    assert.equal(derive({ appointmentStatus: "CANCELLED", payment: payment("EXPIRED", { received: false }) }).state, "cancelled");
  });

  it("an open Session is payment in progress — never confirmation — even past the hold", () => {
    assert.deepEqual(derive({ payment: payment("PENDING") }), { state: "payment-in-progress", canStartCheckout: false });
    assert.equal(derive({ holdExpiresAt: at(-1), payment: payment("PENDING") }).state, "payment-in-progress");
  });

  it("a Payment without a recorded Session needs attention, whatever its age", () => {
    const unrecorded = payment("PENDING", { hasCheckoutSession: false });
    assert.equal(derive({ payment: unrecorded }).state, "needs-attention");
    assert.equal(derivePublicBookingState(facts({ payment: unrecorded }), at(24 * 3600_000)).state, "needs-attention");
  });

  it("an unresolved payment exception makes an unfinished booking need attention", () => {
    assert.equal(derive({ unresolvedPaymentException: true }).state, "needs-attention");
    assert.equal(derive({ appointmentStatus: "CANCELLED", unresolvedPaymentException: true }).state, "needs-attention");
    assert.equal(derive({ appointmentStatus: "CONFIRMED", unresolvedPaymentException: true }).state, "confirmed");
  });

  it("an attempt that ended without money is expired", () => {
    for (const status of ["EXPIRED", "FAILED"] as const) {
      assert.equal(derive({ payment: payment(status, { received: false }) }).state, "expired", status);
    }
    assert.equal(derive({ payment: payment("REFUNDED") }).state, "expired");
  });

  it("an allocated charge on a pending booking is inconsistent and needs attention", () => {
    assert.equal(derive({ payment: payment("PAID", { allocated: true }) }).state, "needs-attention");
  });

  it("an unpaid hold awaits payment until it expires", () => {
    assert.deepEqual(derive({ holdExpiresAt: at(MIN_ORIGINAL_HOLD_MS) }), { state: "awaiting-payment", canStartCheckout: true });
    assert.deepEqual(derive({ holdExpiresAt: at(MIN_ORIGINAL_HOLD_MS - 1) }), { state: "awaiting-payment", canStartCheckout: false });
    assert.deepEqual(derive({ holdExpiresAt: at(1) }), { state: "awaiting-payment", canStartCheckout: false });
    assert.deepEqual(derive({ holdExpiresAt: NOW }), { state: "expired", canStartCheckout: false });
    assert.deepEqual(derive({ holdExpiresAt: null }), { state: "expired", canStartCheckout: false });
  });

  it("only an awaiting-payment booking can ever start Checkout", () => {
    const all: Partial<BookingStatusFacts>[] = [
      { appointmentStatus: "CONFIRMED" },
      { appointmentStatus: "CANCELLED" },
      { appointmentStatus: "COMPLETED" },
      { payment: payment("PENDING") },
      { payment: payment("PAID") },
      { payment: payment("EXPIRED", { received: false }) },
      { holdExpiresAt: at(-1) },
    ];
    for (const overrides of all) assert.equal(derive(overrides).canStartCheckout, false, JSON.stringify(overrides));
  });
});

describe("replacement safety (leaving a booking behind)", () => {
  const safe = (overrides: Partial<BookingStatusFacts>) => isSafeToLeaveBehind(facts(overrides), NOW);
  const allocated = payment("PAID", { allocated: true });

  it("is never safe while any time remains on an unpaid hold", () => {
    for (const remaining of [1, 30_000, MIN_ORIGINAL_HOLD_MS - 1, MIN_ORIGINAL_HOLD_MS, 10 * 60_000]) {
      assert.equal(safe({ holdExpiresAt: at(remaining) }), false, `${remaining} ms left`);
    }
  });

  it("is never safe with a pending Payment, in any appointment state or at any time", () => {
    for (const hasCheckoutSession of [true, false]) {
      for (const appointmentStatus of ["PENDING_PAYMENT", "CANCELLED"] as const) {
        for (const holdExpiresAt of [at(10 * 60_000), at(-3600_000), null]) {
          assert.equal(safe({ appointmentStatus, holdExpiresAt, payment: payment("PENDING", { hasCheckoutSession }) }), false);
        }
      }
    }
  });

  it("is never safe with unallocated money or an unresolved payment exception", () => {
    for (const appointmentStatus of ["PENDING_PAYMENT", "CANCELLED"] as const) {
      assert.equal(safe({ appointmentStatus, holdExpiresAt: at(-1), payment: payment("PAID") }), false);
      assert.equal(safe({ appointmentStatus, holdExpiresAt: at(-1), unresolvedPaymentException: true }), false);
    }
    assert.equal(safe({ appointmentStatus: "CONFIRMED", payment: allocated, unresolvedPaymentException: true }), false);
    assert.equal(safe({ holdExpiresAt: at(-1), payment: allocated }), false, "inconsistent: allocated but pending");
  });

  it("is safe once the booking is terminal with its payment resolved", () => {
    for (const appointmentStatus of ["CONFIRMED", "COMPLETED", "NO_SHOW"] as const) assert.equal(safe({ appointmentStatus, payment: allocated }), true, appointmentStatus);
    assert.equal(safe({ appointmentStatus: "CANCELLED" }), true);
    assert.equal(safe({ appointmentStatus: "CANCELLED", payment: allocated }), true);
    assert.equal(safe({ appointmentStatus: "CANCELLED", payment: payment("REFUNDED") }), true);
    assert.equal(safe({ appointmentStatus: "CANCELLED", payment: payment("EXPIRED", { received: false }) }), true);
  });

  it("is safe for an unpaid booking only once its hold expired or its attempt ended without money", () => {
    assert.equal(safe({ holdExpiresAt: NOW }), true);
    assert.equal(safe({ holdExpiresAt: at(-1) }), true);
    assert.equal(safe({ holdExpiresAt: null }), true);
    for (const status of ["EXPIRED", "FAILED"] as const) {
      assert.equal(safe({ holdExpiresAt: at(10 * 60_000), payment: payment(status, { received: false }) }), true, status);
    }
    assert.equal(safe({ holdExpiresAt: at(-1), payment: payment("REFUNDED") }), true);
  });
});
