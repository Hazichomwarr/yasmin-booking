import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { TODAY_AT_SALON_CONTENT } from "@/components/today-at-salon/today-at-salon-content";
import {
  shouldOpenTodayAtSalon,
  TODAY_AT_SALON_DELAY_MS,
} from "@/components/today-at-salon/today-at-salon-session";

describe("Today at the Salon", () => {
  it("uses the approved copy, safe catalog CTA, versioned video path, and an existing salon poster", () => {
    assert.equal(TODAY_AT_SALON_CONTENT.title, "Inside Yasmin's Beauty Salon");
    assert.equal(TODAY_AT_SALON_CONTENT.ctaHref, "/styles");
    assert.match(TODAY_AT_SALON_CONTENT.videoSrc, /^\/media\/yasmin-salon-week-\d+\.mp4$/);
    assert.equal(TODAY_AT_SALON_CONTENT.videoAvailable, true);
    assert.equal(existsSync(`public${TODAY_AT_SALON_CONTENT.videoSrc}`), true);
    assert.equal(existsSync(`public${TODAY_AT_SALON_CONTENT.posterSrc}`), true);
  });

  it("waits three seconds and suppresses auto-open for reduced motion or another interaction", () => {
    assert.equal(TODAY_AT_SALON_DELAY_MS, 3_000);
    assert.equal(shouldOpenTodayAtSalon({ reducedMotion: false, hasBlockingInteraction: false }), true);
    assert.equal(shouldOpenTodayAtSalon({ reducedMotion: true, hasBlockingInteraction: false }), false);
    assert.equal(shouldOpenTodayAtSalon({ reducedMotion: false, hasBlockingInteraction: true }), false);
  });
});
