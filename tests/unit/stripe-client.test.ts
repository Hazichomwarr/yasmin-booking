import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripeClient } from "@/lib/stripe/client";

const TEST_KEY = "sk_test_local_acceptance_only";
/** stripe-node's runtime accessor for its resolved connection settings (not in its type definitions). */
const api = (client: ReturnType<typeof stripeClient>, field: "host" | "port" | "protocol") =>
  String((client as unknown as { getApiField(name: string): unknown }).getApiField(field));

describe("stripeClient local test API override", () => {
  it("uses Stripe's own API when no override is configured", () => {
    const client = stripeClient(TEST_KEY, { NODE_ENV: "production" });
    assert.equal(api(client, "host"), "api.stripe.com");
    assert.equal(api(client, "protocol"), "https");
  });

  it("points a test key at a loopback double outside production", () => {
    const client = stripeClient(TEST_KEY, { NODE_ENV: "development", STRIPE_LOCAL_TEST_API_URL: "http://127.0.0.1:12111" });
    assert.deepEqual([api(client, "host"), api(client, "port"), api(client, "protocol")], ["127.0.0.1", "12111", "http"]);
  });

  it("refuses the override in production, with a live key, or for any non-loopback or https host", () => {
    const local = "http://localhost:12111";
    assert.throws(() => stripeClient(TEST_KEY, { NODE_ENV: "production", STRIPE_LOCAL_TEST_API_URL: local }), /not allowed in production/);
    assert.throws(() => stripeClient("sk_live_real", { NODE_ENV: "development", STRIPE_LOCAL_TEST_API_URL: local }), /requires a Stripe test key/);
    for (const url of ["http://api.stripe.com:80", "https://localhost:12111", "http://localhost", "http://10.0.0.5:12111", "not a url"]) {
      assert.throws(() => stripeClient(TEST_KEY, { NODE_ENV: "development", STRIPE_LOCAL_TEST_API_URL: url }), /STRIPE_LOCAL_TEST_API_URL/, url);
    }
  });
});
