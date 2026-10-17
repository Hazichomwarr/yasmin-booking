import type { Prisma } from "@prisma/client";

import { publiclyVisibleHairstyle } from "@/lib/catalog";

import { BookingError } from "./errors";

/** Every online service uses this fixed Stripe deposit, in USD cents. */
export const YASMIN_DEPOSIT_CENTS = 4_000;
export const YASMIN_BOOKING_CURRENCY = "usd" as const;
/** Compatibility only for historical internal hold callers without a selection. */
export const YASMIN_V1_TOTAL_PRICE_CENTS = 20_000;
export const YASMIN_V1_DEPOSIT_CENTS = YASMIN_DEPOSIT_CENTS;

export type BookingPriceSnapshot = {
  totalPriceCents: number;
  depositAmountCents: number;
  balanceDueCents: number;
  currency?: typeof YASMIN_BOOKING_CURRENCY;
};

export type CatalogBookingSnapshot = BookingPriceSnapshot & {
  currency: typeof YASMIN_BOOKING_CURRENCY;
  hairstyleId: string;
  hairstyleNameSnapshot: string;
  hairstyleVariantId: string | null;
  hairstyleVariantNameSnapshot: string | null;
};

/** @deprecated New public bookings resolve a catalog selection instead. */
export function v1BookingPriceSnapshot(): BookingPriceSnapshot {
  return {
    totalPriceCents: YASMIN_V1_TOTAL_PRICE_CENTS,
    depositAmountCents: YASMIN_DEPOSIT_CENTS,
    balanceDueCents: YASMIN_V1_TOTAL_PRICE_CENTS - YASMIN_DEPOSIT_CENTS,
  };
}

type CatalogReader = Pick<Prisma.TransactionClient, "hairstyle">;

/**
 * The only booking-price authority. It reads current active catalog data once,
 * then callers persist this returned snapshot on the Appointment in their
 * transaction. Later catalog edits cannot change an agreed pending checkout.
 */
export async function resolveCatalogBookingPrice(
  db: CatalogReader,
  selection: { hairstyleId: string; hairstyleVariantId?: string | null },
): Promise<CatalogBookingSnapshot> {
  const hairstyle = await db.hairstyle.findFirst({
    where: { id: selection.hairstyleId, ...publiclyVisibleHairstyle },
    select: {
      id: true,
      name: true,
      priceCents: true,
      requiresVariant: true,
      variants: {
        where: selection.hairstyleVariantId ? { id: selection.hairstyleVariantId } : undefined,
        select: { id: true, name: true, priceCents: true, isActive: true },
      },
    },
  });
  if (!hairstyle) throw new BookingError("HAIRSTYLE_NOT_AVAILABLE", "Hairstyle is not available for online booking.");

  if (hairstyle.requiresVariant) {
    if (!selection.hairstyleVariantId) throw new BookingError("HAIRSTYLE_VARIANT_REQUIRED", "Select a hairstyle variant.");
    const variant = hairstyle.variants[0];
    if (!variant || !variant.isActive || variant.priceCents === null) throw new BookingError("HAIRSTYLE_VARIANT_NOT_AVAILABLE", "Hairstyle variant is not available for online booking.");
    return priceSnapshot(hairstyle, variant);
  }
  if (selection.hairstyleVariantId) throw new BookingError("HAIRSTYLE_VARIANT_NOT_ALLOWED", "This hairstyle does not have selectable variants.");
  if (hairstyle.priceCents === null) throw new BookingError("HAIRSTYLE_NOT_AVAILABLE", "Hairstyle pricing is not available.");
  return priceSnapshot(hairstyle, null);
}

function priceSnapshot(
  hairstyle: { id: string; name: string; priceCents: number | null },
  variant: { id: string; name: string; priceCents: number | null } | null,
): CatalogBookingSnapshot {
  const totalPriceCents = variant?.priceCents ?? hairstyle.priceCents;
  if (totalPriceCents === null || totalPriceCents < YASMIN_DEPOSIT_CENTS) throw new BookingError("HAIRSTYLE_NOT_AVAILABLE", "Hairstyle pricing is not available.");
  return {
    hairstyleId: hairstyle.id,
    hairstyleNameSnapshot: hairstyle.name,
    hairstyleVariantId: variant?.id ?? null,
    hairstyleVariantNameSnapshot: variant?.name ?? null,
    totalPriceCents,
    depositAmountCents: YASMIN_DEPOSIT_CENTS,
    balanceDueCents: totalPriceCents - YASMIN_DEPOSIT_CENTS,
    currency: YASMIN_BOOKING_CURRENCY,
  };
}
