export type BookingStyleSelection = {
  hairstyleId: string;
  hairstyleVariantId: string;
};

type DeepLinkStyle = {
  id: string;
  slug: string;
  requiresVariant: boolean;
  variants: Array<{ id: string }>;
};

/**
 * Resolve URL hints only against the server-produced bookable catalog. A
 * mismatched variant invalidates the whole hint so it cannot redirect a style
 * selection across catalog ownership boundaries.
 */
export function resolveBookingStylePreselection(
  styles: DeepLinkStyle[],
  styleSlug: string | undefined,
  variantId: string | undefined,
): BookingStyleSelection {
  const empty = { hairstyleId: "", hairstyleVariantId: "" };
  if (!styleSlug) return empty;

  const style = styles.find((item) => item.slug === styleSlug.trim().toLowerCase());
  if (!style) return empty;
  if (!variantId) return { hairstyleId: style.id, hairstyleVariantId: "" };

  const variant = style.variants.find((item) => item.id === variantId);
  if (!style.requiresVariant || !variant) return empty;
  return { hairstyleId: style.id, hairstyleVariantId: variant.id };
}

export function selectBookingHairstyle(
  current: BookingStyleSelection,
  hairstyleId: string,
): BookingStyleSelection {
  if (current.hairstyleId === hairstyleId) return current;

  return {
    hairstyleId,
    hairstyleVariantId: "",
  };
}

/**
 * Browsing a different category makes the previously selected service
 * ineligible for the visible category. Keep a selection only when it belongs
 * to the category the customer is continuing to browse.
 */
export function selectBookingCategory(
  current: BookingStyleSelection,
  selectedHairstyleCategoryId: string | null,
  categoryId: string,
): BookingStyleSelection {
  if (!current.hairstyleId || selectedHairstyleCategoryId === categoryId) return current;

  return {
    hairstyleId: "",
    hairstyleVariantId: "",
  };
}

export function requiresVariantSelection(requiresVariant: boolean, hairstyleVariantId: string): boolean {
  return requiresVariant && !hairstyleVariantId;
}

export function selectGalleryImage<T>(gallery: T[], coverImage: T | null, index: number): T | null {
  return gallery[index] ?? coverImage;
}

export function selectedBookingCover<T>(
  serviceCover: T | null,
  variantCover: T | null | undefined,
): T | null {
  return variantCover ?? serviceCover;
}
