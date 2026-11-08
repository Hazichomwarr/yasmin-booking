import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseStripeServerKey } from "@/lib/stripe/server-key";

describe("parseStripeServerKey", () => {
  it("classifies all four Stripe server-key classes without returning secret material", () => {
    assert.deepEqual(parseStripeServerKey("sk_test_StandardTest123"), { keyClass: "standard", mode: "test" });
    assert.deepEqual(parseStripeServerKey("sk_live_StandardLive123"), { keyClass: "standard", mode: "live" });
    assert.deepEqual(parseStripeServerKey("rk_test_RestrictedTest123"), { keyClass: "restricted", mode: "test" });
    assert.deepEqual(parseStripeServerKey("rk_live_RestrictedLive123"), { keyClass: "restricted", mode: "live" });

    const syntheticRestrictedLiveKey = ["rk", "live", "NeverReturnThisSecret123"].join("_");
    const parsed = JSON.stringify(parseStripeServerKey(syntheticRestrictedLiveKey));
    assert.ok(!parsed.includes("NeverReturnThisSecret123"));
    assert.ok(!parsed.includes("rk_live_"));
  });

  it("rejects empty suffixes, whitespace, quotes, publishable keys, and unknown or malformed values", () => {
    for (const value of [
      undefined,
      "",
      "sk_test_",
      "rk_live_",
      " sk_test_value",
      "sk_test_value ",
      "sk_test_val ue",
      '"sk_test_value"',
      "'rk_live_value'",
      "pk_test_value",
      "whsec_value",
      "xx_live_value",
      "sk_stage_value",
      "sk_live_value-with-symbols",
      "sk_live_value_with_separator",
    ]) {
      assert.equal(parseStripeServerKey(value), null, String(value));
    }
  });
});
