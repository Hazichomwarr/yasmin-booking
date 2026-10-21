export type BookingStyleSelection = {
  hairstyleId: string;
  hairstyleVariantId: string;
};

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
