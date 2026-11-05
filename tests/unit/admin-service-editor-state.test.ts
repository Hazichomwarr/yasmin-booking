import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serviceEditorStateHasChanges, type ServiceEditorDraftState } from "@/lib/admin/service-editor-state";

function draft(): ServiceEditorDraftState {
  return {
    name: "Gypsy",
    categoryId: "boho",
    description: "A salon description.",
    pricingMode: "variants",
    price: "",
    variants: [{ id: "variant-1", name: "Sleek", description: "Smooth finish.", price: "240.00", isActive: true, sortOrder: "0" }],
    removedVariantIds: [],
    isActive: true,
    displayOrder: "2",
    newCategoryName: "",
  };
}

describe("service editor dirty state", () => {
  it("does not report unchanged editor data as dirty", () => {
    assert.equal(serviceEditorStateHasChanges(draft(), draft()), false);
  });

  it("detects edits to service and variant fields", () => {
    const initial = draft();
    assert.equal(serviceEditorStateHasChanges({ ...draft(), name: "Gypsy Braids" }, initial), true);
    assert.equal(serviceEditorStateHasChanges({ ...draft(), displayOrder: "3" }, initial), true);
    assert.equal(serviceEditorStateHasChanges({ ...draft(), variants: [{ ...draft().variants[0], price: "260.00" }] }, initial), true);
  });

  it("detects variant removals and pending category input regardless of removal ordering", () => {
    const initial = draft();
    assert.equal(serviceEditorStateHasChanges({ ...draft(), removedVariantIds: ["variant-2", "variant-1"] }, initial), true);
    assert.equal(serviceEditorStateHasChanges({ ...draft(), newCategoryName: "New category" }, initial), true);
    assert.equal(
      serviceEditorStateHasChanges(
        { ...draft(), removedVariantIds: ["variant-2", "variant-1"] },
        { ...draft(), removedVariantIds: ["variant-1", "variant-2"] },
      ),
      false,
    );
  });
});
