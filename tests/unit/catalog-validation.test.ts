import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPubliclyVisible } from "@/lib/catalog/read-shapes";
import {
  assertCompleteOrdering,
  normalizeDeliveryUrl,
  normalizeName,
  normalizeOptionalText,
  normalizeSlug,
  normalizeStorageKey,
} from "@/lib/catalog/validation";

import { assertCatalogError } from "../support/assertions";

describe("normalizeName", () => {
  it("trims and collapses internal whitespace", () => {
    assert.equal(normalizeName("  Knotless   Braids "), "Knotless Braids");
  });

  it("rejects blank or missing names", async () => {
    await assertCatalogError(() => normalizeName("   "), "INVALID_NAME");
    await assertCatalogError(() => normalizeName(""), "INVALID_NAME");
    await assertCatalogError(() => normalizeName(undefined), "INVALID_NAME");
  });
});

describe("normalizeSlug", () => {
  it("trims and lowercases", () => {
    assert.equal(normalizeSlug("  Knotless-Braids "), "knotless-braids");
  });

  it("rejects blank slugs", async () => {
    await assertCatalogError(() => normalizeSlug("  "), "INVALID_SLUG");
    await assertCatalogError(() => normalizeSlug(null), "INVALID_SLUG");
  });

  it("rejects slugs that are not URL-safe instead of rewriting them", async () => {
    for (const bad of ["box braids", "box--braids", "-box", "box-", "box_braids", "tresses/2"]) {
      await assertCatalogError(() => normalizeSlug(bad), "INVALID_SLUG");
    }
  });
});

describe("normalizeOptionalText", () => {
  it("distinguishes unchanged, cleared, and set values", () => {
    assert.equal(normalizeOptionalText(undefined), undefined);
    assert.equal(normalizeOptionalText(null), null);
    assert.equal(normalizeOptionalText("   "), null);
    assert.equal(normalizeOptionalText("  Long and sleek "), "Long and sleek");
  });
});

describe("media field validation", () => {
  it("requires a non-blank storage key", async () => {
    await assertCatalogError(() => normalizeStorageKey("  "), "INVALID_MEDIA");
    assert.equal(normalizeStorageKey(" styles/a.jpg "), "styles/a.jpg");
  });

  it("accepts absent or http(s) delivery URLs only", async () => {
    assert.equal(normalizeDeliveryUrl(undefined), null);
    assert.equal(normalizeDeliveryUrl("  "), null);
    assert.equal(normalizeDeliveryUrl("https://cdn.example/a.jpg"), "https://cdn.example/a.jpg");
    await assertCatalogError(() => normalizeDeliveryUrl("not a url"), "INVALID_MEDIA");
    await assertCatalogError(() => normalizeDeliveryUrl("javascript:alert(1)"), "INVALID_MEDIA");
  });
});

describe("assertCompleteOrdering", () => {
  const existing = ["a", "b", "c"];

  it("accepts any permutation of the full scope", () => {
    assert.doesNotThrow(() => assertCompleteOrdering(["c", "a", "b"], existing, "scope"));
    assert.doesNotThrow(() => assertCompleteOrdering([], [], "empty scope"));
  });

  it("rejects duplicates, foreign IDs, partial lists, and non-lists", async () => {
    await assertCatalogError(() => assertCompleteOrdering(["a", "a", "b"], existing, "s"), "INVALID_REORDER");
    await assertCatalogError(() => assertCompleteOrdering(["a", "b", "c", "z"], existing, "s"), "INVALID_REORDER");
    await assertCatalogError(() => assertCompleteOrdering(["a", "b"], existing, "s"), "INVALID_REORDER");
    await assertCatalogError(() => assertCompleteOrdering("a,b,c", existing, "s"), "INVALID_REORDER");
  });
});

describe("public visibility rule", () => {
  it("requires both the hairstyle and its category to be active", () => {
    assert.equal(isPubliclyVisible({ isActive: true, category: { isActive: true } }), true);
    assert.equal(isPubliclyVisible({ isActive: true, category: { isActive: false } }), false);
    assert.equal(isPubliclyVisible({ isActive: false, category: { isActive: true } }), false);
  });
});
