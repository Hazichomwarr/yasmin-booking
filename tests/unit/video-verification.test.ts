import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertVideoMayBeAttached,
  MAX_VIDEO_DURATION_SECONDS,
  type VerifiedVideoMetadata,
} from "@/lib/catalog/media-verification";

import { assertCatalogError } from "../support/assertions";

describe("verified video rule", () => {
  it("accepts verified metadata up to and including 30 seconds", () => {
    assert.equal(MAX_VIDEO_DURATION_SECONDS, 30);
    assert.doesNotThrow(() =>
      assertVideoMayBeAttached("v/a.mp4", { storageKey: "v/a.mp4", durationSeconds: 30 }),
    );
    assert.doesNotThrow(() =>
      assertVideoMayBeAttached("v/a.mp4", { storageKey: "v/a.mp4", durationSeconds: 0.5 }),
    );
  });

  it("rejects anything over 30 seconds with VIDEO_TOO_LONG", async () => {
    await assertCatalogError(
      () => assertVideoMayBeAttached("v/b.mp4", { storageKey: "v/b.mp4", durationSeconds: 30.01 }),
      "VIDEO_TOO_LONG",
    );
  });

  it("rejects missing verified metadata", async () => {
    await assertCatalogError(
      () => assertVideoMayBeAttached("v/c.mp4", undefined),
      "VIDEO_NOT_VERIFIED",
    );
    await assertCatalogError(
      () => assertVideoMayBeAttached("v/c.mp4", null as unknown as VerifiedVideoMetadata),
      "VIDEO_NOT_VERIFIED",
    );
  });

  it("rejects metadata measured for a different storage key", async () => {
    await assertCatalogError(
      () => assertVideoMayBeAttached("v/e.mp4", { storageKey: "v/other.mp4", durationSeconds: 10 }),
      "VIDEO_NOT_VERIFIED",
    );
  });

  it("rejects a non-positive, non-finite, or non-numeric duration", async () => {
    for (const durationSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
      await assertCatalogError(
        () =>
          assertVideoMayBeAttached("v/f.mp4", {
            storageKey: "v/f.mp4",
            durationSeconds,
          } as VerifiedVideoMetadata),
        "INVALID_MEDIA",
      );
    }
  });
});
