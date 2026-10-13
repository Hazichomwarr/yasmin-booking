import type {
  AppointmentEventType,
  AppointmentStatus,
  PaymentReconciliationReason,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { PlacePolicyClosedReason } from "./booking-policy";
import { BookingError } from "./errors";
import type { BookingPriceSnapshot } from "./pricing";

/**
 * AppointmentEvent — the append-only audit trail of an appointment.
 *
 * Appointment holds the CURRENT state; events record what happened, in order.
 * Every event is written in the same transaction as the change it describes,
 * timestamped by the database clock (see `eventTimestamp`).
 * This module only appends and reads; there is no update or delete.
 *
 * `details` (JSON) carries the facts needed to understand the change later,
 * as plain salon-local values ("YYYY-MM-DD", "HH:mm", IANA zone) rather than
 * ambiguous instants. Each payload has a schemaVersion so future readers can
 * evolve safely.
 */

const SCHEMA_VERSION = 1;

/** Where/when an appointment is scheduled, in the location's local terms. */
export type ScheduleFacts = {
  locationId: string;
  locationName: string;
  /** The location's IANA timezone at the time the event was written. */
  timeZone: string;
  bookingSlotId: string;
  appointmentDate: string; // YYYY-MM-DD, salon-local
  slotTime: string; // HH:mm, salon-local
};

export type CreatedEventDetails = {
  schemaVersion: 1;
  status: AppointmentStatus;
  holdExpiresAt: string | null; // ISO instant
  schedule: ScheduleFacts;
  hairstyleId: string | null;
  hairstyleNameSnapshot: string | null;
  pricing: BookingPriceSnapshot;
};

export type StatusChangedEventDetails = {
  schemaVersion: 1;
  fromStatus: AppointmentStatus;
  toStatus: AppointmentStatus;
};

export type RescheduledEventDetails = {
  schemaVersion: 1;
  before: ScheduleFacts;
  after: ScheduleFacts;
};

export type FieldChangedEventDetails = {
  schemaVersion: 1;
  field: "customerNotes";
  before: string | null;
  after: string | null;
};

/**
 * Payment facts as verified with Stripe. Instants are ISO strings; amounts
 * are integer minor units with a lowercase ISO 4217 currency.
 */
export type PaymentEventFacts = {
  paymentId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  paidAt: string; // ISO instant (Stripe charge time)
};

/** Hold facts at the decision instant. */
export type HoldFacts = {
  expiresAt: string | null; // ISO instant
  activeAtDecision: boolean;
  /** Informational only — never used to grant a place. Null when there was no hold expiry. */
  paidBeforeExpiry: boolean | null;
};

/** Capacity of the appointment's (slot, date), read under the slot lock. */
export type CapacityFacts = {
  configured: number;
  consumedByOthers: number;
};

export type HoldExpiryChangeReason = "checkout-started" | "checkout-creation-failed";

export type HoldExpiryChangedEventDetails = {
  schemaVersion: 1;
  reason: HoldExpiryChangeReason;
  before: string | null; // ISO instant
  after: string | null; // ISO instant
  paymentId: string;
  checkoutExpiresAt: string | null; // ISO instant
  decidedAt: string; // ISO instant
};

export type PaymentConfirmationMethod = "within-active-hold" | "reacquired-after-hold-expiry";

export type PaymentConfirmedEventDetails = {
  schemaVersion: 1;
  fromStatus: "PENDING_PAYMENT";
  toStatus: "CONFIRMED";
  payment: PaymentEventFacts;
  /** The Payment status before this charge was recorded (PENDING, or EXPIRED/FAILED overridden by Stripe). */
  previousPaymentStatus: PaymentStatus;
  allocatedAt: string; // ISO instant
  confirmation: PaymentConfirmationMethod;
  hold: HoldFacts;
  capacity: CapacityFacts;
  decidedAt: string; // ISO instant
  stripeEventId: string | null;
};

export type PaymentReceivedUnconfirmedEventDetails = {
  schemaVersion: 1;
  /** What Stripe verified (may differ from `recorded` when reason is AMOUNT_MISMATCH). */
  payment: PaymentEventFacts;
  /** What the Payment record expected. */
  recorded: { amountCents: number; currency: string };
  previousPaymentStatus: PaymentStatus;
  reason: PaymentReconciliationReason;
  appointmentStatus: AppointmentStatus;
  hold: HoldFacts;
  capacity: CapacityFacts;
  /** Booking policy at the decision instant, when it was consulted and closed. */
  bookingPolicyClosedReason: PlacePolicyClosedReason | null;
  decidedAt: string; // ISO instant
  stripeEventId: string | null;
};

export type StripeRefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";

export type PaymentRefundUpdatedEventDetails = {
  schemaVersion: 1;
  paymentId: string;
  before: { refundedAmountCents: number; status: PaymentStatus };
  after: { refundedAmountCents: number; status: PaymentStatus };
  /** The verified Stripe refunds the new total was computed from. */
  refunds: { id: string; amountCents: number; status: StripeRefundStatus }[];
  decidedAt: string; // ISO instant
  stripeEventId: string | null;
};

/** Requires every AppointmentEventType to have a details contract. */
type DetailsForEveryEventType<T extends Record<AppointmentEventType, unknown>> = T;

/** The details contract of each event type. */
export type AppointmentEventDetailsByType = DetailsForEveryEventType<{
  CREATED: CreatedEventDetails;
  PAYMENT_CONFIRMED: PaymentConfirmedEventDetails;
  RESCHEDULED: RescheduledEventDetails;
  CANCELLED: StatusChangedEventDetails;
  COMPLETED: StatusChangedEventDetails;
  NO_SHOW: StatusChangedEventDetails;
  /** No writer and no contract yet; defined when one is added. */
  CUSTOMER_UPDATED: never;
  NOTE_UPDATED: FieldChangedEventDetails;
  HOLD_EXPIRY_CHANGED: HoldExpiryChangedEventDetails;
  PAYMENT_RECEIVED_UNCONFIRMED: PaymentReceivedUnconfirmedEventDetails;
  PAYMENT_REFUND_UPDATED: PaymentRefundUpdatedEventDetails;
}>;

export type AppointmentEventDetails = AppointmentEventDetailsByType[AppointmentEventType];

const STRIPE_REFUND_STATUSES: ReadonlySet<string> = new Set<StripeRefundStatus>([
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
]);

/** Payment payloads are history: malformed facts are refused, not stored. */
function instant(value: Date, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`Event details: ${label} must be a valid Date.`);
  }
  return value.toISOString();
}

