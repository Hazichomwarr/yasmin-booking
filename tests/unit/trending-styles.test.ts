import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  LANDING_INSPIRATION_IMAGES,
  resolveTrendingStylesSource,
  type LandingInspirationImage,
} from "@/components/landing/landing-inspiration";

const inspiration = Array.from({ length: 7 }, (_, index) => ({
  src: `/images/landing/approved-style-${index + 1}.webp`,
  alt: `Approved hairstyle inspiration ${index + 1}`,
})) as LandingInspirationImage[];

describe("homepage trending styles fallback", () => {
  it("registers six accessible local salon photographs that exist on disk", () => {
    assert.equal(LANDING_INSPIRATION_IMAGES.length, 6);

    for (const image of LANDING_INSPIRATION_IMAGES) {
      assert.match(image.src, /^\/images\/landing\/[a-z0-9-]+\.jpg$/);
      assert.ok(image.alt.trim().length > 0);
      assert.equal(
        existsSync(path.join(process.cwd(), "public", image.src)),
        true,
        `Missing inspiration image: ${image.src}`,
      );
    }
  });

  it("selects at most six local inspiration images when no eligible feature exists", () => {
    const source = resolveTrendingStylesSource([], inspiration);

    assert.equal(source.kind, "inspiration");
    assert.equal(source.items.length, 6);
    assert.ok(source.items.every((image) => image.src.startsWith("/images/landing/") && image.alt.length > 0));
  });

  it("uses only configured features when at least one eligible feature exists", () => {
    const feature = { id: "feature-1", href: "/styles/silk-press" };
    const source = resolveTrendingStylesSource([feature], inspiration);

    assert.deepEqual(source, { kind: "features", items: [feature] });
    assert.ok(source.items.every((item) => "href" in item));
  });

  it("keeps an empty approved manifest safe instead of inventing photography", () => {
    assert.deepEqual(resolveTrendingStylesSource([], []), { kind: "inspiration", items: [] });
  });
});
