import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  requiresVariantSelection,
  selectGalleryImage,
  selectBookingCategory,
  selectBookingHairstyle,
  selectedBookingCover,
} from "@/components/booking/booking-style-selection";

describe("booking style selection", () => {
  it("keeps the selected variant when the same service is selected again", () => {
    const current = { hairstyleId: "gypsy", hairstyleVariantId: "sleek-braided" };

    assert.equal(selectBookingHairstyle(current, "gypsy"), current);
  });

  it("clears an incompatible variant when a different service is selected", () => {
    assert.deepEqual(
      selectBookingHairstyle({ hairstyleId: "gypsy", hairstyleVariantId: "sleek-braided" }, "silk-press"),
      { hairstyleId: "silk-press", hairstyleVariantId: "" },
    );
  });

  it("preserves a selected look while browsing its own category", () => {
    const current = { hairstyleId: "gypsy", hairstyleVariantId: "sleek-braided" };

    assert.equal(selectBookingCategory(current, "braids", "braids"), current);
  });

  it("clears a selected look when switching to another category", () => {
    assert.deepEqual(
      selectBookingCategory({ hairstyleId: "gypsy", hairstyleVariantId: "sleek-braided" }, "braids", "presses"),
      { hairstyleId: "", hairstyleVariantId: "" },
    );
  });

  it("uses the effective gallery for thumbnail navigation and falls back to its cover", () => {
    const gallery = ["first", "second"];

    assert.equal(selectGalleryImage(gallery, "cover", 1), "second");
    assert.equal(selectGalleryImage(gallery, "cover", 7), "cover");
  });

  it("keeps the selected variant cover consistent in the summary and review", () => {
    assert.equal(selectedBookingCover("service-cover", "variant-cover"), "variant-cover");
    assert.equal(selectedBookingCover("service-cover", null), "service-cover");
  });

  it("requires a variant before a variant-priced service can continue", () => {
    assert.equal(requiresVariantSelection(true, ""), true);
    assert.equal(requiresVariantSelection(true, "sleek-braided"), false);
    assert.equal(requiresVariantSelection(false, ""), false);
  });
});
