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
 * For YASMIN-1D (admin booking / rescheduling): reuse
 * `lockBookingSlotCapacity` + `countConsumedCapacity` + `remainingCapacity`.
 * A reschedule must acquire capacity on the destination slot/date before
 * giving up the original place; lock multiple slots in id order.
 *
 * For YASMIN-1E (Stripe): see the hold-expiry race documented in the 1C
 * report — a payment can complete after its hold has logically expired.
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
