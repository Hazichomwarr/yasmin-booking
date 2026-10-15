import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BookingErrorCode } from "@/lib/booking/errors";
import { BOOKING_COOKIE_NAME, bookingCookie, clearedBookingCookie, readBookingCookie } from "@/lib/http/booking-cookie";
import { UNIDENTIFIED_CLIENT, clientIdentity, normalizeIp } from "@/lib/http/client-ip";
import { DEFAULT_RATE_LIMITS, isPublicBookingEnabled, loadPublicBookingConfig, type Env } from "@/lib/http/config";
import { AMBIGUOUS_CHECKOUT_TO_PUBLIC, isApprovedCheckoutUrl } from "@/lib/http/public-booking-api";
import { BOOKING_ERROR_TO_PUBLIC, PUBLIC_ERRORS, SECURITY_HEADERS, publicError } from "@/lib/http/public-responses";
import { rateLimitKey, windowStartMs } from "@/lib/http/rate-limit";
import { checkMutationOrigin, isJsonContentType, parseJsonObject, readBodyText } from "@/lib/http/request-guards";

/** Pure tests: nothing here touches a database. */

const SECRET = "s".repeat(32);
const LOCAL: Env = { APP_BASE_URL: "https://localhost:3000", RATE_LIMIT_SECRET: SECRET, TRUSTED_CLIENT_IP_SOURCE: "none" };
const PROD: Env = {
  NODE_ENV: "production",
  VERCEL: "1",
  VERCEL_ENV: "production",
  APP_BASE_URL: "https://book.yasmin.example",
  RATE_LIMIT_SECRET: SECRET,
  TRUSTED_CLIENT_IP_SOURCE: "vercel",
  STRIPE_SECRET_KEY: "sk_live_x",
};
const problems = (env: Env) => {
  const result = loadPublicBookingConfig(env);
  return result.ok ? [] : result.problems;
};

describe("feature flag", () => {
  it("is on only for exactly \"true\"", () => {
    assert.equal(isPublicBookingEnabled({ PUBLIC_BOOKING_ENABLED: "true" }), true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      assert.equal(isPublicBookingEnabled({ PUBLIC_BOOKING_ENABLED: value }), false, String(value));
    }
  });
});

