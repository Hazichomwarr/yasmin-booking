import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cancelAppointment } from "@/lib/booking";
import { revokeBookingAccess } from "@/lib/booking/access";
import { startAuthorizedBookingCheckout } from "@/lib/booking/checkout";
import { applyVerifiedCheckoutSession } from "@/lib/booking/payment-fulfillment";
import { verifiedCheckoutEvidence } from "@/lib/booking/payment-policy";
import { BOOKING_COOKIE_NAME } from "@/lib/http/booking-cookie";
import type { Env } from "@/lib/http/config";
import {
  createPublicBookingApi,
  defaultPublicBookingApiDeps,
  type PublicApiLogEntry,
  type PublicBookingApiDeps,
} from "@/lib/http/public-booking-api";
import { SECURITY_HEADERS } from "@/lib/http/public-responses";
import { RateLimitStoreError } from "@/lib/http/rate-limit";
import { prisma } from "@/lib/prisma";
import type { StripeCheckoutAdapter } from "@/lib/stripe/checkout";

import { WEEK, createLocation } from "../support/booking-fixtures";
import { integrationSkip, useCleanTestDatabase } from "../support/integration-database";

const ORIGIN = "https://book.yasmin.example";
const ENV: Env = {
  PUBLIC_BOOKING_ENABLED: "true",
  APP_BASE_URL: ORIGIN,
  RATE_LIMIT_SECRET: "test-rate-limit-secret-0123456789abcdef",
  TRUSTED_CLIENT_IP_SOURCE: "vercel",
  VERCEL: "1",
};

type StripeDouble = StripeCheckoutAdapter & { creates: () => number };
function stripeDouble(options: { url?: (paymentId: string) => string; failCreate?: boolean } = {}): StripeDouble {
  let creates = 0;
  return {
    creates: () => creates,
    async createDepositCheckout(input) {
      creates += 1;
      if (options.failCreate) throw new Error("simulated Stripe timeout");
      return {
        id: `cs_api_${input.paymentId}`,
        url: options.url?.(input.paymentId) ?? `https://checkout.stripe.com/c/pay/opaque_${creates}`,
        amountCents: input.amountCents,
        currency: input.currency,
        mode: "payment",
        status: "open",
        expiresAt: input.expiresAt,
        metadata: { paymentId: input.paymentId, appointmentId: input.appointmentId },
      };
    },
    async retrieveDepositCheckout() {
      throw new Error("simulated Stripe outage");
    },
  };
}

type Harness = {
  api: ReturnType<typeof createPublicBookingApi>;
  logs: PublicApiLogEntry[];
  stripe: StripeDouble;
};

function harness(overrides: Partial<Omit<PublicBookingApiDeps, "env">> & { env?: Env; stripe?: StripeDouble; afterAccessResolved?: () => Promise<void> } = {}): Harness {
  const logs: PublicApiLogEntry[] = [];
  const stripe = overrides.stripe ?? stripeDouble();
  const { env = ENV, afterAccessResolved, ...deps } = overrides;
  const api = createPublicBookingApi({
    ...defaultPublicBookingApiDeps,
    startCheckout: (token) => startAuthorizedBookingCheckout(token, { adapter: stripe, afterAccessResolved }),
    log: (entry) => logs.push(entry),
    ...deps,
    env: () => env,
  });
  return { api, logs, stripe };
}

type Send = { body?: string | object; cookie?: string; ip?: string; headers?: Record<string, string> };

function request(path: string, method: "GET" | "POST", options: Send = {}): Request {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", ...options.headers };
  if (options.cookie) headers.cookie = `${BOOKING_COOKIE_NAME}=${options.cookie}`;
  if (options.ip !== undefined) headers["x-vercel-forwarded-for"] = options.ip;
  for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
  const body = method === "GET" ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {});
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

/** Every response — success or error — must carry the security headers. */
async function respond(response: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, `${response.status} ${name}`);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text, setCookie: response.headers.get("set-cookie"), retryAfter: response.headers.get("retry-after") };
}

const create = async (h: Harness, options: Send = {}) => respond(await h.api.createBooking(request("/api/bookings", "POST", options)));
const checkout = async (h: Harness, options: Send = {}) => respond(await h.api.startCheckout(request("/api/bookings/checkout", "POST", options)));
const status = async (h: Harness, options: Send = {}) => respond(await h.api.getStatus(request("/api/bookings/status", "GET", options)));

const tokenFrom = (setCookie: string | null) => {
  const match = setCookie?.match(new RegExp(`^${BOOKING_COOKIE_NAME}=([A-Za-z0-9_-]{43});`));
  assert.ok(match, `no booking cookie in ${setCookie}`);
  return match[1];
};

let sequence = 0;
async function bookingInput(overrides: Record<string, unknown> = {}, capacity = 10) {
  sequence += 1;
  const { location, slot } = await createLocation({ name: `API Street ${sequence}`, slots: [{ time: "11:00", capacity }] });
  return {
    name: `API Customer ${sequence}`,
    email: `api${sequence}@example.test`,
    phone: `+1 555 020 ${String(sequence).padStart(4, "0")}`,
    locationId: location.id,
    bookingSlotId: slot.id,
    appointmentDate: WEEK.tuesday,
    ...overrides,
  };
}

