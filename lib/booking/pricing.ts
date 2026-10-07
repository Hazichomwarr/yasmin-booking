/**
 * Yasmin V1 booking economics — the single source of truth for the amounts
 * snapshotted onto every new Appointment.
 *
 * Stripe (YASMIN-1E) will charge `depositAmountCents` from the appointment's
 * snapshot; it never decides the price.
 */

export const YASMIN_V1_TOTAL_PRICE_CENTS = 20_000; // $200
export const YASMIN_V1_DEPOSIT_CENTS = 4_000; // $40, collected online

export type BookingPriceSnapshot = {
  totalPriceCents: number;
  depositAmountCents: number;
  /** Paid at the salon: total − deposit. */
  balanceDueCents: number;
};

export function v1BookingPriceSnapshot(): BookingPriceSnapshot {
  return {
    totalPriceCents: YASMIN_V1_TOTAL_PRICE_CENTS,
    depositAmountCents: YASMIN_V1_DEPOSIT_CENTS,
    balanceDueCents: YASMIN_V1_TOTAL_PRICE_CENTS - YASMIN_V1_DEPOSIT_CENTS,
  };
}
