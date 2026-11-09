import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { resendConfirmationEmailAdapter } from "@/lib/email/confirmation";

const originalFetch = globalThis.fetch;
const originalKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.BOOKING_FROM_EMAIL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
  if (originalFrom === undefined) delete process.env.BOOKING_FROM_EMAIL;
  else process.env.BOOKING_FROM_EMAIL = originalFrom;
});

describe("Resend confirmation email adapter", () => {
  it("maps an owner CC to Resend's cc field", async () => {
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.BOOKING_FROM_EMAIL = "Yasmin <bookings@example.test>";
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ id: "email_test" });
    };

    await resendConfirmationEmailAdapter().send({
      to: "owner@example.test",
      cc: "assistant@example.test",
      subject: "New booking",
      text: "Confirmed",
    }, { idempotencyKey: "booking-notification/owner/test" });

    assert.deepEqual(requestBody, {
      from: "Yasmin <bookings@example.test>",
      to: ["owner@example.test"],
      cc: ["assistant@example.test"],
      subject: "New booking",
      text: "Confirmed",
    });
  });

  it("omits Resend's cc field when the message has no CC", async () => {
    process.env.RESEND_API_KEY = "test-resend-key";
    process.env.BOOKING_FROM_EMAIL = "Yasmin <bookings@example.test>";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ id: "email_test" });
    };

    await resendConfirmationEmailAdapter().send({
      to: "customer@example.test",
      subject: "Confirmation",
      text: "Confirmed",
    }, { idempotencyKey: "booking-notification/customer/test" });

    assert.equal("cc" in requestBody, false);
  });
});