/** Creates a booking through the API and returns its cookie token. */
async function booked(h: Harness, input?: Record<string, unknown>, ip = "203.0.113.10") {
  const created = await create(h, { body: input ?? (await bookingInput()), ip });
  assert.equal(created.status, 201, created.text);
  return tokenFrom(created.setCookie);
}

async function appointmentFor(token: string) {
  const { hashBookingAccessToken } = await import("@/lib/booking/access");
  return prisma.appointment.findUniqueOrThrow({ where: { accessTokenHash: hashBookingAccessToken(token) }, include: { payments: true, events: true, customer: true } });
}

async function fulfill(appointmentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { appointmentId_purpose: { appointmentId, purpose: "BOOKING_DEPOSIT" } } });
  return applyVerifiedCheckoutSession(verifiedCheckoutEvidence({
    checkoutSessionId: payment.providerCheckoutSessionId!,
    sessionStatus: "complete",
    paymentStatus: "paid",
    paymentIntentId: `pi_api_${payment.id}`,
    amountCents: payment.amountCents,
    currency: "usd",
    paidAt: new Date(),
    metadataPaymentId: payment.id,
    metadataAppointmentId: appointmentId,
  }));
}

function gate() {
  let open!: () => void;
  let arrived!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  return { open, reached, hook: async () => { arrived(); await opened; } };
}

const mustNotRun = async (): Promise<never> => {
  throw new Error("service must not be invoked");
};

