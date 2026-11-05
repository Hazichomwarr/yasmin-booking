import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { categoryDraftHasChanges, newCategoryDraftHasChanges } from "@/lib/admin/category-editor";

describe("admin category editor state", () => {
  const saved = { name: "Braids", slug: "braids", descriptionText: "Classic styles" };

  it("detects each editable category field without treating unchanged values as dirty", () => {
    assert.equal(categoryDraftHasChanges(saved, saved), false);
    assert.equal(categoryDraftHasChanges({ ...saved, name: "Box Braids" }, saved), true);
    assert.equal(categoryDraftHasChanges({ ...saved, slug: "box-braids" }, saved), true);
    assert.equal(categoryDraftHasChanges({ ...saved, descriptionText: "" }, saved), true);
  });

  it("detects populated and inactive new-category drafts", () => {
    assert.equal(newCategoryDraftHasChanges({ name: "", slug: "", description: "", isActive: true }), false);
    assert.equal(newCategoryDraftHasChanges({ name: "Twists", slug: "", description: "", isActive: true }), true);
    assert.equal(newCategoryDraftHasChanges({ name: "", slug: "", description: "", isActive: false }), true);
  });
});
