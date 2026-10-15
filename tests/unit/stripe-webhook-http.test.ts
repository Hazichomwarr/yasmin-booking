import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStripeWebhookApi, MAX_STRIPE_WEBHOOK_BODY_BYTES } from "@/lib/http/stripe-webhook-api";
import type { StripeWebhookGateway } from "@/lib/stripe/webhook";

const payload = JSON.stringify({ id: "evt_webhook_unit", type: "checkout.session.completed", data: { object: { id: "cs_webhook_unit" } } });

function api(overrides: { expectedSecret?: string; process?: () => Promise<{ kind: "processed" | "busy" }> } = {}) {
  let received = "";
  const gateway: StripeWebhookGateway = {
    constructEvent(body, signature, secret) {
      received = body;
      if (body !== payload || signature !== "valid-signature" || secret !== (overrides.expectedSecret ?? "whsec_test")) throw new Error("bad signature");
      return JSON.parse(body);
    },
    async retrieveCheckoutSession() { throw new Error("not used"); },
  };
  const handler = createStripeWebhookApi({
    env: () => ({ STRIPE_SECRET_KEY: "sk_test_unit", STRIPE_WEBHOOK_SECRET: "whsec_test" }),
    gateway: () => gateway,
    process: async () => overrides.process ? overrides.process() : { kind: "processed" },
    log: () => {},
  });
  return { handler, received: () => received };
}

function request(body = payload, signature: string | null = "valid-signature", method = "POST") {
  const headers = new Headers();
  if (signature !== null) headers.set("stripe-signature", signature);
  return new Request("https://book.yasmin.example/api/stripe/webhook", { method, headers, body: method === "POST" ? body : undefined });
}

describe("Stripe webhook HTTP boundary", () => {
  it("accepts a valid signature over the exact raw body", async () => {
    const h = api();
    const response = await h.handler(request());
    assert.equal(response.status, 200);
    assert.equal(h.received(), payload);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  for (const [label, body, signature] of [
    ["invalid signature", payload, "invalid"],
    ["missing signature", payload, null],
    ["malformed body", "{", "valid-signature"],
    ["modified body after signing", `${payload} `, "valid-signature"],
  ] as const) {
    it(`rejects ${label} before processing`, async () => {
      const h = api();
      assert.equal((await h.handler(request(body, signature))).status, 400);
    });
  }

  it("rejects a signature constructed with another webhook secret", async () => {
    const h = api({ expectedSecret: "whsec_other" });
    assert.equal((await h.handler(request())).status, 400);
  });

  it("rejects oversized input before signature verification", async () => {
    const h = api();
    assert.equal((await h.handler(request("x".repeat(MAX_STRIPE_WEBHOOK_BODY_BYTES + 1)))).status, 413);
  });

  it("does not expose an unsupported method", async () => {
    const h = api();
    assert.equal((await h.handler(request(payload, "valid-signature", "GET"))).status, 405);
  });

  it("returns non-2xx while another delivery owns processing", async () => {
    const h = api({ process: async () => ({ kind: "busy" }) });
    assert.equal((await h.handler(request())).status, 500);
  });
});
