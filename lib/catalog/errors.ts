/**
 * Expected business failures of the catalog domain.
 *
 * Callers (future admin actions, public pages) can switch on `code` instead of
 * inspecting Prisma exceptions. Unexpected database/infrastructure failures are
 * NOT converted into CatalogError — they propagate unchanged.
 */
export type CatalogErrorCode =
  | "CATEGORY_NOT_FOUND"
  | "HAIRSTYLE_NOT_FOUND"
  | "MEDIA_NOT_FOUND"
  | "INVALID_NAME"
  | "INVALID_SLUG"
  | "SLUG_ALREADY_EXISTS"
  | "INVALID_REORDER"
  | "INVALID_MEDIA"
  | "STORAGE_KEY_ALREADY_EXISTS"
  | "MEDIA_LIMIT_REACHED"
  | "VIDEO_NOT_VERIFIED"
  | "VIDEO_TOO_LONG";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

export function isCatalogError(
  error: unknown,
  code?: CatalogErrorCode,
): error is CatalogError {
  return (
    error instanceof CatalogError && (code === undefined || error.code === code)
  );
}