function optionalInstant(value: Date | null, label: string): string | null {
  return value === null ? null : instant(value, label);
}

function cents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Event details: ${label} must be a non-negative integer number of cents.`);
  }
  return value;
}

function currencyCode(value: string): string {
  if (!/^[a-z]{3}$/.test(value)) {
    throw new Error("Event details: currency must be a lowercase three-letter ISO code.");
  }
  return value;
}

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`Event details: ${label} must be a non-empty identifier.`);
  }
  return value;
}

function optionalIdentifier(value: string | null, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

export type PaymentFactsInput = {
  paymentId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
};

function paymentFacts(p: PaymentFactsInput): PaymentEventFacts {
  return {
    paymentId: identifier(p.paymentId, "paymentId"),
    checkoutSessionId: identifier(p.checkoutSessionId, "checkoutSessionId"),
    paymentIntentId: identifier(p.paymentIntentId, "paymentIntentId"),
    amountCents: cents(p.amountCents, "amountCents"),
    currency: currencyCode(p.currency),
    paidAt: instant(p.paidAt, "paidAt"),
  };
}

export type HoldFactsInput = { expiresAt: Date | null; activeAtDecision: boolean; paidAt: Date };

function holdFacts(h: HoldFactsInput): HoldFacts {
  return {
    expiresAt: optionalInstant(h.expiresAt, "hold.expiresAt"),
    activeAtDecision: h.activeAtDecision,
    paidBeforeExpiry: h.expiresAt === null ? null : h.paidAt.getTime() < h.expiresAt.getTime(),
  };
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Event details: ${label} must be a non-negative integer.`);
  }
  return value;
}