describe("configuration", () => {
  it("accepts a safe local and a safe production configuration", () => {
    assert.deepEqual(problems(LOCAL), []);
    assert.deepEqual(problems({ ...LOCAL, APP_BASE_URL: "http://localhost:3000" }), []);
    assert.deepEqual(problems(PROD), []);
    const config = loadPublicBookingConfig(PROD);
    assert.ok(config.ok);
    assert.equal(config.config.appOrigin, "https://book.yasmin.example");
    assert.deepEqual([...config.config.allowedOrigins], ["https://book.yasmin.example"]);
  });

  it("rejects unsafe production values", () => {
    const cases: [string, Env][] = [
      ["http origin", { ...PROD, APP_BASE_URL: "http://book.yasmin.example" }],
      ["missing origin", { ...PROD, APP_BASE_URL: undefined }],
      ["origin with query", { ...PROD, APP_BASE_URL: "https://book.yasmin.example/?x=1" }],
      ["origin with credentials", { ...PROD, APP_BASE_URL: "https://u:p@book.yasmin.example" }],
      ["short secret", { ...PROD, RATE_LIMIT_SECRET: "short" }],
      ["no ip source", { ...PROD, TRUSTED_CLIENT_IP_SOURCE: undefined }],
      ["untrusted ip source", { ...PROD, TRUSTED_CLIENT_IP_SOURCE: "none" }],
      ["spoofable header source", { ...PROD, TRUSTED_CLIENT_IP_SOURCE: "x-forwarded-for" }],
      ["vercel source off Vercel", { ...PROD, VERCEL: undefined }],
      ["extra origins on production", { ...PROD, PUBLIC_BOOKING_ADDITIONAL_ORIGINS: "https://preview.vercel.app" }],
      ["live key on preview", { ...PROD, VERCEL_ENV: "preview" }],
      ["missing stripe key", { ...PROD, STRIPE_SECRET_KEY: undefined }],
      ["bad limit override", { ...PROD, PUBLIC_BOOKING_RATE_LIMITS: '{"bookingIp10m":0}' }],
      ["unknown limit override", { ...PROD, PUBLIC_BOOKING_RATE_LIMITS: '{"other":5}' }],
      ["non-json override", { ...PROD, PUBLIC_BOOKING_RATE_LIMITS: "5" }],
    ];
    for (const [name, env] of cases) assert.ok(problems(env).length > 0, name);
  });

  it("rejects plain http beyond localhost even outside production", () => {
    assert.ok(problems({ ...LOCAL, APP_BASE_URL: "http://example.com" }).length > 0);
  });

  it("accepts only exact https preview origins, never wildcards", () => {
    const preview = { ...PROD, VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_test_x" };
    const ok = loadPublicBookingConfig({ ...preview, PUBLIC_BOOKING_ADDITIONAL_ORIGINS: "https://a.vercel.app, https://b.vercel.app" });
    assert.ok(ok.ok);
    assert.deepEqual([...ok.config.allowedOrigins].sort(), ["https://a.vercel.app", "https://b.vercel.app", "https://book.yasmin.example"]);
    for (const bad of ["https://*.vercel.app", "*", "https://a.vercel.app/path", "http://a.vercel.app", "a.vercel.app"]) {
      assert.ok(problems({ ...preview, PUBLIC_BOOKING_ADDITIONAL_ORIGINS: bad }).length > 0, bad);
    }
  });

  it("applies limit overrides without changing windows or scopes", () => {
    const result = loadPublicBookingConfig({ ...LOCAL, PUBLIC_BOOKING_RATE_LIMITS: '{"bookingIp10m":9}' });
    assert.ok(result.ok);
    assert.deepEqual(result.config.rateLimits.bookingIp10m, { ...DEFAULT_RATE_LIMITS.bookingIp10m, limit: 9 });
    assert.deepEqual(result.config.rateLimits.statusIp1m, DEFAULT_RATE_LIMITS.statusIp1m);
  });

  it("ships the approved default limits with unique scopes", () => {
    const limits = Object.fromEntries(Object.entries(DEFAULT_RATE_LIMITS).map(([k, r]) => [k, [r.limit, r.windowMs / 60_000]]));
    assert.deepEqual(limits, {
      bookingIp10m: [5, 10],
      bookingIpDay: [20, 1440],
      bookingEmailDay: [3, 1440],
      bookingPhoneDay: [3, 1440],
      checkoutCredential10m: [10, 10],
      checkoutIp10m: [30, 10],
      statusCredential1m: [60, 1],
      statusIp1m: [120, 1],
    });
    const scopes = Object.values(DEFAULT_RATE_LIMITS).map((r) => r.scope);
    assert.equal(new Set(scopes).size, scopes.length);
    for (const scope of scopes) assert.match(scope, /^[a-z][a-z0-9.-]{0,63}$/);
  });
});

describe("Origin and Fetch Metadata", () => {
  const allowed = new Set(["https://book.yasmin.example"]);
  const check = (headers: Record<string, string>) => checkMutationOrigin(new Headers(headers), allowed);

  it("accepts the exact configured origin, with or without same-origin Fetch Metadata", () => {
    assert.equal(check({ origin: "https://book.yasmin.example" }), null);
    assert.equal(check({ origin: "https://book.yasmin.example", "sec-fetch-site": "same-origin" }), null);
  });

  it("rejects missing, null, malformed, foreign, sibling, scheme and port mismatches", () => {
    assert.equal(check({}), "ORIGIN_MISSING");
    assert.equal(check({ origin: " " }), "ORIGIN_MISSING");
    assert.equal(check({ origin: "null" }), "ORIGIN_NULL");
    for (const malformed of ["book.yasmin.example", "https://book.yasmin.example/", "https://book.yasmin.example/path", "not a url"]) {
      assert.equal(check({ origin: malformed }), "ORIGIN_MALFORMED", malformed);
    }
    for (const foreign of [
      "https://evil.example",
      "https://shop.yasmin.example",
      "https://yasmin.example",
      "https://book.yasmin.example.evil.example",
      "http://book.yasmin.example",
      "https://book.yasmin.example:8443",
    ]) {
      assert.equal(check({ origin: foreign }), "ORIGIN_NOT_ALLOWED", foreign);
    }
  });

  it("rejects any Fetch Metadata other than same-origin", () => {
    for (const site of ["same-site", "cross-site", "none", "garbage"]) {
      assert.equal(check({ origin: "https://book.yasmin.example", "sec-fetch-site": site }), "FETCH_SITE_NOT_SAME_ORIGIN", site);
    }
  });

  it("never derives trust from Host or forwarded headers", () => {
    assert.equal(
      check({ origin: "https://evil.example", host: "evil.example", "x-forwarded-host": "evil.example" }),
      "ORIGIN_NOT_ALLOWED",
    );
  });
});

describe("Content-Type", () => {
  it("requires application/json with at most a utf-8 charset", () => {
    for (const ok of ["application/json", "Application/JSON", "application/json; charset=utf-8", 'application/json;charset="UTF-8"']) {
      assert.equal(isJsonContentType(ok), true, ok);
    }
    for (const bad of [
      null,
      "",
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/json; charset=latin1",
      "application/json; boundary=x",
      "application/jsonx",
      "application/json-patch+json",
    ]) {
      assert.equal(isJsonContentType(bad), false, String(bad));
    }
  });
});

describe("body reading", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request("https://book.yasmin.example/api/bookings", { method: "POST", body, headers, duplex: "half" } as RequestInit);

  it("accepts a body exactly at the limit and rejects one byte over", async () => {
    assert.deepEqual(await readBodyText(post("x".repeat(8192)), 8192), { ok: true, text: "x".repeat(8192) });
    assert.deepEqual(await readBodyText(post("x".repeat(8193)), 8192), { ok: false, problem: "TOO_LARGE" });
  });

  it("enforces the limit on streamed bytes, ignoring a false Content-Length", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1_000) controller.close();
        else controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
    });
    const result = await readBodyText(post(stream, { "content-length": "10" }), 8192);
    assert.deepEqual(result, { ok: false, problem: "TOO_LARGE" });
    assert.ok(pulled < 20, `stopped reading early (pulled ${pulled} chunks)`);
  });

  it("rejects early on a declared oversized Content-Length", async () => {
    assert.deepEqual(await readBodyText(post("{}", { "content-length": "9000" }), 8192), { ok: false, problem: "TOO_LARGE" });
  });

  it("rejects invalid UTF-8", async () => {
    assert.deepEqual(await readBodyText(post(new Uint8Array([0x7b, 0xff, 0x7d])), 8192), { ok: false, problem: "NOT_UTF8" });
  });

  it("parses only JSON objects", () => {
    assert.deepEqual(parseJsonObject('{"a":1}'), { ok: true, value: { a: 1 } });
    for (const bad of ["", "{", "[]", "null", "42", '"x"', "[{}]"]) assert.deepEqual(parseJsonObject(bad), { ok: false }, bad);
  });
});

