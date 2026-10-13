/**
 * Booking domain — V1 booking policy and the authoritative capacity engine.
 *
 * Where the rules live:
 * - Salon-local DATE/TIME handling ...... salon-calendar.ts
 * - Weekday / location / slot policy .... booking-policy.ts
 * - What consumes capacity .............. capacity.ts (`CAPACITY_CONTRIBUTION`)
 * - Availability (informational) ........ availability.ts
 * - Hold acquisition (authoritative) .... holds.ts (`acquireBookingHold`)
 * - V1 price/deposit/balance ............ pricing.ts
 * - Error codes ......................... errors.ts
 *
 * Current configuration vs history: SalonLocation and BookingSlot are current
 * configuration. An Appointment records booking-time facts in its snapshot
 * fields (location name, slot time, hairstyle name, money), which are written
 * once at hold creation and never recomputed from configuration.
 *
 * READ vs ACQUIRE: availability reads may be stale immediately; only
 * `acquireBookingHold` reserves a place. Stripe checkout must start from an
 * acquired hold, never from an availability read.
 *
 * - Lifecycle transitions (one policy) ... lifecycle-policy.ts
 * - Cancel / complete / no-show / notes .. lifecycle.ts
 * - Rescheduling ......................... reschedule.ts
 * - Audit trail (append-only) ............ appointment-events.ts
 * - Payment confirmation decision ........ payment-policy.ts (pure)
 * - Applying verified payment evidence ... payment-fulfillment.ts
 *
 * Lock order for anything that changes an existing appointment: the
 * appointment row first, then (payment fulfillment) its Payment row, then at
 * most one BookingSlot row. Hold acquisition locks only the BookingSlot. No
 * operation holds two slot locks.
 *
 * There is intentionally NO export here that moves PENDING_PAYMENT → CONFIRMED.
 * payment-policy.ts decides it from verified Stripe evidence and
 * payment-fulfillment.ts (`applyVerifiedCheckoutSession`) executes it under
 * the appointment, payment and slot locks. Both are imported by path by the
 * payment adapters only, never re-exported here.
 */

export { BookingError, isBookingError, type BookingErrorCode } from "./errors";

export {
  assertValidSalonTimeZone,
  parseSalonDate,
  salonToday,
  salonWeekday,
  type SalonDate,
  type Weekday,
} from "./salon-calendar";

export {
  ONLINE_BOOKING_WEEKDAYS,
  type BookingClosedReason,
} from "./booking-policy";

export {
  CAPACITY_CONTRIBUTION,
  capacityConsumingAppointments,
  consumesCapacity,
  countConsumedCapacity,
  lockBookingSlotCapacity,
  remainingCapacity,
} from "./capacity";

export {
  getSlotAvailability,
  listBookableSlotsForDate,
  type DateAvailability,
  type SlotAvailability,
} from "./availability";

export {
  BOOKING_HOLD_MINUTES,
  acquireBookingHold,
  holdExpiryFor,
  type AcquireBookingHoldInput,
  type BookingHold,
} from "./holds";

export {
  YASMIN_V1_DEPOSIT_CENTS,
  YASMIN_V1_TOTAL_PRICE_CENTS,
  v1BookingPriceSnapshot,
  type BookingPriceSnapshot,
} from "./pricing";

export {
  getAppointment,
  type AppointmentChange,
  type AppointmentView,
} from "./appointments";

export {
  LIFECYCLE_TRANSITIONS,
  RESCHEDULABLE_STATUSES,
  TERMINAL_STATUSES,
  type LifecycleCommand,
} from "./lifecycle-policy";

export {
  cancelAppointment,
  completeAppointment,
  markAppointmentNoShow,
  updateAppointmentCustomerNotes,
} from "./lifecycle";

export { rescheduleAppointment, type RescheduleAppointmentInput } from "./reschedule";

export {
  listAppointmentEvents,
  type AppointmentEventDetails,
  type AppointmentEventRecord,
  type CreatedEventDetails,
  type FieldChangedEventDetails,
  type RescheduledEventDetails,
  type ScheduleFacts,
  type StatusChangedEventDetails,
} from "./appointment-events";