function capacityFacts(c: CapacityFacts): CapacityFacts {
  return {
    configured: count(c.configured, "capacity.configured"),
    consumedByOthers: count(c.consumedByOthers, "capacity.consumedByOthers"),
  };
}

export const eventDetails = {
  created: (d: Omit<CreatedEventDetails, "schemaVersion">): CreatedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    ...d,
  }),
  statusChanged: (fromStatus: AppointmentStatus, toStatus: AppointmentStatus): StatusChangedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    fromStatus,
    toStatus,
  }),
  rescheduled: (before: ScheduleFacts, after: ScheduleFacts): RescheduledEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    before,
    after,
  }),
  fieldChanged: (
    field: FieldChangedEventDetails["field"],
    before: string | null,
    after: string | null,
  ): FieldChangedEventDetails => ({ schemaVersion: SCHEMA_VERSION, field, before, after }),

  holdExpiryChanged: (d: {
    reason: HoldExpiryChangeReason;
    before: Date | null;
    after: Date | null;
    paymentId: string;
    checkoutExpiresAt: Date | null;
    decidedAt: Date;
  }): HoldExpiryChangedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    reason: d.reason,
    before: optionalInstant(d.before, "before"),
    after: optionalInstant(d.after, "after"),
    paymentId: identifier(d.paymentId, "paymentId"),
    checkoutExpiresAt: optionalInstant(d.checkoutExpiresAt, "checkoutExpiresAt"),
    decidedAt: instant(d.decidedAt, "decidedAt"),
  }),

  paymentConfirmed: (d: {
    payment: PaymentFactsInput;
    previousPaymentStatus: PaymentStatus;
    allocatedAt: Date;
    confirmation: PaymentConfirmationMethod;
    hold: Omit<HoldFactsInput, "paidAt">;
    capacity: CapacityFacts;
    decidedAt: Date;
    stripeEventId: string | null;
  }): PaymentConfirmedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    fromStatus: "PENDING_PAYMENT",
    toStatus: "CONFIRMED",
    payment: paymentFacts(d.payment),
    previousPaymentStatus: d.previousPaymentStatus,
    allocatedAt: instant(d.allocatedAt, "allocatedAt"),
    confirmation: d.confirmation,
    hold: holdFacts({ ...d.hold, paidAt: d.payment.paidAt }),
    capacity: capacityFacts(d.capacity),
    decidedAt: instant(d.decidedAt, "decidedAt"),
    stripeEventId: optionalIdentifier(d.stripeEventId, "stripeEventId"),
  }),

  paymentReceivedUnconfirmed: (d: {
    payment: PaymentFactsInput;
    recorded: { amountCents: number; currency: string };
    previousPaymentStatus: PaymentStatus;
    reason: PaymentReconciliationReason;
    appointmentStatus: AppointmentStatus;
    hold: Omit<HoldFactsInput, "paidAt">;
    capacity: CapacityFacts;
    bookingPolicyClosedReason: PlacePolicyClosedReason | null;
    decidedAt: Date;
    stripeEventId: string | null;
  }): PaymentReceivedUnconfirmedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    payment: paymentFacts(d.payment),
    recorded: {
      amountCents: cents(d.recorded.amountCents, "recorded.amountCents"),
      currency: currencyCode(d.recorded.currency),
    },
    previousPaymentStatus: d.previousPaymentStatus,
    reason: d.reason,
    appointmentStatus: d.appointmentStatus,
    hold: holdFacts({ ...d.hold, paidAt: d.payment.paidAt }),
    capacity: capacityFacts(d.capacity),
    bookingPolicyClosedReason: d.bookingPolicyClosedReason,
    decidedAt: instant(d.decidedAt, "decidedAt"),
    stripeEventId: optionalIdentifier(d.stripeEventId, "stripeEventId"),
  }),

  paymentRefundUpdated: (d: {
    paymentId: string;
    before: { refundedAmountCents: number; status: PaymentStatus };
    after: { refundedAmountCents: number; status: PaymentStatus };
    refunds: { id: string; amountCents: number; status: StripeRefundStatus }[];
    decidedAt: Date;
    stripeEventId: string | null;
  }): PaymentRefundUpdatedEventDetails => ({
    schemaVersion: SCHEMA_VERSION,
    paymentId: identifier(d.paymentId, "paymentId"),
    before: {
      refundedAmountCents: cents(d.before.refundedAmountCents, "before.refundedAmountCents"),
      status: d.before.status,
    },
    after: {
      refundedAmountCents: cents(d.after.refundedAmountCents, "after.refundedAmountCents"),
      status: d.after.status,
    },
    refunds: d.refunds.map((refund, i) => {
      if (!STRIPE_REFUND_STATUSES.has(refund.status)) {
        throw new Error(`Event details: refunds[${i}].status is not a Stripe refund status.`);
      }
      return {
        id: identifier(refund.id, `refunds[${i}].id`),
        amountCents: cents(refund.amountCents, `refunds[${i}].amountCents`),
        status: refund.status,
      };
    }),
    decidedAt: instant(d.decidedAt, "decidedAt"),
    stripeEventId: optionalIdentifier(d.stripeEventId, "stripeEventId"),
  }),
};