describe("booking cookie", () => {
  const token = "A".repeat(43);
  const now = new Date("2027-03-01T15:00:00.000Z");

  it("sets the secure __Host- cookie with the credential's own expiry", () => {
    const expires = new Date(now.getTime() + 24 * 3600_000);
    assert.equal(
      bookingCookie(token, expires, now),
      `${BOOKING_COOKIE_NAME}=${token}; Max-Age=86400; Expires=${expires.toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    const cookie = bookingCookie(token, expires, now);
    assert.ok(cookie.startsWith("__Host-yasmin_booking="));
    assert.doesNotMatch(cookie, /Domain=/i);
  });

  it("never exceeds 24 hours and never goes negative", () => {
    assert.match(bookingCookie(token, new Date(now.getTime() + 48 * 3600_000), now), /Max-Age=86400;/);
    assert.match(bookingCookie(token, new Date(now.getTime() + 90_500), now), /Max-Age=90;/);
    assert.match(bookingCookie(token, new Date(now.getTime() - 1000), now), /Max-Age=0;/);
  });

  it("clears with the same name and attributes", () => {
    assert.equal(
      clearedBookingCookie(),
      `${BOOKING_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
  });

  it("reads exactly one value and refuses duplicates", () => {
    const read = (cookie?: string) => readBookingCookie(new Headers(cookie ? { cookie } : {}));
    assert.deepEqual(read(), { kind: "absent" });
    assert.deepEqual(read("other=1; yasmin_booking=x"), { kind: "absent" });
    assert.deepEqual(read(`a=1; ${BOOKING_COOKIE_NAME}=${token}; b=2`), { kind: "present", token });
    assert.deepEqual(read(`${BOOKING_COOKIE_NAME}=${token}; ${BOOKING_COOKIE_NAME}=other`), { kind: "ambiguous" });
  });
});

describe("client IP trust", () => {
  const vercel = (headers: Record<string, string>) => clientIdentity(new Headers(headers), "vercel");

  it("reads only x-vercel-forwarded-for, ignoring spoofable headers", () => {
    assert.deepEqual(vercel({ "x-vercel-forwarded-for": "203.0.113.7" }), { kind: "ip", value: "203.0.113.7" });
    assert.deepEqual(vercel({ "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }), { kind: "unidentified", value: UNIDENTIFIED_CLIENT });
    assert.deepEqual(
      vercel({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }),
      { kind: "ip", value: "203.0.113.7" },
    );
  });

  it("maps missing, invalid or multi-valued values to one shared bucket", () => {
    for (const value of ["", "not-an-ip", "203.0.113.7, 198.51.100.1", "999.1.1.1", "fe80::1%eth0"]) {
      assert.deepEqual(vercel({ "x-vercel-forwarded-for": value }), { kind: "unidentified", value: UNIDENTIFIED_CLIENT }, value);
    }
  });

  it("trusts nothing without a configured source", () => {
    assert.deepEqual(clientIdentity(new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }), "none"), { kind: "unidentified", value: UNIDENTIFIED_CLIENT });
  });

  it("canonicalizes IPv4 and groups IPv6 by /64", () => {
    assert.equal(normalizeIp("203.0.113.7"), "203.0.113.7");
    assert.equal(normalizeIp("2001:db8:1:2:3:4:5:6"), "2001:0db8:0001:0002::/64");
    assert.equal(normalizeIp("2001:DB8:1:2::ffff"), "2001:0db8:0001:0002::/64");
    assert.equal(normalizeIp("2001:db8:1:2:aaaa::1"), normalizeIp("2001:db8:1:2:bbbb::2"));
    assert.notEqual(normalizeIp("2001:db8:1:2::1"), normalizeIp("2001:db8:1:3::1"));
    assert.equal(normalizeIp("::1"), "0000:0000:0000:0000::/64");
    assert.equal(normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
    assert.equal(normalizeIp("::ffff:cb00:7107"), "203.0.113.7");
    assert.equal(normalizeIp("nope"), null);
  });
});

describe("rate-limit keys", () => {
  it("are HMAC-SHA256 hex, bound to secret and scope, and never contain the identity", () => {
    const key = rateLimitKey(SECRET, "booking.email.1d", "customer@example.test");
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(key, rateLimitKey(SECRET, "booking.email.1d", "customer@example.test"));
    assert.notEqual(key, rateLimitKey("t".repeat(32), "booking.email.1d", "customer@example.test"));
    assert.notEqual(key, rateLimitKey(SECRET, "booking.phone.1d", "customer@example.test"));
    assert.ok(!key.includes("customer"));
  });

  it("align windows to fixed boundaries", () => {
    assert.equal(windowStartMs(600_000 * 7 + 1, 600_000), 600_000 * 7);
    assert.equal(windowStartMs(600_000 * 7, 600_000), 600_000 * 7);
  });
});

describe("public responses", () => {
  it("map every booking error code to a public code", () => {
    const codes = Object.keys(BOOKING_ERROR_TO_PUBLIC) as BookingErrorCode[];
    for (const code of codes) assert.ok(BOOKING_ERROR_TO_PUBLIC[code] in PUBLIC_ERRORS, code);
    // Internal-only failures never surface as a meaningful public signal.
    assert.equal(BOOKING_ERROR_TO_PUBLIC.APPOINTMENT_NOT_FOUND, "INTERNAL_ERROR");
    assert.equal(BOOKING_ERROR_TO_PUBLIC.CAPACITY_FULL, "SLOT_FULL");
    assert.equal(BOOKING_ERROR_TO_PUBLIC.HOLD_EXPIRED, "HOLD_EXPIRED");
  });

  it("set the security headers and the fixed envelope on every error", async () => {
    for (const code of Object.keys(PUBLIC_ERRORS) as (keyof typeof PUBLIC_ERRORS)[]) {
      const response = publicError(code);
      assert.equal(response.status, PUBLIC_ERRORS[code].status);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, `${code} ${name}`);
      assert.deepEqual(await response.json(), { error: { code, message: PUBLIC_ERRORS[code].message } });
    }
  });
});

describe("Checkout URL approval", () => {
  it("accepts only https on the exact Stripe Checkout host", () => {
    assert.equal(isApprovedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_123#fragment"), true);
    for (const bad of [
      "http://checkout.stripe.com/c/pay/cs_test_123",
      "https://checkout.stripe.com.evil.example/c/pay",
      "https://evil.example/checkout.stripe.com",
      "https://evilcheckout.stripe.com/c/pay",
      "https://stripe.com/c/pay",
      "https://checkout.stripe.com:8443/c/pay",
      "https://user:pass@checkout.stripe.com/c/pay",
      "javascript:alert(1)",
      "not a url",
    ]) {
      assert.equal(isApprovedCheckoutUrl(bad), false, bad);
    }
  });
});

describe("ambiguous Checkout mapping", () => {
  it("maps every reason, with only a failed Session read retryable", () => {
    assert.deepEqual(AMBIGUOUS_CHECKOUT_TO_PUBLIC, {
      "provider-retrieval-failed": "CHECKOUT_TEMPORARILY_UNAVAILABLE",
      "checkout-creation-unconfirmed": "CHECKOUT_OUTCOME_UNCERTAIN",
      "provider-session-unusable": "CHECKOUT_NEEDS_ASSISTANCE",
      "payment-awaiting-confirmation": "PAYMENT_AWAITING_CONFIRMATION",
      "payment-already-received": "PAYMENT_RECEIVED",
      "checkout-attempt-ended": "CHECKOUT_ATTEMPT_ENDED",
      "booking-changed": "BOOKING_STATE_CHANGED",
    });
    for (const code of Object.values(AMBIGUOUS_CHECKOUT_TO_PUBLIC)) assert.ok(code in PUBLIC_ERRORS);
  });

  it("never tells the customer to start over unless the attempt ended without money", () => {
    for (const [reason, code] of Object.entries(AMBIGUOUS_CHECKOUT_TO_PUBLIC)) {
      const startsOver = /please start a new booking/i.test(PUBLIC_ERRORS[code].message);
      assert.equal(startsOver, reason === "checkout-attempt-ended", reason);
    }
    assert.match(PUBLIC_ERRORS.CHECKOUT_OUTCOME_UNCERTAIN.message, /do not start a new booking/i);
  });
});
