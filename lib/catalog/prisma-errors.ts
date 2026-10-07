import { Prisma } from "@prisma/client";

/**
 * Narrow helpers for the two Prisma failures the catalog treats as expected
 * business outcomes. Everything else is left to propagate as an unexpected
 * failure.
 */

/** P2002: a unique constraint on `field` rejected the write. */
export function isUniqueViolationOn(error: unknown, field: string): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === "string") return target.includes(field);
  return false;
}

/** P2025: the record targeted by update/delete does not exist. */
export function isRecordNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  );
}
