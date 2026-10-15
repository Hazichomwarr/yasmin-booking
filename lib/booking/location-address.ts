/**
 * The customer-facing street address of a SalonLocation, built only from its
 * configured address columns (never from its name), e.g.
 * "524 William St, East Orange, NJ" or "…, NJ 07017" when a postal code is set.
 * Null when no address is configured, so callers can fall back to the name.
 * Browser-safe: no server imports.
 */

export type SalonAddressFields = {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

export function formatSalonAddress(location: SalonAddressFields): string | null {
  const part = (value: string | null) => value?.trim() || null;
  const region = [part(location.state), part(location.postalCode)].filter(Boolean).join(" ");
  const address = [part(location.addressLine1), part(location.addressLine2), part(location.city), region || null].filter(Boolean).join(", ");
  return address || null;
}

/** Prisma `select` for exactly the fields `formatSalonAddress` needs. */
export const salonAddressSelect = { addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true } as const;