/**
 * Appends an event inside the caller's transaction.
 *
 * Call only while holding the appointment's row lock (or, for CREATED, in the
 * transaction that inserts the appointment). See `eventTimestamp` for how the
 * timestamp is chosen.
 */
export async function appendAppointmentEvent<T extends AppointmentEventType>(
  tx: Prisma.TransactionClient,
  appointmentId: string,
  type: T,
  details: AppointmentEventDetailsByType[T],
): Promise<void> {
  await tx.appointmentEvent.create({
    data: {
      appointmentId,
      type,
      details: details as unknown as Prisma.InputJsonObject,
      createdAt: await eventTimestamp(tx, appointmentId),
    },
  });
}

/** How long we will wait for the database clock to pass the previous event. */
const MAX_CLOCK_WAIT_MS = 20;

/**
 * The event's timestamp: the DATABASE clock (`clock_timestamp()`), read after
 * the appointment row lock is held.
 *
 * - One clock for every application instance, so app-server drift cannot
 *   reorder or future-date history. (Not `now()`/CURRENT_TIMESTAMP: that is
 *   the transaction START time, which would backdate a transaction that
 *   waited for the lock.)
 * - The row lock serializes all event writers for an appointment, so each
 *   reads the clock after the previous writer committed.
 * - `createdAt` has millisecond precision. If the clock has not yet moved past
 *   the previous event's millisecond, we wait for it to (≈1 ms) rather than
 *   inventing a later time. Timestamps are never adjusted.
 * - If the database clock is clearly BEHIND the latest event (e.g. the clock
 *   was stepped back), we refuse to write rather than record out-of-order
 *   history. This is an unexpected infrastructure failure, not a domain error.
 */
async function eventTimestamp(
  tx: Prisma.TransactionClient,
  appointmentId: string,
): Promise<Date> {
  const previous = await tx.appointmentEvent.findFirst({
    where: { appointmentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { createdAt: true },
  });

  for (let waitedMs = 0; ; waitedMs += 1) {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!previous || now.getTime() > previous.createdAt.getTime()) return now;

    if (waitedMs >= MAX_CLOCK_WAIT_MS) {
      throw new Error(
        `Database clock (${now.toISOString()}) is not after the latest event of appointment ` +
          `${appointmentId} (${previous.createdAt.toISOString()}); refusing to write out-of-order history.`,
      );
    }
    await tx.$executeRaw`SELECT pg_sleep(0.001)`;
  }
}

export type AppointmentEventRecord = {
  id: string;
  type: AppointmentEventType;
  details: AppointmentEventDetails | null;
  createdAt: Date;
};

/** The appointment's history, oldest first (createdAt, then id). */
export async function listAppointmentEvents(
  appointmentId: string,
): Promise<AppointmentEventRecord[]> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      events: {
        select: { id: true, type: true, details: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!appointment) {
    throw new BookingError("APPOINTMENT_NOT_FOUND", `Appointment ${appointmentId} does not exist.`);
  }

  return appointment.events.map((event) => ({
    ...event,
    details: event.details as AppointmentEventDetails | null,
  }));
}
