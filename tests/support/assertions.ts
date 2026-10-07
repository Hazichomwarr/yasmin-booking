import assert from "node:assert/strict";

import { BookingError, type BookingErrorCode } from "@/lib/booking/errors";
import { CatalogError, type CatalogErrorCode } from "@/lib/catalog/errors";

/** Asserts the promise/function fails with a BookingError carrying `code`. */
export async function assertBookingError(
  action: Promise<unknown> | (() => unknown),
  code: BookingErrorCode,
) {
  await assert.rejects(
    async () => (typeof action === "function" ? action() : action),
    (error: unknown) => {
      assert.ok(error instanceof BookingError, `expected BookingError, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}

/** Asserts the promise/function fails with a CatalogError carrying `code`. */
export async function assertCatalogError(
  action: Promise<unknown> | (() => unknown),
  code: CatalogErrorCode,
) {
  await assert.rejects(
    async () => (typeof action === "function" ? action() : action),
    (error: unknown) => {
      assert.ok(error instanceof CatalogError, `expected CatalogError, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    },
  );
}
