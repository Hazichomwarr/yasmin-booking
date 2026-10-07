import { CatalogError } from "./errors";

/**
 * Verified-video rule.
 *
 * Business rule: a hairstyle video may not exceed 30 seconds.
 *
 * The catalog cannot inspect binaries. The trust boundary is the future
 * server-side media-ingestion adapter: it inspects the stored asset (or reads
 * trusted provider metadata), obtains the measured duration, and only then
 * calls `attachVerifiedHairstyleVideo` (media.ts) with that measurement.
 *
 * Consequently:
 * - VIDEO records can be created ONLY through `attachVerifiedHairstyleVideo`;
 *   the ordinary `attachHairstyleImage` path cannot produce a VIDEO.
 * - `VerifiedVideoMetadata` must come from server-side measurement, never
 *   from a request body, form field, or browser-reported duration.
 * - The catalog checks that the measurement describes the asset being
 *   attached (same storageKey) and that it is within the limit.
 *
 * Deferred decision: the measured duration is NOT persisted. HairstyleMedia
 * has no duration column, so the rule is enforced at attachment time only and
 * cannot be re-audited later. The media-ingestion/upload ticket will decide
 * whether HairstyleMedia should gain a verified duration field (required if
 * verification and attachment ever become separate steps).
 */

export const MAX_VIDEO_DURATION_SECONDS = 30;

/** Measurement of a stored video, produced by trusted server-side ingestion. */
export type VerifiedVideoMetadata = {
  /** Storage key of the asset that was measured. */
  storageKey: string;
  /** Duration measured from the stored binary or trusted provider metadata. */
  durationSeconds: number;
};

/** Enforces the verified-video rule for the asset identified by `storageKey`. */
export function assertVideoMayBeAttached(
  storageKey: string,
  verifiedVideo: VerifiedVideoMetadata | undefined,
): void {
  if (typeof verifiedVideo !== "object" || verifiedVideo === null) {
    throw new CatalogError(
      "VIDEO_NOT_VERIFIED",
      "Videos can only be attached with server-side verified metadata.",
    );
  }

  const { durationSeconds } = verifiedVideo;
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new CatalogError("INVALID_MEDIA", "Verified video duration must be a positive number.");
  }

  if (typeof verifiedVideo.storageKey !== "string" || verifiedVideo.storageKey.trim() !== storageKey) {
    throw new CatalogError(
      "VIDEO_NOT_VERIFIED",
      "The verified video metadata describes a different stored asset.",
    );
  }

  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new CatalogError(
      "VIDEO_TOO_LONG",
      `Videos may be at most ${MAX_VIDEO_DURATION_SECONDS} seconds (measured ${durationSeconds}s).`,
    );
  }
}