describe("public booking API", { skip: integrationSkip }, () => {
  useCleanTestDatabase();

  describe("feature flag and configuration", () => {
    it("returns 404 from every endpoint without invoking any service when disabled", async () => {
      for (const flag of [undefined, "false", "TRUE"]) {
        const h = harness({ env: { ...ENV, PUBLIC_BOOKING_ENABLED: flag }, createBooking: mustNotRun, startCheckout: mustNotRun, getStatus: mustNotRun, consumeRateLimits: mustNotRun });
        for (const response of [await create(h, { body: await bookingInput() }), await checkout(h, { cookie: "A".repeat(43) }), await status(h, { cookie: "A".repeat(43) })]) {
          assert.equal(response.status, 404);
          assert.equal(response.json.error.code, "NOT_FOUND");
          assert.equal(response.setCookie, null);
        }
      }
      assert.equal(await prisma.appointment.count(), 0);
    });

    it("fails closed with 503 on unsafe configuration", async () => {
      const h = harness({ env: { ...ENV, RATE_LIMIT_SECRET: "short" }, createBooking: mustNotRun, consumeRateLimits: mustNotRun });
      const response = await create(h, { body: await bookingInput() });
      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, "SERVICE_UNAVAILABLE");
      assert.deepEqual(h.logs.map((l) => l.detail), ["configuration-invalid"]);
    });
  });

  describe("end-to-end flow", () => {
    it("creates a booking, sets the cookie, starts Checkout and reports status", async () => {
      const h = harness();
      const input = await bookingInput();
      const created = await create(h, { body: input, ip: "203.0.113.10" });

      assert.equal(created.status, 201);
      assert.deepEqual(Object.keys(created.json), ["booking"]);
      assert.deepEqual(Object.keys(created.json.booking).sort(), [
        "appointmentDate", "balanceDueCents", "depositAmountCents", "holdExpiresAt", "locationName", "slotTime", "status", "totalPriceCents",
      ]);
      assert.deepEqual([created.json.booking.totalPriceCents, created.json.booking.depositAmountCents, created.json.booking.balanceDueCents], [20_000, 4_000, 16_000]);
      const token = tokenFrom(created.setCookie);
      assert.match(created.setCookie!, /; Max-Age=86(39|40)\d; Expires=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
      assert.doesNotMatch(created.setCookie!, /Domain=/i);

      const appointment = await appointmentFor(token);
      for (const secret of [token, appointment.id, appointment.customerId, appointment.accessTokenHash!, input.email, input.phone]) {
        assert.ok(!created.text.includes(secret), `create leaked ${secret}`);
      }

      const started = await checkout(h, { cookie: token, ip: "203.0.113.10" });
      assert.equal(started.status, 200, started.text);
      assert.deepEqual(Object.keys(started.json.checkout).sort(), ["expiresAt", "url"]);
      assert.match(started.json.checkout.url, /^https:\/\/checkout\.stripe\.com\//);
      const payment = (await appointmentFor(token)).payments[0];
      for (const secret of [payment.id, payment.providerCheckoutSessionId!, appointment.id, token]) assert.ok(!started.text.includes(secret), `checkout leaked ${secret}`);

      const pending = await status(h, { cookie: token, ip: "203.0.113.10" });
      assert.equal(pending.status, 200);
      assert.equal(pending.json.booking.state, "payment-in-progress");

      await fulfill(appointment.id);
      const confirmed = await status(h, { cookie: token, ip: "203.0.113.10" });
      assert.deepEqual([confirmed.json.booking.state, confirmed.json.booking.depositPaid], ["confirmed", true]);

      // Logs carry codes only — never the token, contact details, ids or the Checkout URL.
      const logs = JSON.stringify(h.logs);
      for (const secret of [token, input.email, input.phone, input.name, appointment.id, payment.id, payment.providerCheckoutSessionId!, started.json.checkout.url]) {
        assert.ok(!logs.includes(secret), `logged ${secret}`);
      }
    });

    it("returns status as the exact allow-list and ignores query identifiers", async () => {
      const h = harness();
      const a = await booked(h);
      const b = await booked(h, undefined, "203.0.113.11");
      const appointmentB = await appointmentFor(b);
      await cancelAppointment(appointmentB.id);

      const response = await respond(await h.api.getStatus(new Request(`${ORIGIN}/api/bookings/status?appointment_id=${appointmentB.id}`, {
        headers: { cookie: `${BOOKING_COOKIE_NAME}=${a}`, "x-vercel-forwarded-for": "203.0.113.12" },
      })));
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.json.booking).sort(), [
        "appointmentDate", "balanceDueCents", "canStartCheckout", "depositAmountCents", "depositPaid", "hairstyleName", "holdExpiresAt", "locationName", "slotTime", "state", "totalPriceCents",
      ]);
      assert.equal(response.json.booking.state, "awaiting-payment");
      assert.equal((await status(h, { cookie: b, ip: "203.0.113.12" })).json.booking.state, "cancelled");
    });

    it("ignores appointment identifiers smuggled into Checkout", async () => {
      const h = harness();
      const a = await booked(h);
      const b = await booked(h, undefined, "203.0.113.11");
      const appointmentB = await appointmentFor(b);

      const smuggled = await checkout(h, { cookie: a, ip: "203.0.113.10", body: { appointmentId: appointmentB.id } });
      assert.deepEqual([smuggled.status, smuggled.json.error.code], [400, "INVALID_REQUEST"]);
      const viaQuery = await respond(await h.api.startCheckout(new Request(`${ORIGIN}/api/bookings/checkout?appointment_id=${appointmentB.id}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", cookie: `${BOOKING_COOKIE_NAME}=${a}`, "x-vercel-forwarded-for": "203.0.113.10", referer: `${ORIGIN}/book/success?appointment_id=${appointmentB.id}` },
        body: "{}",
      })));
      assert.equal(viaQuery.status, 200);
      assert.equal((await appointmentFor(a)).payments.length, 1);
      assert.equal((await appointmentFor(b)).payments.length, 0);
    });
  });

  describe("credentials", () => {
    it("answers missing, malformed, unknown, expired and revoked credentials identically", async () => {
      const h = harness();
      const expired = await booked(h);
      const expiredId = (await appointmentFor(expired)).id;
      await prisma.$executeRaw`
        UPDATE "Appointment" SET "accessTokenIssuedAt" = "accessTokenIssuedAt" - interval '2 days', "accessTokenExpiresAt" = "accessTokenExpiresAt" - interval '2 days'
        WHERE "id" = ${expiredId}
      `;
      const revoked = await booked(h, undefined, "203.0.113.11");
      await revokeBookingAccess({ appointmentId: (await appointmentFor(revoked)).id, reason: "suspected-compromise", actorId: "admin_1" });

      const bodies = new Set<string>();
      for (const send of [checkout, status]) {
        const missing = await send(h, { ip: "203.0.113.20" });
        assert.equal(missing.status, 401);
        assert.equal(missing.setCookie, null, "nothing to clear");
        bodies.add(missing.text);
        for (const cookie of ["garbage", "A".repeat(43), expired, revoked]) {
          const response = await send(h, { cookie, ip: "203.0.113.20" });
          assert.equal(response.status, 401, cookie);
          assert.match(response.setCookie!, new RegExp(`^${BOOKING_COOKIE_NAME}=; Max-Age=0; .*Path=/; Secure; HttpOnly; SameSite=Lax$`));
          bodies.add(response.text);
        }
      }
      assert.equal(bodies.size, 1, "one indistinguishable 401 body");
      assert.deepEqual(JSON.parse([...bodies][0]), { error: { code: "BOOKING_ACCESS_DENIED", message: "No active booking was found in this browser." } });
      assert.equal(await prisma.payment.count(), 0);
    });
  });

  describe("cookie replacement policy", () => {
    /** Asserts the second booking was refused and nothing about either booking changed. */
    async function assertRefused(h: Harness, existing: string, ip: string) {
      const before = await appointmentFor(existing);
      const counts = [await prisma.customer.count(), await prisma.appointment.count(), await prisma.payment.count()];
      const second = await create(h, { body: await bookingInput(), cookie: existing, ip });
      assert.deepEqual([second.status, second.json?.error?.code, second.setCookie], [409, "ACTIVE_BOOKING_EXISTS", null], second.text);
      assert.deepEqual([await prisma.customer.count(), await prisma.appointment.count(), await prisma.payment.count()], counts);
      assert.deepEqual(await appointmentFor(existing), before, "existing booking and credential untouched");
      assert.equal((await status(h, { cookie: existing, ip })).status, 200, "existing credential still works");
    }

    it("refuses a pending booking with 30 seconds left and no Payment", async () => {
      const h = harness();
      const token = await booked(h);
      await prisma.appointment.update({ where: { id: (await appointmentFor(token)).id }, data: { holdExpiresAt: new Date(Date.now() + 30_000) } });
      await assertRefused(h, token, "203.0.113.30");
    });

    it("refuses a pending booking with an open Checkout Session", async () => {
      const h = harness();
      const token = await booked(h);
      assert.equal((await checkout(h, { cookie: token, ip: "203.0.113.10" })).status, 200);
      await assertRefused(h, token, "203.0.113.31");
    });

    it("refuses an expired hold whose Payment has an uncertain Session creation", async () => {
      const h = harness({ stripe: stripeDouble({ failCreate: true }) });
      const token = await booked(h);
      assert.equal((await checkout(h, { cookie: token, ip: "203.0.113.10" })).json.error.code, "CHECKOUT_OUTCOME_UNCERTAIN");
      await prisma.appointment.update({ where: { id: (await appointmentFor(token)).id }, data: { holdExpiresAt: new Date(Date.now() - 3600_000) } });
      await assertRefused(h, token, "203.0.113.32");
    });

    it("refuses a cancelled booking with unresolved payment evidence", async () => {
      const h = harness();
      // Cancelled while its Session is still open (it could still be paid).
      const openSession = await booked(h);
      await checkout(h, { cookie: openSession, ip: "203.0.113.10" });
      await cancelAppointment((await appointmentFor(openSession)).id);
      await assertRefused(h, openSession, "203.0.113.33");

      // Cancelled, then paid: money received but not allocated.
      await fulfill((await appointmentFor(openSession)).id);
      assert.equal((await status(h, { cookie: openSession, ip: "203.0.113.34" })).json.booking.state, "needs-attention");
      await assertRefused(h, openSession, "203.0.113.34");

      // Cancelled with no Payment, but an unresolved payment exception names it.
      const exception = await booked(h, undefined, "203.0.113.11");
      const exceptionId = (await appointmentFor(exception)).id;
      await cancelAppointment(exceptionId);
      await prisma.paymentProcessingException.create({
        data: {
          provider: "STRIPE",
          checkoutSessionId: "cs_unresolved_exception",
          expectedAppointmentId: exceptionId,
          category: "MISSING_ASSOCIATION",
          problem: "PAYMENT_NOT_FOUND",
          moneyReceived: true,
          paymentIntentId: "pi_unresolved_exception",
          verifiedAmountCents: 4_000,
          verifiedCurrency: "usd",
          firstObservedAt: new Date(),
          lastObservedAt: new Date(),
        },
      });
      await assertRefused(h, exception, "203.0.113.35");
      await prisma.paymentProcessingException.updateMany({ where: { expectedAppointmentId: exceptionId }, data: { resolvedAt: new Date(Date.now() + 1000), resolutionNote: "refunded" } });
      assert.equal((await create(h, { body: await bookingInput(), cookie: exception, ip: "203.0.113.36" })).status, 201, "replaceable once resolved");
    });

    it("replaces the cookie for a confirmed, cancelled-without-payment, expired or unusable booking", async () => {
      const h = harness();
      const confirmed = await booked(h);
      await checkout(h, { cookie: confirmed, ip: "203.0.113.10" });
      await fulfill((await appointmentFor(confirmed)).id);
      const confirmedAppointmentId = (await appointmentFor(confirmed)).id;
      const cancelled = await booked(h, undefined, "203.0.113.11");
      await cancelAppointment((await appointmentFor(cancelled)).id);
      const expired = await booked(h, undefined, "203.0.113.12");
      await prisma.appointment.update({ where: { id: (await appointmentFor(expired)).id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });

      let ip = 40;
      for (const old of [confirmed, cancelled, expired, "A".repeat(43), "garbage"]) {
        const replaced = await create(h, { body: await bookingInput(), cookie: old, ip: `203.0.113.${ip++}` });
        assert.equal(replaced.status, 201, old);
        assert.notEqual(tokenFrom(replaced.setCookie), old);
      }
      const kept = await prisma.appointment.findUniqueOrThrow({ where: { id: confirmedAppointmentId }, include: { payments: true, events: true } });
      assert.deepEqual([kept.status, kept.payments.length], ["CONFIRMED", 1], "never cancelled or charged again");
      assert.ok(kept.accessTokenRevokedAt);
      assert.equal(kept.events.filter((event) => event.type === "ACCESS_REVOKED").length, 1);
    });

    it("refuses both of two concurrent creations carrying a payable booking's cookie", async () => {
      const h = harness();
      const token = await booked(h);
      const before = await prisma.appointment.count();
      const responses = await Promise.all([1, 2].map(async (n) => create(h, { body: await bookingInput(), cookie: token, ip: `203.0.113.${50 + n}` })));
      assert.deepEqual(responses.map((r) => [r.status, r.json.error.code, r.setCookie]), [[409, "ACTIVE_BOOKING_EXISTS", null], [409, "ACTIVE_BOOKING_EXISTS", null]]);
      assert.equal(await prisma.appointment.count(), before);
    });

    it("allows only one concurrent replacement of a confirmed booking credential", async () => {
      const h = harness();
      const token = await booked(h);
      await checkout(h, { cookie: token, ip: "203.0.113.10" });
      await fulfill((await appointmentFor(token)).id);
      const original = await appointmentFor(token);

      const responses = await Promise.all([1, 2].map(async (n) => create(h, { body: await bookingInput(), cookie: token, ip: `203.0.113.${60 + n}` })));
      assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
      const fresh = await prisma.appointment.findMany({ where: { id: { not: original.id } }, include: { payments: true } });
      assert.equal(fresh.length, 1);
      assert.ok(fresh.every((a) => a.status === "PENDING_PAYMENT" && a.payments.length === 0));
      const historical = await prisma.appointment.findUniqueOrThrow({ where: { id: original.id }, include: { events: true } });
      assert.ok(historical.accessTokenRevokedAt);
      assert.equal(historical.events.filter((event) => event.type === "ACCESS_REVOKED").length, 1);
    });

    it("does not use the legacy preflight replacement seam", async () => {
      const h = harness({ canReplaceBooking: async () => { throw new Error("database down"); } });
      const response = await create(h, { body: await bookingInput(), cookie: "A".repeat(43), ip: "203.0.113.10" });
      assert.equal(response.status, 201);
      assert.equal(await prisma.appointment.count(), 1);
    });
  });

  describe("CSRF and request shape", () => {
    it("rejects foreign, missing, null, sibling and cross-site mutations before any work", async () => {
      const h = harness({ createBooking: mustNotRun, startCheckout: mustNotRun, consumeRateLimits: mustNotRun });
      const input = await bookingInput();
      const rejected: Record<string, string>[] = [
        { origin: "https://evil.example" },
        { origin: "" },
        { origin: "null" },
        { origin: "https://shop.yasmin.example" },
        { origin: "http://book.yasmin.example" },
        { origin: "https://book.yasmin.example:444" },
        { "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "same-site" },
      ];
      for (const headers of rejected) {
        for (const send of [create, checkout]) {
          const response = await send(h, { body: send === create ? input : {}, cookie: "A".repeat(43), headers });
          assert.deepEqual([response.status, response.json.error.code, response.setCookie], [403, "REQUEST_ORIGIN_REJECTED", null], JSON.stringify(headers));
        }
      }
      assert.equal(await prisma.appointment.count(), 0);
      assert.equal(await prisma.rateLimitCounter.count(), 0);
    });

    it("requires application/json", async () => {
      const h = harness({ createBooking: mustNotRun, startCheckout: mustNotRun });
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
        assert.equal((await create(h, { body: await bookingInput(), headers: { "content-type": type } })).status, 415, type);
        assert.equal((await checkout(h, { headers: { "content-type": type } })).status, 415, type);
      }
    });

    it("rejects oversized, malformed, non-object and over-specified bodies without writing", async () => {
      const h = harness();
      const input = await bookingInput();
      const oversized = JSON.stringify({ ...input, customerNotes: "x".repeat(8192) });
      assert.equal((await create(h, { body: oversized, ip: "203.0.113.50" })).json.error.code, "REQUEST_TOO_LARGE");
      assert.equal((await create(h, { body: "{not json", ip: "203.0.113.50" })).json.error.code, "INVALID_JSON");
      assert.equal((await create(h, { body: "[]", ip: "203.0.113.51" })).json.error.code, "INVALID_JSON");
      assert.equal((await create(h, { body: { ...input, customerId: "forbidden" }, ip: "203.0.113.51" })).json.error.code, "INVALID_BOOKING_INPUT");
      assert.equal((await create(h, { body: { ...input, depositAmountCents: 1 }, ip: "203.0.113.52" })).json.error.code, "INVALID_BOOKING_INPUT");
      assert.equal((await checkout(h, { body: "", cookie: "A".repeat(43), ip: "203.0.113.52" })).json.error.code, "INVALID_JSON");
      assert.equal((await checkout(h, { body: "x".repeat(1025), cookie: "A".repeat(43), ip: "203.0.113.52" })).json.error.code, "REQUEST_TOO_LARGE");
      assert.equal(await prisma.customer.count(), 0);
      assert.equal(await prisma.appointment.count(), 0);
    });

    it("accepts a body at exactly 8 KB", async () => {
      const h = harness();
      const input = await bookingInput();
      // Insignificant JSON whitespace pads the body to the exact limit.
      const base = JSON.stringify(input);
      const padded = `${base}${" ".repeat(8192 - Buffer.byteLength(base))}`;
      assert.equal(Buffer.byteLength(padded), 8192);
      assert.equal((await create(h, { body: padded, ip: "203.0.113.53" })).status, 201);
    });

    it("never issues a cookie when booking creation fails, and never leaks internal errors", async () => {
      const full = await bookingInput({}, 1);
      const h = harness();
      assert.equal((await create(h, { body: full, ip: "203.0.113.60" })).status, 201);
      const rejected = await create(h, { body: { ...full, email: "other@example.test", phone: "+1 555 030 0001" }, ip: "203.0.113.61" });
      assert.deepEqual([rejected.status, rejected.json.error.code, rejected.setCookie], [409, "SLOT_FULL", null]);

      const leaky = harness({ createBooking: async () => { throw new Error('PrismaClientKnownRequestError: duplicate "customer@example.test" at 10.0.0.1'); } });
      const response = await create(leaky, { body: await bookingInput(), ip: "203.0.113.62" });
      assert.deepEqual([response.status, response.json, response.setCookie], [500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }, null]);
      assert.ok(!JSON.stringify(leaky.logs).includes("customer@example.test"));
      assert.deepEqual(leaky.logs.at(-1)?.detail, "Error");
    });
  });

  describe("rate limiting", () => {
    it("allows 5 creations per IP per 10 minutes and returns 429 with Retry-After", async () => {
      const h = harness();
      for (let i = 0; i < 5; i++) assert.equal((await create(h, { body: await bookingInput(), ip: "198.51.100.1" })).status, 201, `attempt ${i + 1}`);
      const limited = await create(h, { body: await bookingInput(), ip: "198.51.100.1" });
      assert.deepEqual([limited.status, limited.json.error.code, limited.setCookie], [429, "RATE_LIMITED", null]);
      assert.ok(Number(limited.retryAfter) >= 1 && Number(limited.retryAfter) <= 600);
      assert.equal(await prisma.appointment.count(), 5);
      assert.equal((await create(h, { body: await bookingInput(), ip: "198.51.100.2" })).status, 201, "another IP is independent");
    });

    it("counts malformed and invalid attempts against the IP limit", async () => {
      const h = harness();
      for (let i = 0; i < 5; i++) await create(h, { body: "{bad", ip: "198.51.100.3" });
      assert.equal((await create(h, { body: await bookingInput(), ip: "198.51.100.3" })).status, 429);
    });

    it("limits a normalized email and phone to 3 attempts a day across IPs", async () => {
      const h = harness();
      const email = "Repeat@Example.test";
      for (let i = 0; i < 3; i++) {
        assert.equal((await create(h, { body: await bookingInput({ email: i === 1 ? ` ${email.toLowerCase()} ` : email }), ip: `198.51.100.${10 + i}` })).status, 201);
      }
      assert.equal((await create(h, { body: await bookingInput({ email }), ip: "198.51.100.20" })).status, 429);

      for (let i = 0; i < 3; i++) {
        assert.equal((await create(h, { body: await bookingInput({ phone: i === 1 ? "+1 (555) 040-0000" : "+1 555 040 0000" }), ip: `198.51.100.${30 + i}` })).status, 201);
      }
      assert.equal((await create(h, { body: await bookingInput({ phone: "15550400000" }), ip: "198.51.100.40" })).status, 429);
    });

    it("cannot be bypassed by spoofed forwarding headers or a missing trusted IP", async () => {
      const h = harness();
      for (let i = 0; i < 5; i++) {
        await create(h, { body: "{bad", headers: { "x-forwarded-for": `192.0.2.${i}`, "x-real-ip": `192.0.2.${i}` } });
      }
      assert.equal((await create(h, { body: await bookingInput(), headers: { "x-forwarded-for": "192.0.2.99" } })).status, 429);
      assert.equal((await create(h, { body: await bookingInput(), ip: "not-an-ip" })).status, 429, "invalid trusted value shares the bucket");
    });

    it("limits Checkout per credential and per IP, before credentials are checked", async () => {
      const h = harness();
      const token = await booked(h);
      for (let i = 0; i < 10; i++) await checkout(h, { cookie: token, ip: `198.51.100.${60 + i}` });
      assert.equal((await checkout(h, { cookie: token, ip: "198.51.100.99" })).status, 429, "credential limit");

      for (let i = 0; i < 30; i++) await checkout(h, { ip: "198.51.100.100" });
      const ipLimited = await checkout(h, { ip: "198.51.100.100" });
      assert.deepEqual([ipLimited.status, ipLimited.json.error.code], [429, "RATE_LIMITED"], "IP limit applies without any credential");
      assert.equal(h.stripe.creates(), 1);
    });

    it("limits status reads per credential", async () => {
      const h = harness();
      const token = await booked(h);
      for (let i = 0; i < 60; i++) await status(h, { cookie: token, ip: `198.51.${101 + Math.floor(i / 100)}.${i % 100}` });
      assert.equal((await status(h, { cookie: token, ip: "198.51.120.1" })).status, 429);
    });

    it("fails closed with 503 when the rate-limit store fails", async () => {
      const h = harness({ consumeRateLimits: async () => { throw new RateLimitStoreError(); }, createBooking: mustNotRun, startCheckout: mustNotRun, getStatus: mustNotRun });
      for (const response of [
        await create(h, { body: await bookingInput(), ip: "198.51.100.1" }),
        await checkout(h, { cookie: "A".repeat(43), ip: "198.51.100.1" }),
        await status(h, { cookie: "A".repeat(43), ip: "198.51.100.1" }),
      ]) {
        assert.deepEqual([response.status, response.json.error.code, response.setCookie], [503, "SERVICE_UNAVAILABLE", null]);
      }
      assert.equal(await prisma.appointment.count(), 0);
    });
  });

  describe("concurrency and races", () => {
    it("never overbooks under concurrent creation", async () => {
      const h = harness();
      const base = await bookingInput({}, 1);
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => create(h, { body: { ...base, email: `race${i}@example.test`, phone: `+1 555 050 000${i}` }, ip: `198.51.100.${150 + i}` })),
      );
      assert.equal(responses.filter((r) => r.status === 201).length, 1);
      assert.equal(responses.filter((r) => r.status === 409 && r.json.error.code === "SLOT_FULL").length, 5);
      assert.equal(responses.filter((r) => r.setCookie !== null).length, 1);
      assert.equal(await prisma.appointment.count(), 1);
      assert.equal(await prisma.customer.count(), 1, "no orphan customers");
    });

    it("serializes concurrent Checkout starts: one Payment, one Session, one hold extension", async () => {
      const h = harness();
      const token = await booked(h);
      const responses = await Promise.all(Array.from({ length: 5 }, () => checkout(h, { cookie: token, ip: "198.51.100.200" })));

      const ready = responses.filter((r) => r.status === 200);
      assert.ok(ready.length >= 1);
      // Requests that ran while the first was creating the Session cannot know its outcome.
      assert.ok(responses.every((r) => r.status === 200 || (r.status === 409 && r.json.error.code === "CHECKOUT_OUTCOME_UNCERTAIN")), JSON.stringify(responses.map((r) => r.status)));
      assert.equal(new Set(ready.map((r) => r.json.checkout.url)).size, 1);
      const appointment = await appointmentFor(token);
      assert.equal(appointment.payments.length, 1);
      assert.equal(appointment.events.filter((e) => e.type === "HOLD_EXPIRY_CHANGED").length, 1);
      assert.equal(h.stripe.creates(), 1);
    });

    it("cancellation during Checkout wins: 409, no Payment, no Session", async () => {
      const g = gate();
      const h = harness({ afterAccessResolved: g.hook });
      const token = await booked(h);
      const pending = checkout(h, { cookie: token, ip: "198.51.100.201" });
      await g.reached;
      await cancelAppointment((await appointmentFor(token)).id);
      g.open();
      const response = await pending;
      assert.deepEqual([response.status, response.json.error.code], [409, "BOOKING_NOT_PAYABLE"]);
      assert.equal((await appointmentFor(token)).payments.length, 0);
      assert.equal(h.stripe.creates(), 0);
    });

    it("revocation during Checkout wins: 401, cookie cleared, no Payment", async () => {
      const g = gate();
      const h = harness({ afterAccessResolved: g.hook });
      const token = await booked(h);
      const pending = checkout(h, { cookie: token, ip: "198.51.100.202" });
      await g.reached;
      await revokeBookingAccess({ appointmentId: (await appointmentFor(token)).id, reason: "suspected-compromise", actorId: "admin_1" });
      g.open();
      const response = await pending;
      assert.deepEqual([response.status, response.json.error.code], [401, "BOOKING_ACCESS_DENIED"]);
      assert.match(response.setCookie!, /Max-Age=0/);
      assert.equal((await appointmentFor(token)).payments.length, 0);
      assert.equal(h.stripe.creates(), 0);
    });

    it("verified fulfillment during Checkout wins: 409 already confirmed, no duplicate Payment or events", async () => {
      const g = gate();
      let gated = false;
      const h = harness({ afterAccessResolved: async () => { if (gated) await g.hook(); } });
      const token = await booked(h);
      assert.equal((await checkout(h, { cookie: token, ip: "198.51.100.203" })).status, 200);

      gated = true;
      const pending = checkout(h, { cookie: token, ip: "198.51.100.203" });
      await g.reached;
      assert.equal((await fulfill((await appointmentFor(token)).id)).kind, "confirmed");
      g.open();
      const response = await pending;
      assert.deepEqual([response.status, response.json.error.code], [409, "BOOKING_ALREADY_CONFIRMED"]);

      const appointment = await appointmentFor(token);
      assert.equal(appointment.status, "CONFIRMED");
      assert.equal(appointment.payments.length, 1);
      assert.equal(appointment.events.filter((e) => e.type === "HOLD_EXPIRY_CHANGED").length, 1);
      assert.equal(appointment.events.filter((e) => e.type === "PAYMENT_CONFIRMED").length, 1);
      assert.equal(h.stripe.creates(), 1);
    });
  });

  describe("Checkout outcomes", () => {
    it("answers an uncertain Session creation the same way on every request, never with start-over", async () => {
      const failing = harness({ stripe: stripeDouble({ failCreate: true }) });
      const token = await booked(failing);
      const answers = [];
      for (let i = 0; i < 3; i++) answers.push(await checkout(failing, { cookie: token, ip: "198.51.100.210" }));
      await prisma.$executeRaw`UPDATE "Payment" SET "createdAt" = "createdAt" - interval '10 minutes'`;
      answers.push(await checkout(failing, { cookie: token, ip: "198.51.100.210" }));

      assert.equal(new Set(answers.map((a) => a.text)).size, 1, "identical responses");
      assert.deepEqual([answers[0].status, answers[0].json.error.code, answers[0].retryAfter], [409, "CHECKOUT_OUTCOME_UNCERTAIN", null]);
      assert.doesNotMatch(answers[0].json.error.message, /please start a new booking/i);
      assert.equal(failing.stripe.creates(), 1, "no second provider creation");
      assert.equal((await appointmentFor(token)).payments.length, 1);
      // And the browser cannot start over either.
      assert.equal((await create(failing, { body: await bookingInput(), cookie: token, ip: "198.51.100.211" })).json.error.code, "ACTIVE_BOOKING_EXISTS");
    });

    it("reports a failed read of a recorded Session as temporary, consistently", async () => {
      const h = harness();
      const recorded = await booked(h, undefined, "198.51.100.211");
      assert.equal((await checkout(h, { cookie: recorded, ip: "198.51.100.211" })).status, 200);
      for (let i = 0; i < 2; i++) {
        const outage = await checkout(h, { cookie: recorded, ip: "198.51.100.211" });
        assert.deepEqual([outage.status, outage.json.error.code, outage.retryAfter], [503, "CHECKOUT_TEMPORARILY_UNAVAILABLE", "5"]);
      }
      assert.equal(h.stripe.creates(), 1);
    });

    it("lets the customer start over only after verified evidence ends the attempt", async () => {
      const failing = harness({ stripe: stripeDouble({ failCreate: true }) });
      const token = await booked(failing);
      await checkout(failing, { cookie: token, ip: "198.51.100.212" });
      const payment = (await appointmentFor(token)).payments[0];
      await applyVerifiedCheckoutSession(verifiedCheckoutEvidence({
        checkoutSessionId: `cs_api_${payment.id}`,
        sessionStatus: "expired",
        paymentStatus: "unpaid",
        paymentIntentId: null,
        amountCents: payment.amountCents,
        currency: "usd",
        paidAt: null,
        metadataPaymentId: payment.id,
        metadataAppointmentId: payment.appointmentId,
      }));
      const ended = await checkout(failing, { cookie: token, ip: "198.51.100.212" });
      assert.deepEqual([ended.status, ended.json.error.code], [409, "CHECKOUT_ATTEMPT_ENDED"]);
      assert.match(ended.json.error.message, /please start a new booking/i);
      assert.equal((await create(failing, { body: await bookingInput(), cookie: token, ip: "198.51.100.213" })).status, 201);
    });

    it("refuses to hand out a Checkout URL outside the exact Stripe host", async () => {
      for (const url of ["https://checkout.stripe.com.evil.example/pay", "http://checkout.stripe.com/pay", "https://evil.example/checkout.stripe.com"]) {
        const h = harness({ stripe: stripeDouble({ url: () => url }) });
        const token = await booked(h, undefined, `198.51.100.${220 + url.length % 20}`);
        const response = await checkout(h, { cookie: token, ip: "198.51.100.230" });
        assert.deepEqual([response.status, response.json.error.code], [502, "CHECKOUT_PROVIDER_ERROR"], url);
        assert.ok(!response.text.includes(url));
      }
    });

    it("maps expired and unpayable holds to stable codes", async () => {
      const h = harness();
      const expired = await booked(h);
      await prisma.appointment.update({ where: { id: (await appointmentFor(expired)).id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await checkout(h, { cookie: expired, ip: "198.51.100.240" })).json.error.code, "HOLD_EXPIRED");

      const short = await booked(h, undefined, "198.51.100.241");
      await prisma.appointment.update({ where: { id: (await appointmentFor(short)).id }, data: { holdExpiresAt: new Date(Date.now() + 30_000) } });
      assert.equal((await checkout(h, { cookie: short, ip: "198.51.100.241" })).json.error.code, "HOLD_TIME_INSUFFICIENT");

      const cancelled = await booked(h, undefined, "198.51.100.242");
      await cancelAppointment((await appointmentFor(cancelled)).id);
      assert.equal((await checkout(h, { cookie: cancelled, ip: "198.51.100.242" })).json.error.code, "BOOKING_NOT_PAYABLE");
      assert.equal(await prisma.payment.count(), 0);
    });
  });

  describe("status is read-only", () => {
    it("changes nothing in the database", async () => {
      const h = harness();
      const token = await booked(h);
      const before = await appointmentFor(token);
      for (let i = 0; i < 3; i++) await status(h, { cookie: token, ip: "198.51.100.250" });
      assert.deepEqual(await appointmentFor(token), before);
    });
  });
});
