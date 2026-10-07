import { CatalogError } from "./errors";

/**
 * Pure input normalization/validation for catalog operations.
 * No database access here, so these rules are unit-testable on their own.
 */

/** Lowercase words separated by single hyphens, e.g. "knotless-braids". */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeName(value: unknown, label = "Name"): string {
  if (typeof value !== "string") {
    throw new CatalogError("INVALID_NAME", `${label} is required.`);
  }

  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0) {
    throw new CatalogError("INVALID_NAME", `${label} must not be blank.`);
  }

  return name;
}

/**
 * Slugs are trimmed and lowercased, then must match SLUG_PATTERN.
 * We do not silently rewrite other characters (spaces, punctuation) because a
 * slug becomes a public URL — the caller should see what will be stored.
 */
export function normalizeSlug(value: unknown): string {
  if (typeof value !== "string") {
    throw new CatalogError("INVALID_SLUG", "Slug is required.");
  }

  const slug = value.trim().toLowerCase();
  if (slug.length === 0) {
    throw new CatalogError("INVALID_SLUG", "Slug must not be blank.");
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new CatalogError(
      "INVALID_SLUG",
      "Slug may contain only lowercase letters, numbers, and single hyphens between words.",
    );
  }

  return slug;
}

/**
 * Optional free text (descriptions, alt text, captions).
 * - undefined → undefined ("leave unchanged" on updates)
 * - null or blank → null (cleared)
 * - otherwise trimmed text
 */
export function normalizeOptionalText(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/**
 * Validates that `orderedIds` is exactly a permutation of `existingIds`.
 *
 * Reorders always describe the COMPLETE intended order of one scope (all
 * categories, the hairstyles of one category, the media of one hairstyle).
 * Requiring the full list means a reorder can never silently move records the
 * caller did not mention, and a stale list (records added/removed meanwhile)
 * is rejected instead of half-applied.
 */
export function assertCompleteOrdering(
  orderedIds: unknown,
  existingIds: readonly string[],
  scopeLabel: string,
): asserts orderedIds is string[] {
  if (
    !Array.isArray(orderedIds) ||
    !orderedIds.every((id) => typeof id === "string")
  ) {
    throw new CatalogError("INVALID_REORDER", "Reorder expects a list of IDs.");
  }

  const supplied = new Set(orderedIds);
  if (supplied.size !== orderedIds.length) {
    throw new CatalogError("INVALID_REORDER", "Reorder list contains duplicate IDs.");
  }

  const existing = new Set(existingIds);
  const foreign = orderedIds.filter((id) => !existing.has(id));
  if (foreign.length > 0) {
    throw new CatalogError(
      "INVALID_REORDER",
      `Reorder list contains IDs that do not belong to ${scopeLabel}: ${foreign.join(", ")}.`,
    );
  }

  const missing = existingIds.filter((id) => !supplied.has(id));
  if (missing.length > 0) {
    throw new CatalogError(
      "INVALID_REORDER",
      `Reorder list must include every record in ${scopeLabel}; missing: ${missing.join(", ")}.`,
    );
  }
}

/** Optional delivery URL for media: absent/blank → null, otherwise http(s). */
export function normalizeDeliveryUrl(value: string | null | undefined): string | null {
  const text = normalizeOptionalText(value);
  if (text === undefined || text === null) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CatalogError("INVALID_MEDIA", "Delivery URL must be an absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CatalogError("INVALID_MEDIA", "Delivery URL must use http or https.");
  }

  return text;
}

export function normalizeStorageKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogError("INVALID_MEDIA", "Storage key must not be blank.");
  }
  return value.trim();
}
