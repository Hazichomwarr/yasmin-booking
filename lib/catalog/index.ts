/**
 * Catalog domain — Yasmin's hairstyle categories, hairstyles, and media metadata.
 *
 * Where the business rules live:
 * - Public visibility rule ............ read-shapes.ts (`publiclyVisibleHairstyle`)
 * - Category lifecycle & ordering ..... categories.ts
 * - Hairstyle lifecycle, move, order .. hairstyles.ts
 * - Media limits (8 images, 3 videos) . media.ts
 * - 30-second video rule .............. media-verification.ts
 *   (VIDEO only via attachVerifiedHairstyleVideo — trusted ingestion boundary)
 * - Public reads ...................... public-catalog.ts
 * - Error codes ....................... errors.ts
 *
 * Catalog rows are current configuration. Appointments keep their own
 * snapshots (e.g. hairstyleNameSnapshot) and are never rewritten here.
 * Categories and hairstyles are deactivated, never hard-deleted.
 */

export { CatalogError, isCatalogError, type CatalogErrorCode } from "./errors";

export {
  activateCategory,
  createCategory,
  deactivateCategory,
  getCategoryForAdmin,
  listCategoriesForAdmin,
  reorderCategories,
  updateCategory,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "./categories";

export {
  activateHairstyle,
  createHairstyle,
  deactivateHairstyle,
  getHairstyleDetailForAdmin,
  listHairstylesForAdmin,
  moveHairstyleToCategory,
  reorderHairstylesInCategory,
  updateHairstyle,
  type CreateHairstyleInput,
  type UpdateHairstyleInput,
} from "./hairstyles";

export {
  MEDIA_LIMITS,
  attachHairstyleImage,
  attachVerifiedHairstyleVideo,
  listHairstyleMedia,
  removeHairstyleMediaMetadata,
  reorderHairstyleMedia,
  type AttachHairstyleImageInput,
  type AttachVerifiedHairstyleVideoInput,
  type RemovedMediaMetadata,
} from "./media";

export {
  MAX_VIDEO_DURATION_SECONDS,
  type VerifiedVideoMetadata,
} from "./media-verification";

export {
  getPublicHairstyleBySlug,
  listPublicCategories,
  listPublicHairstyles,
} from "./public-catalog";

/** The public visibility rule, for other domains (e.g. booking) to reuse. */
export { isPubliclyVisible, publiclyVisibleHairstyle } from "./read-shapes";

export type {
  AdminCategory,
  AdminHairstyle,
  AdminHairstyleDetail,
  AdminMedia,
  PublicCategory,
  PublicHairstyle,
  PublicHairstyleDetail,
  PublicMedia,
} from "./read-shapes";
